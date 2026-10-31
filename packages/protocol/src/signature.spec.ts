import { describe, expect, it } from 'vitest';
import { computeSignature, signatureHeaders, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature.js';

const base = { secret: 's3cret', method: 'POST', path: '/api/support/tools/get_coupons', body: '{"customer_ref":"g1","args":{}}' };
const now = new Date('2026-10-31T12:00:00Z');

function signed(overrides: Partial<typeof base> & { at?: Date } = {}) {
  const headers = signatureHeaders({ ...base, ...overrides, now: overrides.at ?? now });
  return { timestamp: headers[TIMESTAMP_HEADER], signature: headers[SIGNATURE_HEADER] };
}

describe('request signature', () => {
  it('format is sha256=<hex> of ts.METHOD.path.body', () => {
    const signature = computeSignature({ ...base, timestamp: 1_800_000_000 });
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(computeSignature({ ...base, method: 'post', timestamp: 1_800_000_000 })).toBe(signature);
  });

  it('a valid signature passes', () => {
    expect(verifySignature({ ...base, ...signed(), now })).toEqual({ ok: true });
  });

  it('a foreign secret, another path, another body — mismatch', () => {
    expect(verifySignature({ ...base, ...signed({ secret: 'other' }), now })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature({ ...base, ...signed({ path: '/api/support/context' }), now })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySignature({ ...base, ...signed(), body: '{}', now })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('older than the tolerance — expired; without headers — missing', () => {
    expect(verifySignature({ ...base, ...signed({ at: new Date(now.getTime() - 301_000) }), now })).toEqual({ ok: false, reason: 'expired' });
    expect(verifySignature({ ...base, timestamp: undefined, signature: undefined, now })).toEqual({ ok: false, reason: 'missing' });
    expect(verifySignature({ ...base, timestamp: 'abc', signature: 'sha256=00', now })).toEqual({ ok: false, reason: 'missing' });
  });

  it('headers as an array (node:http) are read too', () => {
    const { timestamp, signature } = signed();
    expect(verifySignature({ ...base, timestamp: [timestamp!], signature: [signature!], now })).toEqual({ ok: true });
  });
});
