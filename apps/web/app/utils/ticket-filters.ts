import type { TicketStatus } from '@kvitok/shared';

/** Queue tabs: each is a set of statuses, `all` has none. */
export const TICKET_VIEWS: Array<{ value: 'open' | 'pending' | 'done' | 'all'; statuses: TicketStatus[] }> = [
  { value: 'open', statuses: ['new', 'open'] },
  { value: 'pending', statuses: ['pending'] },
  { value: 'done', statuses: ['resolved', 'closed'] },
  { value: 'all', statuses: [] },
];

/** Filters kept in the URL under the list API's parameter names, plus `field.<key>`. */
export const TICKET_FILTER_KEYS = ['attention', 'assignee', 'departmentId', 'priority', 'channelId', 'tags', 'agentState', 'created', 'updated'] as const;

export function isTicketFilterKey(key: string): boolean {
  return (TICKET_FILTER_KEYS as readonly string[]).includes(key) || key.startsWith('field.');
}

export const DATE_PRESETS = ['today', '7d', '30d'] as const;

/** Date filters in the URL and the API parameters of their range. */
const DATE_FILTERS: Record<string, [string, string]> = {
  created: ['createdFrom', 'createdTo'],
  updated: ['updatedFrom', 'updatedTo'],
};

export function isDateFilter(key: string): boolean {
  return key in DATE_FILTERS;
}

/**
 * A date filter's value: a preset or local dates `YYYY-MM-DD..YYYY-MM-DD`, either side may be empty.
 * The range is in the operator's time zone; `to` is the start of the day after the last one.
 */
export function dateRange(spec: string, now = new Date()): { from?: Date; to?: Date } {
  const day = (d: Date, shift = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift);
  const presets: Record<string, number> = { today: 0, '7d': 6, '30d': 29 };
  const back = presets[spec];
  if (back !== undefined) {
    return { from: day(now, -back) };
  }
  const parse = (s: string | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
  };
  const [from, to] = spec.split('..');
  const last = parse(to);
  return { from: parse(from), to: last ? day(last, 1) : undefined };
}

/** The list API's query parameters for the filters from the URL; empty filters are dropped. */
export function ticketFilterParams(filters: Record<string, string>, now = new Date()): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const date = DATE_FILTERS[key];
    if (date) {
      const range = dateRange(value, now);
      if (range.from) params[date[0]] = range.from.toISOString();
      if (range.to) params[date[1]] = range.to.toISOString();
    } else {
      params[key] = value;
    }
  }
  return params;
}

export interface TicketFilterOption {
  label: string;
  value: string;
  icon?: string;
}

/** A filter the queue offers: `options` takes several values, `option` one, `flag` none. */
export interface TicketFilterDef {
  key: string;
  label: string;
  icon: string;
  kind: 'options' | 'option' | 'flag' | 'date' | 'text';
  options?: TicketFilterOption[];
}
