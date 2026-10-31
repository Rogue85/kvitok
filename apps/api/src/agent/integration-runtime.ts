import { Injectable, Logger } from '@nestjs/common';
import { IntegrationError, type ActionDefinition, type IntegrationClient, type ContextResponse, type Manifest, type ToolDefinition } from '@kvitok/protocol';
import { normalizeIdentity } from '@kvitok/shared';
import { stableStringify } from '../common/stable-json';
import { FieldsService } from '../fields/fields.service';
import type { Integration } from '../generated/prisma/client';
import { IdentificationService } from '../identification/identification.service';
import { occursIn } from '../identification/identify';
import type { ClaimOutcome } from '../integrations/claim-policy';
import { applyContextFields } from '../integrations/context-fields';
import { CustomerLinksService, type CustomerWithIdentities } from '../integrations/customer-links.service';
import { IntegrationsService, parseStoredManifest } from '../integrations/integrations.service';
import type { LlmTool } from '../llm/llm.types';
import { PrismaService } from '../prisma/prisma.service';
import type { RunnerStep } from './agent-runner';
import { escapeUntrusted } from './context-assembler';
import { READ_PLAYBOOK, SUBMIT_RESULT } from './submit-schema';

/** Within this period the customer card is taken from the previous run, without a request to the backend. */
export const CONTEXT_TTL_SECONDS = 300;
/** A longer tool response — the model gets the beginning with a truncation note. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** Facts live no longer than a day, whatever cache_ttl_seconds is. */
const MAX_FACT_AGE_MS = 24 * 60 * 60 * 1000;
/** A service tool: find the customer by an identity from the messages. */
export const IDENTIFY_CUSTOMER = 'identify_customer';
const MAX_IDENTIFY_CALLS = 3;
const RESERVED_TOOLS = new Set([SUBMIT_RESULT, READ_PLAYBOOK, IDENTIFY_CUSTOMER, 'propose_action']);

/** What goes into the step input when the agent or the engine calls an integration. */
export interface IntegrationStepInput {
  integrationId: string;
  call: 'resolve' | 'context' | 'tool' | 'validate';
  tool?: string;
  action?: string;
  args?: Record<string, unknown>;
  customerRef?: string | null;
  identities?: Record<string, string>;
}

/** Integration calls of a past run: a replay takes their results instead of asking the backend again. */
export type RecordedCalls = Array<{ input: IntegrationStepInput; output: unknown }>;

/** Previously fetched data that does not need to be requested again yet. */
export interface IntegrationFact {
  /** The tool name as the model sees it. */
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  fetchedAt: Date;
  expiresAt: Date;
}

/** Everything about integrations ContextAssembler needs: data only, no calls. */
export interface IntegrationView {
  id: string;
  title: string;
  customer:
    | { status: 'found'; displayName: string | null; source: string; confirmed: boolean; matchedBy: string[] }
    | { status: 'not_found'; identities: Record<string, string> }
    | { status: 'ambiguous'; candidates: Array<{ displayName: string; hint: string | null }> }
    | { status: 'no_customer' }
    | { status: 'error'; error: string };
  /** A decision about the customer waits for the operator in the timeline (a suggestion, a conflict, candidates). */
  pendingDecision: 'suggestion' | 'conflict' | 'candidates' | 'confirm' | null;
  /** Values from the messages that were checked and found nobody: "card 700012345". */
  notFoundClaims: Array<{ type: string; value: string }>;
  context: { data: ContextResponse; fetchedAt: Date } | null;
  contextError: string | null;
  facts: IntegrationFact[];
  tools: LlmTool[];
  /** Tools that need a customer and are therefore hidden. */
  hiddenTools: string[];
}

export interface ToolExecution {
  content: string;
  stepInput: IntegrationStepInput;
  stepOutput: unknown;
  error: string | null;
}

/** An action proposal that passed validate: stored together with applying the analysis. */
export interface PendingProposal {
  integrationId: string;
  action: string;
  title: string;
  customerRef: string;
  params: Record<string, unknown>;
  normalizedParams: Record<string, unknown> | null;
  preview: string | null;
  warnings: string[];
  reason: string;
  calculation: string | null;
}

export interface ToolExecutor {
  has(name: string): boolean;
  execute(name: string, args: unknown): Promise<ToolExecution>;
  /** Actions the agent proposed in this run (the last one with the same parameters counts once). */
  proposals(): PendingProposal[];
  /** Tools that became available during the run: the customer was identified, their data and actions are open now. */
  added?(): LlmTool[];
}

type ToolBinding =
  | { kind: 'tool'; integration: Integration; tool: ToolDefinition; customerRef: string | null }
  | { kind: 'action'; integration: Integration; action: ActionDefinition; customerRef: string };

/** Prefix of the action-proposal tools: propose_accrue_points. */
export const PROPOSE_PREFIX = 'propose_';

/**
 * Prepares integrations for an agent run: finds the customer, takes the card (or a fresh one from earlier steps),
 * collects stored facts and the tools available to the model. An integration failure does not fail the run — the agent
 * learns about it from the context.
 */
@Injectable()
export class IntegrationRuntimeService {
  private readonly logger = new Logger(IntegrationRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly links: CustomerLinksService,
    private readonly identification: IdentificationService,
    private readonly fields: FieldsService,
  ) {}

  async prepare(
    ticket: { id: string; workspaceId: string; customer: CustomerWithIdentities | null },
    options: {
      now?: Date;
      record: (step: RunnerStep) => Promise<void>;
      /** A replay of a past run: the customer card, tool results and validations are taken from it when the arguments match. */
      recorded?: RecordedCalls;
      /** Check the ticket's values from messages against the backend and apply the linking policy (default — yes). */
      checkClaims?: boolean;
    },
  ): Promise<{ views: IntegrationView[]; executor: ToolExecutor; serviceTools: LlmTool[] }> {
    const now = options.now ?? new Date();
    const rows = await this.prisma.integration.findMany({ where: { workspaceId: ticket.workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    const active = rows.flatMap((row) => {
      const manifest = parseStoredManifest(row);
      return manifest ? [{ row, manifest }] : [];
    });
    if (active.length === 0) {
      return { views: [], executor: { has: () => false, execute: () => Promise.reject(new Error('no tools')), proposals: () => [] }, serviceTools: [] };
    }

    const previous = await this.previousSteps(ticket.id, now);
    const bindings = new Map<string, ToolBinding>();
    const exposedNames = toolNames(active.map((a) => a.manifest));
    const views: IntegrationView[] = [];

    for (const { row, manifest } of active) {
      const view: IntegrationView = {
        id: row.id,
        title: manifest.title,
        customer: { status: 'no_customer' },
        pendingDecision: null,
        notFoundClaims: [],
        context: null,
        contextError: null,
        facts: [],
        tools: [],
        hiddenTools: [],
      };
      let customerRef: string | null = null;

      if (ticket.customer) {
        try {
          const ensured = await this.links.ensure(ticket.customer, row, manifest, now);
          const { call } = ensured;
          let link = ensured.link;
          if (call) {
            await options.record(integrationStep({ integrationId: row.id, call: 'resolve', identities: call.identities }, call.result, call.error, call.durationMs, 'resolve_customer'));
          }
          if (link && options.checkClaims !== false && !options.recorded) {
            const checked = await this.links.checkClaims(ticket.customer, row, manifest, ticket, now);
            for (const claimCall of checked.calls) {
              await options.record(
                integrationStep({ integrationId: row.id, call: 'resolve', identities: claimCall.identities }, claimCall.result, claimCall.error, claimCall.durationMs, 'resolve_customer'),
              );
            }
            link = checked.link ?? link;
          }
          if (link) {
            view.pendingDecision = (link.pending as { kind?: IntegrationView['pendingDecision'] } | null)?.kind ?? null;
            view.notFoundClaims = await this.prisma.identityClaim.findMany({
              where: { ticketId: ticket.id, status: 'not_found', type: { in: manifest.identity_types.map((i) => i.type) } },
              select: { type: true, value: true },
            });
          }
          if (!link) view.customer = { status: 'error', error: call?.error ?? 'no response' };
          else if (link.status === 'found') {
            customerRef = link.customerRef;
            view.customer = { status: 'found', displayName: link.displayName, source: link.source, confirmed: link.confirmed, matchedBy: link.matchedBy };
          } else if (link.status === 'ambiguous') {
            view.customer = { status: 'ambiguous', candidates: (link.candidates as Array<{ displayName: string; hint: string | null }>) ?? [] };
          } else view.customer = { status: 'not_found', identities: call?.identities ?? {} };
        } catch (error) {
          this.logger.warn(`Customer resolve failed for integration ${row.id}: ${String(error)}`);
          view.customer = { status: 'error', error: String(error) };
        }
      }

      const mine = previous.filter((s) => s.input.integrationId === row.id && (s.input.customerRef ?? null) === customerRef);
      if (customerRef) {
        const cached = mine.find((s) => s.input.call === 'context' && now.getTime() - s.createdAt.getTime() < CONTEXT_TTL_SECONDS * 1000);
        const recordedContext = findRecorded(options.recorded, { integrationId: row.id, call: 'context', customerRef });
        if (recordedContext) {
          view.context = { data: recordedContext.output as ContextResponse, fetchedAt: now };
        } else if (cached) {
          view.context = { data: cached.output as ContextResponse, fetchedAt: cached.createdAt };
        } else {
          const started = Date.now();
          try {
            const data = await this.integrations.client(row).context(customerRef);
            await options.record(integrationStep({ integrationId: row.id, call: 'context', customerRef }, data, null, Date.now() - started, 'get_customer_context'));
            view.context = { data, fetchedAt: now };
          } catch (error) {
            const message = describe(error);
            await options.record(integrationStep({ integrationId: row.id, call: 'context', customerRef }, null, message, Date.now() - started, 'get_customer_context'));
            view.contextError = message;
          }
        }
      }

      // A confirmed customer's attributes from the card go into the customer's fields; a run that only looks writes nothing.
      if (view.context && view.customer.status === 'found' && view.customer.confirmed && customerRef && ticket.customer && options.checkClaims !== false && !options.recorded) {
        await this.writeContextFields(ticket.customer, row, customerRef, view.context.data.fields);
      }

      const seen = new Set<string>();
      for (const step of mine.filter((s) => s.input.call === 'tool')) {
        const tool = manifest.tools.find((t) => t.name === step.input.tool);
        if (!tool) continue;
        const expiresAt = new Date(step.createdAt.getTime() + tool.cache_ttl_seconds * 1000);
        const key = `${tool.name}:${stableStringify(step.input.args ?? {})}`;
        if (expiresAt <= now || seen.has(key)) continue;
        seen.add(key);
        view.facts.push({ tool: exposedNames.get(`${manifest.name}:${tool.name}`)!, args: step.input.args ?? {}, result: step.output, fetchedAt: step.createdAt, expiresAt });
      }

      view.tools.push(...bindTools({ row, manifest, customerRef, exposedNames, bindings, hidden: view.hiddenTools, several: active.length > 1 }));
      views.push(view);
    }

    const added: LlmTool[] = [];
    // The agent can identify the customer by a value from the messages where the customer is not certain yet.
    const identifiable =
      ticket.customer && options.checkClaims !== false && !options.recorded
        ? active.filter((a, i) => a.row.claimLinking !== 'off' && a.manifest.identity_types.length > 0 && needsIdentification(views[i]!))
        : [];
    const identify: IdentifyContext | null =
      identifiable.length > 0
        ? { ticket: { id: ticket.id, workspaceId: ticket.workspaceId, customer: ticket.customer! }, integrations: identifiable, exposedNames, bindings, added, several: active.length > 1, calls: 0, now }
        : null;
    const serviceTools = identify ? [identifyTool(identifiable.map((a) => a.manifest))] : [];
    return { views, executor: this.executor(bindings, options.recorded, identify, added), serviceTools };
  }

  private executor(bindings: Map<string, ToolBinding>, recorded: RecordedCalls | undefined, identify: IdentifyContext | null, added: LlmTool[]): ToolExecutor {
    const proposals = new Map<string, PendingProposal>();
    return {
      has: (name) => bindings.has(name) || (name === IDENTIFY_CUSTOMER && identify !== null),
      proposals: () => [...proposals.values()],
      added: () => added,
      execute: async (name, args) => {
        if (name === IDENTIFY_CUSTOMER && identify) {
          return this.identifyCustomer(identify, args);
        }
        const binding = bindings.get(name)!;
        if (binding.kind === 'action') {
          return this.propose(binding, args, proposals, recorded);
        }
        const stepInput: IntegrationStepInput = {
          integrationId: binding.integration.id,
          call: 'tool',
          tool: binding.tool.name,
          args: isPlainObject(args) ? args : {},
          customerRef: binding.customerRef,
        };
        if (!isPlainObject(args)) {
          return { content: 'Error: the arguments must be a JSON object following the tool schema.', stepInput, stepOutput: null, error: 'invalid arguments' };
        }
        try {
          const replayed = findRecorded(recorded, stepInput)?.output as Awaited<ReturnType<IntegrationClient['callTool']>> | undefined;
          const result = replayed ?? (await this.integrations.client(binding.integration).callTool(binding.tool.name, binding.customerRef, args));
          return { content: truncate(JSON.stringify({ ...(result.summary ? { summary: result.summary } : {}), data: result.data })), stepInput, stepOutput: result, error: null };
        } catch (error) {
          const message = describe(error);
          return { content: `Error: ${message}. Fix the arguments or continue without this data.`, stepInput, stepOutput: null, error: message };
        }
      },
    };
  }

  /** propose_*: validate with the backend right away; errors go back to the agent so it can fix the parameters. */
  private async propose(
    binding: Extract<ToolBinding, { kind: 'action' }>,
    args: unknown,
    proposals: Map<string, PendingProposal>,
    recorded?: RecordedCalls,
  ): Promise<ToolExecution> {
    const input = isPlainObject(args) ? args : {};
    const params = isPlainObject(input.params) ? input.params : null;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const calculation = typeof input.calculation === 'string' && input.calculation.trim() ? input.calculation.trim() : null;
    const stepInput: IntegrationStepInput = {
      integrationId: binding.integration.id,
      call: 'validate',
      action: binding.action.name,
      args: params ?? {},
      customerRef: binding.customerRef,
    };
    if (!params || !reason) {
      return { content: 'Error: params (following the action schema) and reason — why the action is needed — are required.', stepInput, stepOutput: null, error: 'invalid arguments' };
    }
    try {
      const replayed = findRecorded(recorded, stepInput)?.output as Awaited<ReturnType<IntegrationClient['validate']>> | undefined;
      const result = replayed ?? (await this.integrations.client(binding.integration).validate(binding.action.name, binding.customerRef, params));
      if (!result.ok) {
        const errors = result.errors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ');
        return {
          content: `The backend rejected the proposal: ${errors}. Fix the parameters or do not propose this action.`,
          stepInput,
          stepOutput: result,
          error: `validate: ${errors}`.slice(0, 2000),
        };
      }
      const normalized = result.normalized_params ?? params;
      proposals.set(`${binding.integration.id}:${binding.action.name}:${stableStringify(normalized)}`, {
        integrationId: binding.integration.id,
        action: binding.action.name,
        title: binding.action.title,
        customerRef: binding.customerRef,
        params,
        normalizedParams: result.normalized_params ?? null,
        preview: result.preview ?? null,
        warnings: result.warnings,
        reason,
        calculation,
      });
      return {
        content: [
          'Proposal accepted: it goes to the operator for approval together with the analysis.',
          result.preview ? `What will be done: ${result.preview}` : null,
          result.warnings.length ? `Backend warnings: ${result.warnings.join('; ')}` : null,
          result.normalized_params ? `Parameters to be executed: ${JSON.stringify(result.normalized_params)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        stepInput,
        stepOutput: result,
        error: null,
      };
    } catch (error) {
      const message = describe(error);
      return { content: `Action validation error: ${message}.`, stepInput, stepOutput: null, error: message };
    }
  }

  /**
   * identify_customer: the values must occur in the customer's messages (or in an operator's message to the agent — then
   * it is the operator's own identification). They become claims, the backend is searched with the linking policy, and a
   * linked customer's tools and card are available from the next turn.
   */
  private async identifyCustomer(ctx: IdentifyContext, args: unknown): Promise<ToolExecution> {
    const input = isPlainObject(args) ? args : {};
    const raw = isPlainObject(input.identities) ? input.identities : {};
    const evidence = typeof input.evidence === 'string' ? input.evidence.trim().slice(0, 200) : '';
    const stepInput: IntegrationStepInput = { integrationId: ctx.integrations[0]!.row.id, call: 'resolve', identities: {} };
    const fail = (content: string, error: string): ToolExecution => ({ content, stepInput, stepOutput: null, error });

    ctx.calls += 1;
    if (ctx.calls > MAX_IDENTIFY_CALLS) {
      return fail(`Error: ${IDENTIFY_CUSTOMER} was already called ${MAX_IDENTIFY_CALLS} times in this run. Continue without it.`, 'too many calls');
    }
    const definitions = new Map(ctx.integrations.flatMap((a) => a.manifest.identity_types.map((i) => [i.type, i] as const)));
    const identities = Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '' && definitions.has(e[0]));
    if (identities.length === 0) {
      return fail(`Error: pass identities as {type: value} with types from: ${[...definitions.keys()].join(', ')}.`, 'no identities');
    }
    stepInput.identities = Object.fromEntries(identities);

    const messages = await this.prisma.message.findMany({
      where: { ticketId: ctx.ticket.id, OR: [{ authorType: 'customer' }, { authorType: 'operator', visibility: 'internal' }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, authorType: true, subject: true, bodyText: true, bodyClean: true },
    });
    const located: Array<{ type: string; value: string; messageId: string; byOperator: boolean }> = [];
    const missing: string[] = [];
    for (const [type, value] of identities) {
      const mode = definitions.get(type)?.normalize ?? null;
      const message = messages.find((m) => occursIn(type, value, `${m.subject ?? ''}\n${m.bodyClean ?? m.bodyText}`, mode));
      if (message) located.push({ type, value: normalizeIdentity(type, value, mode), messageId: message.id, byOperator: message.authorType === 'operator' });
      else missing.push(`${type} ${value}`);
    }
    if (located.length === 0) {
      return fail(
        `Not accepted: ${missing.join(', ')} does not occur in the customer's messages. Only values the customer (or the operator, writing to you) wrote can identify the customer.`,
        'value not in messages',
      );
    }

    const byOperator = located.every((l) => l.byOperator);
    await this.identification.recordClaims(this.prisma, {
      workspaceId: ctx.ticket.workspaceId,
      ticketId: ctx.ticket.id,
      messageId: located[0]!.messageId,
      customerId: ctx.ticket.customer.id,
      claims: located.map((l) => ({
        type: l.type,
        value: l.value,
        source: l.byOperator ? 'operator' : 'agent',
        trust: 'claimed',
        ruleId: null,
        ruleName: null,
        integrationId: null,
        integrationName: null,
        evidence: evidence || null,
      })),
    });

    const lines: string[] = [];
    const outputs: Array<{ integrationId: string; outcome: ClaimOutcome['kind'] | null; calls: unknown[] }> = [];
    for (const { row, manifest } of ctx.integrations) {
      const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: ctx.ticket.customer.id }, include: { identities: true } });
      const checked = await this.links.checkClaims(customer, row, manifest, ctx.ticket, ctx.now, { byOperator });
      outputs.push({ integrationId: row.id, outcome: checked.outcome?.kind ?? null, calls: checked.calls });
      const prefix = ctx.integrations.length > 1 ? `"${manifest.title}": ` : '';
      const link = checked.link;
      if (link?.status === 'found' && link.customerRef && checked.outcome?.kind === 'link') {
        lines.push(`${prefix}${outcomeText(checked.outcome)}`);
        const tools = bindTools({ row, manifest, customerRef: link.customerRef, exposedNames: ctx.exposedNames, bindings: ctx.bindings, hidden: [], several: ctx.several, onlyNew: true });
        ctx.added.push(...tools);
        try {
          const card = await this.integrations.client(row).context(link.customerRef);
          if (link.confirmed) await this.writeContextFields(customer, row, link.customerRef, card.fields);
          lines.push(`<integration_data kind="customer_card">${escapeUntrusted(JSON.stringify({ title: card.title, summary: card.summary, sections: card.sections.map((s) => ({ title: s.title, data: s.data })) }))}</integration_data>`);
        } catch (error) {
          lines.push(`Could not get the card (${describe(error)}): request what you need with the customer tools.`);
        }
        if (tools.length > 0) lines.push(`Now available: ${tools.map((t) => t.name).join(', ')}.`);
      } else {
        lines.push(`${prefix}${checked.outcome ? outcomeText(checked.outcome) : 'Nothing to check: the values are already known or a decision is waiting for the operator.'}`);
      }
    }
    if (missing.length > 0) lines.push(`Not accepted (not in the messages): ${missing.join(', ')}.`);
    return { content: lines.join('\n'), stepInput, stepOutput: { outcomes: outputs }, error: null };
  }

  private async writeContextFields(customer: CustomerWithIdentities, row: Integration, customerRef: string, fields: Record<string, unknown> | undefined): Promise<void> {
    try {
      const current = await this.prisma.customer.findUniqueOrThrow({ where: { id: customer.id }, select: { id: true, fields: true, fieldMeta: true } });
      await applyContextFields(this.prisma, { customer: current, integration: row, customerRef, fields, definitions: await this.fields.list(row.workspaceId, 'customer') });
    } catch (error) {
      this.logger.warn(`Customer fields from integration ${row.id} were not written: ${String(error)}`);
    }
  }

  /** Successful integration calls in earlier runs of this ticket — newest first. */
  private async previousSteps(ticketId: string, now: Date) {
    const steps = await this.prisma.agentStep.findMany({
      where: { run: { ticketId }, kind: 'tool', error: null, createdAt: { gte: new Date(now.getTime() - MAX_FACT_AGE_MS), lte: now } },
      orderBy: { createdAt: 'desc' },
      select: { input: true, output: true, createdAt: true },
    });
    return steps
      .filter((s): s is typeof s & { input: IntegrationStepInput } => isPlainObject(s.input) && typeof (s.input as Record<string, unknown>).integrationId === 'string')
      .map((s) => ({ input: s.input, output: s.output, createdAt: s.createdAt }));
  }
}

/** A recorded call with the same integration, call, tool or action, customer and arguments. */
function findRecorded(recorded: RecordedCalls | undefined, input: IntegrationStepInput): RecordedCalls[number] | undefined {
  if (!recorded) return undefined;
  const key = recordKey(input);
  return recorded.find((r) => recordKey(r.input) === key);
}

function recordKey(input: IntegrationStepInput): string {
  return stableStringify([input.integrationId, input.call, input.tool ?? null, input.action ?? null, input.customerRef ?? null, input.args ?? {}]);
}

/** Tool names for the model: as in the manifest, but prefixed with the integration on a clash between integrations or with service tools. */
function toolNames(manifests: Manifest[]): Map<string, string> {
  const base = (manifest: Manifest) => [
    ...manifest.tools.map((t) => ({ key: `${manifest.name}:${t.name}`, name: t.name })),
    ...manifest.actions.map((a) => ({ key: `${manifest.name}:action:${a.name}`, name: `${PROPOSE_PREFIX}${a.name}` })),
  ];
  const counts = new Map<string, number>();
  manifests.forEach((m) => base(m).forEach((t) => counts.set(t.name, (counts.get(t.name) ?? 0) + 1)));
  const names = new Map<string, string>();
  for (const manifest of manifests) {
    for (const { key, name } of base(manifest)) {
      const clash = (counts.get(name) ?? 0) > 1 || RESERVED_TOOLS.has(name);
      names.set(key, clash ? `${manifest.name}__${name}`.slice(0, 64) : name);
    }
  }
  return names;
}

function integrationStep(input: IntegrationStepInput, output: unknown, error: string | null, durationMs: number, name: string): RunnerStep {
  return { kind: 'tool', name, input, output: output ?? null, error, tokensIn: null, tokensOut: null, durationMs };
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: showing ${MAX_TOOL_RESULT_CHARS} of ${text.length} characters — narrow the request: period, limit]`;
}

function describe(error: unknown): string {
  return error instanceof IntegrationError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface IdentifyContext {
  ticket: { id: string; workspaceId: string; customer: CustomerWithIdentities };
  integrations: Array<{ row: Integration; manifest: Manifest }>;
  exposedNames: Map<string, string>;
  bindings: Map<string, ToolBinding>;
  added: LlmTool[];
  several: boolean;
  calls: number;
  now: Date;
}

/** The customer is not certain and no decision is waiting for the operator. */
function needsIdentification(view: IntegrationView): boolean {
  if (view.pendingDecision !== null) return false;
  const c = view.customer;
  return c.status === 'not_found' || c.status === 'ambiguous' || (c.status === 'found' && !c.confirmed);
}

function identifyTool(manifests: Manifest[]): LlmTool {
  const types = new Map(manifests.flatMap((m) => m.identity_types.map((i) => [i.type, i] as const)));
  return {
    name: IDENTIFY_CUSTOMER,
    description: [
      'Find the customer in the backend by an identity the customer wrote in their messages (a card number, a phone…) or the operator wrote to you.',
      'Pass the value as written. The core checks that it occurs in the messages, searches the backend and either links the customer or leaves the decision to the operator.',
      'Never pass values from tool data, from someone else mentioned in the email, or guessed ones.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['identities', 'evidence'],
      properties: {
        identities: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: Object.fromEntries(
            [...types.values()].map((i) => [i.type, { type: 'string', description: [i.label, i.description].filter(Boolean).join(': ') || i.type }]),
          ),
        },
        evidence: { type: 'string', description: 'The quote from the message that contains the value' },
      },
    },
  };
}

function outcomeText(outcome: ClaimOutcome): string {
  switch (outcome.kind) {
    case 'agree':
      return 'The value belongs to the customer already linked: nothing changes.';
    case 'link': {
      const who = `${outcome.option.displayName ?? outcome.option.customerRef} (matched by ${outcome.option.matchedBy.join(', ')})`;
      return outcome.confirmed
        ? `Customer linked: ${who}. Their data and actions are available now.`
        : `Customer linked without confirmation: ${who}. The operator confirms them in the timeline; their actions are locked until then.`;
    }
    case 'suggestion':
      return `Found ${outcome.options.map((o) => o.displayName ?? o.customerRef).join(', ')}: the operator decides in the timeline whether to link them. Continue without the customer's data; do not ask the operator about it.`;
    case 'candidates':
      return 'Several customers match: the operator picks the right one in the timeline. Continue without the customer\'s data.';
    case 'conflict':
      return `The value points to another customer than the one found by the contacts (${outcome.options.map((o) => o.displayName ?? o.customerRef).join(' / ')}): the operator decides in the timeline. Do not rely on either customer's data until then.`;
    case 'not_found':
      return 'Nobody found by this value. In the draft reply, ask the customer to check it.';
    case 'ignored':
      return 'Found, but linking by values from messages is off for this integration: the operator links the customer by hand.';
  }
}

/** Tool and action bindings of an integration; without a customer, customer tools and actions are hidden. `onlyNew` — skip already bound names. */
function bindTools(params: {
  row: Integration;
  manifest: Manifest;
  customerRef: string | null;
  exposedNames: Map<string, string>;
  bindings: Map<string, ToolBinding>;
  hidden: string[];
  several: boolean;
  onlyNew?: boolean;
}): LlmTool[] {
  const { row, manifest, customerRef, exposedNames, bindings } = params;
  const tools: LlmTool[] = [];
  for (const tool of manifest.tools) {
    const name = exposedNames.get(`${manifest.name}:${tool.name}`)!;
    if (params.onlyNew && bindings.has(name)) continue;
    if (tool.requires_customer && !customerRef) {
      params.hidden.push(name);
      continue;
    }
    bindings.set(name, { kind: 'tool', integration: row, tool, customerRef: tool.requires_customer ? customerRef : null });
    tools.push({
      name,
      description: `${tool.title}. ${tool.description}${params.several ? ` (data from "${manifest.title}")` : ''}`.slice(0, 1024),
      parameters: tool.input_schema,
    });
  }
  // Actions are always about a specific customer: without one there is nothing to propose.
  for (const action of manifest.actions) {
    const name = exposedNames.get(`${manifest.name}:action:${action.name}`)!;
    if (params.onlyNew && bindings.has(name)) continue;
    if (!customerRef) {
      params.hidden.push(name);
      continue;
    }
    bindings.set(name, { kind: 'action', integration: row, action, customerRef });
    tools.push({
      name,
      description: `Propose to the operator: ${action.title}. ${action.description}\nNothing is executed right away: the backend checks the parameters, the operator approves.`.slice(0, 2048),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['params', 'reason'],
        properties: {
          params: action.input_schema,
          reason: { type: 'string', description: "One sentence for the operator, in the operator's language: why the action is needed" },
          calculation: { type: 'string', description: 'How the number was obtained, e.g. "380 × 5% = 19"' },
        },
      },
    });
  }
  return tools;
}

