/** A time zone the runtime knows, otherwise UTC. */
export function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Calendar days in a time zone: analytics counts days as the person looking at them lives them. */
export class ZonedDays {
  private readonly format: Intl.DateTimeFormat;

  constructor(readonly timeZone: string) {
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }

  /** YYYY-MM-DD of the instant in the zone. */
  key(at: Date): string {
    const p = this.parts(at);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  /** The last `count` days up to the day of `now`, oldest first. */
  lastDays(count: number, now: Date): string[] {
    const p = this.parts(now);
    return Array.from({ length: count }, (_, i) => new Date(Date.UTC(p.year, p.month - 1, p.day - (count - 1 - i))).toISOString().slice(0, 10));
  }

  /** The instant the day starts at in the zone. */
  startOf(key: string): Date {
    const midnightUtc = Date.parse(`${key}T00:00:00Z`);
    const p = this.parts(new Date(midnightUtc));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - midnightUtc;
    return new Date(midnightUtc - offset);
  }

  private parts(at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const values = Object.fromEntries(this.format.formatToParts(at).map((part) => [part.type, Number(part.value)]));
    return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
