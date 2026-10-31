import { t } from '@kvitok/i18n';
import { Inject, Injectable } from '@nestjs/common';
import { AgentTriggerService } from '../agent/agent-trigger.service';
import { apiConfig } from '../channels/channel-config';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { buildRuleContext } from '../routing/rule-context';
import { RuleApplier } from '../routing/rule-applier';
import { RoutingRulesService } from '../routing/routing-rules.service';
import { evaluateRules } from '../routing/rules-engine';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { isUniqueViolation } from '../common/prisma-errors';
import { CustomersService, type CustomerInput } from '../customers/customers.service';
import { applyFieldValues } from '../fields/field-values';
import { FieldsService } from '../fields/fields.service';
import { IdentificationService } from '../identification/identification.service';
import type { Channel, Prisma, Ticket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, type Actor } from '../tickets/ticket-events';
import { TicketsService } from '../tickets/tickets.service';
import type { FieldMeta, FieldValues, IngestMessageInput } from '@kvitok/shared';

export interface StoredAttachment {
  filename: string;
  contentType: string;
  size: number;
  storageKey: string;
  contentId?: string | null;
}

/** An incoming customer message from any channel, already normalized by the channel adapter. */
export interface InboundMessage {
  channel: Channel;
  source: 'api' | 'email';
  /** The thread is already resolved by the adapter (e.g. by In-Reply-To). */
  ticketId?: string;
  conversationExternalId?: string;
  customer: CustomerInput & { fields?: Record<string, unknown> };
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  bodyClean?: string | null;
  externalId?: string;
  /** When the message was sent (history import). If not set or in the future — the time of receipt. */
  sentAt?: Date;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  fromEmail?: string | null;
  fromName?: string | null;
  /** An email's Reply-To: the customer of a form email. */
  replyTo?: { email: string; name: string | null } | null;
  /** The receiving server's verdict on the sender (DMARC/DKIM); null — nothing was said. */
  senderAuthenticated?: boolean | null;
  /** All headers of an email for identification rules; not stored. */
  allHeaders?: Record<string, string>;
  /** Identities the API source does not vouch for: checked like values from the text. */
  unverifiedIdentities?: Record<string, string>;
  to?: string[];
  cc?: string[];
  headers?: Record<string, unknown> | null;
  /** An auto-reply: written to the ticket, but it neither reopens the ticket nor wakes the agent. */
  isAutomated?: boolean;
  ticketFields?: Record<string, unknown>;
  participants?: Array<{ email: string; name?: string | null; role: 'customer' | 'cc' }>;
  attachments?: StoredAttachment[];
}

/** A message from an API source, as the ingest endpoint receives it. */
export type ApiIngestMessage = Required<Pick<IngestMessageInput, 'customer'>> & IngestMessageInput;

export interface InboundResult {
  ticketId: string;
  ticketNumber: number;
  messageId: string;
  ticketCreated: boolean;
  duplicate: boolean;
  rejectedFields: Array<{ key: string; reason: string }>;
}

const REOPEN_STATUSES = new Set(['pending', 'resolved', 'closed']);

@Injectable()
export class InboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly fields: FieldsService,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
    private readonly rules: RoutingRulesService,
    private readonly ruleApplier: RuleApplier,
    private readonly identification: IdentificationService,
    private readonly agent: AgentTriggerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** A message from an API channel: metadata mapped to fields, the customer's email becomes a participant. */
  receiveApi(channel: Channel, body: ApiIngestMessage): Promise<InboundResult> {
    const mapped = mapMetadata(body.metadata ?? {}, apiConfig(channel).metadataMapping);
    const email = body.customer.identities?.email;
    return this.receive({
      channel,
      source: 'api',
      conversationExternalId: body.conversation_external_id,
      customer: { name: body.customer.name, identities: body.customer.identities ?? {}, fields: body.customer.fields },
      unverifiedIdentities: body.customer.unverified_identities,
      subject: body.subject ?? '',
      bodyText: body.body,
      bodyHtml: body.body_html ?? null,
      bodyClean: body.body,
      externalId: body.external_id,
      sentAt: body.sent_at ? new Date(body.sent_at) : undefined,
      fromName: body.customer.name ?? null,
      fromEmail: email ? email.trim().toLowerCase() : null,
      ticketFields: { ...mapped, ...(body.fields ?? {}) },
      headers: body.metadata ? { metadata: body.metadata } : null,
      participants: email ? [{ email: email.trim().toLowerCase(), name: body.customer.name ?? null, role: 'customer' }] : [],
    });
  }

  async receive(input: InboundMessage): Promise<InboundResult> {
    const duplicate = await this.findDuplicate(input);
    if (duplicate) {
      return duplicate;
    }

    try {
      const result = await this.prisma.$transaction((tx) => this.receiveInTx(tx, input));
      await this.realtime.publish(input.channel.workspaceId, {
        type: result.ticketCreated ? 'ticket.created' : 'message.created',
        ticketId: result.ticketId,
        ...(result.ticketCreated ? {} : { messageId: result.messageId }),
      } as never);
      if (!input.isAutomated) {
        await this.agent.trigger(
          result.ticketId,
          result.ticketCreated ? { type: 'ticket_created', messageId: result.messageId } : { type: 'customer_message', messageId: result.messageId },
          { mode: 'triage', delay: result.ticketCreated ? 0 : 'debounce' },
        );
      }
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.findDuplicate(input);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  private async receiveInTx(tx: Prisma.TransactionClient, input: InboundMessage): Promise<InboundResult> {
    const workspaceId = input.channel.workspaceId;
    const actor: Actor = { type: 'channel', id: input.channel.id };
    const now = new Date();
    const sentAt = input.sentAt && input.sentAt < now ? input.sentAt : now;

    // Who the customer is: the sender, or the person a form email is about; values from the text become claims.
    const identification = input.isAutomated
      ? null
      : await this.identification.identifyInbound(tx, {
          workspaceId,
          channel: { id: input.channel.id, type: input.channel.type },
          source: input.source,
          subject: input.subject,
          body: input.bodyClean ?? input.bodyText,
          fromEmail: input.fromEmail ?? null,
          replyTo: input.replyTo ?? null,
          senderAuthenticated: input.senderAuthenticated ?? null,
          headers: input.allHeaders ?? {},
          metadata: ((input.headers as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>,
          customer: input.customer,
          unverifiedIdentities: input.unverifiedIdentities,
        });
    const customer = await this.customers.resolve(tx, workspaceId, identification?.customer ?? input.customer);
    const participants = identification?.customerParticipant
      ? [
          { email: identification.customerParticipant.email, name: identification.customerParticipant.name, role: 'customer' as const },
          ...(input.participants ?? []).filter((p) => p.role !== 'customer' && p.email !== identification.customerParticipant!.email),
        ]
      : identification?.customerFrom && identification.customerFrom !== 'sender'
        ? (input.participants ?? []).filter((p) => p.role !== 'customer')
        : (input.participants ?? []);
    const rejectedFields: InboundResult['rejectedFields'] = [];

    if (customer !== null && input.customer.fields && Object.keys(input.customer.fields).length > 0) {
      const applied = applyFieldValues({
        definitions: await this.fields.list(workspaceId, 'customer', tx),
        values: customer.fields as FieldValues,
        meta: customer.fieldMeta as unknown as FieldMeta,
        input: input.customer.fields,
        source: 'ingest',
      });
      rejectedFields.push(...applied.rejected.map((r) => ({ key: `customer.${r.key}`, reason: r.reason })));
      if (applied.changes.length > 0) {
        await tx.customer.update({ where: { id: customer.id }, data: { fields: json(applied.values), fieldMeta: json(applied.meta) } });
      }
    }

    let ticket = await this.findThread(tx, input, now);
    const ticketCreated = ticket === null;
    if (ticket === null) {
      ticket = await tx.ticket.create({
        data: {
          id: newId(),
          workspaceId,
          number: await this.tickets.nextNumber(tx, workspaceId),
          channelId: input.channel.id,
          customerId: customer?.id ?? null,
          subject: subjectOf(input),
          conversationExternalId: input.conversationExternalId ?? null,
          lastMessageAt: sentAt,
          createdAt: sentAt,
        },
      });
      await recordEvent(tx, { workspaceId, ticketId: ticket.id, type: 'ticket_created', actor, data: { source: input.source }, at: sentAt });
    }

    const ticketData: Prisma.TicketUpdateInput = {};
    if (ticket.lastMessageAt < sentAt) {
      ticketData.lastMessageAt = sentAt;
    }

    if (input.ticketFields && Object.keys(input.ticketFields).length > 0) {
      const applied = applyFieldValues({
        definitions: await this.fields.list(workspaceId, 'ticket', tx),
        values: ticket.fields as FieldValues,
        meta: ticket.fieldMeta as unknown as FieldMeta,
        input: input.ticketFields,
        source: 'ingest',
      });
      rejectedFields.push(...applied.rejected);
      if (applied.changes.length > 0) {
        ticketData.fields = json(applied.values);
        ticketData.fieldMeta = json(applied.meta);
        for (const change of applied.changes) {
          await recordEvent(tx, { workspaceId, ticketId: ticket.id, type: 'field_changed', actor, data: { ...change, source: 'ingest' } });
        }
      }
    }
    if (rejectedFields.length > 0) {
      await recordEvent(tx, { workspaceId, ticketId: ticket.id, type: 'fields_rejected', actor, data: { rejected: rejectedFields } });
    }

    const message = await tx.message.create({
      data: {
        id: newId(),
        workspaceId,
        ticketId: ticket.id,
        channelId: input.channel.id,
        authorType: 'customer',
        visibility: 'public',
        source: input.source,
        subject: input.subject || null,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        bodyClean: input.bodyClean ?? null,
        fromEmail: input.fromEmail ?? null,
        fromName: input.fromName ?? null,
        to: input.to ?? [],
        cc: input.cc ?? [],
        externalId: input.externalId ?? null,
        rfcMessageId: input.rfcMessageId ?? null,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? [],
        isAutomated: input.isAutomated ?? false,
        createdAt: sentAt,
        ...(input.headers ? { headers: json(input.headers) } : {}),
        attachments: input.attachments?.length
          ? { create: input.attachments.map((a) => ({ id: newId(), workspaceId, ...a, contentId: a.contentId ?? null })) }
          : undefined,
      },
    });

    if (identification && identification.claims.length > 0) {
      const claims = await this.identification.recordClaims(tx, {
        workspaceId,
        ticketId: ticket.id,
        messageId: message.id,
        customerId: ticket.customerId ?? customer?.id ?? null,
        claims: identification.claims,
      });
      if (claims.length > 0) {
        await recordEvent(tx, {
          workspaceId,
          ticketId: ticket.id,
          type: 'identities_found',
          actor,
          data: {
            identities: claims.map((c) => ({ type: c.type, value: c.value, source: c.source, trust: c.trust, status: c.status, ruleName: c.ruleName })),
            integrations: [...new Set(identification.claims.map((c) => c.integrationName).filter(Boolean))],
          },
        });
      }
    }

    for (const participant of participants) {
      await tx.participant.upsert({
        where: { ticketId_email: { ticketId: ticket.id, email: participant.email } },
        update: {},
        create: { ticketId: ticket.id, email: participant.email, name: participant.name ?? null, role: participant.role },
      });
    }

    if (ticket.customerId === null && customer !== null) {
      ticketData.customer = { connect: { id: customer.id } };
    }
    if (!input.isAutomated) {
      ticketData.revision = { increment: 1 };
      if (!ticketCreated && REOPEN_STATUSES.has(ticket.status)) {
        ticketData.status = 'open';
        ticketData.resolvedAt = null;
        await recordEvent(tx, { workspaceId, ticketId: ticket.id, type: 'status_changed', actor, data: { from: ticket.status, to: 'open' } });
      }
    }
    await tx.ticket.update({ where: { id: ticket.id }, data: ticketData });

    // on_ingest rules apply to a new ticket before the agent: department, priority, tags, fields from regular expressions, turning the agent off.
    if (ticketCreated) {
      const rules = await this.rules.forStage(workspaceId, 'on_ingest', tx);
      if (rules.length > 0) {
        // Inside a transaction queries share one connection — sequentially.
        const fresh = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id }, include: { channel: true, customer: { include: { identities: true } } } });
        const departments = await tx.department.findMany({ where: { workspaceId } });
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
        const ctx = buildRuleContext({
          ticket: fresh,
          message,
          departments: new Map(departments.map((d) => [d.id, d])),
          timezone: (workspace.settings as { timezone?: string }).timezone,
        });
        const outcome = await this.ruleApplier.apply(tx, ticket.id, evaluateRules(rules, ctx), ctx, 'on_ingest');
        if (outcome.skipAgent) {
          await tx.ticket.update({ where: { id: ticket.id }, data: { agentSkipped: true } });
        }
      }
    }

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      messageId: message.id,
      ticketCreated,
      duplicate: false,
      rejectedFields,
    };
  }

  private async findThread(tx: Prisma.TransactionClient, input: InboundMessage, now: Date): Promise<Ticket | null> {
    if (input.ticketId) {
      const ticket = await tx.ticket.findUnique({ where: { id: input.ticketId } });
      if (ticket === null) {
        return null;
      }
      // A reply to a long-closed ticket is a new request.
      const windowMs = this.config.reopenWindowDays * 24 * 60 * 60 * 1000;
      if (ticket.status === 'closed' && ticket.resolvedAt && now.getTime() - ticket.resolvedAt.getTime() > windowMs) {
        return null;
      }
      return ticket;
    }
    if (input.conversationExternalId) {
      return tx.ticket.findUnique({
        where: { channelId_conversationExternalId: { channelId: input.channel.id, conversationExternalId: input.conversationExternalId } },
      });
    }
    return null;
  }

  private async findDuplicate(input: InboundMessage): Promise<InboundResult | null> {
    const where = input.externalId
      ? { channelId: input.channel.id, externalId: input.externalId }
      : input.rfcMessageId
        ? { workspaceId: input.channel.workspaceId, rfcMessageId: input.rfcMessageId }
        : null;
    if (where === null) {
      return null;
    }
    const message = await this.prisma.message.findFirst({ where, include: { ticket: true } });
    if (message === null) {
      return null;
    }
    return {
      ticketId: message.ticketId,
      ticketNumber: message.ticket.number,
      messageId: message.id,
      ticketCreated: false,
      duplicate: true,
      rejectedFields: [],
    };
  }
}

function subjectOf(input: InboundMessage): string {
  const subject = input.subject.trim();
  if (subject !== '') {
    return subject.slice(0, 500);
  }
  const firstLine = input.bodyText.trim().split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine || t('api.noSubject');
}

/** `{ "form.category": "category" }` + metadata `{ form: { category: "bonus" } }` → `{ category: "bonus" }`. */
export function mapMetadata(metadata: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, fieldKey] of Object.entries(mapping)) {
    const value = path.split('.').reduce<unknown>(
      (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      metadata,
    );
    if (value !== undefined) {
      result[fieldKey] = value;
    }
  }
  return result;
}
