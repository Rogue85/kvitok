import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { AgentSettingsDto, UpdateAgentSettingsInput } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import type { AgentSettings } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Created with defaults on first access. Parallel first reads of a new workspace race on create, and `upsert` does not
   * help: with an empty `update` Prisma runs it as SELECT + INSERT. `skipDuplicates` is a single INSERT … ON CONFLICT DO NOTHING.
   */
  async get(workspaceId: string): Promise<AgentSettings> {
    const existing = await this.prisma.agentSettings.findUnique({ where: { workspaceId } });
    if (existing) return existing;
    await this.prisma.agentSettings.createMany({ data: { workspaceId }, skipDuplicates: true });
    return this.prisma.agentSettings.findUniqueOrThrow({ where: { workspaceId } });
  }

  async getDto(workspaceId: string): Promise<AgentSettingsDto> {
    return toAgentSettingsDto(await this.get(workspaceId));
  }

  async update(workspaceId: string, input: UpdateAgentSettingsInput): Promise<AgentSettingsDto> {
    const current = await this.get(workspaceId);
    const next = { ...toAgentSettingsDto(current), ...input };
    if (next.providerId) {
      const provider = await this.prisma.llmProvider.findFirst({ where: { id: next.providerId, workspaceId } });
      if (provider === null) {
        throw errors.validation([{ path: 'providerId', message: t('api.providerNotFound'), code: 'custom' }]);
      }
    }
    if (next.enabled && (!next.providerId || !next.model)) {
      throw errors.validation([{ path: 'enabled', message: t('api.agentNeedsModel'), code: 'custom' }]);
    }
    const row = await this.prisma.agentSettings.update({ where: { workspaceId }, data: input });
    const dto = toAgentSettingsDto(row);
    await this.audit.record({ workspaceId, entity: 'agent_settings', entityId: null, action: 'update', before: toAgentSettingsDto(current), after: dto });
    return dto;
  }
}

export function toAgentSettingsDto(row: AgentSettings): AgentSettingsDto {
  return {
    enabled: row.enabled,
    providerId: row.providerId,
    model: row.model,
    policy: row.policy,
    playbookMode: row.playbookMode as AgentSettingsDto['playbookMode'],
    maxToolCalls: row.maxToolCalls,
    maxOutputTokens: row.maxOutputTokens,
    temperature: row.temperature,
    confidenceThreshold: row.confidenceThreshold,
    debounceSeconds: row.debounceSeconds,
  };
}
