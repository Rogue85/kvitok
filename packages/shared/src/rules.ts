import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { patchOf } from './patch.js';
import { FieldKeySchema } from './fields.js';
import { TagSchema, TicketPrioritySchema } from './tickets.js';

export const RULE_STAGES = ['on_ingest', 'after_agent'] as const;
export const RuleStageSchema = z.enum(RULE_STAGES);
export type RuleStage = z.infer<typeof RuleStageSchema>;

export const RULE_OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
] as const;
export const RuleOperatorSchema = z.enum(RULE_OPERATORS);
export type RuleOperator = z.infer<typeof RuleOperatorSchema>;

export interface RuleLeaf {
  field: string;
  op: RuleOperator;
  value?: unknown;
}
export type RuleCondition = RuleLeaf | { all: RuleCondition[] } | { any: RuleCondition[] } | { not: RuleCondition };

/**
 * Condition fields: subject, body, channel.type, channel.id, from.email, from.domain,
 * metadata.<path>, fields.<key>, customer.fields.<key>, customer.identity.<type>,
 * ticket.priority, ticket.department, ticket.tags, time.hour, time.weekday,
 * agent.department, agent.confidence, agent.needs_human (after_agent only).
 */
export const RuleLeafSchema = z
  .object({
    field: z.string().trim().min(1).max(200),
    op: RuleOperatorSchema,
    value: z.unknown().optional(),
  })
  .superRefine((leaf, ctx) => {
    if (leaf.op === 'matches') {
      try {
        new RegExp(String(leaf.value ?? ''), 'i');
      } catch {
        ctx.addIssue({ code: 'custom', path: ['value'], message: t('validation.invalidRegex') });
      }
    }
    if (leaf.op === 'between' && !(Array.isArray(leaf.value) && leaf.value.length === 2)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: t('validation.betweenRange') });
    }
  });

export const RuleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    RuleLeafSchema,
    z.object({ all: z.array(RuleConditionSchema).max(50) }),
    z.object({ any: z.array(RuleConditionSchema).max(50) }),
    z.object({ not: RuleConditionSchema }),
  ]),
) as z.ZodType<RuleCondition>;

export const RuleEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_department'), departmentKey: FieldKeySchema }),
  z.object({ type: z.literal('set_priority'), priority: TicketPrioritySchema }),
  z.object({ type: z.literal('add_tags'), tags: z.array(TagSchema).min(1).max(20) }),
  z.object({ type: z.literal('assign'), userId: z.string().min(1) }),
  z.object({ type: z.literal('set_field'), key: FieldKeySchema, value: z.unknown() }),
  /** Field value from a regular expression over the subject or body: group 1 (or the named group `value`). */
  z.object({
    type: z.literal('set_field_from_regex'),
    key: FieldKeySchema,
    source: z.enum(['subject', 'body']),
    pattern: z.string().min(1).max(500),
  }),
  /** Do not run the agent on this ticket (on_ingest only). */
  z.object({ type: z.literal('skip_agent') }),
]);
export type RuleEffect = z.infer<typeof RuleEffectSchema>;

const RuleBase = z.object({
  name: z.string().trim().min(1).max(200),
  conditions: RuleConditionSchema,
  effects: z.array(RuleEffectSchema).min(1).max(20),
  stop: z.boolean().default(false),
  enabled: z.boolean().default(true),
  position: z.number().int().default(0),
});
export const CreateRoutingRuleSchema = RuleBase.extend({ stage: RuleStageSchema });
export type CreateRoutingRuleInput = z.input<typeof CreateRoutingRuleSchema>;
export const UpdateRoutingRuleSchema = patchOf(RuleBase);
export type UpdateRoutingRuleInput = z.input<typeof UpdateRoutingRuleSchema>;

export interface RoutingRuleDto {
  id: string;
  name: string;
  stage: RuleStage;
  position: number;
  conditions: RuleCondition;
  effects: RuleEffect[];
  stop: boolean;
  enabled: boolean;
}

export interface RuleTestResultDto {
  stage: RuleStage;
  matched: Array<{ ruleId: string; name: string; effects: RuleEffect[] }>;
  context: Record<string, unknown>;
}
