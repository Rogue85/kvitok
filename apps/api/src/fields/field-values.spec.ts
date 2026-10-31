import { describe, expect, it } from 'vitest';
import { applyFieldValues, type FieldDefinitionLike } from './field-values';

const definitions: FieldDefinitionLike[] = [
  { key: 'dept_number', type: 'number', options: [], validation: { integer: true }, archived: false },
  {
    key: 'urgency',
    type: 'select',
    options: [
      { value: 'low', label: 'Низкая' },
      { value: 'critical', label: 'Критично' },
    ],
    validation: {},
    archived: false,
  },
  { key: 'old_field', type: 'text', options: [], validation: {}, archived: true },
];
const now = new Date('2026-10-31T10:00:00Z');

describe('applyFieldValues', () => {
  it('stores valid values with their origin and drops invalid ones', () => {
    const result = applyFieldValues({
      definitions,
      values: {},
      meta: {},
      input: { dept_number: '214', urgency: 'unknown', nope: 1, old_field: 'x' },
      source: 'ingest',
      now,
    });

    expect(result.values).toEqual({ dept_number: 214 });
    expect(result.meta.dept_number).toEqual({ source: 'ingest', locked: false, updatedAt: now.toISOString() });
    expect(result.changes).toEqual([{ key: 'dept_number', old: null, new: 214 }]);
    expect(result.rejected.map((r) => r.key)).toEqual(['urgency', 'nope', 'old_field']);
  });

  it('an operator edit pins the field, the agent does not overwrite it', () => {
    const byOperator = applyFieldValues({
      definitions,
      values: { dept_number: 214 },
      meta: { dept_number: { source: 'agent', locked: false, updatedAt: now.toISOString(), confidence: 0.7 } },
      input: { dept_number: 215 },
      source: 'operator',
      actor: { userId: 'u1' },
      now,
    });
    expect(byOperator.meta.dept_number).toMatchObject({ source: 'operator', locked: true, userId: 'u1' });
    expect(byOperator.meta.dept_number?.confidence).toBeUndefined();

    const byAgent = applyFieldValues({
      definitions,
      values: byOperator.values,
      meta: byOperator.meta,
      input: { dept_number: 300 },
      source: 'agent',
      actor: { runId: 'r1', confidence: 0.99, evidence: 'отдел 300' },
      now,
    });
    expect(byAgent.values.dept_number).toBe(215);
    expect(byAgent.skipped).toEqual([{ key: 'dept_number', reason: 'locked' }]);
  });

  it('the agent records confidence and evidence', () => {
    const result = applyFieldValues({
      definitions,
      values: {},
      meta: {},
      input: { urgency: 'critical' },
      source: 'agent',
      actor: { runId: 'r1', confidence: 0.92, evidence: '«всё лежит»' },
      now,
    });
    expect(result.meta.urgency).toEqual({
      source: 'agent',
      locked: false,
      updatedAt: now.toISOString(),
      runId: 'r1',
      confidence: 0.92,
      evidence: '«всё лежит»',
    });
  });

  it('null clears the value; an operator clearing it pins the field empty', () => {
    const result = applyFieldValues({
      definitions,
      values: { urgency: 'low' },
      meta: { urgency: { source: 'ingest', locked: false, updatedAt: now.toISOString() } },
      input: { urgency: null },
      source: 'operator',
      now,
    });
    expect(result.values).toEqual({});
    expect(result.changes).toEqual([{ key: 'urgency', old: 'low', new: null }]);
    expect(result.meta.urgency?.locked).toBe(true);
  });

  it('the same value produces no change', () => {
    const result = applyFieldValues({
      definitions,
      values: { dept_number: 214 },
      meta: {},
      input: { dept_number: '214' },
      source: 'ingest',
      now,
    });
    expect(result.changes).toEqual([]);
  });
});
