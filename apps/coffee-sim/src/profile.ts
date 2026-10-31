import type { ConformanceProfile } from '@kvitok/protocol';
import type { SimStore } from './store.js';

/** Conformance profile from the world data: a guest with receipts, their receipt and order. */
export function simConformanceProfile(store: SimStore, baseUrl: string, secret: string): ConformanceProfile {
  const guest = [...store.guests.values()].find((g) => store.transactionsOf(g.id).length > 0);
  if (!guest) throw new Error('The world has no guest with receipts — nobody to run the checks on');
  const transaction = store.transactionsOf(guest.id)[0]!;
  return {
    baseUrl,
    secret,
    customer: { identities: { phone: guest.phone } },
    tools: {
      get_receipt: { transaction_id: transaction.id },
      get_promo_journal: { transaction_ids: [transaction.id] },
    },
  };
}
