import { describe, expect, it } from 'vitest';
import { mergeOptions, optionsHash, toFieldOption } from './option-sets';

describe('option sets', () => {
  it('a protocol option becomes a field option: description is the agent hint, inactive is archived', () => {
    expect(toFieldOption({ value: '512', label: 'Tverskaya', group: 'Moscow', description: 'Pushkinskaya metro', active: true })).toEqual({
      value: '512',
      label: 'Tverskaya',
      group: 'Moscow',
      agentHint: 'Pushkinskaya metro',
    });
    expect(toFieldOption({ value: '77', label: 'Leninsky', active: false })).toEqual({ value: '77', label: 'Leninsky', archived: true });
  });

  it('merge: adds, changes, archives the missing and the inactive, restores, keeps the backend order with archived at the end', () => {
    const stored = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C', archived: true },
      { value: 'd', label: 'D' },
    ];
    const merged = mergeOptions(stored, [
      { value: 'e', label: 'E', active: true },
      { value: 'c', label: 'C', active: true },
      { value: 'a', label: 'A2', active: true },
      { value: 'b', label: 'B', active: false },
    ]);
    expect(merged.options).toEqual([
      { value: 'e', label: 'E' },
      { value: 'c', label: 'C' },
      { value: 'a', label: 'A2' },
      { value: 'b', label: 'B', archived: true },
      { value: 'd', label: 'D', archived: true },
    ]);
    expect(merged).toMatchObject({ added: ['e'], changed: ['a'], archived: ['b', 'd'], restored: ['c'] });
  });

  it('merge: an option missing twice is archived once; the hash follows the content only', () => {
    const first = mergeOptions([{ value: 'a', label: 'A' }], []);
    const second = mergeOptions(first.options, []);
    expect(first.archived).toEqual(['a']);
    expect(second.archived).toEqual([]);
    expect(optionsHash(first.options)).toBe(optionsHash(second.options));
    expect(optionsHash([{ value: 'a', label: 'A' }])).not.toBe(optionsHash(first.options));
  });
});
