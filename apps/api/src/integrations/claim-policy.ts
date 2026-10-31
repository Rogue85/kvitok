import type { ResolveResponse } from '@kvitok/protocol';
import type { ClaimLinking, PendingOption } from '@kvitok/shared';

/** The customer link before identities from messages are checked. */
export interface CurrentLink {
  status: string;
  customerRef: string | null;
  displayName: string | null;
  matchedBy: string[];
}

export type ClaimOutcome =
  /** Values from messages point to the customer already found: they are confirmed. */
  | { kind: 'agree'; matchedBy: string[] }
  /** Linked right away: confirmed (corroborated) or not (the `auto` policy, the operator confirms). */
  | { kind: 'link'; option: PendingOption; confirmed: boolean }
  | { kind: 'suggestion'; options: PendingOption[] }
  | { kind: 'conflict'; options: PendingOption[] }
  | { kind: 'candidates'; options: PendingOption[] }
  /** Nobody is found by the values from messages. */
  | { kind: 'not_found' }
  /** Found, but linking by values from messages is off: only a line in the timeline. */
  | { kind: 'ignored'; options: PendingOption[] };

/**
 * What resolve over trusted identities plus values from messages means for the link (design.md, "The linking policy").
 * A conflict is never resolved automatically; a customer found only by typed values is linked only by `corroborated` (two or
 * more identity types agree) or `auto` (unconfirmed).
 */
export function decideClaimOutcome(input: {
  policy: ClaimLinking;
  link: CurrentLink | null;
  factTypes: string[];
  claimTypes: string[];
  result: ResolveResponse;
}): ClaimOutcome {
  const { policy, result } = input;
  const claimTypes = new Set(input.claimTypes);
  const current = input.link?.status === 'found' && input.link.customerRef ? input.link : null;
  const byClaims = (matchedBy: string[]) => matchedBy.some((type) => claimTypes.has(type));

  if (result.status === 'not_found') return { kind: 'not_found' };

  if (result.status === 'found') {
    // Without matched_by the backend did not say what matched: count it as matched by the values from messages only.
    const matchedBy = result.matched_by ?? input.claimTypes;
    if (!byClaims(matchedBy)) return { kind: 'not_found' };
    const option: PendingOption = { customerRef: result.customer_ref, displayName: result.display_name ?? null, hint: null, matchedBy, current: false };
    if (current?.customerRef === result.customer_ref) return { kind: 'agree', matchedBy };
    if (policy === 'off') return { kind: 'ignored', options: [option] };
    if (current) return { kind: 'conflict', options: [currentOption(current, input.factTypes), option] };
    const corroborated = matchedBy.length >= 2;
    if (policy === 'suggest') return { kind: 'suggestion', options: [option] };
    if (policy === 'corroborated') return corroborated ? { kind: 'link', option, confirmed: true } : { kind: 'suggestion', options: [option] };
    return { kind: 'link', option, confirmed: corroborated };
  }

  const candidates: PendingOption[] = result.candidates.map((c) => ({
    customerRef: c.customer_ref,
    displayName: c.display_name,
    hint: c.hint ?? null,
    matchedBy: c.matched_by ?? input.claimTypes,
    current: c.customer_ref === current?.customerRef,
  }));
  const claimed = candidates.filter((c) => byClaims(c.matchedBy));
  if (claimed.length === 0) return { kind: 'not_found' };
  if (current) {
    const others = claimed.filter((c) => c.customerRef !== current.customerRef);
    if (others.length === 0) return { kind: 'agree', matchedBy: claimed[0]!.matchedBy };
    if (policy === 'off') return { kind: 'ignored', options: others };
    const self = candidates.find((c) => c.current) ?? currentOption(current, input.factTypes);
    return { kind: 'conflict', options: [{ ...self, current: true }, ...others] };
  }
  if (policy === 'off') return { kind: 'ignored', options: candidates };
  return { kind: 'candidates', options: candidates };
}

function currentOption(link: CurrentLink, factTypes: string[]): PendingOption {
  return {
    customerRef: link.customerRef!,
    displayName: link.displayName,
    hint: null,
    matchedBy: link.matchedBy.length > 0 ? link.matchedBy : factTypes,
    current: true,
  };
}
