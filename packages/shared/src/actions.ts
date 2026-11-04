import { z } from 'zod';

/*
 * Actions in external systems: the agent (or an operator by hand) proposes (validate), an operator decides,
 * the worker executes (execute).
 */

export const ACTION_STATUSES = ['proposed', 'approved', 'executing', 'executed', 'failed', 'rejected', 'superseded'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Who proposed an action. */
export const ACTION_SOURCES = ['agent', 'operator'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export interface ActionProposalDto {
  id: string;
  /** The agent run that proposed the action; null for an operator's manual action. */
  runId: string | null;
  source: ActionSource;
  /** The operator who proposed a manual action. */
  createdBy: { id: string; name: string } | null;
  /** The operator's action that replaced this one: executed instead of it, or an edited manual card. */
  replacedById: string | null;
  /** After a manual action finishes, the agent updates the reply. */
  refreshDraft: boolean;
  integrationId: string;
  integrationName: string;
  action: string;
  title: string;
  params: Record<string, unknown>;
  /** Parameters after the backend validated them — these are what gets executed. */
  normalizedParams: Record<string, unknown> | null;
  /** What will happen: "Credit 19 points (tier cashback…) — Anna". */
  preview: string | null;
  warnings: string[];
  reason: string;
  calculation: string | null;
  status: ActionStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionComment: string | null;
  executedAt: string | null;
  result: unknown;
  externalRef: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

export const ApproveActionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
  /**
   * An operator's manual action: the other proposals the confirmation showed as pending (they will be rejected).
   * If a colleague approved one of them meanwhile, the approval stops with a 409 instead of executing both.
   */
  pending: z.array(z.string().min(1)).max(200).optional(),
});
export type ApproveActionInput = z.infer<typeof ApproveActionSchema>;

/** The rejection reason is visible to the agent: it will not propose the same thing again. */
export const RejectActionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});
export type RejectActionInput = z.infer<typeof RejectActionSchema>;

/** An operator proposes an action by hand; it appears in the timeline as a card waiting for "Execute". */
export const CreateActionSchema = z.object({
  integrationId: z.string().min(1),
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()),
  /** Why: seen by colleagues and the agent. */
  reason: z.string().trim().min(1).max(2000),
  refreshDraft: z.boolean().default(true),
  /** The operator's own pending card being edited: it is superseded by the new one. */
  replaces: z.string().min(1).optional(),
});
export type CreateActionInput = z.infer<typeof CreateActionSchema>;

/** A validate error of the backend, returned in `details.errors` of a 422 so the form can highlight the field. */
export interface ActionValidationIssue {
  path?: string;
  message: string;
}

/** An action an operator may start by hand. */
export interface ActionCatalogItem {
  name: string;
  title: string;
  description: string;
  /** For operators only: the agent never proposes it. */
  operatorOnly: boolean;
  inputSchema: Record<string, unknown>;
  examples: Array<{ title?: string; params: Record<string, unknown> }>;
}

/** The actions of one integration for the ticket's customer. */
export interface ActionCatalogIntegration {
  integrationId: string;
  title: string;
  /** The customer in this integration; null when not found. */
  customer: { displayName: string | null; confirmed: boolean } | null;
  /** Why actions cannot be proposed now: no customer, not confirmed. */
  blocked: 'no_customer' | 'not_confirmed' | null;
  actions: ActionCatalogItem[];
}

/* ───────────── a form from input_schema ───────────── */

interface FieldBase {
  name: string;
  /** The JSON Schema `title`, otherwise the parameter name. */
  label: string;
  description: string | null;
  required: boolean;
  /** `null` is allowed: the field may be left empty on purpose. */
  nullable: boolean;
  default?: unknown;
}

export type ActionFormField =
  | (FieldBase & { kind: 'enum'; options: Array<string | number> })
  | (FieldBase & { kind: 'integer' | 'number'; min: number | null; max: number | null })
  | (FieldBase & { kind: 'string'; maxLength: number | null })
  | (FieldBase & { kind: 'boolean' });

/** Larger than this is "no limit" for the form: zod writes Number.MAX_SAFE_INTEGER. */
const NO_LIMIT = 1e12;

/**
 * Flat form fields for an action's `input_schema`. `null` — the schema has what a flat form cannot show
 * (nested objects, arrays, `oneOf`, conditional fields): the UI falls back to a JSON editor.
 */
export function actionFormFields(schema: Record<string, unknown>): ActionFormField[] | null {
  if (schema.type !== 'object') return null;
  if (['anyOf', 'oneOf', 'allOf', 'if', 'then', 'dependentRequired', 'dependentSchemas', 'patternProperties'].some((k) => k in schema)) return null;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const fields: ActionFormField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const field = formField(name, raw, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

function formField(name: string, raw: unknown, required: boolean): ActionFormField | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const property = raw as Record<string, unknown>;
  let nullable = false;
  let body = property;
  // `anyOf: [X, {type: null}]` — how zod writes `.nullable()`.
  if (Array.isArray(property.anyOf)) {
    const variants = property.anyOf as Array<Record<string, unknown>>;
    const rest = variants.filter((v) => v?.type !== 'null');
    if (rest.length !== 1 || variants.length !== 2) return null;
    nullable = true;
    body = { ...property, ...rest[0] };
    delete body.anyOf;
  }
  let type = body.type;
  if (Array.isArray(type)) {
    const rest = type.filter((t) => t !== 'null');
    if (rest.length !== 1) return null;
    nullable = nullable || rest.length !== type.length;
    type = rest[0];
  }
  const base: FieldBase = {
    name,
    label: typeof body.title === 'string' && body.title.trim() ? body.title : name,
    description: typeof body.description === 'string' ? body.description : null,
    required,
    nullable,
    ...('default' in body ? { default: body.default } : {}),
  };
  if (Array.isArray(body.enum)) {
    // An empty string is "nothing chosen" for a select, so such an enum goes to the JSON editor.
    const options = (body.enum as unknown[]).filter((o): o is string | number => (typeof o === 'string' && o !== '') || typeof o === 'number');
    if (options.length !== body.enum.length || options.length === 0) return null;
    return { ...base, kind: 'enum', options };
  }
  if (type === 'integer' || type === 'number') {
    const limit = (value: unknown) => (typeof value === 'number' && Math.abs(value) < NO_LIMIT ? value : null);
    return { ...base, kind: type, min: limit(body.minimum), max: limit(body.maximum) };
  }
  if (type === 'string') return { ...base, kind: 'string', maxLength: typeof body.maxLength === 'number' ? body.maxLength : null };
  if (type === 'boolean') return { ...base, kind: 'boolean' };
  return null;
}
