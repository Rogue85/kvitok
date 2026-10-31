import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { patchOf } from './patch.js';

export const FIELD_ENTITIES = ['ticket', 'customer'] as const;
export const FieldEntitySchema = z.enum(FIELD_ENTITIES);
export type FieldEntity = z.infer<typeof FieldEntitySchema>;

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'datetime',
  'select',
  'multiselect',
  'email',
  'phone',
  'url',
] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FIELD_FILL_MODES = ['manual', 'agent_suggest', 'agent_auto'] as const;
export const FieldFillModeSchema = z.enum(FIELD_FILL_MODES);
export type FieldFillMode = z.infer<typeof FieldFillModeSchema>;

export const FIELD_REQUIRED_ON = ['resolve', 'agent_done'] as const;
export const FIELD_DISPLAY = ['sidebar', 'list_column', 'filter'] as const;

export const FieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, { error: () => t('validation.fieldKey') });

export const FieldOptionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  agentHint: z.string().max(1000).optional(),
});
export type FieldOption = z.infer<typeof FieldOptionSchema>;

export const FieldValidationSchema = z
  .object({
    maxLength: z.number().int().positive().max(100_000),
    min: z.number(),
    max: z.number(),
    integer: z.boolean(),
    pattern: z.string().max(500),
  })
  .partial();
export type FieldValidation = z.infer<typeof FieldValidationSchema>;

const FieldDefinitionBase = z.object({
  label: z.string().trim().min(1).max(200),
  options: z.array(FieldOptionSchema).max(500).default([]),
  validation: FieldValidationSchema.default({}),
  agentHint: z.string().max(4000).default(''),
  fillMode: FieldFillModeSchema.default('manual'),
  agentMinConfidence: z.number().min(0).max(1).default(0.8),
  requiredOn: z.array(z.enum(FIELD_REQUIRED_ON)).default([]),
  scopeDepartmentIds: z.array(z.string()).default([]),
  display: z.array(z.enum(FIELD_DISPLAY)).default(['sidebar']),
  passToIntegration: z.boolean().default(false),
  position: z.number().int().default(0),
});

function checkOptions(value: { type?: FieldType; options?: FieldOption[]; validation?: FieldValidation }, ctx: z.RefinementCtx): void {
  const needsOptions = value.type === 'select' || value.type === 'multiselect';
  if (needsOptions && (value.options?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: t('validation.optionsRequired') });
  }
  const values = value.options?.map((o) => o.value) ?? [];
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: t('validation.optionsUnique') });
  }
  if (value.validation?.pattern !== undefined) {
    try {
      new RegExp(value.validation.pattern);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['validation', 'pattern'], message: t('validation.invalidRegex') });
    }
  }
}

export const CreateFieldDefinitionSchema = FieldDefinitionBase.extend({
  entity: FieldEntitySchema,
  key: FieldKeySchema,
  type: FieldTypeSchema,
}).superRefine(checkOptions);
export type CreateFieldDefinitionInput = z.input<typeof CreateFieldDefinitionSchema>;

/** key, entity and type do not change after creation: rules, the API and stored values refer to them. */
export const UpdateFieldDefinitionSchema = patchOf(FieldDefinitionBase)
  .extend({ archived: z.boolean().optional() })
  .superRefine((value, ctx) => checkOptions(value, ctx));
export type UpdateFieldDefinitionInput = z.input<typeof UpdateFieldDefinitionSchema>;

export interface FieldDefinitionDto {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  validation: FieldValidation;
  agentHint: string;
  fillMode: FieldFillMode;
  agentMinConfidence: number;
  requiredOn: Array<(typeof FIELD_REQUIRED_ON)[number]>;
  scopeDepartmentIds: string[];
  display: Array<(typeof FIELD_DISPLAY)[number]>;
  passToIntegration: boolean;
  position: number;
  archived: boolean;
}

export type FieldValueSource = 'ingest' | 'rule' | 'agent' | 'operator' | 'integration';

export interface FieldMetaEntry {
  source: FieldValueSource;
  locked: boolean;
  updatedAt: string;
  userId?: string;
  runId?: string;
  ruleId?: string;
  confidence?: number;
  evidence?: string;
}

export type FieldValues = Record<string, unknown>;
export type FieldMeta = Record<string, FieldMetaEntry>;

const PHONE_RE = /^\+?[0-9][0-9 ()-]{3,24}$/;

/**
 * zod schema of one field value. Strings from external sources are coerced to the field type
 * (e.g. "214" → 214 for number), so ingest and forms behave the same.
 */
export function fieldValueSchema(def: Pick<FieldDefinitionDto, 'type' | 'options' | 'validation'>): z.ZodType<unknown> {
  const v = def.validation ?? {};
  const optionValues = def.options.map((o) => o.value);

  switch (def.type) {
    case 'text':
    case 'textarea': {
      let schema = z.string().trim().min(1).max(v.maxLength ?? (def.type === 'text' ? 1000 : 20_000));
      if (v.pattern) {
        schema = schema.regex(new RegExp(v.pattern));
      }
      return schema;
    }
    case 'number': {
      let schema = z.number({ error: () => t('validation.number') });
      if (v.integer) {
        schema = schema.int({ error: () => t('validation.integer') });
      }
      if (v.min !== undefined) {
        schema = schema.min(v.min, { error: () => t('validation.min', { min: v.min! }) });
      }
      if (v.max !== undefined) {
        schema = schema.max(v.max, { error: () => t('validation.max', { max: v.max! }) });
      }
      return z.union([z.number(), z.string().trim().min(1).transform(Number)]).pipe(schema);
    }
    case 'boolean':
      return z.union([z.boolean(), z.enum(['true', 'false']).transform((s) => s === 'true')]);
    case 'date':
      return z.iso.date();
    case 'datetime':
      return z.iso.datetime({ offset: true });
    case 'select':
      return z.string().refine((s) => optionValues.includes(s), { error: () => t('validation.unknownOption') });
    case 'multiselect':
      return z
        .array(z.string().refine((s) => optionValues.includes(s), { error: () => t('validation.unknownOption') }))
        .transform((values) => [...new Set(values)]);
    case 'email':
      return z.string().trim().toLowerCase().pipe(z.email());
    case 'phone':
      return z.string().trim().regex(PHONE_RE, { error: () => t('validation.phone') });
    case 'url':
      return z.url();
  }
}

/** The value is "empty" — the field is not filled in (for required and clearing). */
export function isEmptyFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}
