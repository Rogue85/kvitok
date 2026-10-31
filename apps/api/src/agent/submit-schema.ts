import type { DepartmentDto, FieldDefinitionDto, FieldType } from '@kvitok/shared';
import { z } from 'zod';
import type { LlmTool } from '../llm/llm.types';

export const SUBMIT_RESULT = 'submit_result';
export const READ_PLAYBOOK = 'read_playbook';

export interface AgentFieldValue {
  value: unknown;
  confidence: number;
  evidence: string | null;
}

/**
 * Result of submit_result. In a full run all sections are filled (the schema fills in defaults).
 * In a partial one (after an operator message) a missing section means "no changes".
 */
export interface AgentResult {
  /** Reply to the operator in the ticket chat; empty — nothing to say. */
  message_to_operator: string;
  department?: string | null;
  confidence?: number;
  routing_reason?: string;
  alternative_department?: string | null;
  summary?: string;
  findings?: string[];
  fields: Record<string, AgentFieldValue>;
  /** The model passes a flat reply_body; the schema folds it here (the old nested reply is accepted too). */
  reply?: { needed: boolean; body: string };
  needs_human?: boolean;
  questions_for_operator?: string[];
  playbooks_used: string[];
  /** A partial run: withdraw unconfirmed action proposals without proposing new ones. */
  drop_pending_actions?: boolean;
}

const stringList = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? [] : [v]) : (v ?? [])),
  z.array(z.string().trim().min(1).max(2000)).max(20),
);
const confidence = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().min(0).max(1));
/**
 * Flat reply_body → reply: { needed, body }. OpenAI-compatible proxies corrupt nested objects more often
 * (they insert their own parameter markup), so a single string field is exposed.
 */
function liftReplyBody(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { reply_body: body, ...rest } = raw as Record<string, unknown>;
  return typeof body === 'string' ? { ...rest, reply: { needed: body.trim() !== '', body } } : rest;
}

/**
 * Tool-call markup of different model families: Anthropic-style <parameter>/<invoke>/<function_calls>,
 * Hermes/Qwen <tool_call>, Llama <function=…> and special tokens like <|python_tag|>.
 */
const LEAKED_MARKUP = /<\/?(?:[a-z]+:)?(?:parameter|invoke|function_calls|tool_call)\b|<function=|<\|[a-z_]+\|>/i;

/**
 * Path to a string that other arguments leaked into, or null: call markup, or a JSON fragment that starts the next
 * known field ("…", "summary": "…") — the model or the provider lost track of the arguments.
 */
export function findLeakedMarkup(value: unknown, keys: string[] = [], path = ''): string | null {
  if (typeof value === 'string') return LEAKED_MARKUP.test(value) || leakedJsonField(value, keys) ? path || '(root)' : null;
  if (value === null || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    const found = findLeakedMarkup(item, keys, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function leakedJsonField(text: string, keys: string[]): boolean {
  return keys.some((key) => new RegExp(`"\\s*,\\s*"${key}"\\s*:`).test(text));
}

const fieldValueSchema = z.object({
  value: z.unknown(),
  confidence: confidence.default(0.5),
  evidence: z.string().max(1000).nullable().optional().transform((v) => v ?? null),
});

/**
 * Field values. Models often put here what they found in the data (a phone, a coffee shop) or a bare value
 * instead of { value, confidence }: unknown fields are dropped, a bare value is wrapped with confidence 0.5
 * (it becomes a suggestion, not an autofill) — instead of an extra repair round.
 */
function fieldsSchemaFor(fieldKeys: string[] | undefined) {
  return z.preprocess((raw) => {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([key]) => fieldKeys === undefined || fieldKeys.includes(key))
      .map(([key, value]) => [key, value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value ? value : { value }]);
    return Object.fromEntries(entries);
  }, z.record(z.string(), fieldValueSchema));
}

/**
 * Validation of the submit_result arguments. Customer fields are checked against the definitions later, in ResultApplier.
 * `partial` — a partial run: only the reply to the operator is required, the other sections are optional and have no defaults.
 */
export function resultSchema(
  departmentKeys: string[],
  { partial = false, fieldKeys }: { partial?: boolean; fieldKeys?: string[] } = {},
): z.ZodType<AgentResult> {
  const fieldsSchema = fieldsSchemaFor(fieldKeys);
  const department = z
    .string()
    .nullable()
    .refine((key) => key === null || departmentKeys.includes(key), {
      message: `A department key from the list is required: ${departmentKeys.join(', ') || '(there are no departments — pass null)'}, or null`,
    });
  const message = z.string().trim().max(4000);
  const reply = z.object({ needed: z.boolean(), body: z.string().max(20_000).default('') });
  if (partial) {
    return z.preprocess(liftReplyBody, z.object({
      message_to_operator: message.default(''),
      department: department.optional(),
      confidence: confidence.optional(),
      routing_reason: z.string().max(2000).optional(),
      alternative_department: department.optional(),
      summary: z.string().trim().min(1).max(4000).optional(),
      findings: stringList.optional(),
      fields: fieldsSchema.default({}),
      reply: reply.optional(),
      needs_human: z.boolean().optional(),
      questions_for_operator: stringList.optional(),
      playbooks_used: z.array(z.string()).max(20).default([]),
      drop_pending_actions: z.boolean().optional(),
    })) as unknown as z.ZodType<AgentResult>;
  }
  return z.preprocess(liftReplyBody, z.object({
    message_to_operator: message.default(''),
    department: department.default(null),
    confidence,
    routing_reason: z.string().max(2000).default(''),
    alternative_department: department.optional().transform((v) => v ?? null),
    summary: z.string().trim().min(1).max(4000),
    findings: stringList.default([]),
    fields: fieldsSchema.default({}),
    reply: reply.default({ needed: false, body: '' }),
    needs_human: z.boolean().default(false),
    questions_for_operator: stringList.default([]),
    playbooks_used: z.array(z.string()).max(20).default([]),
  })) as unknown as z.ZodType<AgentResult>;
}

function fieldsToolSchema(fields: FieldDefinitionDto[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    description: 'Only the field values you found; leave out the ones you did not',
    properties: Object.fromEntries(
      fields.map((field) => [
        field.key,
        {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'confidence'],
          properties: {
            value: valueJsonSchema(field),
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence: { type: 'string', description: 'A quote from the conversation the value is based on' },
          },
        },
      ]),
    ),
  };
}

/** JSON Schema of a field value for the model (the stricter check is fieldValueSchema in ResultApplier). */
function valueJsonSchema(field: FieldDefinitionDto): Record<string, unknown> {
  const options = field.options.map((o) => o.value);
  const byType: Record<FieldType, Record<string, unknown>> = {
    text: { type: 'string' },
    textarea: { type: 'string' },
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    datetime: { type: 'string', description: 'ISO 8601 with a time zone' },
    select: { type: 'string', enum: options },
    multiselect: { type: 'array', items: { type: 'string', enum: options } },
    email: { type: 'string' },
    phone: { type: 'string' },
    url: { type: 'string' },
  };
  return byType[field.type];
}

export function buildSubmitResultTool(departments: DepartmentDto[], fields: FieldDefinitionDto[], { partial = false }: { partial?: boolean } = {}): LlmTool {
  const keys = departments.map((d) => d.key);
  const departmentSchema = { type: ['string', 'null'], enum: [...keys, null] };
  return {
    name: SUBMIT_RESULT,
    description: partial
      ? 'Reply to the operator and pass only the changed sections of the analysis. A section not passed stays as is. Called exactly once, at the end.'
      : 'Finish the ticket analysis: department, findings, field values, the draft reply to the customer and questions for the operator. Called exactly once, at the end.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: partial
        ? ['message_to_operator']
        : ['department', 'confidence', 'routing_reason', 'summary', 'findings', ...(fields.length > 0 ? ['fields'] : []), 'reply_body', 'needs_human', 'questions_for_operator'],
      properties: {
        message_to_operator: {
          type: 'string',
          description: partial
            ? "Reply to the operator in the chat, in the operator's language: 1–3 sentences — what you understood and what you changed (or the answer to their question)"
            : "A short message to the operator, in the operator's language, if there is something to say beyond the analysis; otherwise empty",
        },
        department: { ...departmentSchema, description: 'The department key, or null if none fits' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence in the department choice' },
        routing_reason: { type: 'string', description: 'Why this department — one sentence' },
        alternative_department: { ...departmentSchema, description: 'The second most likely department, or null' },
        summary: { type: 'string', description: '1–3 sentences: what the request is about and what is known' },
        findings: { type: 'array', items: { type: 'string' }, description: 'Facts and conclusions that are not in the text of the request' },
        // No fields for the agent — hide the section itself, otherwise the model dumps everything it found there.
        ...(fields.length > 0 ? { fields: fieldsToolSchema(fields) } : {}),
        reply_body: {
          type: 'string',
          description: partial
            ? "The whole new draft reply to the customer as plain text, in the customer's language. Do not pass it if the draft does not need to change"
            : "The draft reply to the customer as plain text, in the customer's language; an empty string — no reply is needed now",
        },
        needs_human: { type: 'boolean', description: 'A human must decide (a compensation, a disputed case). Still set the department' },
        questions_for_operator: { type: 'array', items: { type: 'string' }, description: 'Open questions only the operator can answer; usually empty. Replaces the open ones: repeat an open question exactly to keep it' },
        ...(partial
          ? {
              drop_pending_actions: {
                type: 'boolean',
                description: 'true — withdraw all unapproved action proposals (e.g. the operator asked not to do them). If you propose new actions, the old unapproved ones are replaced anyway',
              },
            }
          : {}),
        playbooks_used: { type: 'array', items: { type: 'string' }, description: 'Keys of the playbooks used' },
      },
    },
  };
}

export function buildReadPlaybookTool(keys: string[]): LlmTool {
  return {
    name: READ_PLAYBOOK,
    description: 'Get the full text of a scenario (playbook) by its key from the catalog.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: { key: { type: 'string', enum: keys } },
    },
  };
}
