import { getLocale } from '@kvitok/i18n';
import type { DeliveryStatus, TicketPriority, TicketStatus, UserStatus } from '@kvitok/shared';
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

export const USER_STATUS_COLORS: Record<UserStatus, BadgeColor> = {
  active: 'success',
  invited: 'info',
  disabled: 'neutral',
};

export function userStatusLabel(status: UserStatus): string {
  return t(`users.status.${status}`);
}

/** Every ISO 4217 currency the browser knows, by code with its name in the interface language. */
export function currencyItems(): Array<{ label: string; value: string }> {
  const names = new Intl.DisplayNames(getLocale(), { type: 'currency' });
  return Intl.supportedValuesOf('currency').map((code) => ({ label: `${code} — ${names.of(code) ?? code}`, value: code }));
}

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
let formatters: { relative: Intl.RelativeTimeFormat; dateTime: Intl.DateTimeFormat; date: Intl.DateTimeFormat } | null = null;
function intl() {
  formatters ??= {
    relative: new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }),
    dateTime: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    date: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }),
  };
  return formatters;
}

export function formatDateTime(iso: string): string {
  return intl().dateTime.format(new Date(iso));
}

/** A date with the year, for dates that can be far away. */
export function formatDate(iso: string): string {
  return intl().date.format(new Date(iso));
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

/** Agent runs cost fractions of a cent: below one the amount keeps up to four decimals. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(getLocale(), {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: amount !== 0 && Math.abs(amount) < 1 ? 4 : 2,
    }).format(amount);
  } catch {
    // A code this browser's Intl does not know yet: the number and the code.
    return `${amount} ${currency}`;
  }
}

/** 1 284, 12.9K, 4.2M. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** A span in the largest fitting unit: 12 sec, 45 min, 5.5 h, 3 days. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  const [value, unit] =
    seconds < 90 ? [seconds, 'second'] : seconds < 90 * 60 ? [seconds / 60, 'minute'] : seconds < 48 * 3600 ? [seconds / 3600, 'hour'] : [seconds / 86_400, 'day'];
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

/** 0.256 → 26%. */
export function formatPercent(share: number): string {
  return new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(share);
}

/** A calendar day (YYYY-MM-DD) without the year: 5 Mar. */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
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
