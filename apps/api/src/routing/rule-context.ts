import type { FieldValues } from '@kvitok/shared';
import type { Channel, Customer, CustomerIdentity, Department, Message, Ticket } from '../generated/prisma/client';
import type { RuleContextData } from './rules-engine';

const DEFAULT_TIMEZONE = 'Europe/Moscow';

export interface RuleContextInput {
  ticket: Ticket & { channel: Channel | null; customer: (Customer & { identities: CustomerIdentity[] }) | null };
  /** The customer message whose subject and text are checked (usually the first or the last one). */
  message: Pick<Message, 'subject' | 'bodyText' | 'bodyClean' | 'fromEmail' | 'headers'> | null;
  departments: Map<string, Pick<Department, 'id' | 'key'>>;
  agent?: RuleContextData['agent'];
  now?: Date;
  timezone?: string;
}

export function buildRuleContext(input: RuleContextInput): RuleContextData {
  const { ticket, message } = input;
  const fromEmail = message?.fromEmail ?? null;
  const metadata = ((message?.headers as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
  const identity: Record<string, string[]> = {};
  for (const item of ticket.customer?.identities ?? []) {
    (identity[item.type] ??= []).push(item.value);
  }

  return {
    subject: message?.subject ?? ticket.subject,
    body: message?.bodyClean ?? message?.bodyText ?? '',
    channel: ticket.channel ? { id: ticket.channel.id, type: ticket.channel.type } : null,
    from: fromEmail ? { email: fromEmail, domain: fromEmail.split('@')[1] ?? '' } : null,
    metadata,
    fields: ticket.fields as FieldValues,
    customer: ticket.customer ? { fields: ticket.customer.fields as FieldValues, identity } : null,
    ticket: {
      priority: ticket.priority,
      department: ticket.departmentId ? (input.departments.get(ticket.departmentId)?.key ?? null) : null,
      tags: ticket.tags,
      status: ticket.status,
    },
    time: localTime(input.now ?? new Date(), input.timezone ?? DEFAULT_TIMEZONE),
    ...(input.agent ? { agent: input.agent } : {}),
  };
}

function localTime(now: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayName) + 1;
  return { hour, weekday };
}
