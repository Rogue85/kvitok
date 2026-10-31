import { t } from '@kvitok/i18n';
import { Inject, Injectable } from '@nestjs/common';
import type { CreateLlmProviderInput, LlmCapabilities, LlmModel, LlmProviderDto, UpdateLlmProviderInput } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { SecretBox } from '../crypto/secret-box';
import type { LlmProvider } from '../generated/prisma/client';
import { LLM_CLIENT_FACTORY, type LlmClientFactory, type ResolvedLlmProvider } from '../llm/llm-client.factory';
import { PrismaService } from '../prisma/prisma.service';

interface ProviderSecrets {
  apiKey?: string;
}

@Injectable()
export class LlmProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    @Inject(LLM_CLIENT_FACTORY) private readonly clientFactory: LlmClientFactory,
  ) {}

  async list(workspaceId: string): Promise<LlmProviderDto[]> {
    const rows = await this.prisma.llmProvider.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => this.toDto(row));
  }

  async get(workspaceId: string, id: string): Promise<LlmProvider> {
    const row = await this.prisma.llmProvider.findFirst({ where: { id, workspaceId } });
    if (row === null) {
      throw errors.notFound(t('api.providerNotFound'));
    }
    return row;
  }

  async create(workspaceId: string, input: CreateLlmProviderInput): Promise<LlmProviderDto> {
    const row = await this.prisma.llmProvider.create({
      data: {
        id: newId(),
        workspaceId,
        name: input.name,
        baseUrl: input.baseUrl,
        secrets: this.box.encrypt(input.apiKey ? { apiKey: input.apiKey } : {}),
        models: json(input.models ?? []),
        capabilities: json(input.capabilities ?? { tools: true, vision: false }),
      },
    });
    const dto = this.toDto(row);
    await this.audit.record({ workspaceId, entity: 'llm_provider', entityId: row.id, action: 'create', after: dto });
    return dto;
  }

  async update(workspaceId: string, id: string, input: UpdateLlmProviderInput): Promise<LlmProviderDto> {
    const existing = await this.get(workspaceId, id);
    const secrets = this.secretsOf(existing);
    const row = await this.prisma.llmProvider.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.models === undefined ? {} : { models: json(input.models) }),
        ...(input.capabilities === undefined ? {} : { capabilities: json(input.capabilities) }),
        ...(input.apiKey === undefined ? {} : { secrets: this.box.encrypt({ ...secrets, apiKey: input.apiKey || undefined }) }),
      },
    });
    const dto = this.toDto(row);
    await this.audit.record({
      workspaceId,
      entity: 'llm_provider',
      entityId: id,
      action: 'update',
      before: this.toDto(existing),
      after: input.apiKey === undefined ? dto : { ...dto, apiKeyChanged: true },
    });
    return dto;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.get(workspaceId, id);
    const inUse = await this.prisma.agentSettings.count({ where: { workspaceId, providerId: id } });
    if (inUse > 0) {
      throw errors.conflict(t('api.providerInUse'));
    }
    await this.prisma.llmProvider.delete({ where: { id } });
    await this.audit.record({ workspaceId, entity: 'llm_provider', entityId: id, action: 'delete', before: this.toDto(existing) });
  }

  /** A check from the UI: a short request to the model. */
  async test(workspaceId: string, id: string, model: string): Promise<{ ok: boolean; reply?: string; error?: string; latencyMs: number }> {
    const provider = await this.get(workspaceId, id);
    const started = Date.now();
    try {
      const response = await this.clientFactory(this.resolve(provider)).chat({
        model,
        messages: [{ role: 'user', content: 'Reply with one word: ok' }],
        maxTokens: 20,
      });
      return { ok: true, reply: response.content ?? '', latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
    }
  }

  resolve(provider: LlmProvider): ResolvedLlmProvider {
    return { id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, apiKey: this.secretsOf(provider).apiKey ?? null };
  }

  private secretsOf(provider: LlmProvider): ProviderSecrets {
    return provider.secrets ? this.box.decrypt<ProviderSecrets>(provider.secrets) : {};
  }

  toDto(row: LlmProvider): LlmProviderDto {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUrl: row.baseUrl,
      hasApiKey: Boolean(this.secretsOf(row).apiKey),
      models: row.models as unknown as LlmModel[],
      capabilities: { tools: true, vision: false, ...(row.capabilities as Partial<LlmCapabilities>) },
    };
  }
}

export function modelPricing(provider: LlmProviderDto | null, modelId: string | null): LlmModel | null {
  return provider?.models.find((m) => m.id === modelId) ?? null;
}
