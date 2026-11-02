import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  type ClaimSource,
  type CreateIdentificationRuleInput,
  type CustomerFrom,
  type IdentificationCheckDto,
  type IdentificationRuleDto,
  type IdentificationSettingsDto,
  type IdentityExtract,
  type IdentityNormalization,
  type IdentityTrust,
  normalizeIdentity,
  type RuleCondition,
  type TrustSender,
  type UpdateIdentificationRuleInput,
} from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { CustomerInput } from '../customers/customers.service';
import { ticketScopeWhere, type TicketAccess } from '../departments/department-access';
import type { IdentificationRule, IdentityClaim, Prisma } from '../generated/prisma/client';
import { parseStoredManifest } from '../integrations/integrations.service';
import { senderAuthenticated } from '../mail/authentication';
import { PrismaService } from '../prisma/prisma.service';
import { identify, type IdentificationContext, type IdentificationRuleLike, type ManifestIdentityPattern } from './identify';

type Db = Pick<Prisma.TransactionClient, 'identificationRule' | 'integration' | 'workspace' | 'identityClaim' | 'customerIdentity'>;

/** The message as a channel adapter delivered it: what identification looks at before the customer is known. */
export interface InboundIdentificationInput {
  workspaceId: string;
  channel: { id: string; type: string };
  source: 'email' | 'api';
  subject: string;
  body: string;
  fromEmail: string | null;
  replyTo: { email: string; name: string | null } | null;
  /** What the receiving server said about the sender; null — nothing (or not an email). */
  senderAuthenticated: boolean | null;
  /** All headers of an email, names in lowercase. */
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
  /** The customer as the channel sees it: its identities are trusted. */
  customer: CustomerInput;
  /** Identities the API source does not vouch for. */
  unverifiedIdentities?: Record<string, string>;
}

/** A value to store as an identity claim of the ticket. */
export interface ClaimInput {
  type: string;
  value: string;
  source: ClaimSource;
  trust: IdentityTrust;
  ruleId: string | null;
  ruleName: string | null;
  integrationId: string | null;
  integrationName: string | null;
  evidence: string | null;
}

export interface InboundIdentification {
  /** The customer to resolve in Kvitok: only trusted identities. */
  customer: CustomerInput;
  /** A form email: the customer participant (the reply address) instead of the sender. */
  customerParticipant: { email: string; name: string | null } | null;
  customerFrom: CustomerFrom;
  claims: ClaimInput[];
  matched: Array<{ id: string; name: string }>;
}

@Injectable()
export class IdentificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<IdentificationRuleDto[]> {
    const rows = await this.prisma.identificationRule.findMany({ where: { workspaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toIdentificationRuleDto);
  }

  async create(workspaceId: string, input: CreateIdentificationRuleInput): Promise<IdentificationRuleDto> {
    const row = await this.prisma.identificationRule.create({
      data: {
        id: newId(),
        workspaceId,
        name: input.name,
        position: input.position ?? 0,
        conditions: json(input.conditions),
        customerFrom: input.customerFrom ?? 'sender',
        extract: json(input.extract ?? []),
        stop: input.stop ?? false,
        enabled: input.enabled ?? true,
      },
    });
    const dto = toIdentificationRuleDto(row);
    await this.audit.record({ workspaceId, entity: 'identification_rule', entityId: row.id, action: 'create', after: dto });
    return dto;
  }

  async update(workspaceId: string, id: string, input: UpdateIdentificationRuleInput): Promise<IdentificationRuleDto> {
    const existing = await this.get(workspaceId, id);
    const customerFrom = input.customerFrom ?? (existing.customerFrom as CustomerFrom);
    const extract = input.extract ?? (existing.extract as unknown as IdentityExtract[]);
    if (customerFrom === 'extracted_email' && !extract.some((e) => e.identityType === 'email')) {
      throw errors.validation([{ path: 'extract', message: t('validation.extractEmailRequired'), code: 'custom' }]);
    }
    const data: Prisma.IdentificationRuleUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.stop === undefined ? {} : { stop: input.stop }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.customerFrom === undefined ? {} : { customerFrom: input.customerFrom }),
      ...(input.conditions === undefined ? {} : { conditions: json(input.conditions) }),
      ...(input.extract === undefined ? {} : { extract: json(input.extract) }),
    };
    const dto = toIdentificationRuleDto(await this.prisma.identificationRule.update({ where: { id }, data }));
    await this.audit.record({ workspaceId, entity: 'identification_rule', entityId: id, action: 'update', before: toIdentificationRuleDto(existing), after: dto });
    return dto;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.get(workspaceId, id);
    await this.prisma.identificationRule.delete({ where: { id } });
    await this.audit.record({ workspaceId, entity: 'identification_rule', entityId: id, action: 'delete', before: toIdentificationRuleDto(existing) });
  }

  async settings(workspaceId: string, db: Pick<Db, 'workspace'> = this.prisma): Promise<IdentificationSettingsDto> {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    return settingsOf(workspace.settings);
  }

  async updateSettings(workspaceId: string, input: IdentificationSettingsDto): Promise<IdentificationSettingsDto> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const before = settingsOf(workspace.settings);
    const settings = { ...(workspace.settings as Record<string, unknown>), identification: { trustSender: input.trustSender } };
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { settings: json(settings) } });
    await this.audit.record({ workspaceId, entity: 'identification_settings', entityId: workspaceId, action: 'update', before, after: input });
    return input;
  }

  /**
   * Who the customer of an inbound message is and which identities it carries: rules, manifest patterns,
   * the trust in the sender. Writes nothing — the caller resolves the customer and stores the claims.
   */
  async identifyInbound(db: Db, input: InboundIdentificationInput): Promise<InboundIdentification> {
    const { rules, patterns, normalization, trustSender } = await this.inboundConfig(db, input.workspaceId);
    const outcome = identify({ ctx: inboundContext(input), rules, patterns, normalization });

    const identities: Record<string, string> = { ...input.customer.identities };
    let name = input.customer.name ?? null;
    let customerParticipant: InboundIdentification['customerParticipant'] = null;
    const claims: ClaimInput[] = [];
    const claim = (value: Omit<ClaimInput, 'ruleId' | 'ruleName' | 'integrationId' | 'integrationName'> & Partial<ClaimInput>): void => {
      claims.push({ ruleId: null, ruleName: null, integrationId: null, integrationName: null, ...value });
    };

    if (outcome.customerFrom !== 'sender') {
      // A form: the sender is the form itself, the customer is in Reply-To or in the text.
      delete identities.email;
      name = outcome.customerName ?? (outcome.customerFrom === 'reply_to' ? (input.replyTo?.name ?? null) : null);
      const email = outcome.customerEmail;
      if (email) {
        customerParticipant = { email: email.value, name };
        if (email.trust === 'trusted') identities.email = email.value;
        else claim({ type: 'email', value: email.value, source: 'rule', trust: 'claimed', evidence: null, ruleName: outcome.matched[0]?.name ?? null });
      }
    } else {
      name ??= outcome.customerName;
      if (input.source === 'email' && trustSender === 'authenticated' && input.senderAuthenticated !== true && identities.email) {
        claim({ type: 'email', value: identities.email, source: 'sender', trust: 'claimed', evidence: input.fromEmail ? `From: ${input.fromEmail}` : null });
        delete identities.email;
      }
    }

    for (const found of outcome.found) {
      if (found.trust === 'trusted' && identities[found.type] === undefined) identities[found.type] = found.value;
      claim({ ...found });
    }
    for (const [type, raw] of Object.entries(input.unverifiedIdentities ?? {})) {
      claim({ type, value: normalizeIdentity(type, raw, normalization.get(type) ?? null), source: 'api', trust: 'claimed', evidence: null });
    }

    // Values the customer is already identified by are facts, not claims.
    const facts = new Set(Object.entries(identities).map(([type, value]) => `${type}\u0000${normalizeIdentity(type, value, normalization.get(type) ?? null)}`));
    const unique = new Map<string, ClaimInput>();
    for (const item of claims) {
      const key = `${item.type}\u0000${item.value}`;
      if (item.trust === 'claimed' && facts.has(key)) continue;
      if (!unique.has(key)) unique.set(key, item);
    }

    return {
      customer: { name, identities },
      customerParticipant,
      customerFrom: outcome.customerFrom,
      claims: [...unique.values()],
      matched: outcome.matched,
    };
  }

  /**
   * Stores the claims of a message. A value the customer already rejected in another ticket is stored as rejected;
   * a trusted value from a rule is stored as confirmed — the customer has it as an identity already.
   */
  async recordClaims(
    db: Db,
    params: { workspaceId: string; ticketId: string; messageId: string | null; customerId: string | null; claims: ClaimInput[]; runId?: string | null },
  ): Promise<IdentityClaim[]> {
    // A value the customer already has as an identity is a fact, not something to check.
    const known = params.customerId
      ? new Set(
          (await db.customerIdentity.findMany({ where: { customerId: params.customerId }, select: { type: true, value: true } })).map((i) => `${i.type}\u0000${i.value}`),
        )
      : new Set<string>();
    const claims = params.claims.filter((c) => c.trust === 'trusted' || !known.has(`${c.type}\u0000${c.value}`));
    if (claims.length === 0) return [];
    const rejected = params.customerId
      ? await db.identityClaim.findMany({
          where: {
            workspaceId: params.workspaceId,
            status: 'rejected',
            ticket: { customerId: params.customerId },
            OR: claims.map((c) => ({ type: c.type, value: c.value })),
          },
          select: { type: true, value: true },
        })
      : [];
    const rejectedKeys = new Set(rejected.map((r) => `${r.type}\u0000${r.value}`));
    return db.identityClaim.createManyAndReturn({
      data: claims.map((c) => ({
        id: newId(),
        workspaceId: params.workspaceId,
        ticketId: params.ticketId,
        messageId: params.messageId,
        type: c.type,
        value: c.value,
        source: c.source,
        trust: c.trust,
        status: c.trust === 'trusted' ? 'confirmed' : rejectedKeys.has(`${c.type}\u0000${c.value}`) ? 'rejected' : 'pending',
        ruleId: c.ruleId,
        ruleName: c.ruleName,
        integrationId: c.integrationId,
        runId: params.runId ?? null,
        evidence: c.evidence,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * "Check on ticket": identification of the ticket's last customer message with the current rules, without writing anything.
   * The ticket is one the caller may see.
   */
  async check(access: TicketAccess, ticketId: string): Promise<IdentificationCheckDto> {
    const { workspaceId } = access;
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId, ...ticketScopeWhere(access) }, include: { channel: true } });
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }
    const message = await this.prisma.message.findFirst({ where: { ticketId, authorType: 'customer' }, orderBy: { createdAt: 'desc' } });
    if (message === null) {
      throw errors.notFound(t('api.messageNotFound'));
    }
    const stored = (message.headers ?? {}) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(stored).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const replyTo = parseAddress(headers['reply-to']);
    const input: InboundIdentificationInput = {
      workspaceId,
      channel: { id: ticket.channelId ?? '', type: ticket.channel?.type ?? 'api' },
      source: message.source === 'email' ? 'email' : 'api',
      subject: message.subject ?? ticket.subject,
      body: message.bodyClean ?? message.bodyText,
      fromEmail: message.fromEmail,
      replyTo,
      senderAuthenticated: message.fromEmail ? senderAuthenticated(headers['authentication-results'] ?? null, message.fromEmail) : null,
      headers,
      metadata: (stored.metadata ?? {}) as Record<string, unknown>,
      customer: { name: message.fromName, identities: message.fromEmail ? { email: message.fromEmail } : {} },
    };
    const result = await this.identifyInbound(this.prisma, input);
    return {
      matched: result.matched.map((m) => ({ ruleId: m.id, name: m.name })),
      customerFrom: result.customerFrom,
      customer: { email: result.customerParticipant?.email ?? result.customer.identities.email ?? null, name: result.customer.name ?? null },
      identities: [
        ...Object.entries(result.customer.identities).map(([type, value]) => ({ type, value, trust: 'trusted' as const, source: 'sender' as const, ruleName: null, integrationName: null })),
        ...result.claims
          .filter((c) => !(c.trust === 'trusted' && result.customer.identities[c.type] === c.value))
          .map((c) => ({ type: c.type, value: c.value, trust: c.trust, source: c.source, ruleName: c.ruleName, integrationName: c.integrationName })),
      ],
      context: inboundContext(input) as unknown as Record<string, unknown>,
    };
  }

  /** Enabled rules, manifest patterns of integrations that look for identities in text, the type normalizations. */
  private async inboundConfig(db: Db, workspaceId: string) {
    const [ruleRows, integrations, settings] = await Promise.all([
      db.identificationRule.findMany({ where: { workspaceId, enabled: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
      db.integration.findMany({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } }),
      this.settings(workspaceId, db),
    ]);
    const patterns: ManifestIdentityPattern[] = [];
    const normalization = new Map<string, IdentityNormalization | null>();
    for (const row of integrations) {
      const manifest = parseStoredManifest(row);
      if (!manifest) continue;
      for (const identity of manifest.identity_types) {
        if (!normalization.has(identity.type)) normalization.set(identity.type, identity.normalize ?? null);
        if (identity.pattern && row.textIdentities) {
          patterns.push({ integrationId: row.id, integrationName: row.name, type: identity.type, pattern: identity.pattern, normalize: identity.normalize ?? null });
        }
      }
    }
    const rules: IdentificationRuleLike[] = ruleRows.map(toIdentificationRuleDto);
    return { rules, patterns, normalization, trustSender: settings.trustSender };
  }

  private async get(workspaceId: string, id: string): Promise<IdentificationRule> {
    const row = await this.prisma.identificationRule.findFirst({ where: { id, workspaceId } });
    if (row === null) {
      throw errors.notFound(t('api.ruleNotFound'));
    }
    return row;
  }
}

function inboundContext(input: InboundIdentificationInput): IdentificationContext {
  const domain = (email: string) => email.split('@')[1] ?? '';
  return {
    subject: input.subject,
    body: input.body,
    channel: input.channel,
    from: input.fromEmail ? { email: input.fromEmail, domain: domain(input.fromEmail) } : null,
    reply_to: input.replyTo ? { email: input.replyTo.email, domain: domain(input.replyTo.email) } : null,
    sender: { authenticated: input.senderAuthenticated },
    metadata: input.metadata,
    header: input.headers,
  };
}

function settingsOf(raw: unknown): IdentificationSettingsDto {
  const trustSender = ((raw ?? {}) as { identification?: { trustSender?: TrustSender } }).identification?.trustSender;
  return { trustSender: trustSender === 'authenticated' ? 'authenticated' : 'always' };
}

/** `"Anna" <anna@example.com>` or `anna@example.com` → the address and the name. */
function parseAddress(value: string | undefined): { email: string; name: string | null } | null {
  if (!value) return null;
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value) ?? /^\s*()([^<>\s]+@[^<>\s]+)\s*$/.exec(value);
  if (!match) return null;
  return { email: match[2]!.toLowerCase(), name: match[1]?.trim() || null };
}

export function toIdentificationRuleDto(row: IdentificationRule): IdentificationRuleDto {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    conditions: row.conditions as unknown as RuleCondition,
    customerFrom: row.customerFrom as CustomerFrom,
    extract: row.extract as unknown as IdentityExtract[],
    stop: row.stop,
    enabled: row.enabled,
  };
}
