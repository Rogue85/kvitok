import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-support-timestamp';
export const SIGNATURE_HEADER = 'x-support-signature';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Allowed clock skew between the core and the backend. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SignatureInput {
  secret: string;
  /** unix seconds */
  timestamp: number;
  method: string;
  /** Path with the query, as in the request line: `/api/support/tools/get_coupons?x=1`. */
  path: string;
  /** The body as is; an empty string for GET. */
  body: string;
}

/**
 * `sha256=<hex>` of `{timestamp}.{METHOD}.{path}.{body}`.
 * The method and the path are signed so a signed request cannot be replayed against another endpoint.
 */
export function computeSignature(input: SignatureInput): string {
  const payload = `${input.timestamp}.${input.method.toUpperCase()}.${input.path}.${input.body}`;
  return `sha256=${createHmac('sha256', input.secret).update(payload).digest('hex')}`;
}

/** Signature headers for an outgoing request. */
export function signatureHeaders(input: Omit<SignatureInput, 'timestamp'> & { now?: Date }): Record<string, string> {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: computeSignature({ ...input, timestamp }),
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'expired' | 'mismatch' };

/** Verification on the backend side: headers may arrive in any case and as an array. */
export function verifySignature(input: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: string | string[] | undefined;
  signature: string | string[] | undefined;
  now?: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  const timestamp = Array.isArray(input.timestamp) ? input.timestamp[0] : input.timestamp;
  const signature = Array.isArray(input.signature) ? input.signature[0] : input.signature;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: 'missing' };
  }
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'expired' };
  }
  const expected = Buffer.from(computeSignature({ ...input, timestamp: Number(timestamp) }));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
