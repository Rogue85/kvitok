import { t } from '@kvitok/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentRunDto, AgentRunMode, LlmModel } from '@kvitok/shared';
import type IORedis from 'ioredis';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { Prisma, type AgentRun } from '../generated/prisma/client';
import { LLM_CLIENT_FACTORY, type LlmClientFactory } from '../llm/llm-client.factory';
import type { LlmMessage } from '../llm/llm.types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { REDIS } from '../redis/redis.module';
import { recordEvent, SYSTEM_ACTOR } from '../tickets/ticket-events';
import { cancelKey } from './agent.constants';
import { AgentRunner, type RunnerStep } from './agent-runner';
import { AgentTriggerService, lockTicket } from './agent-trigger.service';
import { CHAT_TRIGGERS, type AgentPending, type AgentTrigger } from './agent-trigger.types';
import { ConfigSnapshotService } from './config-snapshot.service';
import { assembleContext, type AssembledContext } from './context-assembler';
import { DraftsService } from './drafts.service';
import { IntegrationRuntimeService, type IntegrationStepInput, type RecordedCalls } from './integration-runtime';
import { LlmProvidersService } from './llm-providers.service';
import { ResultApplier } from './result-applier';
import type { AgentResult } from './submit-schema';

const CANCEL_POLL_MS = 1000;

export type RunOutcome = 'applied' | 'stale' | 'failed' | 'cancelled' | 'dry_run';

export interface ExecuteParams {
  ticketId: string;
  mode: AgentRunMode;
  triggers: AgentTrigger[];
  inputRevision: number;
  dryRun?: boolean;
  /** A trial run on another provider or model — without changing the settings. */
  override?: { providerId?: string; model?: string };
  /**
   * Replays a past run with the current configuration: the ticket part of the prompt is the one that run saw,
   * backend results are its recorded ones. Always a dry run.
   */
  replayOf?: string;
}

export class AgentNotConfiguredError extends Error {}

/** A whole agent run: configuration version → context → LLM loop → application; with steps and cost recorded. */
@Injectable()
export class AgentEngine {
  private readonly logger = new Logger(AgentEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigSnapshotService,
    private readonly providers: LlmProvidersService,
    private readonly runner: AgentRunner,
    private readonly applier: ResultApplier,
    private readonly drafts: DraftsService,
    private readonly triggers: AgentTriggerService,
    private readonly realtime: RealtimeService,
    private readonly integrations: IntegrationRuntimeService,
    @Inject(LLM_CLIENT_FACTORY) private readonly clientFactory: LlmClientFactory,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  /** Handles a queue job: take the accumulated triggers, run, queue the next run if needed. */
  async processTicket(ticketId: string, jobId: string): Promise<RunOutcome | 'skipped'> {
    const claim = await this.prisma.$transaction(async (tx) => {
      const row = await lockTicket(tx, ticketId);
      if (row.agent_job_id !== jobId) return null;
      await tx.ticket.update({
        where: { id: ticketId },
        data: { agentState: 'running', agentPending: Prisma.DbNull, agentRerunPending: false, agentJobId: null },
      });
      return {
        workspaceId: row.workspace_id,
        pending: row.agent_pending ?? ({ mode: 'triage', triggers: [{ type: 'manual' }] } satisfies AgentPending),
        revision: row.revision,
      };
    });
    if (claim === null) return 'skipped';

    await this.redis.del(cancelKey(ticketId));
    await this.realtime.publish(claim.workspaceId, { type: 'agent.updated', ticketId, state: 'running' });

    const outcome = await this.execute({ ticketId, mode: claim.pending.mode, triggers: claim.pending.triggers, inputRevision: claim.revision }).then(
      (r) => r.outcome,
      // Failed before the run was created (configuration, database) — otherwise the ticket would stay in running forever.
      async (error: unknown): Promise<RunOutcome> => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Agent run for ticket ${ticketId} failed before start: ${message}`);
        await this.prisma.$transaction((tx) =>
          recordEvent(tx, { workspaceId: claim.workspaceId, ticketId, type: 'agent_failed', actor: SYSTEM_ACTOR, data: { error: message.slice(0, 500) } }),
        );
        return 'failed';
      },
    );

    const next = await this.prisma.$transaction(async (tx) => {
      const row = await lockTicket(tx, ticketId);
      let pending = row.agent_pending;
      if (outcome === 'stale' && pending === null) {
        pending = { mode: claim.pending.mode, triggers: [{ type: 'stale_rerun' }] };
      }
      // The run did not finish — the operator got no reply to their messages: carry them over to the next run.
      const unanswered = outcome === 'stale' || outcome === 'cancelled' ? claim.pending.triggers.filter((t) => CHAT_TRIGGERS.includes(t.type)) : [];
      if ((pending !== null || row.agent_rerun_pending) && unanswered.length > 0) {
        pending = { mode: 'refine', triggers: [...unanswered, ...(pending?.triggers ?? [])].slice(-20) };
      }
      if (pending !== null || row.agent_rerun_pending) {
        const nextJobId = `run:${ticketId}:${newId()}`;
        await tx.ticket.update({
          where: { id: ticketId },
          data: { agentState: 'queued', agentJobId: nextJobId, agentRerunPending: false, agentPending: json(pending ?? { mode: 'refine', triggers: [{ type: 'stale_rerun' }] }) },
        });
        return { jobId: nextJobId, state: 'queued' };
      }
      const state = outcome === 'failed' ? 'failed' : 'idle';
      await tx.ticket.update({ where: { id: ticketId }, data: { agentState: state } });
      return { jobId: null, state };
    });

    if (next.jobId) {
      await this.triggers.addRunJob(ticketId, next.jobId);
    }
    await this.realtime.publish(claim.workspaceId, { type: 'agent.updated', ticketId, state: next.state });
    await this.realtime.publish(claim.workspaceId, { type: 'ticket.updated', ticketId });
    return outcome;
  }

  async execute(params: ExecuteParams): Promise<{ outcome: RunOutcome; run: AgentRun; result?: AgentResult }> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({
      where: { id: params.ticketId },
      include: { channel: true, customer: { include: { identities: true } } },
    });
    const { version, snapshot } = await this.config.resolve(ticket.workspaceId);
    const replay = params.replayOf ? await this.loadReplay(ticket.id, params.replayOf) : null;
    const dryRun = (params.dryRun ?? false) || replay !== null;
    const providerId = params.override?.providerId ?? snapshot.provider?.id ?? null;
    const model = params.override?.model ?? snapshot.settings.model;

    let run = await this.prisma.agentRun.create({
      data: {
        id: newId(),
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        mode: params.mode,
        trigger: json(params.triggers.at(-1) ?? { type: 'manual' }),
        status: 'running',
        dryRun,
        inputRevision: params.inputRevision,
        configVersionId: version.id,
        model,
        startedAt: new Date(),
      },
    });

    const controller = new AbortController();
    const poller = dryRun ? null : setInterval(() => void this.checkCancel(ticket.id, controller), CANCEL_POLL_MS);
    let stepIndex = 0;

    try {
      if (!providerId || !model) {
        throw new AgentNotConfiguredError(t('api.agentNotConfigured'));
      }
      const provider = await this.providers.get(ticket.workspaceId, providerId);
      const providerInfo = this.providers.toDto(provider);
      const [messages, questions, draftState, actions] = await Promise.all([
        this.prisma.message.findMany({ where: { ticketId: ticket.id }, include: { authorUser: true }, orderBy: { createdAt: 'asc' } }),
        this.prisma.agentQuestion.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: 'asc' } }),
        this.drafts.state(ticket.id),
        this.prisma.actionProposal.findMany({ where: { ticketId: ticket.id, status: { not: 'superseded' } }, orderBy: { createdAt: 'asc' } }),
      ]);
      // The customer in external systems, the card and stored facts — before the prompt is built; calls are recorded as run steps.
      const integrations = await this.integrations.prepare(ticket, {
        now: replay?.at,
        record: (step) => this.saveStep(run.id, stepIndex++, step),
        recorded: replay?.calls,
      });
      const context: AssembledContext = assembleContext({
        snapshot,
        ticket,
        messages,
        questions,
        mode: params.mode,
        triggers: params.triggers,
        draft: draftState.draft,
        supportsTools: providerInfo.capabilities.tools,
        integrations: integrations.views,
        actions,
      });
      if (replay) {
        // The configuration layers are today's; what the agent knew about the ticket is what the past run saw.
        context.messages = [context.messages[0]!, replay.ticketMessage];
      }
      run = await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { inputSnapshot: json({ messages: context.messages, tools: context.tools }) },
      });

      const output = await this.runner.run({
        client: this.clientFactory(this.providers.resolve(provider)),
        model,
        snapshot,
        context,
        signal: controller.signal,
        tools: integrations.executor,
        onStep: (step) => this.saveStep(run.id, stepIndex++, step),
      });

      const cost = computeCost(providerInfo.models.find((m) => m.id === model), output.usage);
      const finished = { output: json(output.result), tokensIn: output.usage.input, tokensOut: output.usage.output, ...cost, finishedAt: new Date() };

      if (dryRun) {
        run = await this.prisma.agentRun.update({ where: { id: run.id }, data: { ...finished, status: 'applied' } });
        return { outcome: 'dry_run', run, result: output.result };
      }

      const outcome = await this.applier.apply(run, output.result, snapshot, {
        partial: context.partial,
        chat: context.chat,
        proposals: integrations.executor.proposals(),
      });
      run = await this.prisma.agentRun.update({ where: { id: run.id }, data: { ...finished, status: outcome === 'stale' ? 'stale' : 'applied' } });
      return { outcome, run, result: output.result };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (!cancelled) {
        this.logger.warn(`Agent run ${run.id} failed: ${message}`);
      }
      run = await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : message.slice(0, 2000), finishedAt: new Date() },
      });
      if (!cancelled && !dryRun) {
        await this.prisma.$transaction((tx) =>
          recordEvent(tx, { workspaceId: ticket.workspaceId, ticketId: ticket.id, type: 'agent_failed', actor: SYSTEM_ACTOR, data: { runId: run.id, error: message.slice(0, 500) } }),
        );
      }
      return { outcome: cancelled ? 'cancelled' : 'failed', run };
    } finally {
      if (poller) clearInterval(poller);
    }
  }

  private async loadReplay(ticketId: string, runId: string): Promise<{ at: Date; ticketMessage: LlmMessage; calls: RecordedCalls }> {
    const past = await this.prisma.agentRun.findFirst({ where: { id: runId, ticketId } });
    const messages = (past?.inputSnapshot as { messages?: LlmMessage[] } | null)?.messages;
    const ticketMessage = messages?.find((m) => m.role === 'user');
    if (!past || !ticketMessage) {
      throw new Error(`Run ${runId} has no stored input to replay`);
    }
    // That run's calls and the stored facts it relied on: successful calls of this and earlier runs, the newest first.
    const steps = await this.prisma.agentStep.findMany({
      where: { kind: 'tool', error: null, run: { ticketId, OR: [{ id: past.id }, { createdAt: { lt: past.createdAt } }] } },
      orderBy: [{ createdAt: 'desc' }, { index: 'desc' }],
    });
    const calls = steps
      .filter((s) => typeof (s.input as IntegrationStepInput | null)?.integrationId === 'string')
      .map((s) => ({ input: s.input as unknown as IntegrationStepInput, output: s.output }));
    return { at: past.createdAt, ticketMessage, calls };
  }

  private async checkCancel(ticketId: string, controller: AbortController): Promise<void> {
    if (!controller.signal.aborted && (await this.redis.get(cancelKey(ticketId))) !== null) {
      controller.abort();
    }
  }

  private async saveStep(runId: string, index: number, step: RunnerStep): Promise<void> {
    await this.prisma.agentStep.create({
      data: {
        id: newId(),
        runId,
        index,
        kind: step.kind,
        name: step.name,
        input: json(step.input ?? null),
        output: json(step.output ?? null),
        error: step.error,
        tokensIn: step.tokensIn,
        tokensOut: step.tokensOut,
        durationMs: step.durationMs,
      },
    });
  }
}

export function computeCost(model: LlmModel | undefined, usage: { input: number; output: number }): { cost: number | null; currency: string | null } {
  if (!model || (model.inputPerMillion === undefined && model.outputPerMillion === undefined)) {
    return { cost: null, currency: null };
  }
  const cost = (usage.input * (model.inputPerMillion ?? 0) + usage.output * (model.outputPerMillion ?? 0)) / 1_000_000;
  return { cost: Math.round(cost * 1_000_000) / 1_000_000, currency: model.currency ?? 'USD' };
}

export function toRunDto(run: AgentRun & { configVersion?: { number: number } | null }): AgentRunDto {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    dryRun: run.dryRun,
    trigger: run.trigger as AgentRunDto['trigger'],
    model: run.model,
    configVersion: run.configVersion?.number ?? null,
    error: run.error,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    cost: run.cost,
    currency: run.currency,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
