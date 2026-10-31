import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  CreateApiChannelSchema,
  CreateDepartmentSchema,
  CreateEmailChannelSchema,
  CreateFieldDefinitionSchema,
  CreateIntegrationSchema,
  CreateLlmProviderSchema,
  CreatePlaybookSchema,
  CreateRoutingRuleSchema,
  CreateWorkspaceSchema,
  FieldEntitySchema,
  ImportDepartmentsSchema,
  UpdateAgentSettingsSchema,
  UpdateChannelSchema,
  UpdateDepartmentSchema,
  UpdateFieldDefinitionSchema,
  UpdateIntegrationSchema,
  UpdateLlmProviderSchema,
  UpdatePlaybookSchema,
  UpdateRoutingRuleSchema,
  UpdateWorkspaceSchema,
  type FieldEntity,
} from '@kvitok/shared';
import { z } from 'zod';
import { AgentSettingsService } from '../../agent/agent-settings.service';
import { LlmProvidersService } from '../../agent/llm-providers.service';
import { PlaybooksService } from '../../agent/playbooks.service';
import { ChannelsService } from '../../channels/channels.service';
import { errors } from '../../common/errors';
import { DepartmentsService } from '../../departments/departments.service';
import { FieldsService } from '../../fields/fields.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { RoutingRulesService } from '../../routing/routing-rules.service';
import { WorkspacesService } from '../../workspaces/workspaces.service';
import { tool, withoutWorkspace, type ToolSpec } from '../mcp-tool';
import { departmentByKey } from './read.tools';

const CHANGES_APPLY =
  'The change applies immediately: the next agent run uses it, and it is recorded in the change log.';

/** Tools that change the configuration. They call the same services as the UI, with the same validation and audit. */
@Injectable()
export class ConfigTools {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly settings: AgentSettingsService,
    private readonly providers: LlmProvidersService,
    private readonly playbooks: PlaybooksService,
    private readonly departments: DepartmentsService,
    private readonly fields: FieldsService,
    private readonly rules: RoutingRulesService,
    private readonly channels: ChannelsService,
    private readonly integrations: IntegrationsService,
  ) {}

  specs(): ToolSpec[] {
    return [
      tool({
        name: 'create_workspace',
        title: 'Create a workspace',
        description: 'A new workspace for a project; you become its admin. Configure it with the other tools, passing its id as workspaceId.',
        input: CreateWorkspaceSchema,
        scope: 'workspaces:create',
        role: null,
        run: (input, { call }) => this.workspaces.create(input, call.auth.user),
      }),
      tool({
        name: 'update_workspace',
        title: 'Rename the workspace',
        description: `Change the workspace name or the language of the customer conversation. ${CHANGES_APPLY}`,
        input: UpdateWorkspaceSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.workspaces.update(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_agent_settings',
        title: 'Change the agent settings',
        description:
          'The support policy (layer 2 of the prompt: tone, what must not be promised, compensation policy, when to ask a human), the provider and model, ' +
          `the confidence threshold for triage, tool-call and token limits, and whether the agent is enabled. Pass only what changes. ${CHANGES_APPLY}`,
        input: UpdateAgentSettingsSchema,
        scope: 'config:write',
        role: 'admin',
        destructive: true,
        run: (input, { workspaceId }) => this.settings.update(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'create_llm_provider',
        title: 'Add an LLM provider',
        description:
          'An OpenAI-compatible endpoint with tool calling (OpenAI, OpenRouter, LiteLLM, vLLM, Ollama). The API key is stored encrypted and never returned. ' +
          'List models with prices per million tokens so run costs are known.',
        input: CreateLlmProviderSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.providers.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_llm_provider',
        title: 'Change an LLM provider',
        description: 'Pass only what changes; omit apiKey to keep the current one.',
        input: UpdateLlmProviderSchema.safeExtend({ providerId: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: ({ providerId, ...input }, { workspaceId }) => this.providers.update(workspaceId, providerId, withoutWorkspace(input)),
      }),
      tool({
        name: 'delete_llm_provider',
        title: 'Delete an LLM provider',
        description: 'A provider used by the agent settings cannot be deleted.',
        input: z.object({ providerId: z.string() }),
        scope: 'config:write',
        role: 'admin',
        destructive: true,
        run: async ({ providerId }, { workspaceId }) => {
          await this.providers.remove(workspaceId, providerId);
          return { deleted: providerId };
        },
      }),
      tool({
        name: 'create_department',
        title: 'Create a department',
        description:
          'A queue of operators. The agent routes by description and examples: describe the customer problems it handles and give 2–5 typical requests ' +
          `(write them yourself, never copy real customer messages). Exactly one department should be the triage one. ${CHANGES_APPLY}`,
        input: CreateDepartmentSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.departments.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_department',
        title: 'Change a department',
        description: `Pass the department key and only what changes; archived: true hides it from routing. ${CHANGES_APPLY}`,
        input: UpdateDepartmentSchema.safeExtend({ department: z.string().describe('Key of the department to change.') }),
        scope: 'config:write',
        role: 'admin',
        run: async ({ department, ...input }, { workspaceId }) => {
          const target = departmentByKey(await this.departments.list(workspaceId), department);
          return this.departments.update(workspaceId, target.id, withoutWorkspace(input));
        },
      }),
      tool({
        name: 'create_field',
        title: 'Create a field',
        description:
          'A ticket or customer field. key and type never change later. agentHint tells the agent how to find and normalize the value; ' +
          `fillMode decides whether the agent may fill it. See kvitok://reference/fields. ${CHANGES_APPLY}`,
        input: CreateFieldDefinitionSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.fields.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_field',
        title: 'Change a field',
        description: `Pass the entity and key of the field and only what changes; key and type cannot change, archived: true retires it. ${CHANGES_APPLY}`,
        input: UpdateFieldDefinitionSchema.safeExtend({ entity: FieldEntitySchema, key: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: async ({ entity, key, ...input }, { workspaceId }) => {
          const field = await this.fieldByKey(workspaceId, entity, key);
          return this.fields.update(workspaceId, field.id, withoutWorkspace(input));
        },
      }),
      tool({
        name: 'create_playbook',
        title: 'Create a playbook',
        description:
          'A scenario for a typical request, written by support. "when" is the one line the agent sees before opening it; make it specific. ' +
          `Domain playbooks that depend on how the backend works belong in the manifest instead. ${CHANGES_APPLY}`,
        input: CreatePlaybookSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.playbooks.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_playbook',
        title: 'Change a playbook',
        description: `Pass the key and only what changes. A playbook from the manifest can only be enabled or disabled here. ${CHANGES_APPLY}`,
        input: UpdatePlaybookSchema.safeExtend({ key: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: async ({ key, ...input }, { workspaceId }) => {
          const playbook = await this.playbookByKey(workspaceId, key);
          return this.playbooks.update(workspaceId, playbook.id, withoutWorkspace(input));
        },
      }),
      tool({
        name: 'delete_playbook',
        title: 'Delete a playbook',
        description: 'Only playbooks created in Kvitok; disable a manifest playbook with update_playbook instead.',
        input: z.object({ key: z.string() }),
        scope: 'config:write',
        role: 'admin',
        destructive: true,
        run: async ({ key }, { workspaceId }) => {
          const playbook = await this.playbookByKey(workspaceId, key);
          await this.playbooks.remove(workspaceId, playbook.id);
          return { deleted: key };
        },
      }),
      tool({
        name: 'create_routing_rule',
        title: 'Create a routing rule',
        description: `A deterministic rule before the agent (on_ingest) or after it (after_agent). See kvitok://reference/routing-rules; check it with test_rule. ${CHANGES_APPLY}`,
        input: CreateRoutingRuleSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.rules.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_routing_rule',
        title: 'Change a routing rule',
        description: `Pass the rule id and only what changes. ${CHANGES_APPLY}`,
        input: UpdateRoutingRuleSchema.safeExtend({ ruleId: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: ({ ruleId, ...input }, { workspaceId }) => this.rules.update(workspaceId, ruleId, withoutWorkspace(input)),
      }),
      tool({
        name: 'delete_routing_rule',
        title: 'Delete a routing rule',
        description: 'Prefer update_routing_rule with enabled: false when the rule may be needed again.',
        input: z.object({ ruleId: z.string() }),
        scope: 'config:write',
        role: 'admin',
        destructive: true,
        run: async ({ ruleId }, { workspaceId }) => {
          await this.rules.remove(workspaceId, ruleId);
          return { deleted: ruleId };
        },
      }),
      tool({
        name: 'create_api_channel',
        title: 'Create an API channel',
        description:
          'A source that sends tickets to POST /api/v1/ingest/{channelId}. The channel key is returned once — hand it to whoever configures the source. ' +
          'webhookUrl receives replies and status changes, signed with a secret that is also returned once.',
        input: CreateApiChannelSchema.omit({ type: true }),
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.channels.create(workspaceId, { type: 'api', ...withoutWorkspace(input) }),
      }),
      tool({
        name: 'create_mailbox',
        title: 'Create a mailbox',
        description:
          'An email channel. transport "sandbox" is a test mailbox: emails stay in Kvitok and never leave it — use it for test workspaces. ' +
          'For "smtp" pass smtp (and imap for incoming mail); passwords are stored encrypted and never returned. Pass type: "email".',
        input: CreateEmailChannelSchema,
        scope: 'config:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.channels.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_channel',
        title: 'Change a channel',
        description: 'Pass the channel id and only what changes; omit passwords to keep the current ones.',
        input: UpdateChannelSchema.safeExtend({ channelId: z.string() }),
        scope: 'config:write',
        role: 'admin',
        run: ({ channelId, ...input }, { workspaceId }) => this.channels.update(workspaceId, channelId, withoutWorkspace(input)),
      }),
      tool({
        name: 'connect_integration',
        title: 'Connect a backend',
        description:
          'A backend speaking the Support Action Protocol (kvitok://docs/protocol). Kvitok fetches the manifest right away; its playbooks appear as manifest playbooks, ' +
          'its suggested departments can be created with import_departments. The secret is stored encrypted and never returned.',
        input: CreateIntegrationSchema,
        scope: 'integrations:write',
        role: 'admin',
        run: (input, { workspaceId }) => this.integrations.create(workspaceId, withoutWorkspace(input)),
      }),
      tool({
        name: 'update_integration',
        title: 'Change an integration',
        description: 'Pass the integration id and only what changes; enabled: false removes its knowledge and playbooks from the prompt.',
        input: UpdateIntegrationSchema.safeExtend({ integrationId: z.string() }),
        scope: 'integrations:write',
        role: 'admin',
        run: ({ integrationId, ...input }, { workspaceId }) => this.integrations.update(workspaceId, integrationId, withoutWorkspace(input)),
      }),
      tool({
        name: 'sync_integration',
        title: 'Sync the manifest',
        description: 'Fetch the backend manifest now, for example after changing its instructions or playbooks in the backend repository.',
        input: z.object({ integrationId: z.string(), force: z.boolean().default(false).describe('Ignore the ETag and load the whole manifest.') }),
        scope: 'integrations:write',
        role: 'admin',
        run: ({ integrationId, force }, { workspaceId }) => this.integrations.sync(workspaceId, integrationId, { force }),
      }),
      tool({
        name: 'import_departments',
        title: 'Import suggested departments',
        description: 'Create departments the manifest suggests, by key; existing departments are left alone.',
        input: ImportDepartmentsSchema.safeExtend({ integrationId: z.string() }),
        scope: 'integrations:write',
        role: 'admin',
        run: ({ integrationId, keys }, { workspaceId }) => this.integrations.importDepartments(workspaceId, integrationId, keys),
      }),
      tool({
        name: 'remove_integration',
        title: 'Remove an integration',
        description: 'Removes the integration and its manifest playbooks. Prefer update_integration with enabled: false.',
        input: z.object({ integrationId: z.string() }),
        scope: 'integrations:write',
        role: 'admin',
        destructive: true,
        run: async ({ integrationId }, { workspaceId }) => {
          await this.integrations.remove(workspaceId, integrationId);
          return { deleted: integrationId };
        },
      }),
    ];
  }

  private async fieldByKey(workspaceId: string, entity: FieldEntity, key: string) {
    const field = (await this.fields.list(workspaceId, entity)).find((f) => f.key === key);
    if (!field) throw errors.notFound(t('api.fieldNotFound'));
    return field;
  }

  private async playbookByKey(workspaceId: string, key: string) {
    const playbook = (await this.playbooks.list(workspaceId)).find((p) => p.key === key);
    if (!playbook) throw errors.notFound(t('api.playbookNotFound'));
    return playbook;
  }
}
