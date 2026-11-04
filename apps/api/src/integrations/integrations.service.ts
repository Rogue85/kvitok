import { t } from '@kvitok/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IntegrationClient, IntegrationError, ManifestSchema, type InputSchema, type Manifest } from '@kvitok/protocol';
import {
  CreateDepartmentSchema,
  type ClaimLinking,
  type CreateIntegrationInput,
  type DepartmentDto,
  type IntegrationDto,
  type IntegrationManifestDto,
  type FieldOption,
  type IntegrationSyncResultDto,
  type IntegrationToolDto,
  type OptionSetDto,
  type OptionSetSyncDto,
  type UpdateIntegrationInput,
} from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { stableStringify } from '../common/stable-json';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { SecretBox } from '../crypto/secret-box';
import { DepartmentsService } from '../departments/departments.service';
import type { Integration, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mergeOptions, optionsHash, toOptionSetDto } from './option-sets';

interface IntegrationSecrets {
  secret: string;
}

/** The "integration knowledge" layer of the agent prompt and part of its configuration version. */
export interface AgentIntegration {
  id: string;
  name: string;
  title: string;
  instructions: string;
  manifestHash: string;
}

type PlaybookSync = NonNullable<IntegrationSyncResultDto['playbooks']>;

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly departments: DepartmentsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(workspaceId: string): Promise<IntegrationDto[]> {
    const [rows, departments, sets] = await Promise.all([
      this.prisma.integration.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.departments.list(workspaceId),
      this.listOptionSets(workspaceId),
    ]);
    const keys = new Set(departments.map((d) => d.key));
    return rows.map((row) => toIntegrationDto(row, keys, sets.filter((s) => s.integrationId === row.id)));
  }

  async getDto(workspaceId: string, id: string): Promise<IntegrationDto> {
    const [row, departments, sets] = await Promise.all([this.get(workspaceId, id), this.departments.list(workspaceId), this.listOptionSets(workspaceId, id)]);
    return toIntegrationDto(row, new Set(departments.map((d) => d.key)), sets);
  }

  /** Directories of the workspace's integrations, for binding fields and for the integration page. */
  async listOptionSets(workspaceId: string, integrationId?: string): Promise<OptionSetDto[]> {
    const rows = await this.prisma.optionSet.findMany({
      where: { workspaceId, ...(integrationId ? { integrationId } : {}) },
      include: { integration: { select: { name: true } }, fields: { select: { key: true, archivedAt: true } } },
      orderBy: [{ integration: { createdAt: 'asc' } }, { createdAt: 'asc' }],
    });
    return rows.map(toOptionSetDto);
  }

  async get(workspaceId: string, id: string): Promise<Integration> {
    const row = await this.prisma.integration.findFirst({ where: { id, workspaceId } });
    if (row === null) {
      throw errors.notFound(t('api.integrationNotFound'));
    }
    return row;
  }

  /** Creates an integration and immediately tries to fetch the manifest: an error does not prevent saving, it shows in the status. */
  async create(workspaceId: string, input: CreateIntegrationInput): Promise<{ integration: IntegrationDto; sync: IntegrationSyncResultDto }> {
    const row = await this.prisma.integration.create({
      data: {
        id: newId(),
        workspaceId,
        name: input.name,
        baseUrl: input.baseUrl,
        secrets: this.box.encrypt({ secret: input.secret } satisfies IntegrationSecrets),
        enabled: input.enabled ?? true,
      },
    });
    await this.audit.record({ workspaceId, entity: 'integration', entityId: row.id, action: 'create', after: auditView(row) });
    const sync = await this.sync(workspaceId, row.id);
    return { integration: await this.getDto(workspaceId, row.id), sync };
  }

  async update(workspaceId: string, id: string, input: UpdateIntegrationInput): Promise<IntegrationDto> {
    const existing = await this.get(workspaceId, id);
    // Another address or secret — the previous ETag guarantees nothing.
    const endpointChanged = (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) || input.secret !== undefined;
    const updated = await this.prisma.integration.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.secret === undefined ? {} : { secrets: this.box.encrypt({ secret: input.secret } satisfies IntegrationSecrets) }),
        ...(input.claimLinking === undefined ? {} : { claimLinking: input.claimLinking }),
        ...(input.textIdentities === undefined ? {} : { textIdentities: input.textIdentities }),
        ...(input.fieldMapping === undefined ? {} : { fieldMapping: json(input.fieldMapping) }),
        ...(endpointChanged ? { manifestEtag: null } : {}),
      },
    });
    await this.audit.record({
      workspaceId,
      entity: 'integration',
      entityId: id,
      action: 'update',
      before: auditView(existing),
      after: input.secret === undefined ? auditView(updated) : { ...auditView(updated), secretChanged: true },
    });
    return this.getDto(workspaceId, id);
  }

  /**
   * Deletion also removes the playbooks from its manifest and its option sets. Fields bound to a set keep its options
   * as their own static ones, so stored values stay valid and readable.
   */
  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.get(workspaceId, id);
    await this.prisma.$transaction(async (tx) => {
      const sets = await tx.optionSet.findMany({ where: { integrationId: id }, include: { fields: { select: { id: true } } } });
      for (const set of sets) {
        for (const field of set.fields) {
          await tx.fieldDefinition.update({ where: { id: field.id }, data: { options: json(set.options), optionSetId: null } });
        }
      }
      await tx.integration.delete({ where: { id } });
    });
    await this.audit.record({ workspaceId, entity: 'integration', entityId: id, action: 'delete', before: auditView(existing) });
  }

  client(row: Integration): IntegrationClient {
    return new IntegrationClient({
      baseUrl: row.baseUrl,
      secret: this.box.decrypt<IntegrationSecrets>(row.secrets).secret,
      timeoutMs: this.config.integrationTimeoutMs,
    });
  }

  /**
   * Fetches the manifest (with If-None-Match if one exists) and lays out the playbooks.
   * On an error the previous manifest stays in use and the error is written to the integration status.
   */
  async sync(workspaceId: string, id: string, options: { force?: boolean } = {}): Promise<IntegrationSyncResultDto> {
    const row = await this.get(workspaceId, id);
    const now = new Date();
    let fetched: Awaited<ReturnType<IntegrationClient['manifest']>>;
    try {
      fetched = await this.client(row).manifest(options.force || row.manifest === null ? null : row.manifestEtag);
    } catch (error) {
      const message = error instanceof IntegrationError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      await this.prisma.integration.update({ where: { id }, data: { lastSyncAt: now, lastSyncError: message.slice(0, 2000) } });
      return { status: 'error', error: message };
    }

    if (fetched.notModified) {
      await this.prisma.integration.update({ where: { id }, data: { lastSyncAt: now, syncedAt: now, lastSyncError: null } });
      const stored = parseStoredManifest(row);
      const optionSets = stored ? await this.syncOptionSets(row, stored, options) : [];
      return { status: 'not_modified', ...(optionSets.length > 0 ? { optionSets } : {}) };
    }

    const manifest = fetched.manifest;
    const playbooks = await this.prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id },
        data: {
          manifest: json(manifest),
          manifestEtag: fetched.etag,
          manifestHash: createHash('sha256').update(stableStringify(manifest)).digest('hex'),
          syncedAt: now,
          lastSyncAt: now,
          lastSyncError: null,
        },
      });
      return this.syncPlaybooks(tx, row, manifest);
    });
    // Only a new manifest is recorded: it changes the agent's knowledge and playbooks.
    await this.audit.record({
      workspaceId,
      entity: 'integration',
      entityId: id,
      action: 'sync',
      after: { manifestEtag: fetched.etag, playbooks },
    });
    const optionSets = await this.syncOptionSets(row, manifest, options);
    return { status: 'updated', playbooks, ...(optionSets.length > 0 ? { optionSets } : {}) };
  }

  /**
   * Fetches every set the manifest declares (each with its own ETag) and merges the options: nothing is deleted, missing
   * and inactive options are archived. An error keeps the previous options. Sets the manifest dropped are marked removed.
   */
  private async syncOptionSets(row: Integration, manifest: Manifest, options: { force?: boolean }): Promise<OptionSetSyncDto[]> {
    const now = new Date();
    const existing = new Map((await this.prisma.optionSet.findMany({ where: { integrationId: row.id } })).map((s) => [s.name, s]));
    const results: OptionSetSyncDto[] = [];
    const client = this.client(row);

    for (const declared of manifest.option_sets) {
      const current = existing.get(declared.name);
      existing.delete(declared.name);
      const meta = { title: declared.title, description: declared.description, removedAt: null };
      const empty = { added: 0, changed: 0, archived: 0, restored: 0 };
      let fetched: Awaited<ReturnType<IntegrationClient['optionSet']>>;
      try {
        // A set that was removed or never loaded is fetched in full.
        fetched = await client.optionSet(declared.name, options.force || !current || current.removedAt ? null : current.etag);
      } catch (error) {
        const message = (error instanceof IntegrationError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)).slice(0, 2000);
        await this.prisma.optionSet.upsert({
          where: { integrationId_name: { integrationId: row.id, name: declared.name } },
          create: { id: newId(), workspaceId: row.workspaceId, integrationId: row.id, name: declared.name, ...meta, lastSyncError: message },
          update: { ...meta, lastSyncError: message },
        });
        this.logger.warn(`Option set ${declared.name} of integration ${row.name} (${row.id}) sync failed: ${message}`);
        results.push({ name: declared.name, status: 'error', error: message, ...empty });
        continue;
      }
      if (fetched.notModified && current) {
        await this.prisma.optionSet.update({ where: { id: current.id }, data: { ...meta, syncedAt: now, lastSyncError: null } });
        results.push({ name: declared.name, status: 'not_modified', ...empty });
        continue;
      }
      if (fetched.notModified) {
        // 304 without our ETag: nothing to keep — try again in full next time.
        results.push({ name: declared.name, status: 'error', error: 'unexpected 304', ...empty });
        continue;
      }
      const merged = mergeOptions((current?.options ?? []) as FieldOption[], fetched.options);
      const hash = optionsHash(merged.options);
      const data = { ...meta, options: json(merged.options), hash, etag: fetched.etag, syncedAt: now, lastSyncError: null };
      const saved = current
        ? await this.prisma.optionSet.update({ where: { id: current.id }, data })
        : await this.prisma.optionSet.create({ data: { id: newId(), workspaceId: row.workspaceId, integrationId: row.id, name: declared.name, ...data } });
      const counts = { added: merged.added.length, changed: merged.changed.length, archived: merged.archived.length, restored: merged.restored.length };
      if (!current || current.hash !== hash) {
        await this.audit.record({ workspaceId: row.workspaceId, entity: 'option_set', entityId: saved.id, action: 'update', after: { name: declared.name, ...counts } });
      }
      results.push({ name: declared.name, status: current?.hash === hash ? 'not_modified' : 'updated', ...counts });
    }

    for (const stale of existing.values()) {
      if (stale.removedAt === null) {
        await this.prisma.optionSet.update({ where: { id: stale.id }, data: { removedAt: now } });
        await this.audit.record({ workspaceId: row.workspaceId, entity: 'option_set', entityId: stale.id, action: 'update', after: { name: stale.name, removed: true } });
      }
    }
    return results;
  }

  /** For the worker: all enabled integrations one by one. */
  async syncAll(): Promise<void> {
    const rows = await this.prisma.integration.findMany({ where: { enabled: true }, select: { id: true, workspaceId: true, name: true } });
    for (const row of rows) {
      const result = await this.sync(row.workspaceId, row.id).catch((error: unknown) => ({ status: 'error', error: String(error) }) as const);
      if (result.status === 'error') {
        this.logger.warn(`Integration ${row.name} (${row.id}) sync failed: ${result.error}`);
      }
    }
  }

  /** Creates the departments the manifest suggests; existing ones are left alone. */
  async importDepartments(workspaceId: string, id: string, keys: string[]): Promise<DepartmentDto[]> {
    const row = await this.get(workspaceId, id);
    const manifest = parseStoredManifest(row);
    if (!manifest) {
      throw errors.conflict(t('api.manifestNotReceived'));
    }
    const existing = new Set((await this.departments.list(workspaceId)).map((d) => d.key));
    const created: DepartmentDto[] = [];
    for (const suggestion of manifest.suggested_departments.filter((d) => keys.includes(d.key) && !existing.has(d.key))) {
      const input = CreateDepartmentSchema.safeParse(suggestion);
      if (!input.success) {
        throw errors.validation(input.error.issues.map((i) => ({ path: `${suggestion.key}.${i.path.join('.')}`, message: i.message, code: 'custom' })));
      }
      created.push(await this.departments.create(workspaceId, input.data));
    }
    // Playbooks that referred to these departments are now linked to them.
    await this.prisma.$transaction((tx) => this.syncPlaybooks(tx, row, manifest));
    return created;
  }

  /** Enabled integrations with a received manifest — for the prompt and the agent configuration version. */
  async forAgent(workspaceId: string): Promise<AgentIntegration[]> {
    const rows = await this.prisma.integration.findMany({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    return rows.flatMap((row) => {
      const manifest = parseStoredManifest(row);
      return manifest && row.manifestHash
        ? [{ id: row.id, name: manifest.name, title: manifest.title, instructions: manifest.instructions, manifestHash: row.manifestHash }]
        : [];
    });
  }

  private async syncPlaybooks(tx: Prisma.TransactionClient, integration: Integration, manifest: Manifest): Promise<PlaybookSync> {
    const result: PlaybookSync = { added: [], updated: [], removed: [], skipped: [] };
    const workspaceId = integration.workspaceId;
    const departments = new Map((await tx.department.findMany({ where: { workspaceId, archivedAt: null } })).map((d) => [d.key, d.id]));
    const current = new Map((await tx.playbook.findMany({ where: { integrationId: integration.id } })).map((p) => [p.key, p]));

    for (const playbook of manifest.playbooks) {
      const content = {
        title: playbook.title,
        when: playbook.when,
        body: playbook.body,
        departmentId: playbook.suggested_department ? (departments.get(playbook.suggested_department) ?? null) : null,
      };
      const existing = current.get(playbook.key);
      if (existing) {
        current.delete(playbook.key);
        if ((Object.keys(content) as Array<keyof typeof content>).some((key) => existing[key] !== content[key])) {
          // enabled is not touched: a playbook disabled by an operator stays disabled.
          await tx.playbook.update({ where: { id: existing.id }, data: { ...content, version: { increment: 1 } } });
          result.updated.push(playbook.key);
        }
        continue;
      }
      const clash = await tx.playbook.findUnique({ where: { workspaceId_key: { workspaceId, key: playbook.key } } });
      if (clash) {
        result.skipped.push({ key: playbook.key, reason: clash.integrationId ? t('api.playbookKeyTakenByIntegration') : t('api.playbookKeyTakenByUi') });
        continue;
      }
      await tx.playbook.create({
        data: { id: newId(), workspaceId, key: playbook.key, ...content, source: 'manifest', integrationId: integration.id, enabled: true },
      });
      result.added.push(playbook.key);
    }
    for (const stale of current.values()) {
      await tx.playbook.delete({ where: { id: stale.id } });
      result.removed.push(stale.key);
    }
    return result;
  }
}

/** What the audit log keeps about an integration: no secret and no manifest (its sync is recorded separately). */
function auditView(row: Integration): Record<string, unknown> {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    claimLinking: row.claimLinking,
    textIdentities: row.textIdentities,
    fieldMapping: row.fieldMapping,
  };
}

/** The stored manifest has already passed the schema; parsing it again fills in the defaults. */
export function parseStoredManifest(row: Integration): Manifest | null {
  if (row.manifest === null) return null;
  const parsed = ManifestSchema.safeParse(row.manifest);
  return parsed.success ? parsed.data : null;
}

export function toIntegrationDto(row: Integration, departmentKeys: Set<string>, optionSets: OptionSetDto[] = []): IntegrationDto {
  const manifest = parseStoredManifest(row);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasSecret: row.secrets !== '',
    syncedAt: row.syncedAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    manifestEtag: row.manifestEtag,
    manifest: manifest ? toManifestDto(manifest, departmentKeys) : null,
    claimLinking: row.claimLinking as ClaimLinking,
    textIdentities: row.textIdentities,
    fieldMapping: row.fieldMapping as Record<string, string>,
    optionSets,
  };
}

function toManifestDto(manifest: Manifest, departmentKeys: Set<string>): IntegrationManifestDto {
  return {
    name: manifest.name,
    title: manifest.title,
    protocolVersion: manifest.protocol_version,
    identityTypes: manifest.identity_types.map((i) => ({
      type: i.type,
      label: i.label ?? null,
      pattern: i.pattern ?? null,
      normalize: i.normalize ?? null,
      description: i.description ?? null,
    })),
    instructions: manifest.instructions,
    tools: manifest.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      display: t.display,
      requiresCustomer: t.requires_customer,
      cacheTtlSeconds: t.cache_ttl_seconds,
      params: schemaParams(t.input_schema),
    })),
    actions: manifest.actions.map((a) => ({
      name: a.name,
      title: a.title,
      description: a.description,
      requiresApproval: a.requires_approval,
      params: schemaParams(a.input_schema),
    })),
    playbookKeys: manifest.playbooks.map((p) => p.key),
    suggestedDepartments: manifest.suggested_departments.map((d) => ({ ...d, exists: departmentKeys.has(d.key) })),
  };
}

/** Parameters from the JSON Schema for the UI: name, type, whether required, description. */
function schemaParams(schema: InputSchema): IntegrationToolDto['params'] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: describeType(property),
    required: required.has(name),
    description: typeof property.description === 'string' ? property.description : null,
  }));
}

function describeType(property: Record<string, unknown>): string {
  if (Array.isArray(property.enum)) return property.enum.map(String).join(' | ');
  if (Array.isArray(property.anyOf)) return (property.anyOf as Array<Record<string, unknown>>).map(describeType).join(' | ');
  if (property.type === 'array') return `${describeType((property.items ?? {}) as Record<string, unknown>)}[]`;
  if (Array.isArray(property.type)) return property.type.join(' | ');
  return typeof property.type === 'string' ? property.type : 'any';
}
