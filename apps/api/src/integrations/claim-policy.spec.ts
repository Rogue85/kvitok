import type { ResolveResponse } from '@kvitok/protocol';
import type { ClaimLinking } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { decideClaimOutcome, type CurrentLink } from './claim-policy';

const notFound: CurrentLink = { status: 'not_found', customerRef: null, displayName: null, matchedBy: [] };
const anna: CurrentLink = { status: 'found', customerRef: 'anna', displayName: 'Анна', matchedBy: ['email'] };
const found = (ref: string, matchedBy?: string[]): ResolveResponse => ({ status: 'found', customer_ref: ref, display_name: ref, ...(matchedBy ? { matched_by: matchedBy } : {}) });

const decide = (policy: ClaimLinking, link: CurrentLink, result: ResolveResponse, claimTypes = ['card_number'], factTypes = ['email']) =>
  decideClaimOutcome({ policy, link, factTypes, claimTypes, result });

describe('decideClaimOutcome', () => {
  it('nobody found, or found only by the trusted identities — the claims found nobody', () => {
    expect(decide('auto', notFound, { status: 'not_found' }).kind).toBe('not_found');
    expect(decide('auto', notFound, found('anna', ['email'])).kind).toBe('not_found');
  });

  it('the claim points to the customer already found — agree, in every mode', () => {
    for (const policy of ['off', 'suggest', 'corroborated', 'auto'] as const) {
      expect(decide(policy, anna, found('anna', ['email', 'card_number']))).toEqual({ kind: 'agree', matchedBy: ['email', 'card_number'] });
    }
  });

  it('found by a claim only: off — ignored, suggest — a suggestion, corroborated — a suggestion for one type, auto — an unconfirmed link', () => {
    expect(decide('off', notFound, found('boris', ['card_number'])).kind).toBe('ignored');
    expect(decide('suggest', notFound, found('boris', ['card_number']))).toMatchObject({ kind: 'suggestion', options: [{ customerRef: 'boris', matchedBy: ['card_number'], current: false }] });
    expect(decide('corroborated', notFound, found('boris', ['card_number'])).kind).toBe('suggestion');
    expect(decide('auto', notFound, found('boris', ['card_number']))).toMatchObject({ kind: 'link', confirmed: false, option: { customerRef: 'boris' } });
  });

  it('two identity types agree: corroborated and auto link confirmed, suggest still asks', () => {
    const result = found('boris', ['phone', 'card_number']);
    expect(decide('corroborated', notFound, result, ['phone', 'card_number'])).toMatchObject({ kind: 'link', confirmed: true });
    expect(decide('auto', notFound, result, ['phone', 'card_number'])).toMatchObject({ kind: 'link', confirmed: true });
    expect(decide('suggest', notFound, result, ['phone', 'card_number']).kind).toBe('suggestion');
  });

  it('without matched_by a match counts as made by the claims only', () => {
    expect(decide('corroborated', notFound, found('boris'), ['phone', 'card_number'])).toMatchObject({ kind: 'link', option: { matchedBy: ['phone', 'card_number'] } });
    expect(decide('auto', notFound, found('boris'))).toMatchObject({ kind: 'link', confirmed: false, option: { matchedBy: ['card_number'] } });
  });

  it('the trusted identities point to one customer, the claim to another — a conflict, never resolved automatically', () => {
    const ambiguous: ResolveResponse = {
      status: 'ambiguous',
      candidates: [
        { customer_ref: 'anna', display_name: 'Анна', matched_by: ['email'] },
        { customer_ref: 'boris', display_name: 'Борис', matched_by: ['card_number'] },
      ],
    };
    for (const policy of ['suggest', 'corroborated', 'auto'] as const) {
      expect(decide(policy, anna, ambiguous)).toMatchObject({
        kind: 'conflict',
        options: [
          { customerRef: 'anna', current: true, matchedBy: ['email'] },
          { customerRef: 'boris', current: false, matchedBy: ['card_number'] },
        ],
      });
    }
    expect(decide('off', anna, ambiguous)).toMatchObject({ kind: 'ignored', options: [{ customerRef: 'boris' }] });
    // A backend that answers "found" for the claim alone.
    expect(decide('auto', anna, found('boris', ['card_number']))).toMatchObject({ kind: 'conflict', options: [{ customerRef: 'anna', current: true }, { customerRef: 'boris' }] });
  });

  it('several candidates by the claims without a found customer — the operator picks', () => {
    const ambiguous: ResolveResponse = {
      status: 'ambiguous',
      candidates: [
        { customer_ref: 'anna', display_name: 'Анна', matched_by: ['phone'] },
        { customer_ref: 'vera', display_name: 'Вера', matched_by: ['phone'] },
      ],
    };
    expect(decide('auto', notFound, ambiguous, ['phone'])).toMatchObject({ kind: 'candidates', options: [{ customerRef: 'anna' }, { customerRef: 'vera' }] });
    expect(decide('auto', notFound, ambiguous, ['card_number']).kind).toBe('not_found');
  });
});
