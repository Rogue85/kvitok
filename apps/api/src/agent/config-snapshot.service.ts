import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getLocale, type Locale } from '@kvitok/i18n';
import type { AgentSettingsDto, DepartmentDto, FieldDefinitionDto, LlmProviderDto, PlaybookDto } from '@kvitok/shared';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { isUniqueViolation } from '../common/prisma-errors';
import { stableStringify } from '../common/stable-json';
import { DepartmentsService } from '../departments/departments.service';
import { FieldsService } from '../fields/fields.service';
import type { AgentConfigVersion } from '../generated/prisma/client';
import { IntegrationsService, type AgentIntegration } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentSettingsService, toAgentSettingsDto } from './agent-settings.service';
import { CORE_PROMPT_VERSION } from './core-prompt';
import { LlmProvidersService } from './llm-providers.service';
import { PlaybooksService } from './playbooks.service';

/** Everything that affects the agent's behavior. Shows which instructions the agent followed in every run. */
/** A department as the agent sees it: without how it hands tickets to operators, so the version does not change with that. */
export type AgentDepartment = Omit<DepartmentDto, 'assignmentMode'>;

export interface AgentConfigSnapshot {
  corePromptVersion: number;
  /** The installation language: the agent writes operator-facing texts in it. */
  locale: Locale;
  settings: Omit<AgentSettingsDto, 'enabled'>;
  provider: Pick<LlmProviderDto, 'id' | 'name' | 'kind' | 'baseUrl' | 'capabilities' | 'models'> | null;
  /** Enabled integrations with a manifest: domain knowledge for the prompt; the manifest hash changes the version. */
  integrations: AgentIntegration[];
  playbooks: PlaybookDto[];
  departments: AgentDepartment[];
  fields: FieldDefinitionDto[];
}

export interface ResolvedAgentConfig {
  version: AgentConfigVersion;
  snapshot: AgentConfigSnapshot;
}

@Injectable()
export class ConfigSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AgentSettingsService,
    private readonly providers: LlmProvidersService,
    private readonly playbooks: PlaybooksService,
    private readonly departments: DepartmentsService,
    private readonly fields: FieldsService,
    private readonly integrations: IntegrationsService,
  ) {}

  async build(workspaceId: string): Promise<AgentConfigSnapshot> {
    const settings = toAgentSettingsDto(await this.settings.get(workspaceId));
    const [providers, playbooks, departments, fields, integrations] = await Promise.all([
      this.providers.list(workspaceId),
      this.playbooks.list(workspaceId),
      this.departments.list(workspaceId),
      this.fields.list(workspaceId),
      this.integrations.forAgent(workspaceId),
    ]);
    const activeIntegrations = new Set(integrations.map((i) => i.id));
    const provider = providers.find((p) => p.id === settings.providerId) ?? null;
    const { enabled: _enabled, ...rest } = settings;

    return {
      corePromptVersion: CORE_PROMPT_VERSION,
      locale: getLocale(),
      settings: rest,
      provider: provider
        ? { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, capabilities: provider.capabilities, models: provider.models }
        : null,
      integrations,
      // The agent does not need the playbooks of a disabled integration.
      playbooks: playbooks.filter((p) => p.enabled && (p.integrationId === null || activeIntegrations.has(p.integrationId))),
      departments: departments.filter((d) => !d.archived).map(({ assignmentMode: _assignmentMode, ...department }) => department),
      fields: fields.filter((f) => !f.archived),
    };
  }

  /** The current configuration as an immutable version: if such a snapshot already exists, it is returned. */
  async resolve(workspaceId: string): Promise<ResolvedAgentConfig> {
    const snapshot = await this.build(workspaceId);
    const hash = createHash('sha256').update(stableStringify(snapshot)).digest('hex');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.prisma.agentConfigVersion.findUnique({ where: { workspaceId_hash: { workspaceId, hash } } });
      if (existing) {
        return { version: existing, snapshot };
      }
      const last = await this.prisma.agentConfigVersion.findFirst({ where: { workspaceId }, orderBy: { number: 'desc' } });
      try {
        const version = await this.prisma.agentConfigVersion.create({
          data: { id: newId(), workspaceId, number: (last?.number ?? 0) + 1, hash, snapshot: json(snapshot) },
        });
        return { version, snapshot };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new Error('Could not allocate agent config version');
  }
}
