import { t } from '@kvitok/i18n';
import {
  fieldValueSchema,
  isEmptyFieldValue,
  type FieldDefinitionDto,
  type FieldMeta,
  type FieldMetaEntry,
  type FieldValues,
  type FieldValueSource,
} from '@kvitok/shared';

export type FieldDefinitionLike = Pick<FieldDefinitionDto, 'key' | 'type' | 'options' | 'validation' | 'archived'>;

export interface FieldChange {
  key: string;
  old: unknown;
  new: unknown;
}

export interface ApplyFieldValuesParams {
  definitions: FieldDefinitionLike[];
  values: FieldValues;
  meta: FieldMeta;
  input: Record<string, unknown>;
  source: FieldValueSource;
  actor?: Pick<FieldMetaEntry, 'userId' | 'runId' | 'ruleId' | 'confidence' | 'evidence'>;
  now?: Date;
}

export interface ApplyFieldValuesResult {
  values: FieldValues;
  meta: FieldMeta;
  changes: FieldChange[];
  /** Invalid or unknown keys. */
  rejected: Array<{ key: string; reason: string }>;
  /** Fields pinned by an operator that this source cannot change. */
  skipped: Array<{ key: string; reason: 'locked' }>;
}

/**
 * Applies new field values taking their origin into account:
 * an operator's edit pins the field, and neither ingest, rules nor the agent overwrite it anymore.
 * null or an empty string clears the value.
 */
export function applyFieldValues(params: ApplyFieldValuesParams): ApplyFieldValuesResult {
  const now = (params.now ?? new Date()).toISOString();
  const definitions = new Map(params.definitions.map((d) => [d.key, d]));
  const values: FieldValues = { ...params.values };
  const meta: FieldMeta = { ...params.meta };
  const result: ApplyFieldValuesResult = { values, meta, changes: [], rejected: [], skipped: [] };
  const isOperator = params.source === 'operator';

  for (const [key, raw] of Object.entries(params.input)) {
    const definition = definitions.get(key);
    if (definition === undefined) {
      result.rejected.push({ key, reason: t('api.unknownField') });
      continue;
    }
    if (definition.archived) {
      result.rejected.push({ key, reason: t('api.fieldArchived') });
      continue;
    }
    if (meta[key]?.locked && !isOperator) {
      result.skipped.push({ key, reason: 'locked' });
      continue;
    }

    const old = values[key];

    if (isEmptyFieldValue(raw)) {
      if (old !== undefined) {
        delete values[key];
        result.changes.push({ key, old, new: null });
      }
      if (isOperator) {
        meta[key] = { source: 'operator', locked: true, updatedAt: now, ...(params.actor?.userId ? { userId: params.actor.userId } : {}) };
      } else {
        delete meta[key];
      }
      continue;
    }

    const parsed = fieldValueSchema(definition).safeParse(raw);
    if (!parsed.success) {
      result.rejected.push({ key, reason: parsed.error.issues[0]?.message ?? t('api.invalidValue') });
      continue;
    }

    if (!sameValue(old, parsed.data)) {
      values[key] = parsed.data;
      result.changes.push({ key, old: old ?? null, new: parsed.data });
    }
    meta[key] = { source: params.source, locked: isOperator, updatedAt: now, ...compact(params.actor) };
  }

  return result;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compact<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
