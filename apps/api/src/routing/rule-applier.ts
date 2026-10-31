import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { FieldMeta, FieldValues, RuleEffect, RuleStage } from '@kvitok/shared';
import { json } from '../common/json';
import { applyFieldValues } from '../fields/field-values';
import { FieldsService } from '../fields/fields.service';
import type { Prisma, Ticket } from '../generated/prisma/client';
import { recordEvent } from '../tickets/ticket-events';
import { extractByRegex, type EvaluableRule, type RuleContextData } from './rules-engine';

export interface RuleApplyOutcome {
  skipAgent: boolean;
  applied: Array<{ ruleId: string; effect: RuleEffect['type']; result: 'applied' | 'skipped'; reason?: string }>;
}

/** Applies the effects of matched rules to a ticket: respects the pinned department and the operator's fields. */
@Injectable()
export class RuleApplier {
  constructor(private readonly fields: FieldsService) {}

  async apply(
    tx: Prisma.TransactionClient,
    ticketId: string,
    rules: EvaluableRule[],
    ctx: RuleContextData,
    stage: RuleStage,
  ): Promise<RuleApplyOutcome> {
    const outcome: RuleApplyOutcome = { skipAgent: false, applied: [] };
    if (rules.length === 0) {
      return outcome;
    }
    let ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const definitions = await this.fields.list(ticket.workspaceId, 'ticket', tx);

    for (const rule of rules) {
      const actor = { type: 'rule' as const, id: rule.id };
      const event = (type: string, data: Record<string, unknown>) =>
        recordEvent(tx, { workspaceId: ticket.workspaceId, ticketId, type, actor, data: { ...data, rule: rule.name, stage } });
      const note = (effect: RuleEffect, result: 'applied' | 'skipped', reason?: string) =>
        outcome.applied.push({ ruleId: rule.id, effect: effect.type, result, ...(reason ? { reason } : {}) });

      for (const effect of rule.effects) {
        switch (effect.type) {
          case 'skip_agent':
            outcome.skipAgent = true;
            note(effect, 'applied');
            break;

          case 'set_department': {
            const department = await tx.department.findFirst({
              where: { workspaceId: ticket.workspaceId, key: effect.departmentKey, archivedAt: null },
            });
            if (department === null) {
              note(effect, 'skipped', t('api.rule.departmentNotFound'));
            } else if (ticket.departmentLocked) {
              note(effect, 'skipped', t('api.rule.departmentPinned'));
            } else if (department.id !== ticket.departmentId) {
              await event('department_changed', { from: ticket.departmentId, to: department.id });
              ticket = await tx.ticket.update({ where: { id: ticketId }, data: { departmentId: department.id } });
              note(effect, 'applied');
            }
            break;
          }

          case 'set_priority':
            if (effect.priority !== ticket.priority) {
              await event('priority_changed', { from: ticket.priority, to: effect.priority });
              ticket = await tx.ticket.update({ where: { id: ticketId }, data: { priority: effect.priority } });
            }
            note(effect, 'applied');
            break;

          case 'add_tags': {
            const added = effect.tags.filter((t) => !ticket.tags.includes(t));
            if (added.length > 0) {
              await event('tags_changed', { added, removed: [] });
              ticket = await tx.ticket.update({ where: { id: ticketId }, data: { tags: [...ticket.tags, ...added] } });
            }
            note(effect, 'applied');
            break;
          }

          case 'assign': {
            const membership = await tx.membership.findUnique({
              where: { workspaceId_userId: { workspaceId: ticket.workspaceId, userId: effect.userId } },
            });
            if (membership === null || membership.role === 'viewer') {
              note(effect, 'skipped', t('api.rule.assigneeNotOperator'));
            } else if (ticket.assigneeId === null) {
              await event('assignee_changed', { from: null, to: effect.userId });
              ticket = await tx.ticket.update({ where: { id: ticketId }, data: { assigneeId: effect.userId } });
              note(effect, 'applied');
            } else {
              note(effect, 'skipped', t('api.rule.assigneeAlreadySet'));
            }
            break;
          }

          case 'set_field':
          case 'set_field_from_regex': {
            const value =
              effect.type === 'set_field'
                ? effect.value
                : extractByRegex(effect.pattern, effect.source === 'subject' ? ctx.subject : ctx.body);
            if (value === null || value === undefined) {
              note(effect, 'skipped', t('api.rule.valueNotFound'));
              break;
            }
            ticket = await this.setField(tx, ticket, definitions, effect.key, value, rule.id, (r) => note(effect, r.result, r.reason), event);
            break;
          }
        }
      }
    }
    return outcome;
  }

  private async setField(
    tx: Prisma.TransactionClient,
    ticket: Ticket,
    definitions: Awaited<ReturnType<FieldsService['list']>>,
    key: string,
    value: unknown,
    ruleId: string,
    note: (r: { result: 'applied' | 'skipped'; reason?: string }) => void,
    event: (type: string, data: Record<string, unknown>) => Promise<unknown>,
  ): Promise<Ticket> {
    const result = applyFieldValues({
      definitions,
      values: ticket.fields as FieldValues,
      meta: ticket.fieldMeta as unknown as FieldMeta,
      input: { [key]: value },
      source: 'rule',
      actor: { ruleId },
    });
    if (result.skipped.length > 0) {
      note({ result: 'skipped', reason: t('api.rule.fieldPinned') });
      return ticket;
    }
    if (result.rejected.length > 0) {
      note({ result: 'skipped', reason: result.rejected[0]!.reason });
      return ticket;
    }
    for (const change of result.changes) {
      await event('field_changed', { ...change, source: 'rule' });
    }
    note({ result: 'applied' });
    return tx.ticket.update({ where: { id: ticket.id }, data: { fields: json(result.values), fieldMeta: json(result.meta) } });
  }
}
