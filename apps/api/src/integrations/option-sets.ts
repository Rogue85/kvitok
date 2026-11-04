import { createHash } from 'node:crypto';
import type { Option } from '@kvitok/protocol';
import type { FieldOption, OptionSetDto } from '@kvitok/shared';
import { stableStringify } from '../common/stable-json';
import type { FieldDefinition, Integration, OptionSet } from '../generated/prisma/client';

export interface OptionsMerge {
  options: FieldOption[];
  added: string[];
  changed: string[];
  archived: string[];
  restored: string[];
}

/** A protocol option as a field option: `description` is the hint for the agent, `active: false` archives it. */
export function toFieldOption(option: Option): FieldOption {
  return {
    value: option.value,
    label: option.label,
    ...(option.group ? { group: option.group } : {}),
    ...(option.description ? { agentHint: option.description } : {}),
    ...(option.active === false ? { archived: true } : {}),
  };
}

/**
 * The new list from the backend over the stored one. Nothing is deleted: an option the backend stopped returning is archived
 * and moves to the end, so old tickets keep its label; one that comes back active is restored. The backend's order is kept.
 */
export function mergeOptions(stored: FieldOption[], incoming: Option[]): OptionsMerge {
  const before = new Map(stored.map((o) => [o.value, o]));
  const result: OptionsMerge = { options: [], added: [], changed: [], archived: [], restored: [] };
  const seen = new Set<string>();
  for (const option of incoming) {
    const next = toFieldOption(option);
    const previous = before.get(next.value);
    seen.add(next.value);
    result.options.push(next);
    if (!previous) {
      result.added.push(next.value);
      continue;
    }
    if (!previous.archived && next.archived) result.archived.push(next.value);
    else if (previous.archived && !next.archived) result.restored.push(next.value);
    if (previous.label !== next.label || previous.group !== next.group || previous.agentHint !== next.agentHint) result.changed.push(next.value);
  }
  for (const option of stored) {
    if (seen.has(option.value)) continue;
    if (!option.archived) result.archived.push(option.value);
    result.options.push({ ...option, archived: true });
  }
  return result;
}

export function optionsHash(options: FieldOption[]): string {
  return createHash('sha256').update(stableStringify(options)).digest('hex');
}

export function toOptionSetDto(
  row: OptionSet & { integration: Pick<Integration, 'name'>; fields?: Array<Pick<FieldDefinition, 'key' | 'archivedAt'>> },
): OptionSetDto {
  const options = row.options as FieldOption[];
  return {
    id: row.id,
    integrationId: row.integrationId,
    integrationName: row.integration.name,
    name: row.name,
    title: row.title,
    description: row.description,
    size: options.length,
    activeSize: options.filter((o) => !o.archived).length,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    removed: row.removedAt !== null,
    fieldKeys: (row.fields ?? []).filter((f) => f.archivedAt === null).map((f) => f.key),
  };
}
