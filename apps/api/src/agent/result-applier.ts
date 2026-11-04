import { Injectable } from '@nestjs/common';
import {
  fieldValueSchema,
  type AgentAnalyzedEventData,
  isEmptyFieldValue,
  type FieldMeta,
  type FieldSuggestion,
  type FieldValues,
  type TicketAnalysis,
} from '@kvitok/shared';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { applyFieldValues } from '../fields/field-values';
import type { AgentRun, Prisma } from '../generated/prisma/client';
import { textToHtml } from '../mail/html';
import { PrismaService } from '../prisma/prisma.service';
import { buildRuleContext } from '../routing/rule-context';
import { RuleApplier } from '../routing/rule-applier';
import { RoutingRulesService } from '../routing/routing-rules.service';
import { evaluateRules } from '../routing/rules-engine';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { publishAssigneeChanges, settleAssignees, takenByHuman, type AssigneeChange } from '../tickets/assignment';
import { recordDepartmentChange } from '../tickets/department-change';
import { recordEvent } from '../tickets/ticket-events';
import type { PendingProposal } from './integration-runtime';
import type { AgentConfigSnapshot, AgentDepartment } from './config-snapshot.service';
import { DraftsService } from './drafts.service';
import { lockTicket } from './agent-trigger.service';
import type { AgentResult } from './submit-schema';

export type ApplyOutcome = 'applied' | 'stale';

export interface ApplyOptions {
  /** A partial run: sections not passed stay from the previous analysis. */
  partial?: boolean;
  /** A run on an operator message: the new draft replaces the current one (the agent saw the operator's edits). */
  chat?: boolean;
  /** Actions the agent proposed in this run (they already passed the backend's validate). */
  proposals?: PendingProposal[];
}

/**
 * Applies the analysis result atomically. If the ticket changed during the run (revision grew), touches nothing.
 * Changes the department and fields only where the operator did not pin a decision; otherwise leaves suggestions.
 * The run outcome (reply to the operator, summary, questions) goes into the agent_analyzed event — the timeline builds the agent message from it.
 */
@Injectable()
export class ResultApplier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: DraftsService,
    private readonly rules: RoutingRulesService,
    private readonly ruleApplier: RuleApplier,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async apply(run: AgentRun, result: AgentResult, snapshot: AgentConfigSnapshot, options: ApplyOptions = {}): Promise<ApplyOutcome> {
    const assigneeChanges: AssigneeChange[] = [];
    const outcome = await this.prisma.$transaction(async (tx): Promise<ApplyOutcome> => {
      const locked = await lockTicket(tx, run.ticketId);
      if (locked.revision !== run.inputRevision) {
        return 'stale';
      }
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: run.ticketId } });
      const actor = { type: 'agent' as const, id: run.id };
      const event = (type: string, data: Record<string, unknown>) =>
        recordEvent(tx, { workspaceId: ticket.workspaceId, ticketId: ticket.id, type, actor, data });

      const previous = options.partial ? (ticket.analysis as unknown as TicketAnalysis | null) : null;
      const departments = new Map(snapshot.departments.map((d) => [d.key, d]));
      // A partial run without department — routing is not revised.
      const routingUpdated = result.department !== undefined || previous === null;
      const departmentKey = routingUpdated ? (result.department ?? null) : previous.department;
      const confidence = result.confidence ?? previous?.confidence ?? 0;
      const routingReason = result.routing_reason ?? previous?.routingReason ?? '';
      const agentDepartment = departmentKey ? (departments.get(departmentKey) ?? null) : null;
      const triage = snapshot.departments.find((d) => d.isTriage) ?? null;
      // needs_human means "a human decides", not "unclear where": highlight it, but do not reset routing.
      const uncertain = agentDepartment === null || confidence < snapshot.settings.confidenceThreshold;
      // Pinned, or taken by a person of its department; a ticket in triage stays the agent's to route.
      const operatorOwnsRouting = ticket.departmentLocked || (await takenByHuman(tx, ticket));

      // Department: automatically only while nobody has taken the ticket; otherwise a suggestion.
      let departmentSuggestion: TicketAnalysis['departmentSuggestion'] = previous?.departmentSuggestion ?? null;
      let sentToTriage = previous?.sentToTriage ?? false;
      const data: Prisma.TicketUpdateInput = {};
      if (!routingUpdated) {
        // keep the decision of the previous analysis
      } else if (operatorOwnsRouting) {
        departmentSuggestion = null;
        sentToTriage = false;
        if (agentDepartment && agentDepartment.id !== ticket.departmentId) {
          departmentSuggestion = { departmentId: agentDepartment.id, confidence, reason: routingReason };
        }
      } else {
        departmentSuggestion = null;
        const target: AgentDepartment | null = uncertain ? triage : agentDepartment;
        sentToTriage = uncertain && target !== null;
        if (target && target.id !== ticket.departmentId) {
          data.department = { connect: { id: target.id } };
          await recordDepartmentChange(tx, ticket, target.id, actor, { confidence, reason: routingReason, triage: sentToTriage });
        }
      }

      // Fields: agent_auto with enough confidence and not taken by another source — right away; the rest are suggestions.
      const meta = ticket.fieldMeta as unknown as FieldMeta;
      const values = ticket.fields as FieldValues;
      // A partial run adds to the suggestions of the previous analysis; a full one replaces them.
      const fieldSuggestions: Record<string, FieldSuggestion> = { ...previous?.fieldSuggestions };
      const autoInput: Record<string, unknown> = {};
      const autoActor: Record<string, { confidence: number; evidence: string | null }> = {};
      for (const [key, proposal] of Object.entries(result.fields)) {
        const definition = snapshot.fields.find((f) => f.entity === 'ticket' && f.key === key && f.fillMode !== 'manual');
        if (!definition) continue;
        // Only a select chooses among candidates; for other types they are noise.
        const candidates = definition.type === 'select' ? (proposal.candidates ?? []) : [];
        const hasValue = !isEmptyFieldValue(proposal.value);
        if (hasValue ? !fieldValueSchema(definition, values[key]).safeParse(proposal.value).success : candidates.length === 0) continue;

        delete fieldSuggestions[key];
        const current = meta[key];
        const suggestion = (reason: FieldSuggestion['reason']) => {
          fieldSuggestions[key] = {
            value: hasValue ? proposal.value : null,
            confidence: proposal.confidence,
            evidence: proposal.evidence,
            ...(candidates.length > 0 ? { candidates } : {}),
            reason,
          };
        };
        if (candidates.length > 0) {
          // Several options fit: the operator chooses, whatever the field's mode. Not over a pinned value or another source's one.
          const takenByOthers = current?.locked || (current && current.source !== 'agent' && !isEmptyFieldValue(values[key]));
          if (!takenByOthers) suggestion('ambiguous');
        } else if (current?.locked) {
          if (JSON.stringify(values[key]) !== JSON.stringify(proposal.value)) suggestion('locked');
        } else if (current && current.source !== 'agent' && !isEmptyFieldValue(values[key])) {
          if (JSON.stringify(values[key]) !== JSON.stringify(proposal.value)) suggestion('filled_by_other_source');
        } else if (definition.fillMode === 'agent_suggest') {
          suggestion('suggest_mode');
        } else if (proposal.confidence < definition.agentMinConfidence) {
          suggestion('low_confidence');
        } else {
          autoInput[key] = proposal.value;
          autoActor[key] = { confidence: proposal.confidence, evidence: proposal.evidence };
        }
      }

      let fields = values;
      let fieldMeta = meta;
      for (const [key, value] of Object.entries(autoInput)) {
        const applied = applyFieldValues({
          definitions: snapshot.fields.filter((f) => f.entity === 'ticket'),
          values: fields,
          meta: fieldMeta,
          input: { [key]: value },
          source: 'agent',
          actor: { runId: run.id, confidence: autoActor[key]!.confidence, ...(autoActor[key]!.evidence ? { evidence: autoActor[key]!.evidence! } : {}) },
        });
        fields = applied.values;
        fieldMeta = applied.meta;
        for (const change of applied.changes) {
          await event('field_changed', { ...change, source: 'agent', confidence: autoActor[key]!.confidence });
        }
      }
      if (Object.keys(autoInput).length > 0) {
        data.fields = json(fields);
        data.fieldMeta = json(fieldMeta);
      }

      const analysisUpdated = previous === null || routingUpdated || result.summary !== undefined || result.findings !== undefined;
      const analysis: TicketAnalysis = {
        runId: run.id,
        at: new Date().toISOString(),
        department: agentDepartment?.key ?? null,
        confidence,
        routingReason,
        alternativeDepartment: result.alternative_department !== undefined ? result.alternative_department : (previous?.alternativeDepartment ?? null),
        summary: result.summary ?? previous?.summary ?? '',
        findings: result.findings ?? previous?.findings ?? [],
        needsHuman: result.needs_human ?? previous?.needsHuman ?? false,
        playbooksUsed: result.playbooks_used.length > 0 ? result.playbooks_used : (previous?.playbooksUsed ?? []),
        departmentSuggestion,
        sentToTriage,
        fieldSuggestions,
      };
      data.analysis = json(analysis);
      await tx.ticket.update({ where: { id: ticket.id }, data });

      // after_agent rules see the agent's output; their effects respect operator pins.
      // A partial run that touched neither the department nor fields does not rerun the rules.
      const afterRules = routingUpdated || Object.keys(autoInput).length > 0 ? await this.rules.forStage(ticket.workspaceId, 'after_agent', tx) : [];
      if (afterRules.length > 0) {
        const fresh = await tx.ticket.findUniqueOrThrow({
          where: { id: ticket.id },
          include: { channel: true, customer: { include: { identities: true } } },
        });
        const firstMessage = await tx.message.findFirst({ where: { ticketId: ticket.id, authorType: 'customer' }, orderBy: { createdAt: 'asc' } });
        const ctx = buildRuleContext({
          ticket: fresh,
          message: firstMessage,
          departments: new Map(snapshot.departments.map((d) => [d.id, d])),
          agent: { department: analysis.department, confidence: analysis.confidence, needs_human: analysis.needsHuman },
        });
        const rules = await this.ruleApplier.apply(tx, ticket.id, evaluateRules(afterRules, ctx), ctx, 'after_agent');
        assigneeChanges.push(...rules.assigneeChanges);
      }
      // The agent chose the department: its assignees are settled and it may hand the ticket out. Idempotent after the rules did it.
      const { departmentId } = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { departmentId: true } });
      if (departmentId !== ticket.departmentId) {
        assigneeChanges.push(await settleAssignees(tx, ticket.id, actor, 'department_changed'));
      }

      const replyUpdated = Boolean(result.reply?.needed && result.reply.body.trim());
      if (replyUpdated) {
        await this.drafts.addAgentDraft(tx, {
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          runId: run.id,
          bodyHtml: textToHtml(result.reply!.body),
          revision: ticket.revision,
          force: options.chat,
        });
      }

      // The list of questions replaces the open ones; no section (partial run) — the open ones stay.
      // An open question repeated as is stays where it was asked: the new message carries only new questions.
      let questions: Array<{ id: string; text: string }> = [];
      if (result.questions_for_operator !== undefined) {
        const asked = new Set(result.questions_for_operator.map(normalizeQuestion));
        const open = await tx.agentQuestion.findMany({ where: { ticketId: ticket.id, status: 'open' }, select: { id: true, text: true } });
        const kept = open.filter((q) => asked.has(normalizeQuestion(q.text)));
        await tx.agentQuestion.updateMany({
          where: { id: { in: open.filter((q) => !kept.includes(q)).map((q) => q.id) } },
          data: { status: 'dismissed' },
        });
        const seen = new Set(kept.map((q) => normalizeQuestion(q.text)));
        for (const text of result.questions_for_operator) {
          if (seen.has(normalizeQuestion(text))) continue;
          seen.add(normalizeQuestion(text));
          questions.push({ id: newId(), text });
        }
      }
      if (questions.length > 0) {
        await tx.agentQuestion.createMany({
          data: questions.map((q) => ({ id: q.id, workspaceId: ticket.workspaceId, ticketId: ticket.id, runId: run.id, text: q.text })),
        });
      }

      // Action proposals: a full analysis replaces undecided proposals of earlier runs;
      // a partial one only if the agent proposed new ones or explicitly withdrew old ones. Decided ones are left alone.
      const proposals = options.proposals ?? [];
      if (!options.partial || proposals.length > 0 || result.drop_pending_actions === true) {
        // Only the agent's own proposals: an operator's manual card waits for the operator.
        await tx.actionProposal.updateMany({ where: { ticketId: ticket.id, status: 'proposed', source: 'agent' }, data: { status: 'superseded' } });
      }
      const actions = proposals.map((p) => ({ id: newId(), title: p.title, preview: p.preview }));
      if (proposals.length > 0) {
        await tx.actionProposal.createMany({
          data: proposals.map((p, i) => ({
            id: actions[i]!.id,
            workspaceId: ticket.workspaceId,
            ticketId: ticket.id,
            runId: run.id,
            integrationId: p.integrationId,
            action: p.action,
            title: p.title,
            customerRef: p.customerRef,
            params: json(p.params),
            ...(p.normalizedParams ? { normalizedParams: json(p.normalizedParams) } : {}),
            preview: p.preview,
            warnings: json(p.warnings),
            reason: p.reason,
            calculation: p.calculation,
          })),
        });
      }

      await event('agent_analyzed', {
        runId: run.id,
        mode: run.mode,
        message: result.message_to_operator,
        analysisUpdated,
        summary: analysis.summary,
        findings: analysis.findings,
        department: analysis.department,
        confidence: analysis.confidence,
        sentToTriage,
        needsHuman: analysis.needsHuman,
        questions,
        replyUpdated,
        ...(actions.length > 0 ? { actions } : {}),
      } satisfies AgentAnalyzedEventData);
      return 'applied';
    });
    if (outcome === 'applied') {
      await publishAssigneeChanges(this.realtime, this.notifications, run.workspaceId, assigneeChanges, null);
    }
    return outcome;
  }
}

/** The same question asked again: case, spacing and the final punctuation do not matter. */
function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.?!]+$/, '').trim();
}
