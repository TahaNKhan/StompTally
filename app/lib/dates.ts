// Calendar-date helpers. All "dates" are 'YYYY-MM-DD' strings in a group's local timezone.

export function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export function localDate(now: Date, timeZone: string): string {
  return localParts(now, timeZone).date;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function isDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Day D locks at 21:05 local time on D itself: steps freeze and the result is computed.
 * Skips for D stay open until local midnight (see canChangeSkip), which recomputes the result.
 * Returns the latest date that is allowed to be finalized right now.
 */
export const FINALIZE_MINUTE_OF_DAY = 21 * 60 + 5;
export function lastFinalizableDate(now: Date, timeZone: string): string {
  const { date, hour, minute } = localParts(now, timeZone);
  return addDays(date, hour * 60 + minute >= FINALIZE_MINUTE_OF_DAY ? 0 : -1);
}

/** Milliseconds `timeZone` is ahead of UTC at `instant` (negative for the Americas). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - (instant - (instant % 1000));
}

/** The instant a local wall-clock time happens in `timeZone`, e.g. 21:05 on 2026-10-21 in Los Angeles. */
export function zonedInstant(date: string, minuteOfDay: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  // Guess with the offset at the wall time, then correct once: right even on daylight-saving days.
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
}

/** When `date` locks: FINALIZE_MINUTE_OF_DAY on that day, local time. */
export const lockInstant = (date: string, timeZone: string) => zonedInstant(date, FINALIZE_MINUTE_OF_DAY, timeZone);

/** A skip for `date` can be claimed or undone only while it is still that day, locally. */
export function canChangeSkip(date: string, now: Date, timeZone: string): boolean {
  return localDate(now, timeZone) === date;
}

export function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatMonth(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
