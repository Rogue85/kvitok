import type { DepartmentDto, FieldDefinitionDto, MemberDto, TicketEventDto, TicketPriority, TicketStatus } from '@kvitok/shared';
import { formatFieldValue, priorityLabel, statusLabel } from './format';
import { t } from './i18n';

export interface EventLookups {
  departments: Map<string, DepartmentDto>;
  members: Map<string, MemberDto>;
  fields: Map<string, FieldDefinitionDto>;
}

const ACTORS = ['system', 'channel', 'rule', 'agent'] as const;

export function eventActor(event: TicketEventDto): string {
  const type = ACTORS.find((a) => a === event.actorType);
  return event.actor?.name ?? (type ? t(`events.actor.${type}`) : '');
}

export function eventIcon(event: TicketEventDto): string {
  const icons: Record<string, string> = {
    ticket_created: 'i-lucide-inbox',
    status_changed: 'i-lucide-circle-dot',
    priority_changed: 'i-lucide-flag',
    department_changed: 'i-lucide-users',
    assignee_changed: 'i-lucide-user-check',
    tags_changed: 'i-lucide-tag',
    field_changed: 'i-lucide-list',
    fields_rejected: 'i-lucide-triangle-alert',
    reply_cancelled: 'i-lucide-undo-2',
    delivery_failed: 'i-lucide-circle-x',
    delivery_bounced: 'i-lucide-mail-x',
    subject_changed: 'i-lucide-pencil',
    agent_analyzed: 'i-lucide-sparkles',
    agent_failed: 'i-lucide-bot-off',
    customer_linked: 'i-lucide-link',
    action_approved: 'i-lucide-check',
    action_rejected: 'i-lucide-x',
    action_retried: 'i-lucide-rotate-ccw',
    action_executed: 'i-lucide-zap',
    action_failed: 'i-lucide-circle-x',
  };
  return icons[event.type] ?? 'i-lucide-dot';
}

export function eventText(event: TicketEventDto, lookups: EventLookups): string {
  const d = event.data as Record<string, unknown>;
  const dept = (id: unknown) =>
    typeof id === 'string' ? (lookups.departments.get(id)?.title ?? t('events.deletedDepartment')) : t('events.noDepartment');
  const member = (id: unknown) => (typeof id === 'string' ? (lookups.members.get(id)?.name ?? t('events.formerMember')) : t('events.nobody'));
  const percent = (value: unknown) => Math.round(Number(value) * 100);
  const action = String(d.preview ?? d.title);

  switch (event.type) {
    case 'ticket_created':
      return t('events.ticketCreated', { source: d.source === 'email' ? 'email' : 'API' });
    case 'status_changed':
      return t('events.statusChanged', { from: statusLabel(d.from as TicketStatus), to: statusLabel(d.to as TicketStatus) });
    case 'priority_changed':
      return t('events.priorityChanged', { from: priorityLabel(d.from as TicketPriority), to: priorityLabel(d.to as TicketPriority) });
    case 'department_changed': {
      const text = t('events.departmentChanged', { from: dept(d.from), to: dept(d.to) });
      return typeof d.confidence === 'number' ? `${text} ${t('events.departmentByAgent', { percent: percent(d.confidence) })}` : text;
    }
    case 'assignee_changed':
      return t('events.assigneeChanged', { from: member(d.from), to: member(d.to) });
    case 'tags_changed': {
      const added = (d.added as string[]).map((tag) => `+${tag}`);
      const removed = (d.removed as string[]).map((tag) => `−${tag}`);
      return t('events.tagsChanged', { tags: [...added, ...removed].join(' ') });
    }
    case 'subject_changed':
      return t('events.subjectChanged', { subject: String(d.to) });
    case 'field_changed': {
      const field = lookups.fields.get(String(d.key));
      const text = t('events.fieldChanged', {
        label: field?.label ?? String(d.key),
        from: formatFieldValue(d.old, field?.options),
        to: formatFieldValue(d.new, field?.options),
      });
      const source = d.source === 'agent' || d.source === 'rule' || d.source === 'ingest' ? d.source : null;
      return source ? `${text} ${t(`events.bySource.${source}`)}` : text;
    }
    case 'fields_rejected':
      return t('events.fieldsRejected', {
        fields: (d.rejected as Array<{ key: string; reason: string }>).map((r) => `${r.key} (${r.reason})`).join(', '),
      });
    case 'reply_cancelled':
      return t('events.replyCancelled');
    case 'delivery_failed':
      return t(d.kind === 'email' ? 'events.deliveryFailedEmail' : 'events.deliveryFailedWebhook', { error: String(d.error ?? '') });
    case 'delivery_bounced':
      return t('events.deliveryBounced', { reason: String(d.reason ?? '') });
    case 'agent_analyzed': {
      const department =
        typeof d.department === 'string'
          ? ([...lookups.departments.values()].find((x) => x.key === d.department)?.title ?? d.department)
          : t('events.undetermined');
      const text = t(d.mode === 'refine' ? 'events.agentRefined' : 'events.agentAnalyzed', { department });
      const confidence = typeof d.confidence === 'number' ? t('events.confidenceSuffix', { percent: percent(d.confidence) }) : '';
      return `${text}${confidence}${d.sentToTriage ? ` ${t('events.toTriage')}` : ''}`;
    }
    case 'customer_linked': {
      const text = t('events.customerLinked', {
        integration: String(d.integration ?? t('events.integrationFallback')),
        customer: String(d.displayName ?? t('events.customerFound')),
      });
      return d.source === 'manual' ? `${text} ${t('events.linkedByOperator')}` : text;
    }
    case 'action_approved':
      return `${t('events.actionApproved', { action })}${d.comment ? ` ${t('events.approvalComment', { comment: String(d.comment) })}` : ''}`;
    case 'action_rejected':
      return `${t('events.actionRejected', { action })}${d.comment ? ` ${t('events.rejectionComment', { comment: String(d.comment) })}` : ''}`;
    case 'action_retried':
      return t('events.actionRetried', { action: String(d.title) });
    case 'action_executed':
      return `${t('events.actionExecuted', { action })}${d.externalRef ? ` (${String(d.externalRef)})` : ''}`;
    case 'action_failed':
      return t('events.actionFailed', { action: String(d.title), error: String(d.error ?? '') });
    case 'agent_failed':
      return t('events.agentFailed', { error: String(d.error ?? '') });
    default:
      return event.type;
  }
}
