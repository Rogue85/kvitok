import { RULE_OPERATORS, type RuleCondition, type RuleLeaf, type RuleOperator } from '@kvitok/shared';
import { t } from './i18n';

/** A condition row of the builder: values of lists and ranges are typed as "a, b". */
export interface ConditionRow {
  field: string;
  op: RuleOperator;
  value: string;
}

/** What the condition builder edits: a flat list of rows joined by all/any, or JSON for nested conditions. */
export interface ConditionsDraft {
  advanced: boolean;
  match: 'all' | 'any';
  rows: ConditionRow[];
  json: string;
}

export function ruleOperatorLabel(op: RuleOperator): string {
  return t(`rules.op.${op}`);
}

/** Call it in a component's setup: the interface language is known only by then. */
export function ruleOperatorItems(): Array<{ label: string; value: RuleOperator }> {
  return RULE_OPERATORS.map((op) => ({ label: ruleOperatorLabel(op), value: op }));
}

function leafToRow(leaf: RuleLeaf): ConditionRow {
  const value = Array.isArray(leaf.value) ? leaf.value.join(', ') : leaf.value === undefined ? '' : String(leaf.value);
  return { field: leaf.field, op: leaf.op, value };
}

function rowToLeaf(row: ConditionRow): RuleLeaf {
  if (row.op === 'is_empty' || row.op === 'is_not_empty') return { field: row.field, op: row.op };
  if (row.op === 'in' || row.op === 'not_in' || row.op === 'between') {
    return { field: row.field, op: row.op, value: row.value.split(/[,;]|\s-\s/).map((v) => v.trim()).filter(Boolean) };
  }
  return { field: row.field, op: row.op, value: row.value };
}

function isFlat(condition: RuleCondition): condition is { all: RuleLeaf[] } | { any: RuleLeaf[] } {
  const list = 'all' in condition ? condition.all : 'any' in condition ? condition.any : null;
  return list !== null && list.every((c) => 'field' in c);
}

export function conditionsDraft(conditions: RuleCondition): ConditionsDraft {
  const flat = 'field' in conditions ? { all: [conditions] } : conditions;
  return {
    advanced: !isFlat(flat),
    match: 'any' in flat ? 'any' : 'all',
    rows: isFlat(flat) ? ('all' in flat ? flat.all : flat.any).map(leafToRow) : [],
    json: JSON.stringify(conditions, null, 2),
  };
}

/** The condition from the builder; invalid JSON throws. */
export function conditionsFromDraft(draft: ConditionsDraft): RuleCondition {
  return draft.advanced ? (JSON.parse(draft.json) as RuleCondition) : ({ [draft.match]: draft.rows.map(rowToLeaf) } as RuleCondition);
}

/** A condition in one line: "from.email = noreply@… and subject contains form". */
export function describeCondition(condition: RuleCondition): string {
  if ('field' in condition) {
    return `${condition.field} ${ruleOperatorLabel(condition.op)}${condition.value !== undefined ? ` ${Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}` : ''}`;
  }
  if ('all' in condition) return condition.all.map(describeCondition).join(` ${t('rules.and')} `);
  if ('any' in condition) return `(${condition.any.map(describeCondition).join(` ${t('rules.or')} `)})`;
  return t('rules.not', { condition: describeCondition(condition.not) });
}
