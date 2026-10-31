import { t } from '@kvitok/i18n';
import { Inject, Injectable } from '@nestjs/common';
import { ManifestSchema, runConformance, type Manifest } from '@kvitok/protocol';
import { IngestMessageSchema } from '@kvitok/shared';
import { z } from 'zod';
import { AgentService } from '../../agent/agent.service';
import { LlmProvidersService } from '../../agent/llm-providers.service';
import { ChannelsService } from '../../channels/channels.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { errors } from '../../common/errors';
import { DepartmentsService } from '../../departments/departments.service';
import { InboundService } from '../../ingest/inbound.service';
import { IdentificationService } from '../../identification/identification.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { RoutingRulesService } from '../../routing/routing-rules.service';
import { errorText, McpToolError, tool, withoutWorkspace, type ToolSpec } from '../mcp-tool';
import { ReplayService, type ReplayComparison } from '../replay.service';
import { ReadTools } from './read.tools';

const MAX_REPLAY_TICKETS = 10;

const TicketRef = {
  ticketId: z.string().optional().describe('Ticket id.'),
  number: z.number().int().positive().optional().describe('Ticket number, as in #T-123 — instead of ticketId.'),
};

/** Tools that check the configuration on real data without applying anything. */
@Injectable()
export class CheckTools {
  constructor(
    private readonly agent: AgentService,
    private readonly replays: ReplayService,
    private readonly rules: RoutingRulesService,
    private readonly providers: LlmProvidersService,
    private readonly channels: ChannelsService,
    private readonly inbound: InboundService,
    private readonly integrations: IntegrationsService,
    private readonly departments: DepartmentsService,
    private readonly identification: IdentificationService,
    private readonly read: ReadTools,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  specs(): ToolSpec[] {
    return [
      tool({
        name: 'dry_run',
        title: 'Run the agent without applying',
        description:
          'Runs the Kvitok agent on a ticket as it is now, with the current configuration (or another provider or model), and returns its result. ' +
          'Nothing is applied to the ticket. Calls the model (costs money) and the backend read tools.',
        input: z.object({
          ...TicketRef,
          providerId: z.string().optional(),
          model: z.string().optional(),
        }),
        scope: 'config:write',
        role: 'admin',
        run: async ({ ticketId, number, providerId, model }, { workspaceId }) => {
          const id = await this.read.ticketId(workspaceId, { ticketId, number });
          const { run, result } = await this.agent.dryRun(workspaceId, id, { providerId, model });
          return { runId: run.id, status: run.status, error: run.error, configVersion: run.configVersion, cost: run.cost, tokensIn: run.tokensIn, tokensOut: run.tokensOut, result };
        },
      }),
      tool({
        name: 'replay',
        title: 'Replay past runs with the current configuration',
        description:
          "Re-runs the agent's last applied run of each ticket (or the given run) with the current configuration: the agent sees the ticket as it was then, " +
          'and backend results come from that run, so only the configuration differs. Compares department, confidence, needs_human, actions with ' +
          "the operator's decisions, fields and the reply draft (also against the reply the operator actually sent). Nothing is applied. Calls the model for each ticket.",
        input: z.object({
          tickets: z
            .array(z.object(TicketRef).extend({ runId: z.string().optional().describe('A specific past run; by default the last applied one.') }))
            .min(1)
            .max(MAX_REPLAY_TICKETS),
        }),
        scope: 'config:write',
        role: 'admin',
        run: async ({ tickets }, { workspaceId }) => {
          const results: Array<ReplayComparison | { ticket: { ticketId?: string; number?: number }; error: string }> = [];
          for (const ref of tickets) {
            try {
              const ticketId = await this.read.ticketId(workspaceId, ref);
              results.push(await this.replays.replay(workspaceId, await this.replays.pastRun(workspaceId, ticketId, ref.runId)));
            } catch (error) {
              results.push({ ticket: { ticketId: ref.ticketId, number: ref.number }, error: errorText(error, 'replay') });
            }
          }
          return { summary: summarize(results), results };
        },
      }),
      tool({
        name: 'test_rule',
        title: 'Test routing rules on a ticket',
        description: 'Which enabled rules of each stage would match this ticket now, and the values the conditions see. Applies nothing.',
        input: z.object(TicketRef),
        scope: 'read',
        role: 'admin',
        readOnly: true,
        run: async (args, { workspaceId }) => this.rules.test(workspaceId, await this.read.ticketId(workspaceId, args)),
      }),
      tool({
        name: 'check_identification',
        title: 'Check customer identification on a ticket',
        description:
          "Applies the current identification rules and the integrations' identity patterns to the ticket's last customer message: which rules matched, who the customer would be, which identities would be taken and how far they are trusted. Writes nothing.",
        input: z.object(TicketRef),
        scope: 'read',
        role: 'admin',
        readOnly: true,
        run: async (args, { workspaceId }) => this.identification.check(workspaceId, await this.read.ticketId(workspaceId, args)),
      }),
      tool({
        name: 'test_llm_provider',
        title: 'Check an LLM provider',
        description: 'A short request to the model through the provider: checks the address, the key and the model name.',
        input: z.object({ providerId: z.string(), model: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: ({ providerId, model }, { workspaceId }) => this.providers.test(workspaceId, providerId, model),
      }),
      tool({
        name: 'ingest_ticket',
        title: 'Create a test ticket',
        description:
          'Sends a message through an API channel as a source would (POST /api/v1/ingest): routing rules and the agent run as for a real ticket. ' +
          'For test workspaces: write the text yourself or take it from simulator scenarios, never copy real customer messages. ' +
          'The same external_id twice does not create a duplicate; conversation_external_id appends to an existing ticket.',
        input: IngestMessageSchema.safeExtend({ channelId: z.string() }),
        scope: 'tickets:ingest',
        role: 'admin',
        run: async ({ channelId, ...args }, { workspaceId }) => {
          const channel = await this.channels.get(workspaceId, channelId);
          if (channel.type !== 'api') {
            throw errors.validation([{ path: 'channelId', message: t('api.keyOnlyForApiChannel'), code: 'custom' }]);
          }
          if (!channel.enabled) throw errors.forbidden(t('api.channelDisabled'));
          const result = await this.inbound.receiveApi(channel, withoutWorkspace(args));
          return { ticketId: result.ticketId, number: result.ticketNumber, duplicate: result.duplicate, rejectedFields: result.rejectedFields };
        },
      }),
      tool({
        name: 'validate_manifest',
        title: 'Validate a backend manifest',
        description:
          'Checks a manifest against the protocol schema and gives quality hints for the agent: missing descriptions, examples, instructions, ' +
          'parameter descriptions, playbooks pointing at unknown departments. Pass the manifest JSON, or integrationId to fetch it from the backend ' +
          '(the stored one is checked if the backend does not answer).',
        input: z.object({
          manifest: z.unknown().optional().describe('The JSON returned by GET /manifest.'),
          integrationId: z.string().optional(),
        }),
        scope: 'read',
        role: 'viewer',
        readOnly: true,
        run: async ({ manifest, integrationId }, { workspaceId }) => {
          let raw = manifest;
          const notes: string[] = [];
          if (raw === undefined) {
            if (!integrationId) throw new McpToolError('Pass manifest or integrationId.');
            const integration = await this.integrations.get(workspaceId, integrationId);
            try {
              const fetched = await this.integrations.client(integration).manifest(null);
              raw = fetched.notModified ? integration.manifest : fetched.manifest;
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (integration.manifest === null) throw new McpToolError(`The backend did not return the manifest: ${reason}`);
              raw = integration.manifest;
              notes.push(`The backend did not answer (${reason}); the manifest stored at the last sync was checked.`);
            }
          }
          const parsed = ManifestSchema.safeParse(raw);
          if (!parsed.success) {
            return { valid: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), hints: [], notes };
          }
          const departments = await this.departments.list(workspaceId);
          return { valid: true, errors: [], hints: manifestHints(parsed.data, new Set(departments.map((d) => d.key))), notes };
        },
      }),
      tool({
        name: 'run_conformance',
        title: 'Run the protocol conformance suite',
        description:
          'Checks a backend implementation from the Kvitok server: manifest schema, signatures, unknown tools and actions, customer resolve, tool and context ' +
          'responses, argument validation and, with execute: true, idempotent execution (this really executes actions — staging with a test customer only). ' +
          'The backend must be reachable from the Kvitok server; for a backend on your machine run `PROTOCOL_SECRET=… pnpm --filter @kvitok/protocol conformance --profile profile.json` from a Kvitok checkout instead.',
        input: z.object({
          baseUrl: z.url({ protocol: /^https?$/ }),
          secret: z.string().min(16),
          customerIdentities: z.record(z.string(), z.string()).describe('Identities of an existing test customer, e.g. {"phone": "79000000001"}.'),
          tools: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('Tool arguments; by default the first manifest example.'),
          actions: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('Action parameters; by default the first manifest example.'),
          execute: z.boolean().default(false),
        }),
        scope: 'integrations:write',
        role: 'admin',
        run: ({ baseUrl, secret, customerIdentities, tools, actions, execute }) =>
          runConformance({ baseUrl, secret, customer: { identities: customerIdentities }, tools, actions, execute, timeoutMs: this.config.integrationTimeoutMs }),
      }),
    ];
  }
}

function summarize(results: Array<ReplayComparison | { error: string }>) {
  const done = results.filter((r): r is ReplayComparison => !('error' in r));
  const matches = (r: ReplayComparison, which: 'before' | 'after') => r.department.operatorFinal !== null && r.department[which] === r.department.operatorFinal;
  return {
    replayed: done.length,
    failed: results.length - done.length,
    departmentChanged: done.filter((r) => r.department.before !== r.department.after).length,
    departmentMatchesOperator: { before: done.filter((r) => matches(r, 'before')).length, after: done.filter((r) => matches(r, 'after')).length },
    actionsChanged: done.filter((r) => JSON.stringify(r.actions.before.map(({ operatorDecision: _, ...p }) => p)) !== JSON.stringify(r.actions.after)).length,
    cost: Math.round(done.reduce((sum, r) => sum + (r.replayRun.cost ?? 0), 0) * 10_000) / 10_000,
  };
}

/** What makes a manifest harder for the agent to use, beyond the schema. */
export function manifestHints(manifest: Manifest, departmentKeys: Set<string>): string[] {
  const hints: string[] = [];
  if (!manifest.instructions.trim()) {
    hints.push('instructions is empty: describe how the domain works and how to read the tool data (layer 3 of the prompt).');
  }
  if (manifest.identity_types.length === 0) {
    hints.push('identity_types is empty: list the identities the backend resolves (phone, email, card…) so Kvitok sends only those.');
  }
  for (const tool of manifest.tools) {
    if (tool.description.length < 40) hints.push(`tool ${tool.name}: the description is short — say what it returns and when to call it.`);
    if (tool.examples.length === 0) hints.push(`tool ${tool.name}: no examples — conformance checks and test calls need them.`);
    for (const name of undocumented(tool.input_schema)) hints.push(`tool ${tool.name}: parameter ${name} has no description.`);
  }
  for (const action of manifest.actions) {
    if (action.description.length < 40) hints.push(`action ${action.name}: the description is short — say when it is appropriate and how to compute the parameters.`);
    if (action.examples.length === 0) hints.push(`action ${action.name}: no examples — conformance checks need valid parameters.`);
    for (const name of undocumented(action.input_schema)) hints.push(`action ${action.name}: parameter ${name} has no description.`);
  }
  const suggested = new Set(manifest.suggested_departments.map((d) => d.key));
  for (const playbook of manifest.playbooks) {
    if (playbook.when.length > 300) hints.push(`playbook ${playbook.key}: "when" is long — the agent sees it in the catalog; keep it to one line.`);
    const department = playbook.suggested_department;
    if (department && !suggested.has(department) && !departmentKeys.has(department)) {
      hints.push(`playbook ${playbook.key}: suggested_department "${department}" is neither suggested by the manifest nor a department of the workspace.`);
    }
  }
  return hints;
}

function undocumented(schema: Record<string, unknown>): string[] {
  const properties = (schema.properties ?? {}) as Record<string, { description?: unknown }>;
  return Object.entries(properties)
    .filter(([, property]) => typeof property.description !== 'string' || property.description.trim() === '')
    .map(([name]) => name);
}

