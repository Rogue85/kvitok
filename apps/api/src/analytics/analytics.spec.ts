import { describe, expect, it } from 'vitest';
import { summarizeUsage } from './usage';
import { resolveTimeZone, ZonedDays } from './zoned-days';

describe('ZonedDays', () => {
  it('puts an instant on the day it is in the zone', () => {
    const late = new Date('2026-03-01T22:30:00Z');
    expect(new ZonedDays('UTC').key(late)).toBe('2026-03-01');
    expect(new ZonedDays('Europe/Moscow').key(late)).toBe('2026-03-02');
    expect(new ZonedDays('America/New_York').key(late)).toBe('2026-03-01');
  });

  it('lists the last days up to today, across a month end', () => {
    expect(new ZonedDays('Europe/Moscow').lastDays(3, new Date('2026-03-01T22:30:00Z'))).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('finds the instant a day starts, also on a daylight saving change', () => {
    expect(new ZonedDays('Europe/Moscow').startOf('2026-03-02').toISOString()).toBe('2026-03-01T21:00:00.000Z');
    expect(new ZonedDays('America/New_York').startOf('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(new ZonedDays('America/New_York').startOf('2026-07-15').toISOString()).toBe('2026-07-15T04:00:00.000Z');
    // Clocks went forward at 02:00 that night; midnight is still on standard time.
    expect(new ZonedDays('America/New_York').startOf('2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('falls back to UTC for a zone the runtime does not know', () => {
    expect(resolveTimeZone('Mars/Olympus')).toBe('UTC');
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });
});

describe('summarizeUsage', () => {
  it('sums the cost and counts runs on a model without a price', () => {
    const usage = summarizeUsage([
      { tokensIn: 100, tokensOut: 10, cost: 0.1 },
      { tokensIn: 100, tokensOut: 10, cost: 0.2 },
      { tokensIn: 100, tokensOut: 10, cost: null },
      // Failed before calling the model: nothing was spent.
      { tokensIn: 0, tokensOut: 0, cost: null },
    ]);
    expect(usage).toEqual({ runs: 4, tokensIn: 300, tokensOut: 30, cost: 0.3, unpricedRuns: 1 });
  });
});
