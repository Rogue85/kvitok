import type { DepartmentDto, FieldDefinitionDto, IdentityTypeDto, MemberDto, PendingOption, TicketEventDto, TicketPriority, TicketStatus } from '@kvitok/shared';
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
    assignees_changed: 'i-lucide-user-check',
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
    identities_found: 'i-lucide-scan-search',
    customer_identification: 'i-lucide-user-search',
    identification_rejected: 'i-lucide-user-x',
    action_proposed_by_operator: 'i-lucide-hand',
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
      // Unassigned because the assignee could no longer see the ticket.
      if (d.reason === 'department_access') return t('events.unassignedNoAccess', { name: member(d.from), department: dept(d.departmentId) });
      if (d.reason === 'access_removed') return t('events.unassignedAccessRemoved', { name: member(d.from), department: dept(d.departmentId) });
      if (d.reason === 'triage_changed') return t('events.unassignedTriageChanged', { name: member(d.from) });
      return t('events.assigneeChanged', { from: member(d.from), to: member(d.to) });
    case 'assignees_changed':
      return assigneesText(d, member, dept);
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
    case 'identities_found':
      return t('events.identitiesFound', { identities: identitiesText(d.identities) });
    case 'customer_identification':
      return identificationText(event);
    case 'identification_rejected':
      return t('events.identificationRejected', { identities: identitiesText(d.identities) });
    case 'action_proposed_by_operator':
      return t('events.actionProposedByOperator', { action });
    case 'action_approved': {
      const replaced = (d.replaced as Array<{ title: string }> | undefined) ?? [];
      return `${t('events.actionApproved', { action })}${d.comment ? ` ${t('events.approvalComment', { comment: String(d.comment) })}` : ''}${
        replaced.length ? ` ${t('events.actionReplacedOthers', { actions: replaced.map((r) => r.title).join(', ') })}` : ''
      }`;
    }
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

const KNOWN_IDENTITIES = ['phone', 'email', 'card_number'] as const;

/** The name of an identity type: the label from the integration manifest, a known one, or the type itself. */
export function identityLabel(type: string, types: IdentityTypeDto[] = []): string {
  const label = types.find((i) => i.type === type)?.label;
  if (label) return label;
  const known = KNOWN_IDENTITIES.find((k) => k === type);
  return known ? t(`customerLinks.identity.${known}`) : type;
}

function identitiesText(value: unknown): string {
  const list = Array.isArray(value) ? (value as Array<{ type: string; value: string; ruleName?: string | null }>) : [];
  return list.map((i) => `${identityLabel(i.type)} ${i.value}${i.ruleName ? ` (${t('events.byRule', { rule: i.ruleName })})` : ''}`).join(', ');
}

/** A line about customer identification: linked automatically, nobody found, or a decision the card asked for. */
export function identificationText(event: TicketEventDto): string {
  const d = event.data as { kind?: string; integration?: string; identities?: unknown; options?: PendingOption[]; displayName?: string | null };
  const identities = identitiesText(d.identities);
  const customers = (d.options ?? []).map((o) => o.displayName ?? o.customerRef).join(' / ');
  switch (d.kind) {
    case 'linked':
      return t('events.identification.linked', { identities, customer: d.displayName ?? customers });
    case 'not_found':
      return t('events.identification.notFound', { identities });
    case 'ignored':
      return t('events.identification.ignored', { identities, customer: customers });
    default:
      return t('events.identification.asked', { identities, customer: customers });
  }
}

/** Failures the operator must notice: never hidden in a group, shown in the error color. */
const ALERT_EVENTS = new Set(['fields_rejected', 'delivery_failed', 'delivery_bounced', 'action_failed']);

export function isAlertEvent(event: TicketEventDto): boolean {
  return ALERT_EVENTS.has(event.type);
}

/** Events that stay on their own line between groups: failures and status changes, the milestones of the conversation. */
export function isStandaloneEvent(event: TicketEventDto): boolean {
  return isAlertEvent(event) || event.type === 'status_changed';
}

/** What a run of events left behind, for its collapsed line: the latest value of each property, tags net of each other. */
export function eventsSummary(events: TicketEventDto[], lookups: EventLookups): string[] {
  const parts = new Map<string, string>();
  const tags = new Map<string, boolean>();
  const assignees = new Map<string, boolean>();
  for (const event of events) {
    const d = event.data as Record<string, unknown>;
    switch (event.type) {
      case 'ticket_created':
        parts.set('created', t('events.summary.created'));
        break;
      case 'priority_changed':
        parts.set('priority', priorityLabel(d.to as TicketPriority));
        break;
      case 'department_changed':
        parts.set(
          'department',
          typeof d.to === 'string' ? (lookups.departments.get(d.to)?.title ?? t('events.deletedDepartment')) : t('events.noDepartment'),
        );
        break;
      case 'assignee_changed':
        parts.set('assignee', typeof d.to === 'string' ? (lookups.members.get(d.to)?.name ?? t('events.formerMember')) : t('events.nobody'));
        break;
      case 'assignees_changed':
        // Someone added and removed within the run cancels out, as tags do.
        for (const id of (d.added as string[] | undefined) ?? []) (assignees.get(id) === false ? assignees.delete(id) : assignees.set(id, true));
        for (const id of (d.removed as string[] | undefined) ?? []) (assignees.get(id) === true ? assignees.delete(id) : assignees.set(id, false));
        parts.set('assignees', '');
        break;
      case 'subject_changed':
        parts.set('subject', t('events.summary.subject'));
        break;
      case 'field_changed': {
        const field = lookups.fields.get(String(d.key));
        parts.set(`field:${String(d.key)}`, `${field?.label ?? String(d.key)}: ${formatFieldValue(d.new, field?.options)}`);
        break;
      }
      case 'tags_changed':
        // A tag added and removed within the run cancels out.
        for (const tag of d.added as string[]) (tags.get(tag) === false ? tags.delete(tag) : tags.set(tag, true));
        for (const tag of d.removed as string[]) (tags.get(tag) === true ? tags.delete(tag) : tags.set(tag, false));
        parts.set('tags', '');
        break;
      case 'identities_found':
        parts.set('identities', t('events.summary.identities'));
        break;
      case 'customer_linked':
        parts.set(`customer:${String(d.integrationId ?? d.integration)}`, String(d.displayName ?? t('events.customerFound')));
        break;
      case 'customer_identification':
        parts.set(
          `customer:${String(d.integrationId)}`,
          d.kind === 'linked' && typeof d.displayName === 'string' ? d.displayName : t('events.summary.notIdentified'),
        );
        break;
      default:
        parts.set(event.id, eventText(event, lookups));
    }
  }
  const tagText = [...tags].map(([tag, added]) => `${added ? '+' : '−'}${tag}`).join(' ');
  if (tagText) parts.set('tags', tagText);
  else parts.delete('tags');
  const assigneeText = [...assignees].map(([id, added]) => `${added ? '+' : '−'}${lookups.members.get(id)?.name ?? t('events.formerMember')}`).join(' ');
  if (assigneeText) parts.set('assignees', t('events.summary.assignees', { names: assigneeText }));
  else parts.delete('assignees');
  return [...parts.values()];
}

/**
 * A change of the assignees: one event either adds or removes. Added — by hand, by a rule, in turn by the department,
 * or because they worked on the ticket; removed — by hand, or because they lost access to the ticket's department.
 */
function assigneesText(d: Record<string, unknown>, member: (id: unknown) => string, dept: (id: unknown) => string): string {
  const names = (ids: unknown) => ((ids as string[] | undefined) ?? []).map(member).join(', ');
  const added = names(d.added);
  if (added) {
    if (d.source === 'auto') return t('events.assignedInTurn', { names: added, department: dept(d.departmentId) });
    if (d.source === 'action') return t('events.assignedActive', { names: added });
    if (d.source === 'rule') return t('events.assignedByRule', { names: added });
    return t('events.assigneesAdded', { names: added });
  }
  const removed = names(d.removed);
  if (d.reason === 'department_changed') return t('events.unassignedNoAccess', { name: removed, department: dept(d.departmentId) });
  if (d.reason === 'access_removed') return t('events.unassignedAccessRemoved', { name: removed, department: dept(d.departmentId) });
  if (d.reason === 'triage_changed') return t('events.unassignedTriageChanged', { name: removed });
  return t('events.assigneesRemoved', { names: removed });
}
