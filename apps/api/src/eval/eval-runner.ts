import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Scenario } from '@kvitok/coffee-sim';
import type { TicketAnalysis } from '@kvitok/shared';
import { AgentEngine } from '../agent/agent-engine';
import { AgentSettingsService } from '../agent/agent-settings.service';
import { ConfigSnapshotService } from '../agent/config-snapshot.service';
import { CORE_PROMPT_VERSION } from '../agent/core-prompt';
import { LlmProvidersService } from '../agent/llm-providers.service';
import { PlaybooksService } from '../agent/playbooks.service';
import { ChannelsService } from '../channels/channels.service';
import { newId } from '../common/ids';
import { DepartmentsService } from '../departments/departments.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { scoreScenario, summarize, type EvalReport, type ScenarioExpectation, type ScenarioOutcome, type ScenarioScore } from './compare';

/** A provider from environment variables (CI): the key comes from secrets. */
export interface EnvProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  /** The currency the prices are in; becomes the evaluation workspace currency. */
  currency?: string;
}

export interface EvalRunOptions {
  scenarios: Scenario[];
  /** A simulator started by the caller: address, secret and the scenario ticket body. */
  sim: { url: string; secret: string; ingestPayload: (scenario: Scenario) => Record<string, unknown> };
  /** Language of the simulator scenarios, for the report. */
  locale?: string;
  /** The workspace providing the policy, settings, departments, playbooks and provider — the "configuration under evaluation". */
  settingsFrom?: string;
  provider?: EnvProvider;
  /** Another model of the same provider. */
  model?: string;
  /** A throwaway evaluation workspace; recreated. Only with the eval prefix. */
  workspaceSlug?: string;
  concurrency?: number;
  /** How many times to run each scenario: the model is nondeterministic. */
  repeat?: number;
  /** Do not start new scenarios once more than this has been spent (in the workspace currency). */
  budget?: number;
  onProgress?: (score: ScenarioScore, done: number, total: number) => void;
}

/**
 * An evaluation run: a throwaway workspace with the agent configuration from settingsFrom (or an env provider),
 * an integration with the simulator, scenario tickets via ingest, analysis by the agent and comparison with the expectation.
 * The agent is disabled in the workspace — the run itself analyzes the tickets, workers leave them alone.
 */
export class EvalRunner {
  private readonly prisma: PrismaService;

  constructor(private readonly app: NestFastifyApplication) {
    this.prisma = app.get(PrismaService);
  }

  async run(options: EvalRunOptions): Promise<EvalReport> {
    const startedAt = new Date().toISOString();
    const slug = options.workspaceSlug ?? 'eval';
    if (!slug.startsWith('eval')) throw new Error('The evaluation workspace is recreated, so its slug must start with eval');
    if (!options.settingsFrom && !options.provider) throw new Error('Either --from <workspace> or a provider from the EVAL_LLM_* variables is required');

    const setup = await this.prepareWorkspace(slug, options);
    // All scenarios once first, then the repeats — repeats of one scenario do not run in parallel.
    const repeat = Math.max(1, options.repeat ?? 1);
    const queue = Array.from({ length: repeat }, (_, i) => options.scenarios.map((scenario) => ({ scenario, attempt: i + 1 }))).flat();
    const scores: ScenarioScore[] = new Array(queue.length);
    let spent = 0;
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const index = next++;
        const { scenario, attempt } = queue[index]!;
        const outcome = options.budget !== undefined && spent >= options.budget ? skipped() : await this.runScenario(scenario, attempt, setup, options);
        spent += outcome.cost ?? 0;
        scores[index] = scoreScenario(toExpectation(scenario), outcome, attempt);
        options.onProgress?.(scores[index]!, ++done, queue.length);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));

    const { version, snapshot } = await this.app.get(ConfigSnapshotService).resolve(setup.workspaceId);
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      config: {
        model: options.model ?? snapshot.settings.model,
        provider: snapshot.provider?.name ?? null,
        configHash: version.hash,
        corePromptVersion: CORE_PROMPT_VERSION,
        source: options.settingsFrom ?? 'env',
        locale: options.locale,
      },
      summary: summarize(scores),
      scores,
    };
  }

  private async prepareWorkspace(slug: string, options: EvalRunOptions) {
    const prisma = this.prisma;
    const source = options.settingsFrom ? await prisma.workspace.findUnique({ where: { slug: options.settingsFrom } }) : null;
    if (options.settingsFrom && !source) throw new Error(`No workspace "${options.settingsFrom}"`);

    await prisma.workspace.deleteMany({ where: { slug } });
    // Model prices are in the workspace currency: the source's, or the one the env prices are in.
    const currency = source?.currency ?? options.provider?.currency ?? 'USD';
    const workspace = await prisma.workspace.create({ data: { id: newId(), name: 'Agent evaluation', slug, currency } });
    const workspaceId = workspace.id;

    // So the result of the last run can be opened in the interface.
    const members = source
      ? await prisma.membership.findMany({ where: { workspaceId: source.id } })
      : (await prisma.user.findMany({ where: { isSuperadmin: true } })).map((u) => ({ userId: u.id, role: 'admin' as const }));
    if (members.length) {
      await prisma.membership.createMany({ data: members.map((m) => ({ workspaceId, userId: m.userId, role: m.role })) });
    }

    const settings = this.app.get(AgentSettingsService);
    let providerId: string;
    let model: string | null;
    if (source) {
      const from = await settings.get(source.id);
      if (!from.providerId || !from.model) throw new Error(`"${options.settingsFrom}" has no agent provider or model selected`);
      const provider = await prisma.llmProvider.findUniqueOrThrow({ where: { id: from.providerId } });
      // A copy of the row with the already encrypted key: the key is never decrypted and never leaves the database.
      providerId = newId();
      await prisma.llmProvider.create({
        data: { id: providerId, workspaceId, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, secrets: provider.secrets, models: provider.models ?? [], capabilities: provider.capabilities ?? {} },
      });
      model = from.model;
      await settings.update(workspaceId, {
        policy: from.policy,
        playbookMode: from.playbookMode as 'on_demand' | 'inline',
        maxToolCalls: from.maxToolCalls,
        maxOutputTokens: from.maxOutputTokens,
        temperature: from.temperature,
        confidenceThreshold: from.confidenceThreshold,
      });
      const playbooks = this.app.get(PlaybooksService);
      for (const p of await prisma.playbook.findMany({ where: { workspaceId: source.id, source: 'ui', enabled: true } })) {
        await playbooks.create(workspaceId, { key: p.key, title: p.title, when: p.when, body: p.body, departmentId: null, enabled: true });
      }
    } else {
      const env = options.provider!;
      providerId = (
        await this.app.get(LlmProvidersService).create(workspaceId, {
          name: env.name,
          baseUrl: env.baseUrl,
          apiKey: env.apiKey,
          models: [{ id: env.model, inputPerMillion: env.inputPerMillion, outputPerMillion: env.outputPerMillion }],
        })
      ).id;
      model = env.model;
    }
    await settings.update(workspaceId, { enabled: false, providerId, model: options.model ?? model });

    const integrations = this.app.get(IntegrationsService);
    const { integration, sync } = await integrations.create(workspaceId, { name: 'Simulator', baseUrl: options.sim.url, secret: options.sim.secret });
    if (sync.status === 'error') throw new Error(`The simulator did not return a manifest: ${sync.error}`);

    // Departments come from the "configuration under evaluation"; missing expectation keys come from the simulator manifest.
    const departments = this.app.get(DepartmentsService);
    const keys = new Set<string>();
    if (source) {
      for (const d of (await departments.list(source.id)).filter((d) => !d.archived)) {
        await departments.create(workspaceId, { key: d.key, title: d.title, description: d.description, examples: d.examples, instructions: d.instructions, isTriage: d.isTriage });
        keys.add(d.key);
      }
    }
    const suggested = integration.manifest?.suggestedDepartments ?? [];
    for (const key of new Set(options.scenarios.flatMap((s) => [s.expect.department].flat()))) {
      if (keys.has(key)) continue;
      const fromManifest = suggested.find((d) => d.key === key);
      await departments.create(workspaceId, fromManifest ? { key, title: fromManifest.title, description: fromManifest.description, examples: fromManifest.examples } : { key, title: key === 'triage' ? 'Triage' : key, isTriage: key === 'triage' });
      keys.add(key);
    }
    // Playbooks could reference departments that did not exist at sync time.
    await integrations.sync(workspaceId, integration.id, { force: true });

    const { channel, apiKey } = await this.app.get(ChannelsService).create(workspaceId, { type: 'api', name: 'Scenarios', metadataMapping: {}, webhookUrl: null });
    return { workspaceId, channelId: channel.id, apiKey: apiKey!, currency };
  }

  private async runScenario(
    scenario: Scenario,
    attempt: number,
    setup: { channelId: string; apiKey: string; currency: string },
    options: EvalRunOptions,
  ): Promise<ScenarioOutcome> {
    const started = Date.now();
    const payload = options.sim.ingestPayload(scenario);
    // A repeat is a separate ticket: without a suffix ingest would return the same one by external_id.
    if (attempt > 1) payload.external_id = `${String(payload.external_id)}#${attempt}`;
    const response = await this.app.inject({
      method: 'POST',
      url: `/api/v1/ingest/${setup.channelId}`,
      headers: { authorization: `Bearer ${setup.apiKey}` },
      payload,
    });
    if (response.statusCode >= 300) {
      return { ...skipped(), status: 'failed', error: `ingest ${response.statusCode}: ${response.body.slice(0, 300)}` };
    }
    const ticketId = response.json<{ ticket_id: string }>().ticket_id;
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const { run } = await this.app.get(AgentEngine).execute({
      ticketId,
      mode: 'triage',
      triggers: [{ type: 'manual' }],
      inputRevision: ticket.revision,
      ...(options.model ? { override: { model: options.model } } : {}),
    });

    const [after, proposals, steps] = await Promise.all([
      this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { department: true } }),
      this.prisma.actionProposal.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.agentStep.findMany({ where: { runId: run.id, kind: 'tool' }, orderBy: { index: 'asc' }, select: { name: true } }),
    ]);
    const analysis = after.analysis as unknown as TicketAnalysis | null;
    return {
      status: run.status === 'applied' || run.status === 'stale' || run.status === 'cancelled' ? run.status : 'failed',
      error: run.error,
      department: after.department?.key ?? null,
      agentDepartment: analysis?.department ?? null,
      confidence: analysis?.confidence ?? null,
      needsHuman: analysis?.needsHuman ?? null,
      summary: analysis?.summary ?? null,
      actions: proposals.map((p) => ({
        type: p.action,
        params: ((p.normalizedParams ?? p.params) as Record<string, unknown>) ?? {},
        preview: p.preview,
        reason: p.reason,
      })),
      tools: steps.map((s) => s.name ?? '?'),
      tokensIn: run.tokensIn ?? 0,
      tokensOut: run.tokensOut ?? 0,
      cost: run.cost === null ? null : Number(run.cost),
      currency: setup.currency,
      durationMs: Date.now() - started,
    };
  }
}

function toExpectation(scenario: Scenario): ScenarioExpectation {
  return {
    id: scenario.id,
    title: scenario.title,
    tags: scenario.tags,
    departments: [scenario.expect.department].flat(),
    actions: scenario.expect.actions.map((a) => ({ type: a.type, params: a.params })),
    forbidActions: scenario.expect.forbid_actions,
    needsHuman: scenario.expect.needs_human,
    note: scenario.expect.note,
  };
}

function skipped(): ScenarioOutcome {
  return {
    status: 'skipped',
    error: null,
    department: null,
    agentDepartment: null,
    confidence: null,
    needsHuman: null,
    summary: null,
    actions: [],
    tools: [],
    tokensIn: 0,
    tokensOut: 0,
    cost: null,
    currency: null,
    durationMs: 0,
  };
}
