<script setup lang="ts">
import { ANALYTICS_PERIODS, type AnalyticsCostRowDto, type AnalyticsDayDto, type AnalyticsDto, type TicketStatus } from '@kvitok/shared';
import type { BreakdownRow } from '~/components/analytics/BreakdownList.vue';

const route = useRoute();
const router = useRouter();
const { workspaceId, scope } = useWorkspace();
const { departmentById, channels } = useWorkspaceData();

const days = ref<number>(ANALYTICS_PERIODS.find((p) => p === Number(route.query.days)) ?? 30);
watch(days, (value) => void router.replace({ query: value === 30 ? {} : { days: String(value) } }));
const periodItems = ANALYTICS_PERIODS.map((value) => ({ label: t('analytics.days', { count: value }), value }));
/** Days are counted in the viewer's time zone. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const { data: report, status, error } = await useAsyncData(
  () => `analytics:${workspaceId.value}:${days.value}`,
  () => api<AnalyticsDto>(`/workspaces/${workspaceId.value}/analytics?${new URLSearchParams({ days: String(days.value), tz: timeZone })}`),
  { watch: [workspaceId, days] },
);

const costTable = ref(false);
const ticketsTable = ref(false);

/* Agent spending: every cost is in the workspace currency */
function money(amount: number): string {
  return report.value ? formatMoney(amount, report.value.currency) : '—';
}
const failedRuns = computed(() => (report.value?.agent.byStatus.failed ?? 0));

function costRows(rows: AnalyticsCostRowDto[], label: (key: string | null) => string): BreakdownRow[] {
  return rows.map((row) => ({
    key: row.key ?? '',
    label: label(row.key),
    value: row.cost,
    // No run of the row has a price: a zero would claim it was free.
    display: row.unpricedRuns === row.runs ? '—' : money(row.cost),
    meta: `${tp('ticket.cost.runs', row.runs)} · ${tp('analytics.ticketCount', row.tickets)}`,
  }));
}
const TRIGGERS = ['ticket_created', 'customer_message', 'operator_message', 'question_answer', 'manual', 'stale_rerun', 'customer_linked', 'action_executed'] as const;
function triggerLabel(key: string | null): string {
  const known = TRIGGERS.find((tr) => tr === key);
  return known ? t(`agentRuns.trigger.${known}`) : (key ?? '—');
}
const byDepartment = computed(() =>
  costRows(report.value?.agent.byDepartment ?? [], (key) => (key ? (departmentById.value.get(key)?.title ?? t('events.deletedDepartment')) : t('tickets.filters.noDepartment'))),
);
const byModel = computed(() => costRows(report.value?.agent.byModel ?? [], (key) => key ?? t('analytics.agent.noModel')));
const byTrigger = computed(() => costRows(report.value?.agent.byTrigger ?? [], triggerLabel));
const topTickets = computed<BreakdownRow[]>(() =>
  (report.value?.agent.topTickets ?? []).map((ticket) => ({
    key: ticket.id,
    label: `T-${ticket.number} · ${ticket.subject}`,
    value: ticket.cost,
    display: money(ticket.cost),
    meta: tp('ticket.cost.runs', ticket.runs),
    to: `/w/${workspaceId.value}/tickets/${ticket.id}`,
  })),
);

function costDetails(day: AnalyticsDayDto): string[] {
  return [tp('ticket.cost.runs', day.runs), t('ticket.cost.tokens', { count: formatCompact(day.tokens) })];
}

/* Tickets */
const byChannel = computed<BreakdownRow[]>(() => {
  const names = new Map(channels.data.value.map((c) => [c.id, c.name]));
  return (report.value?.tickets.byChannel ?? []).map((row) => ({
    key: row.key ?? '',
    label: row.key ? (names.get(row.key) ?? '—') : t('analytics.tickets.noChannel'),
    value: row.count,
    display: String(row.count),
  }));
});
const STATUS_ORDER: TicketStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];
const byStatus = computed<BreakdownRow[]>(() =>
  STATUS_ORDER.filter((s) => report.value?.tickets.byStatus[s]).map((s) => ({
    key: s,
    label: statusLabel(s),
    value: report.value!.tickets.byStatus[s]!,
    display: String(report.value!.tickets.byStatus[s]),
  })),
);
function ticketDetails(day: AnalyticsDayDto): string[] {
  return [t('analytics.tickets.resolvedOnDay', { count: day.ticketsResolved })];
}

/* How operators used the agent's work */
function share(part: number, whole: number): string | undefined {
  return whole > 0 ? formatPercent(part / whole) : undefined;
}
const REPLY_KINDS = ['unchanged', 'edited', 'rewritten', 'withoutAgentDraft'] as const;
const replies = computed<BreakdownRow[]>(() => {
  const r = report.value?.quality.replies;
  if (!r || r.sent === 0) return [];
  return REPLY_KINDS.map((kind) => ({ key: kind, label: t(`analytics.quality.reply.${kind}`), value: r[kind], display: String(r[kind]), meta: share(r[kind], r.sent) }));
});
const ACTION_STATUSES = ['proposed', 'approved', 'executing', 'executed', 'failed', 'rejected', 'superseded'] as const;
const actions = computed<BreakdownRow[]>(() => {
  const counts = report.value?.quality.actions ?? {};
  return ACTION_STATUSES.filter((s) => counts[s]).map((s) => ({ key: s, label: t(`action.status.${s}`), value: counts[s]!, display: String(counts[s]) }));
});
/** Executed actions: proposed by the agent or done by hand, and where the agent was corrected or missed one. */
const executedActions = computed<BreakdownRow[]>(() => {
  const quality = report.value?.quality;
  if (!quality) return [];
  const byAgent = quality.actions.executed ?? 0;
  const { executed, replaced, missed } = quality.manualActions;
  const total = byAgent + executed;
  if (total === 0) return [];
  const row = (key: 'byAgent' | 'manual' | 'replaced' | 'missed', value: number, of: number) => ({ key, label: t(`analytics.quality.executed.${key}`), value, display: String(value), meta: share(value, of) });
  return [row('byAgent', byAgent, total), row('manual', executed, total), row('replaced', replaced, executed), row('missed', missed, executed)];
});
</script>

<template>
  <UDashboardPanel id="analytics">
    <template #header>
      <UDashboardNavbar :title="t('nav.analytics')">
        <template #right>
          <UTooltip v-if="!scope.all" :text="t('analytics.scopeHint')">
            <UIcon name="i-lucide-building-2" class="size-4 text-(--ui-text-muted)" :aria-label="t('analytics.scopeHint')" />
          </UTooltip>
          <UTabs v-model="days" :items="periodItems" :content="false" size="xs" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="t('analytics.loadFailed')" />
      <p v-else-if="!report && status === 'pending'" class="text-sm text-(--ui-text-muted)">{{ t('common.loading') }}</p>

      <div v-else-if="report" class="mx-auto w-full max-w-6xl space-y-10" :class="status === 'pending' ? 'opacity-60' : ''">
        <section class="space-y-4">
          <h2 class="text-lg font-semibold">{{ t('analytics.agent.title') }}</h2>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AnalyticsStatTile
              :label="t('analytics.agent.spent')"
              :value="money(report.agent.usage.cost)"
              :hint="`${tp('ticket.cost.runs', report.agent.usage.runs)} · ${t('ticket.cost.tokens', { count: formatCompact(report.agent.usage.tokensIn + report.agent.usage.tokensOut) })}`"
            />
            <AnalyticsStatTile
              :label="t('analytics.agent.perTicket')"
              :value="report.agent.costPerTicket !== null ? money(report.agent.costPerTicket) : '—'"
              :hint="tp('analytics.agent.ticketsWithAgent', report.agent.ticketsWithRuns)"
            />
            <AnalyticsStatTile
              :label="t('analytics.agent.tuning')"
              :value="money(report.agent.dryRuns.cost)"
              :hint="tp('analytics.agent.tuningRuns', report.agent.dryRuns.runs)"
            />
            <AnalyticsStatTile
              :label="t('analytics.agent.failed')"
              :value="share(failedRuns, report.agent.usage.runs) ?? '—'"
              :hint="
                report.agent.avgDurationMs !== null
                  ? `${tp('ticket.cost.runs', failedRuns)} · ${t('analytics.agent.avgDuration', { duration: formatDuration(report.agent.avgDurationMs) })}`
                  : tp('ticket.cost.runs', failedRuns)
              "
            />
          </div>
          <UAlert
            v-if="report.agent.usage.unpricedRuns"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="tp('analytics.agent.unpriced', report.agent.usage.unpricedRuns)"
            :description="t('analytics.agent.unpricedHint')"
          />

          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1">
                  <h3 class="font-medium">{{ t('analytics.agent.perDay') }}</h3>
                  <p class="text-xs text-(--ui-text-muted)">{{ t('analytics.agent.perDayHint', { total: money(report.agent.usage.cost) }) }}</p>
                </div>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="costTable ? 'i-lucide-chart-column' : 'i-lucide-table'"
                  :label="costTable ? t('analytics.chart') : t('analytics.table')"
                  @click="costTable = !costTable"
                />
              </div>
            </template>
            <AnalyticsDayBars :days="report.days" :value="(d) => d.cost" :format="money" :details="costDetails" :table="costTable" />
          </UCard>

          <div class="grid gap-4 lg:grid-cols-2">
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.agent.topTickets') }}</h3></template>
              <AnalyticsBreakdownList :rows="topTickets" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.agent.byDepartment') }}</h3></template>
              <AnalyticsBreakdownList :rows="byDepartment" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.agent.byTrigger') }}</h3></template>
              <AnalyticsBreakdownList :rows="byTrigger" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.agent.byModel') }}</h3></template>
              <AnalyticsBreakdownList :rows="byModel" :empty="t('analytics.empty')" />
            </UCard>
          </div>
        </section>

        <section class="space-y-4">
          <h2 class="text-lg font-semibold">{{ t('analytics.tickets.title') }}</h2>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AnalyticsStatTile
              :label="t('analytics.tickets.created')"
              :value="String(report.tickets.created)"
              :hint="t('analytics.tickets.openNow', { count: report.tickets.open })"
            />
            <AnalyticsStatTile :label="t('analytics.tickets.resolved')" :value="String(report.tickets.resolved)" />
            <AnalyticsStatTile
              :label="t('analytics.tickets.firstResponse')"
              :value="report.tickets.firstResponseMedianMs !== null ? formatDuration(report.tickets.firstResponseMedianMs) : '—'"
              :hint="t('analytics.tickets.median')"
            />
            <AnalyticsStatTile
              :label="t('analytics.tickets.resolution')"
              :value="report.tickets.resolutionMedianMs !== null ? formatDuration(report.tickets.resolutionMedianMs) : '—'"
              :hint="t('analytics.tickets.median')"
            />
          </div>

          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <h3 class="min-w-0 flex-1 font-medium">{{ t('analytics.tickets.perDay') }}</h3>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="ticketsTable ? 'i-lucide-chart-column' : 'i-lucide-table'"
                  :label="ticketsTable ? t('analytics.chart') : t('analytics.table')"
                  @click="ticketsTable = !ticketsTable"
                />
              </div>
            </template>
            <AnalyticsDayBars :days="report.days" :value="(d) => d.ticketsCreated" :format="String" :details="ticketDetails" :table="ticketsTable" integer />
          </UCard>

          <div class="grid gap-4 lg:grid-cols-2">
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.tickets.byChannel') }}</h3></template>
              <AnalyticsBreakdownList :rows="byChannel" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.tickets.byStatus') }}</h3></template>
              <AnalyticsBreakdownList :rows="byStatus" :empty="t('analytics.empty')" />
            </UCard>
          </div>
        </section>

        <section class="space-y-4">
          <div>
            <h2 class="text-lg font-semibold">{{ t('analytics.quality.title') }}</h2>
            <p class="text-sm text-(--ui-text-muted)">{{ t('analytics.quality.intro') }}</p>
          </div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AnalyticsStatTile :label="t('analytics.quality.analyzed')" :value="String(report.quality.analyzed)" />
            <AnalyticsStatTile
              :label="t('analytics.quality.needsHuman')"
              :value="String(report.quality.needsHuman)"
              :hint="share(report.quality.needsHuman, report.quality.analyzed)"
            />
            <AnalyticsStatTile
              :label="t('analytics.quality.overrides')"
              :value="String(report.quality.departmentOverrides)"
              :hint="share(report.quality.departmentOverrides, report.quality.analyzed)"
            />
            <AnalyticsStatTile :label="t('analytics.quality.questions')" :value="String(report.quality.questions)" />
          </div>
          <div class="grid gap-4 lg:grid-cols-2">
            <UCard>
              <template #header>
                <h3 class="font-medium">{{ t('analytics.quality.replies') }}</h3>
                <p class="text-xs text-(--ui-text-muted)">{{ t('analytics.quality.repliesHint') }}</p>
              </template>
              <AnalyticsBreakdownList :rows="replies" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header><h3 class="font-medium">{{ t('analytics.quality.actions') }}</h3></template>
              <AnalyticsBreakdownList :rows="actions" :empty="t('analytics.empty')" />
            </UCard>
            <UCard>
              <template #header>
                <h3 class="font-medium">{{ t('analytics.quality.executedActions') }}</h3>
                <p class="text-xs text-(--ui-text-muted)">{{ t('analytics.quality.executedActionsHint') }}</p>
              </template>
              <AnalyticsBreakdownList :rows="executedActions" :empty="t('analytics.empty')" />
            </UCard>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
