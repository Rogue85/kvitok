import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type {
  CreateRoutingRuleInput,
  RoutingRuleDto,
  RuleCondition,
  RuleEffect,
  RuleStage,
  RuleTestResultDto,
  TicketAnalysis,
  UpdateRoutingRuleInput,
} from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { Prisma, RoutingRule } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildRuleContext } from './rule-context';
import { evaluateRules, type EvaluableRule } from './rules-engine';

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<RoutingRuleDto[]> {
    const rows = await this.prisma.routingRule.findMany({
      where: { workspaceId },
      orderBy: [{ stage: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRuleDto);
  }

  /** Enabled rules of a stage in application order. */
  async forStage(workspaceId: string, stage: RuleStage, db: Pick<PrismaService, 'routingRule'> = this.prisma): Promise<EvaluableRule[]> {
    const rows = await db.routingRule.findMany({
      where: { workspaceId, stage, enabled: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRuleDto);
  }

  async create(workspaceId: string, input: CreateRoutingRuleInput): Promise<RoutingRuleDto> {
    const row = await this.prisma.routingRule.create({
      data: {
        id: newId(),
        workspaceId,
        name: input.name,
        stage: input.stage,
        position: input.position ?? 0,
        conditions: json(input.conditions),
        effects: json(input.effects),
        stop: input.stop ?? false,
        enabled: input.enabled ?? true,
      },
    });
    const dto = toRuleDto(row);
    await this.audit.record({ workspaceId, entity: 'routing_rule', entityId: row.id, action: 'create', after: dto });
    return dto;
  }

  async update(workspaceId: string, id: string, input: UpdateRoutingRuleInput): Promise<RoutingRuleDto> {
    const existing = await this.get(workspaceId, id);
    const data: Prisma.RoutingRuleUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.stop === undefined ? {} : { stop: input.stop }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.conditions === undefined ? {} : { conditions: json(input.conditions) }),
      ...(input.effects === undefined ? {} : { effects: json(input.effects) }),
    };
    const dto = toRuleDto(await this.prisma.routingRule.update({ where: { id }, data }));
    await this.audit.record({ workspaceId, entity: 'routing_rule', entityId: id, action: 'update', before: toRuleDto(existing), after: dto });
    return dto;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.get(workspaceId, id);
    await this.prisma.routingRule.delete({ where: { id } });
    await this.audit.record({ workspaceId, entity: 'routing_rule', entityId: id, action: 'delete', before: toRuleDto(existing) });
  }

  /** Which rules would match this ticket (without applying them). */
  async test(workspaceId: string, ticketId: string): Promise<RuleTestResultDto[]> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { channel: true, customer: { include: { identities: true } } },
    });
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }
    const [message, departments, workspace] = await Promise.all([
      this.prisma.message.findFirst({ where: { ticketId, authorType: 'customer' }, orderBy: { createdAt: 'asc' } }),
      this.prisma.department.findMany({ where: { workspaceId } }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    ]);
    const analysis = ticket.analysis as unknown as TicketAnalysis | null;
    const ctx = buildRuleContext({
      ticket,
      message,
      departments: new Map(departments.map((d) => [d.id, d])),
      agent: analysis ? { department: analysis.department, confidence: analysis.confidence, needs_human: analysis.needsHuman } : undefined,
      timezone: (workspace.settings as { timezone?: string }).timezone,
    });

    const results: RuleTestResultDto[] = [];
    for (const stage of ['on_ingest', 'after_agent'] as const) {
      const matched = evaluateRules(await this.forStage(workspaceId, stage), ctx);
      results.push({
        stage,
        matched: matched.map((r) => ({ ruleId: r.id, name: r.name, effects: r.effects })),
        context: ctx as unknown as Record<string, unknown>,
      });
    }
    return results;
  }

  private async get(workspaceId: string, id: string): Promise<RoutingRule> {
    const row = await this.prisma.routingRule.findFirst({ where: { id, workspaceId } });
    if (row === null) {
      throw errors.notFound(t('api.ruleNotFound'));
    }
    return row;
  }
}

export function toRuleDto(row: RoutingRule): RoutingRuleDto {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    position: row.position,
    conditions: row.conditions as unknown as RuleCondition,
    effects: row.effects as unknown as RuleEffect[],
    stop: row.stop,
    enabled: row.enabled,
  };
}
