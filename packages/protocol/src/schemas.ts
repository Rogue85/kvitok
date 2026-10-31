import { z } from 'zod';

/** Protocol version in the manifest. Incompatible changes mean a new version. */
export const PROTOCOL_VERSION = 1;

/** Names of tools, actions, playbooks and departments: Latin letters, digits, `_`. */
export const NameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase Latin letters, digits and _');

/** `input_schema` is the JSON Schema of the arguments object. */
export const InputSchemaSchema = z.looseObject({ type: z.literal('object') });
export type InputSchema = z.infer<typeof InputSchemaSchema>;

/** How the UI shows a tool result or a section of the customer card. */
export const DISPLAY_KINDS = ['kv', 'table', 'timeline', 'markdown', 'json'] as const;
export const DisplaySchema = z.enum(DISPLAY_KINDS);
export type Display = z.infer<typeof DisplaySchema>;

const ArgsSchema = z.record(z.string(), z.unknown());

/* ───────────── manifest ───────────── */

export const ToolDefinitionSchema = z.object({
  name: NameSchema,
  title: z.string().trim().min(1).max(200),
  /** For the LLM: what the tool returns and when to call it. */
  description: z.string().trim().min(1).max(4000),
  input_schema: InputSchemaSchema,
  display: DisplaySchema.default('json'),
  /** false — reference data, the tool is available without a resolved customer. */
  requires_customer: z.boolean().default(true),
  /** How many seconds the result may be reused in later agent runs; 0 — do not reuse. */
  cache_ttl_seconds: z.number().int().min(0).max(86_400).default(300),
  /** Argument examples: documentation, a test call in the UI, conformance checks. */
  examples: z.array(z.object({ title: z.string().max(200).optional(), args: ArgsSchema })).max(10).default([]),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ActionDefinitionSchema = z.object({
  name: NameSchema,
  title: z.string().trim().min(1).max(200),
  /** For the LLM: when the action is appropriate and how to compute the parameters. */
  description: z.string().trim().min(1).max(4000),
  input_schema: InputSchemaSchema,
  requires_approval: z.boolean().default(true),
  examples: z.array(z.object({ title: z.string().max(200).optional(), params: ArgsSchema })).max(10).default([]),
});
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;

export const PlaybookDefinitionSchema = z.object({
  key: NameSchema,
  title: z.string().trim().min(1).max(200),
  when: z.string().trim().min(1).max(1000),
  body: z.string().trim().min(1).max(50_000),
  suggested_department: NameSchema.optional(),
  tools: z.array(NameSchema).max(50).optional(),
  actions: z.array(NameSchema).max(50).optional(),
});
export type PlaybookDefinition = z.infer<typeof PlaybookDefinitionSchema>;

export const DepartmentSuggestionSchema = z.object({
  key: NameSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  examples: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
});
export type DepartmentSuggestion = z.infer<typeof DepartmentSuggestionSchema>;

/** Identity type names: phone, email, card_number… */
export const IdentityTypeNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase Latin letters, digits and _');

/** How identity values are compared: digits only (phones, cards), lowercase (emails), as is. */
export const IDENTITY_NORMALIZATIONS = ['digits', 'lowercase', 'none'] as const;

/**
 * An identity type the backend resolves by. `pattern` lets the core find such values in message text:
 * a JavaScript regular expression, case-insensitive; the value is the named group `value`, otherwise group 1, otherwise the whole match.
 */
export const IdentityTypeDefinitionSchema = z.object({
  type: IdentityTypeNameSchema,
  /** For the operator: "Loyalty card". */
  label: z.string().trim().min(1).max(100).optional(),
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((pattern) => compiles(pattern), 'not a valid regular expression')
    .optional(),
  normalize: z.enum(IDENTITY_NORMALIZATIONS).optional(),
  /** For the agent: what the value looks like, "16 digits starting with 7777". */
  description: z.string().trim().max(1000).optional(),
});
export type IdentityTypeDefinition = z.infer<typeof IdentityTypeDefinitionSchema>;

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'gi');
    return true;
  } catch {
    return false;
  }
}

export const ManifestSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    name: NameSchema,
    title: z.string().trim().min(1).max(200),
    /** Identity types resolve works with: a name (`"phone"`) or a definition with a label and a pattern. */
    identity_types: z
      .array(z.union([IdentityTypeNameSchema, IdentityTypeDefinitionSchema]).transform((v): IdentityTypeDefinition => (typeof v === 'string' ? { type: v } : v)))
      .max(20)
      .default([]),
    /** How the domain works and how to read tool data — the "integration knowledge" layer of the prompt. */
    instructions: z.string().max(50_000).default(''),
    tools: z.array(ToolDefinitionSchema).max(100).default([]),
    actions: z.array(ActionDefinitionSchema).max(100).default([]),
    playbooks: z.array(PlaybookDefinitionSchema).max(200).default([]),
    suggested_departments: z.array(DepartmentSuggestionSchema).max(50).default([]),
  })
  .superRefine((manifest, ctx) => {
    const types = new Set<string>();
    manifest.identity_types.forEach((identity, index) => {
      if (types.has(identity.type)) {
        ctx.addIssue({ code: 'custom', path: ['identity_types', index], message: `Duplicate identity type ${identity.type}` });
      }
      types.add(identity.type);
    });
    for (const [list, label] of [
      [manifest.tools, 'tools'],
      [manifest.actions, 'actions'],
      [manifest.playbooks.map((p) => ({ name: p.key })), 'playbooks'],
    ] as const) {
      const seen = new Set<string>();
      list.forEach((item, index) => {
        if (seen.has(item.name)) {
          ctx.addIssue({ code: 'custom', path: [label, index], message: `Duplicate name ${item.name}` });
        }
        seen.add(item.name);
      });
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;

/* ───────────── customer ───────────── */

export const IdentitiesSchema = z.record(IdentityTypeNameSchema, z.string().trim().min(1).max(320));
export const CustomerRefSchema = z.string().min(1).max(200);

export const ResolveRequestSchema = z.object({ identities: IdentitiesSchema });
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

export const CustomerCandidateSchema = z.object({
  customer_ref: CustomerRefSchema,
  display_name: z.string().max(200),
  /** What distinguishes the candidate: "card …0548, last receipt 14.10". */
  hint: z.string().max(500).optional(),
  /** Which of the requested identities point to this candidate. */
  matched_by: z.array(IdentityTypeNameSchema).max(20).optional(),
});

/**
 * Several identities: those that match nobody are ignored; if all matching ones point to one customer — `found`,
 * if to different customers (or one identity to several) — `ambiguous`. `matched_by` lists the identity types that matched.
 */
export const ResolveResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('found'),
    customer_ref: CustomerRefSchema,
    display_name: z.string().max(200).optional(),
    matched_by: z.array(IdentityTypeNameSchema).max(20).optional(),
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('ambiguous'), candidates: z.array(CustomerCandidateSchema).min(2).max(20) }),
]);
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

/* ───────────── data: context and tools ───────────── */

export const RefSchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  /** Link to the backend admin. */
  url: z.url().optional(),
});
export type Ref = z.infer<typeof RefSchema>;

/** Tool response: `data` goes to the agent as is, the UI renders it by `display`. */
export const DataResultSchema = z.object({
  summary: z.string().max(2000).optional(),
  data: z.unknown(),
  display: DisplaySchema.optional(),
  refs: z.array(RefSchema).max(50).default([]),
});
export type DataResult = z.infer<typeof DataResultSchema>;

export const ContextRequestSchema = z.object({ customer_ref: CustomerRefSchema });

export const ContextSectionSchema = z.object({
  key: NameSchema,
  title: z.string().min(1).max(200),
  display: DisplaySchema.default('kv'),
  data: z.unknown(),
});

/** A customer attribute value: a scalar or a list of strings (for multiple choice). */
export const ContextFieldValueSchema = z.union([z.string().max(1000), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]);

/** Customer card: a short summary and sections. */
export const ContextResponseSchema = z.object({
  title: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
  sections: z.array(ContextSectionSchema).max(20).default([]),
  refs: z.array(RefSchema).max(50).default([]),
  /** Customer attributes the support system can store in its customer fields: tier, plan, employee number. */
  fields: z.record(NameSchema, ContextFieldValueSchema).optional(),
});
export type ContextResponse = z.infer<typeof ContextResponseSchema>;

export const ToolCallRequestSchema = z.object({
  /** null — a tool without a customer (`requires_customer: false`). */
  customer_ref: CustomerRefSchema.nullable(),
  args: ArgsSchema.default({}),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

/* ───────────── actions ───────────── */

export const ActionRequestSchema = z.object({
  customer_ref: CustomerRefSchema,
  params: ArgsSchema,
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ValidationIssueSchema = z.object({
  path: z.string().max(200).optional(),
  message: z.string().min(1).max(2000),
});

/** validate responds 200 even for semantically invalid parameters: errors are a hint for the agent, not a failure. */
export const ValidateResponseSchema = z.object({
  ok: z.boolean(),
  normalized_params: ArgsSchema.optional(),
  /** What will happen, for the operator: "Credit 19 points to Anna for the 14.10 receipt". */
  preview: z.string().max(2000).optional(),
  warnings: z.array(z.string().max(2000)).max(20).default([]),
  errors: z.array(ValidationIssueSchema).max(20).default([]),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

export const ExecuteResponseSchema = z.object({
  status: z.enum(['executed', 'failed']),
  result: z.unknown().optional(),
  /** Identifier in the external system: the id of the credit, coupon or refund. */
  external_ref: z.string().max(200).optional(),
  error: z.string().max(2000).optional(),
});
export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>;

/** `unknown` — a request with this key never reached the backend, it can be safely retried. */
export const ExecutionStatusResponseSchema = z.object({
  status: z.enum(['executed', 'failed', 'pending', 'unknown']),
  action: NameSchema.optional(),
  result: z.unknown().optional(),
  external_ref: z.string().max(200).optional(),
  error: z.string().max(2000).optional(),
});
export type ExecutionStatusResponse = z.infer<typeof ExecutionStatusResponseSchema>;

/* ───────────── errors ───────────── */

export const PROTOCOL_ERROR_CODES = [
  'invalid_signature',
  'unknown_tool',
  'unknown_action',
  'unknown_customer',
  'not_found',
  'invalid_arguments',
  'idempotency_conflict',
  'internal',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** HTTP status for each error code. */
export const PROTOCOL_ERROR_STATUS: Record<ProtocolErrorCode, number> = {
  invalid_signature: 401,
  unknown_tool: 404,
  unknown_action: 404,
  unknown_customer: 404,
  not_found: 404,
  invalid_arguments: 422,
  idempotency_conflict: 409,
  internal: 500,
};

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(2000),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function protocolError(code: ProtocolErrorCode, message: string, details?: unknown): { status: number; body: ErrorResponse } {
  return { status: PROTOCOL_ERROR_STATUS[code], body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

/* ───────────── paths ───────────── */

export const PROTOCOL_PATHS = {
  manifest: '/manifest',
  resolve: '/customers/resolve',
  context: '/context',
  tool: (name: string) => `/tools/${encodeURIComponent(name)}`,
  validate: (action: string) => `/actions/${encodeURIComponent(action)}/validate`,
  execute: (action: string) => `/actions/${encodeURIComponent(action)}/execute`,
  execution: (key: string) => `/actions/executions/${encodeURIComponent(key)}`,
} as const;
