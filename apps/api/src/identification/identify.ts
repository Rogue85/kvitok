import { NAME_IDENTITY, normalizeIdentity, type ClaimSource, type CustomerFrom, type IdentityExtract, type IdentityNormalization, type IdentityTrust, type RuleCondition } from '@kvitok/shared';
import { evaluateCondition } from '../routing/rules-engine';

/** At most this many values of one type per message: a list of numbers in an email is not a list of customers. */
export const MAX_VALUES_PER_TYPE = 5;
/** Patterns run over the beginning of the text only: a long email with a quoted thread gives nothing new further down. */
const MAX_SCANNED_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 200;

/** What identification rules are checked against: the message as it arrived, before the customer is known. */
export interface IdentificationContext {
  subject: string;
  body: string;
  channel: { id: string; type: string };
  from: { email: string; domain: string } | null;
  reply_to: { email: string; domain: string } | null;
  /** true / false — what the receiving server said about the sender (DMARC/DKIM); null — it said nothing (or not an email). */
  sender: { authenticated: boolean | null };
  metadata: Record<string, unknown>;
  /** All headers of an email, names in lowercase. */
  header: Record<string, string>;
}

export interface IdentificationRuleLike {
  id: string;
  name: string;
  conditions: RuleCondition;
  customerFrom: CustomerFrom;
  extract: IdentityExtract[];
  stop: boolean;
  enabled: boolean;
}

/** An identity type with a pattern from an integration manifest. */
export interface ManifestIdentityPattern {
  integrationId: string;
  integrationName: string;
  type: string;
  pattern: string;
  normalize: IdentityNormalization | null;
}

export interface FoundIdentity {
  type: string;
  /** Normalized: this is how customers are compared and searched. */
  value: string;
  trust: IdentityTrust;
  source: Extract<ClaimSource, 'rule' | 'manifest'>;
  ruleId: string | null;
  ruleName: string | null;
  integrationId: string | null;
  integrationName: string | null;
  /** The line the value was found in. */
  evidence: string;
}

export interface IdentificationOutcome {
  matched: Array<{ id: string; name: string }>;
  customerFrom: CustomerFrom;
  /** For `reply_to` and `extracted_email`: the customer's email and how far it is trusted. */
  customerEmail: { value: string; trust: IdentityTrust } | null;
  /** The `name` pseudo-type: the customer name. */
  customerName: string | null;
  found: FoundIdentity[];
}

/**
 * Applies identification rules and manifest patterns to a message. Pure: the caller decides what to write.
 * The first matching rule with a customer source other than the sender sets it; `stop` ends the list.
 */
export function identify(input: {
  ctx: IdentificationContext;
  rules: IdentificationRuleLike[];
  patterns: ManifestIdentityPattern[];
  /** How values of each type are normalized (from the manifests); the rest — by the type's own rules. */
  normalization?: Map<string, IdentityNormalization | null>;
}): IdentificationOutcome {
  const { ctx } = input;
  const outcome: IdentificationOutcome = { matched: [], customerFrom: 'sender', customerEmail: null, customerName: null, found: [] };
  const seen = new Set<string>();
  const perType = new Map<string, number>();
  const normalize = (type: string, raw: string) => normalizeIdentity(type, raw, input.normalization?.get(type) ?? null);
  const add = (found: Omit<FoundIdentity, 'value'>, raw: string): FoundIdentity | null => {
    const value = normalize(found.type, raw);
    const key = `${found.type}\u0000${value}`;
    if (value === '' || seen.has(key) || (perType.get(found.type) ?? 0) >= MAX_VALUES_PER_TYPE) return null;
    seen.add(key);
    perType.set(found.type, (perType.get(found.type) ?? 0) + 1);
    const item = { ...found, value };
    outcome.found.push(item);
    return item;
  };

  for (const rule of input.rules) {
    if (!rule.enabled || !evaluateCondition(rule.conditions, ctx)) continue;
    outcome.matched.push({ id: rule.id, name: rule.name });
    let ruleEmail: { value: string; trust: IdentityTrust } | null = null;
    for (const extract of rule.extract) {
      for (const match of findAll(extract.pattern, sourceText(ctx, extract.source))) {
        if (extract.identityType === NAME_IDENTITY) {
          outcome.customerName ??= match.raw.slice(0, 200);
          continue;
        }
        const item = add(
          { type: extract.identityType, trust: extract.trust, source: 'rule', ruleId: rule.id, ruleName: rule.name, integrationId: null, integrationName: null, evidence: match.evidence },
          match.raw,
        );
        if (item?.type === 'email') ruleEmail ??= { value: item.value, trust: item.trust };
      }
    }
    if (outcome.customerFrom === 'sender' && rule.customerFrom !== 'sender') {
      outcome.customerFrom = rule.customerFrom;
      outcome.customerEmail =
        rule.customerFrom === 'reply_to' ? (ctx.reply_to ? { value: ctx.reply_to.email, trust: 'trusted' } : null) : ruleEmail;
    }
    if (rule.stop) break;
  }

  const texts = [ctx.subject, ctx.body];
  for (const pattern of input.patterns) {
    for (const text of texts) {
      for (const match of findAll(pattern.pattern, text)) {
        add(
          {
            type: pattern.type,
            trust: 'claimed',
            source: 'manifest',
            ruleId: null,
            ruleName: null,
            integrationId: pattern.integrationId,
            integrationName: pattern.integrationName,
            evidence: match.evidence,
          },
          match.raw,
        );
      }
    }
  }

  // The customer's own email from a form is the conversation address, not a value to check.
  if (outcome.customerEmail) {
    const email = outcome.customerEmail.value;
    outcome.found = outcome.found.filter((f) => !(f.type === 'email' && f.value === email));
  }
  return outcome;
}

function sourceText(ctx: IdentificationContext, source: string): string {
  if (source === 'subject') return ctx.subject;
  if (source === 'body') return ctx.body;
  return ctx.header[source.slice('header:'.length).toLowerCase()] ?? '';
}

/** All matches: the named group `value`, otherwise group 1, otherwise the whole match; with the line around it. */
export function findAll(pattern: string, text: string): Array<{ raw: string; evidence: string }> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch {
    return [];
  }
  const scanned = text.slice(0, MAX_SCANNED_CHARS);
  const result: Array<{ raw: string; evidence: string }> = [];
  for (const match of scanned.matchAll(re)) {
    const raw = (match.groups?.value ?? match[1] ?? match[0])?.trim();
    if (!raw) continue;
    result.push({ raw, evidence: lineAround(scanned, match.index ?? 0, match[0].length) });
    if (result.length >= MAX_VALUES_PER_TYPE * 2) break;
  }
  return result;
}

function lineAround(text: string, index: number, length: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const endBreak = text.indexOf('\n', index + length);
  const line = text.slice(start, endBreak === -1 ? undefined : endBreak).trim();
  return line.length <= MAX_EVIDENCE_CHARS ? line : `${line.slice(0, MAX_EVIDENCE_CHARS - 1)}…`;
}

/**
 * Whether a value occurs in the text: digits may be split by spaces, dashes, dots or brackets ("700 012 345"),
 * other values compare case-insensitively. A phone also matches by its last 10 digits (8 / +7 / 7 prefixes).
 */
export function occursIn(type: string, value: string, text: string, mode?: IdentityNormalization | null): boolean {
  const normalized = normalizeIdentity(type, value, mode);
  const digitsOnly = /^\d+$/.test(normalized);
  if (!digitsOnly) {
    return text.toLowerCase().includes(normalized.toLowerCase());
  }
  const variants = [normalized];
  if (type === 'phone' && normalized.length > 10) variants.push(normalized.slice(-10));
  return variants.some((digits) => new RegExp(`(?<!\\d)${digits.split('').join('[\\s\\-().]*')}(?!\\d)`).test(text));
}
