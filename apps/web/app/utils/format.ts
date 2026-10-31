import { getLocale } from '@kvitok/i18n';
import type { DeliveryStatus, TicketPriority, TicketStatus } from '@kvitok/shared';
import { t } from './i18n';

type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral';

export const STATUS_COLORS: Record<TicketStatus, BadgeColor> = {
  new: 'info',
  open: 'warning',
  pending: 'neutral',
  resolved: 'success',
  closed: 'neutral',
};

export const PRIORITY_COLORS: Record<TicketPriority, BadgeColor> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'error',
};

export const DELIVERY_COLORS: Record<DeliveryStatus, BadgeColor> = {
  queued: 'neutral',
  sending: 'info',
  sent: 'success',
  failed: 'error',
  cancelled: 'neutral',
};

export function statusLabel(status: TicketStatus): string {
  return t(`ticketStatus.${status}`);
}

export function priorityLabel(priority: TicketPriority): string {
  return t(`ticketPriority.${priority}`);
}

export function deliveryLabel(status: DeliveryStatus): string {
  return t(`deliveryStatus.${status}`);
}

/* Formatters are created on first use: the locale is known only after the i18n plugin has run. */
let formatters: { relative: Intl.RelativeTimeFormat; dateTime: Intl.DateTimeFormat } | null = null;
function intl() {
  formatters ??= {
    relative: new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }),
    dateTime: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  };
  return formatters;
}

export function formatDateTime(iso: string): string {
  return intl().dateTime.format(new Date(iso));
}

/** "5 minutes ago", "yesterday"; older than a week — the date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return t('common.justNow');
  if (abs < 3600) return intl().relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return intl().relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return intl().relative.format(Math.round(diff / 86_400), 'day');
  return formatDateTime(iso);
}

export function formatBytes(size: number): string {
  if (size < 1024) return t('common.bytes', { value: size });
  if (size < 1024 * 1024) return t('common.kilobytes', { value: (size / 1024).toFixed(0) });
  return t('common.megabytes', { value: (size / 1024 / 1024).toFixed(1) });
}

export function formatFieldValue(value: unknown, options: Array<{ value: string; label: string }> = []): string {
  if (value === null || value === undefined || value === '') return '—';
  const label = (v: unknown) => options.find((o) => o.value === v)?.label ?? String(v);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  return label(value);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
