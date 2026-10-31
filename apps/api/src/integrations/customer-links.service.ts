import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IntegrationError, type Manifest, type ResolveResponse } from '@kvitok/protocol';
import { normalizeIdentity, type CustomerLinkDto, type LinkCustomerInput } from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { isUniqueViolation } from '../common/prisma-errors';
import { stableStringify } from '../common/stable-json';
import type { Customer, CustomerIdentity, CustomerLink, Integration } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationsService, parseStoredManifest } from './integrations.service';

/** Not found or several found — repeat the search no more often than this: the customer may have registered. */
const RETRY_UNRESOLVED_MS = 5 * 60 * 1000;

export type CustomerWithIdentities = Customer & { identities: CustomerIdentity[] };

/** What the search did — the agent engine records it as a run step. */
export interface ResolveCall {
  identities: Record<string, string>;
  result: ResolveResponse | null;
  error: string | null;
  durationMs: number;
}

@Injectable()
export class CustomerLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  /**
   * Customer link for an agent run. Searches if not searched yet, if the contacts changed
   * or the last search was inconclusive long ago. Never revises an operator's choice.
   */
  async ensure(customer: CustomerWithIdentities, integration: Integration, manifest: Manifest, now = new Date()): Promise<{ link: CustomerLink | null; call: ResolveCall | null }> {
    const existing = await this.prisma.customerLink.findUnique({ where: { customerId_integrationId: { customerId: customer.id, integrationId: integration.id } } });
    const identities = identitiesFor(customer, manifest);
    const hash = identitiesHash(identities);
    if (existing?.source === 'manual') return { link: existing, call: null };
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

  /** Customer links of the ticket for every enabled integration with a manifest. */
  async listForTicket(workspaceId: string, ticketId: string): Promise<CustomerLinkDto[]> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { customerId: true } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    const integrations = await this.prisma.integration.findMany({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    const links = ticket.customerId ? await this.prisma.customerLink.findMany({ where: { customerId: ticket.customerId } }) : [];
    return integrations.flatMap((integration) => {
      const manifest = parseStoredManifest(integration);
      if (!manifest) return [];
      return [toLinkDto(integration, manifest, links.find((l) => l.integrationId === integration.id) ?? null)];
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
        await this.addIdentities(customer, input.identities);
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

    const changed = saved?.status === 'found' && (before?.status !== 'found' || before.customerRef !== saved.customerRef);
    return { outcome: outcome.status, link: toLinkDto(integration, manifest, saved), changed };
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
        result.status === 'ambiguous' ? result.candidates.map((c) => ({ customerRef: c.customer_ref, displayName: c.display_name, hint: c.hint ?? null })) : [],
      ),
      source: options.source,
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

  /** The contacts the operator found the customer by will help in later tickets too — if nobody owns them. */
  private async addIdentities(customer: CustomerWithIdentities, identities: Record<string, string>): Promise<void> {
    for (const [type, raw] of Object.entries(identities)) {
      const value = normalizeIdentity(type, raw);
      if (customer.identities.some((i) => i.type === type && i.value === value)) continue;
      try {
        await this.prisma.customerIdentity.create({ data: { id: newId(), workspaceId: customer.workspaceId, customerId: customer.id, type, value } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }
}

/** Customer identities the backend can search by (one per type). */
export function identitiesFor(customer: CustomerWithIdentities, manifest: Manifest): Record<string, string> {
  const allowed = manifest.identity_types.length > 0 ? new Set(manifest.identity_types) : null;
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

export function toLinkDto(integration: Integration, manifest: Manifest, link: CustomerLink | null): CustomerLinkDto {
  return {
    integrationId: integration.id,
    integrationName: integration.name,
    status: (link?.status as CustomerLinkDto['status'] | undefined) ?? 'unresolved',
    customerRef: link?.customerRef ?? null,
    displayName: link?.displayName ?? null,
    candidates: (link?.candidates as CustomerLinkDto['candidates'] | undefined) ?? [],
    source: (link?.source as CustomerLinkDto['source'] | undefined) ?? null,
    resolvedAt: link?.resolvedAt.toISOString() ?? null,
    lastError: link?.lastError ?? null,
    identityTypes: manifest.identity_types,
  };
}
