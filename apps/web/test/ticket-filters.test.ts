import { describe, expect, it } from 'vitest';
import { dateRange, ticketFilterParams } from '../app/utils/ticket-filters';

describe('ticket filters', () => {
  const now = new Date(2026, 10, 15, 14, 30);

  it('a preset counts whole local days back from today', () => {
    expect(dateRange('today', now)).toEqual({ from: new Date(2026, 10, 15) });
    expect(dateRange('7d', now)).toEqual({ from: new Date(2026, 10, 9) });
  });

  it('a range includes its last day; either side may be empty', () => {
    expect(dateRange('2026-10-01..2026-10-31', now)).toEqual({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) });
    expect(dateRange('..2026-10-31', now)).toEqual({ from: undefined, to: new Date(2026, 10, 1) });
    expect(dateRange('nonsense', now)).toEqual({ from: undefined, to: undefined });
  });

  it('turns the URL filters into list API parameters', () => {
    expect(ticketFilterParams({ priority: 'high,urgent', tags: '', created: 'today', 'field.city': 'msk' }, now)).toEqual({
      priority: 'high,urgent',
      createdFrom: new Date(2026, 10, 15).toISOString(),
      'field.city': 'msk',
    });
  });
});
