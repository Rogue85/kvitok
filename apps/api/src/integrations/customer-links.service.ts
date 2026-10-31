import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IntegrationError, type Manifest, type ResolveResponse } from '@kvitok/protocol';
import {
  normalizeIdentity,
  type ClaimLinking,
  type ClaimSource,
  type ClaimStatus,
  type CustomerLinkDto,
  type DecideIdentificationInput,
  type IdentityClaimDto,
  type IdentityTrust,
  type LinkCustomerInput,
  type PendingIdentification,
  type PendingOption,
} from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { isUniqueViolation } from '../common/prisma-errors';
import { stableStringify } from '../common/stable-json';
import { Prisma, type Customer, type CustomerIdentity, type CustomerLink, type IdentityClaim, type Integration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { recordEvent, SYSTEM_ACTOR } from '../tickets/ticket-events';
import { decideClaimOutcome, type ClaimOutcome } from './claim-policy';
import { IntegrationsService, parseStoredManifest } from './integrations.service';

/** Not found or several found — repeat the search no more often than this: the customer may have registered. */
const RETRY_UNRESOLVED_MS = 5 * 60 * 1000;
/** Searches by values from messages per run: a message with several numbers gets a few tries, not a scan. */
const MAX_CLAIM_ROUNDS = 3;

export type CustomerWithIdentities = Customer & { identities: CustomerIdentity[] };

/** What the search did — the agent engine records it as a run step. */
export interface ResolveCall {
  identities: Record<string, string>;
  result: ResolveResponse | null;
  error: string | null;
  durationMs: number;
}

/** What checking the ticket's values from messages did. */
export interface ClaimCheck {
  link: CustomerLink | null;
  calls: ResolveCall[];
  outcome: ClaimOutcome | null;
  /** The values that were checked. */
  claims: IdentityClaim[];
}

@Injectable()
export class CustomerLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  /**
   * Customer link for an agent run. Searches if not searched yet, if the contacts changed
   * or the last search was inconclusive long ago. Never revises an operator's choice or a link waiting for one.
   */
  async ensure(customer: CustomerWithIdentities, integration: Integration, manifest: Manifest, now = new Date()): Promise<{ link: CustomerLink | null; call: ResolveCall | null }> {
    const existing = await this.prisma.customerLink.findUnique({ where: { customerId_integrationId: { customerId: customer.id, integrationId: integration.id } } });
    const identities = identitiesFor(customer, manifest);
    const hash = identitiesHash(identities);
    if (existing && (existing.source === 'manual' || existing.source === 'claim' || existing.pending !== null)) return { link: existing, call: null };
    if (existing && existing.identitiesHash === hash && (existing.status === 'found' || now.getTime() - existing.resolvedAt.getTime() < RETRY_UNRESOLVED_MS)) {
      return { link: existing, call: null };
    }
    if (Object.keys(identities).length === 0) {
      return { link: await this.save(customer, integration, { status: 'not_found' }, { hash, source: 'auto', now }), call: null };
    }
    const call = await this.resolve(integration, identities);
    if (!call.result) {
      const link = existing ? await this.prisma.customerLink.update({ where: { id: existing.id }, data: { lastError: call.error } }) : null;
      return { link, call };
    }
    return { link: await this.save(customer, integration, call.result, { hash, source: 'auto', now }), call };
  }

  /**
   * Checks the ticket's values from messages (claims) against the backend together with the trusted identities and applies
   * the integration's linking policy: confirms them, links the customer, or leaves a decision for the operator in the timeline.
   * The link changes inside the agent run that called it, so the revision does not grow.
   * `byOperator` — the values come from the operator's message to the agent: a single match is linked as if by hand.
   */
  async checkClaims(
    customer: CustomerWithIdentities,
    integration: Integration,
    manifest: Manifest,
    ticket: { id: string; workspaceId: string },
    now = new Date(),
    options: { byOperator?: boolean } = {},
  ): Promise<ClaimCheck> {
    const result: ClaimCheck = { link: null, calls: [], outcome: null, claims: [] };
    const types = new Set(manifest.identity_types.map((i) => i.type));
    const facts = identitiesFor(customer, manifest);
    const policy: ClaimLinking = options.byOperator ? 'auto' : (integration.claimLinking as ClaimLinking);

    for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
      const link = await this.prisma.customerLink.findUnique({ where: { customerId_integrationId: { customerId: customer.id, integrationId: integration.id } } });
      result.link = link;
      // A decision is already waiting for the operator: new values wait for it too.
      if (link === null || link.pending !== null) return result;
      const pending = await this.prisma.identityClaim.findMany({
        where: { ticketId: ticket.id, status: 'pending', trust: 'claimed', ...(types.size > 0 ? { type: { in: [...types] } } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      // One value per type, the latest message first; the rest wait for the next round.
      const batch = [...new Map(pending.map((c) => [c.type, c])).values()].filter((c) => !(c.type in facts && facts[c.type] === c.value));
      if (batch.length === 0) return result;

      const claimIdentities = Object.fromEntries(batch.map((c) => [c.type, c.value]));
      const call = await this.resolve(integration, { ...facts, ...claimIdentities });
      result.calls.push(call);
      result.claims.push(...batch);
      if (!call.result) return result;

      let outcome = decideClaimOutcome({
        policy,
        link: { status: link.status, customerRef: link.customerRef, displayName: link.displayName, matchedBy: link.matchedBy },
        factTypes: Object.keys(facts).filter((type) => !(type in claimIdentities)),
        claimTypes: Object.keys(claimIdentities),
        result: call.result,
      });
      if (options.byOperator && outcome.kind === 'link') outcome = { ...outcome, confirmed: true };
      result.outcome = outcome;
      result.link = await this.applyOutcome(customer, integration, ticket, link, batch, outcome, now, options.byOperator ? 'manual' : 'claim');
      if (outcome.kind !== 'not_found') return result;
    }
    return result;
  }

  /** Customer links of the ticket for every enabled integration with a manifest. */
  async listForTicket(workspaceId: string, ticketId: string): Promise<CustomerLinkDto[]> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { customerId: true } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    const [integrations, links, claims] = await Promise.all([
      this.prisma.integration.findMany({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } }),
      ticket.customerId ? this.prisma.customerLink.findMany({ where: { customerId: ticket.customerId } }) : Promise.resolve([]),
      this.prisma.identityClaim.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return integrations.flatMap((integration) => {
      const manifest = parseStoredManifest(integration);
      if (!manifest) return [];
      return [toLinkDto(integration, manifest, links.find((l) => l.integrationId === integration.id) ?? null, claims)];
    });
  }

  /**
   * Manual link from the ticket: pick a candidate, search by the entered identities
   * or (empty body) search again by the customer's contacts.
   * `changed` — the customer got a different link: the agent needs to rebuild the analysis.
   */
  async link(
    workspaceId: string,
    ticketId: string,
    integrationId: string,
    input: LinkCustomerInput,
  ): Promise<{ outcome: 'found' | 'not_found' | 'ambiguous'; link: CustomerLinkDto; changed: boolean }> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, include: { customer: { include: { identities: true } } } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    if (!ticket.customer) throw errors.conflict(t('api.ticketHasNoCustomer'));
    const integration = await this.integrations.get(workspaceId, integrationId);
    const manifest = parseStoredManifest(integration);
    if (!manifest) throw errors.conflict(t('api.manifestNotReceived'));
    const customer = ticket.customer;
    const before = await this.prisma.customerLink.findUnique({ where: { customerId_integrationId: { customerId: customer.id, integrationId } } });
    const now = new Date();

    let outcome: ResolveResponse;
    let saved: CustomerLink | null = before;
    if (input.customerRef) {
      // Check the reference with the customer card: the backend responds 404 if there is no such customer.
      const context = await this.integrations
        .client(integration)
        .context(input.customerRef)
        .catch((error: unknown) => {
          throw error instanceof IntegrationError && error.status === 404 ? errors.validation([{ path: 'customerRef', message: t('api.customerNotFoundExternally'), code: 'custom' }]) : integrationFailure(error);
        });
      outcome = { status: 'found', customer_ref: input.customerRef, display_name: context.title };
      saved = await this.save(customer, integration, outcome, { hash: before?.identitiesHash ?? null, source: 'manual', now });
    } else if (input.identities) {
      const call = await this.resolve(integration, input.identities);
      if (!call.result) throw integrationFailure(call.error);
      outcome = call.result;
      if (outcome.status === 'found') {
        saved = await this.save(customer, integration, outcome, { hash: before?.identitiesHash ?? null, source: 'manual', now });
        await addIdentities(this.prisma, customer, input.identities, manifest);
      } else if (outcome.status === 'ambiguous' || !before || before.status !== 'found') {
        // An unsuccessful search does not overwrite a found customer — it only shows the candidates.
        saved = await this.save(customer, integration, outcome, { hash: before?.identitiesHash ?? null, source: 'auto', now });
      }
    } else {
      const identities = identitiesFor(customer, manifest);
      const call = await this.resolve(integration, identities);
      if (!call.result) throw integrationFailure(call.error);
      outcome = call.result;
      saved = await this.save(customer, integration, outcome, { hash: identitiesHash(identities), source: 'auto', now });
    }

    const changed = saved?.status === 'found' && (before?.status !== 'found' || before.customerRef !== saved.customerRef || !before.confirmed);
    const claims = await this.prisma.identityClaim.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
    return { outcome: outcome.status, link: toLinkDto(integration, manifest, saved, claims), changed };
  }

  /**
   * The operator's answer to an identification card: this customer (confirms the values that point to them and
   * rejects the rest) or none of the offered (rejects the values; an unconfirmed link goes back to what it was).
   */
  async decide(
    workspaceId: string,
    ticketId: string,
    integrationId: string,
    input: DecideIdentificationInput,
  ): Promise<{ link: CustomerLinkDto; changed: boolean; chosen: PendingOption | null; claims: IdentityClaim[] }> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, include: { customer: { include: { identities: true } } } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    if (!ticket.customer) throw errors.conflict(t('api.ticketHasNoCustomer'));
    const customer = ticket.customer;
    const integration = await this.integrations.get(workspaceId, integrationId);
    const manifest = parseStoredManifest(integration);
    if (!manifest) throw errors.conflict(t('api.manifestNotReceived'));

    const result = await this.prisma.$transaction(async (tx) => {
      const [link] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM customer_links WHERE customer_id = ${customer.id} AND integration_id = ${integrationId} FOR UPDATE`;
      const row = link ? await tx.customerLink.findUniqueOrThrow({ where: { id: link.id } }) : null;
      const pending = row?.pending as PendingIdentification | null | undefined;
      if (!row || !pending) throw errors.conflict(t('api.identificationNothingPending'));
      const claims = await tx.identityClaim.findMany({ where: { id: { in: pending.claimIds } } });
      const now = new Date();

      if (input.decision === 'choose') {
        const option = pending.options.find((o) => o.customerRef === input.customerRef);
        if (!option) throw errors.validation([{ path: 'customerRef', message: t('api.identificationUnknownOption'), code: 'custom' }]);
        const updated = await tx.customerLink.update({
          where: { id: row.id },
          data: {
            status: 'found',
            customerRef: option.customerRef,
            displayName: option.displayName,
            candidates: json([]),
            source: 'manual',
            confirmed: true,
            matchedBy: option.matchedBy,
            pending: Prisma.DbNull,
            lastError: null,
            resolvedAt: now,
          },
        });
        const confirmed = claims.filter((c) => option.matchedBy.includes(c.type));
        await setClaimStatus(tx, confirmed, 'confirmed');
        await setClaimStatus(tx, claims.filter((c) => !confirmed.includes(c)), 'rejected');
        await addIdentities(tx, customer, Object.fromEntries(confirmed.map((c) => [c.type, c.value])), manifest);
        const changed = row.status !== 'found' || row.customerRef !== option.customerRef || !row.confirmed;
        return { link: updated, changed, chosen: option, claims };
      }

      const data: Prisma.CustomerLinkUpdateInput = { pending: Prisma.DbNull };
      if (pending.kind === 'confirm' && pending.previous) {
        Object.assign(data, {
          status: pending.previous.status,
          customerRef: pending.previous.customerRef,
          displayName: pending.previous.displayName,
          candidates: json(pending.previous.candidates ?? []),
          matchedBy: pending.previous.matchedBy,
          source: 'auto',
          confirmed: true,
        });
      } else if (pending.kind === 'conflict') {
        // Neither of the two: nobody is linked until the operator finds the customer by hand.
        Object.assign(data, { status: 'not_found', customerRef: null, displayName: null, candidates: json([]), matchedBy: [], source: 'manual', confirmed: true });
      }
      const updated = await tx.customerLink.update({ where: { id: row.id }, data });
      await setClaimStatus(tx, claims, 'rejected');
      return { link: updated, changed: pending.kind === 'confirm' || pending.kind === 'conflict', chosen: null, claims };
    });

    const claims = await this.prisma.identityClaim.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
    return { link: toLinkDto(integration, manifest, result.link, claims), changed: result.changed, chosen: result.chosen, claims: result.claims };
  }

  private async applyOutcome(
    customer: CustomerWithIdentities,
    integration: Integration,
    ticket: { id: string; workspaceId: string },
    link: CustomerLink,
    batch: IdentityClaim[],
    outcome: ClaimOutcome,
    now: Date,
    source: 'claim' | 'manual',
  ): Promise<CustomerLink> {
    const matchedTypes = new Set(
      outcome.kind === 'agree'
        ? outcome.matchedBy
        : outcome.kind === 'link'
          ? outcome.option.matchedBy
          : outcome.kind === 'not_found'
            ? []
            : outcome.options.flatMap((o) => o.matchedBy),
    );
    const matched = batch.filter((c) => matchedTypes.has(c.type));
    const unmatched = batch.filter((c) => !matchedTypes.has(c.type));
    const manifest = parseStoredManifest(integration)!;

    return this.prisma.$transaction(async (tx) => {
      await setClaimStatus(tx, unmatched, 'not_found');
      const event = async (data: Record<string, unknown>) =>
        recordEvent(tx, {
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          type: 'customer_identification',
          actor: SYSTEM_ACTOR,
          data: { integrationId: integration.id, integration: integration.name, identities: batch.map(claimView), ...data },
        });
      const pendingOf = (eventId: string, kind: PendingIdentification['kind'], options: PendingOption[], previous: PendingIdentification['previous'] = null): PendingIdentification => ({
        kind,
        ticketId: ticket.id,
        eventId,
        claimIds: matched.map((c) => c.id),
        options,
        previous,
        createdAt: now.toISOString(),
      });

      switch (outcome.kind) {
        case 'agree': {
          // The values confirm the customer already found: they are the customer's identities now (if the link is confirmed).
          await setClaimStatus(tx, matched, link.confirmed ? 'confirmed' : 'matched');
          if (link.confirmed) await addIdentities(tx, customer, Object.fromEntries(matched.map((c) => [c.type, c.value])), manifest);
          return link;
        }
        case 'not_found': {
          await event({ kind: 'not_found' });
          return link;
        }
        case 'ignored': {
          await setClaimStatus(tx, matched, 'matched');
          await event({ kind: 'ignored', options: outcome.options });
          return link;
        }
        case 'link': {
          const { option, confirmed } = outcome;
          const eventId = await event({ kind: confirmed ? 'linked' : 'confirm', options: [option], customerRef: option.customerRef, displayName: option.displayName, matchedBy: option.matchedBy });
          await setClaimStatus(tx, matched, confirmed ? 'confirmed' : 'matched');
          if (confirmed) await addIdentities(tx, customer, Object.fromEntries(matched.map((c) => [c.type, c.value])), manifest);
          const previous = { status: link.status, customerRef: link.customerRef, displayName: link.displayName, candidates: link.candidates, matchedBy: link.matchedBy };
          return tx.customerLink.update({
            where: { id: link.id },
            data: {
              status: 'found',
              customerRef: option.customerRef,
              displayName: option.displayName,
              candidates: json([]),
              source,
              confirmed,
              matchedBy: option.matchedBy,
              pending: confirmed ? Prisma.DbNull : json(pendingOf(eventId, 'confirm', [option], previous)),
              lastError: null,
              resolvedAt: now,
            },
          });
        }
        case 'suggestion':
        case 'candidates':
        case 'conflict': {
          const eventId = await event({ kind: outcome.kind, options: outcome.options });
          await setClaimStatus(tx, matched, 'matched');
          return tx.customerLink.update({
            where: { id: link.id },
            // In a conflict nobody is certain: the current customer's actions wait for the operator too.
            data: { pending: json(pendingOf(eventId, outcome.kind, outcome.options)), ...(outcome.kind === 'conflict' ? { confirmed: false } : {}) },
          });
        }
      }
    });
  }

  private async resolve(integration: Integration, identities: Record<string, string>): Promise<ResolveCall> {
    const started = Date.now();
    try {
      const result = await this.integrations.client(integration).resolve(identities);
      return { identities, result, error: null, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof IntegrationError ? `${error.code}: ${error.message}` : String(error);
      return { identities, result: null, error: message, durationMs: Date.now() - started };
    }
  }

  private async save(
    customer: Customer,
    integration: Integration,
    result: ResolveResponse,
    options: { hash: string | null; source: 'auto' | 'manual'; now: Date },
  ): Promise<CustomerLink> {
    const data = {
      status: result.status,
      customerRef: result.status === 'found' ? result.customer_ref : null,
      displayName: result.status === 'found' ? (result.display_name ?? null) : null,
      candidates: json(
        result.status === 'ambiguous'
          ? result.candidates.map((c) => ({ customerRef: c.customer_ref, displayName: c.display_name, hint: c.hint ?? null, matchedBy: c.matched_by ?? [] }))
          : [],
      ),
      source: options.source,
      confirmed: true,
      matchedBy: result.status === 'found' ? (result.matched_by ?? []) : [],
      pending: Prisma.DbNull,
      identitiesHash: options.hash,
      lastError: null,
      resolvedAt: options.now,
    };
    return this.prisma.customerLink.upsert({
      where: { customerId_integrationId: { customerId: customer.id, integrationId: integration.id } },
      update: data,
      create: { id: newId(), workspaceId: customer.workspaceId, customerId: customer.id, integrationId: integration.id, ...data },
    });
  }
}

/** The contacts the customer was found by will help in later tickets too — if nobody owns them. */
async function addIdentities(
  db: Pick<Prisma.TransactionClient, 'customerIdentity'>,
  customer: CustomerWithIdentities,
  identities: Record<string, string>,
  manifest: Manifest,
): Promise<void> {
  for (const [type, raw] of Object.entries(identities)) {
    const value = normalizeIdentity(type, raw, manifest.identity_types.find((i) => i.type === type)?.normalize ?? null);
    if (customer.identities.some((i) => i.type === type && i.value === value)) continue;
    const owner = await db.customerIdentity.findFirst({ where: { workspaceId: customer.workspaceId, type, value } });
    if (owner) continue;
    try {
      await db.customerIdentity.create({ data: { id: newId(), workspaceId: customer.workspaceId, customerId: customer.id, type, value } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

async function setClaimStatus(db: Pick<Prisma.TransactionClient, 'identityClaim'>, claims: IdentityClaim[], status: ClaimStatus): Promise<void> {
  if (claims.length === 0) return;
  await db.identityClaim.updateMany({ where: { id: { in: claims.map((c) => c.id) } }, data: { status } });
}

function claimView(claim: IdentityClaim): Record<string, unknown> {
  return { id: claim.id, type: claim.type, value: claim.value, source: claim.source, ruleName: claim.ruleName, evidence: claim.evidence };
}

/** Customer identities the backend can search by (one per type). */
export function identitiesFor(customer: CustomerWithIdentities, manifest: Manifest): Record<string, string> {
  const allowed = manifest.identity_types.length > 0 ? new Set(manifest.identity_types.map((i) => i.type)) : null;
  const identities: Record<string, string> = {};
  for (const identity of customer.identities) {
    if ((allowed === null || allowed.has(identity.type)) && identities[identity.type] === undefined) {
      identities[identity.type] = identity.value;
    }
  }
  return identities;
}

function identitiesHash(identities: Record<string, string>): string {
  return createHash('sha256').update(stableStringify(identities)).digest('hex');
}

function integrationFailure(error: unknown): Error {
  const message = error instanceof IntegrationError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  return errors.conflict(t('api.integrationFailed', { error: message }));
}

export function toClaimDto(claim: IdentityClaim): IdentityClaimDto {
  return {
    id: claim.id,
    type: claim.type,
    value: claim.value,
    source: claim.source as ClaimSource,
    trust: claim.trust as IdentityTrust,
    status: claim.status as ClaimStatus,
    ruleName: claim.ruleName,
    evidence: claim.evidence,
    messageId: claim.messageId,
    createdAt: claim.createdAt.toISOString(),
  };
}

export function toLinkDto(integration: Integration, manifest: Manifest, link: CustomerLink | null, claims: IdentityClaim[] = []): CustomerLinkDto {
  const types = new Set(manifest.identity_types.map((i) => i.type));
  return {
    integrationId: integration.id,
    integrationName: integration.name,
    status: (link?.status as CustomerLinkDto['status'] | undefined) ?? 'unresolved',
    customerRef: link?.customerRef ?? null,
    displayName: link?.displayName ?? null,
    candidates: (link?.candidates as CustomerLinkDto['candidates'] | undefined) ?? [],
    source: (link?.source as CustomerLinkDto['source'] | undefined) ?? null,
    confirmed: link?.confirmed ?? true,
    matchedBy: link?.matchedBy ?? [],
    pending: (link?.pending as PendingIdentification | null | undefined) ?? null,
    resolvedAt: link?.resolvedAt.toISOString() ?? null,
    lastError: link?.lastError ?? null,
    identityTypes: manifest.identity_types.map((i) => ({
      type: i.type,
      label: i.label ?? null,
      pattern: i.pattern ?? null,
      normalize: i.normalize ?? null,
      description: i.description ?? null,
    })),
    claims: claims.filter((c) => types.size === 0 || types.has(c.type)).map(toClaimDto),
  };
}
