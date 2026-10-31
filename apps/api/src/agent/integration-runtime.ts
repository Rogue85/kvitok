import { Injectable, Logger } from '@nestjs/common';
import { IntegrationError, type ActionDefinition, type ContextResponse, type Manifest, type ToolDefinition } from '@kvitok/protocol';
import { stableStringify } from '../common/stable-json';
import type { Integration } from '../generated/prisma/client';
import { CustomerLinksService, type CustomerWithIdentities } from '../integrations/customer-links.service';
import { IntegrationsService, parseStoredManifest } from '../integrations/integrations.service';
import type { LlmTool } from '../llm/llm.types';
import { PrismaService } from '../prisma/prisma.service';
import type { RunnerStep } from './agent-runner';
import { READ_PLAYBOOK, SUBMIT_RESULT } from './submit-schema';

/** Within this period the customer card is taken from the previous run, without a request to the backend. */
export const CONTEXT_TTL_SECONDS = 300;
/** A longer tool response — the model gets the beginning with a truncation note. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** Facts live no longer than a day, whatever cache_ttl_seconds is. */
const MAX_FACT_AGE_MS = 24 * 60 * 60 * 1000;
const RESERVED_TOOLS = new Set([SUBMIT_RESULT, READ_PLAYBOOK, 'propose_action']);

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
    | { status: 'found'; displayName: string | null; source: string }
    | { status: 'not_found'; identities: Record<string, string> }
    | { status: 'ambiguous'; candidates: Array<{ displayName: string; hint: string | null }> }
    | { status: 'no_customer' }
    | { status: 'error'; error: string };
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
  ) {}

  async prepare(
    ticket: { id: string; workspaceId: string; customer: CustomerWithIdentities | null },
    options: { now?: Date; record: (step: RunnerStep) => Promise<void> },
  ): Promise<{ views: IntegrationView[]; executor: ToolExecutor }> {
    const now = options.now ?? new Date();
    const rows = await this.prisma.integration.findMany({ where: { workspaceId: ticket.workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    const active = rows.flatMap((row) => {
      const manifest = parseStoredManifest(row);
      return manifest ? [{ row, manifest }] : [];
    });
    if (active.length === 0) {
      return { views: [], executor: { has: () => false, execute: () => Promise.reject(new Error('no tools')), proposals: () => [] } };
    }

    const previous = await this.previousSteps(ticket.id, now);
    const bindings = new Map<string, ToolBinding>();
    const exposedNames = toolNames(active.map((a) => a.manifest));
    const views: IntegrationView[] = [];

    for (const { row, manifest } of active) {
      const view: IntegrationView = { id: row.id, title: manifest.title, customer: { status: 'no_customer' }, context: null, contextError: null, facts: [], tools: [], hiddenTools: [] };
      let customerRef: string | null = null;

      if (ticket.customer) {
        try {
          const { link, call } = await this.links.ensure(ticket.customer, row, manifest, now);
          if (call) {
            await options.record(integrationStep({ integrationId: row.id, call: 'resolve', identities: call.identities }, call.result, call.error, call.durationMs, 'resolve_customer'));
          }
          if (!link) view.customer = { status: 'error', error: call?.error ?? 'no response' };
          else if (link.status === 'found') {
            customerRef = link.customerRef;
            view.customer = { status: 'found', displayName: link.displayName, source: link.source };
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
        if (cached) {
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

      for (const tool of manifest.tools) {
        const name = exposedNames.get(`${manifest.name}:${tool.name}`)!;
        if (tool.requires_customer && !customerRef) {
          view.hiddenTools.push(name);
          continue;
        }
        bindings.set(name, { kind: 'tool', integration: row, tool, customerRef: tool.requires_customer ? customerRef : null });
        view.tools.push({
          name,
          description: `${tool.title}. ${tool.description}${active.length > 1 ? ` (data from "${manifest.title}")` : ''}`.slice(0, 1024),
          parameters: tool.input_schema,
        });
      }
      // Actions are always about a specific customer: without one there is nothing to propose.
      for (const action of manifest.actions) {
        const name = exposedNames.get(`${manifest.name}:action:${action.name}`)!;
        if (!customerRef) {
          view.hiddenTools.push(name);
          continue;
        }
        bindings.set(name, { kind: 'action', integration: row, action, customerRef });
        view.tools.push({
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
      views.push(view);
    }

    return { views, executor: this.executor(bindings) };
  }

  private executor(bindings: Map<string, ToolBinding>): ToolExecutor {
    const proposals = new Map<string, PendingProposal>();
    return {
      has: (name) => bindings.has(name),
      proposals: () => [...proposals.values()],
      execute: async (name, args) => {
        const binding = bindings.get(name)!;
        if (binding.kind === 'action') {
          return this.propose(binding, args, proposals);
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
          const result = await this.integrations.client(binding.integration).callTool(binding.tool.name, binding.customerRef, args);
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
      const result = await this.integrations.client(binding.integration).validate(binding.action.name, binding.customerRef, params);
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

  /** Successful integration calls in earlier runs of this ticket — newest first. */
  private async previousSteps(ticketId: string, now: Date) {
    const steps = await this.prisma.agentStep.findMany({
      where: { run: { ticketId }, kind: 'tool', error: null, createdAt: { gte: new Date(now.getTime() - MAX_FACT_AGE_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { input: true, output: true, createdAt: true },
    });
    return steps
      .filter((s): s is typeof s & { input: IntegrationStepInput } => isPlainObject(s.input) && typeof (s.input as Record<string, unknown>).integrationId === 'string')
      .map((s) => ({ input: s.input, output: s.output, createdAt: s.createdAt }));
  }
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
