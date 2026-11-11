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
 * Day D's two instants, as minutes after D's local midnight (a value of 24 * 60 or more falls on
 * the next calendar day). The Stompers game runs midnight to midnight, and items thrown late in the
 * evening still move game counts, so the game window closes at the end of D. The day locks five
 * minutes later, at 12:05 AM on D + 1: the gap lets the last walk and the last item land, and the
 * lock needs those final counts before it freezes anything.
 */
export const GAME_END_MINUTE_OF_DAY = 24 * 60;
export const FINALIZE_MINUTE_OF_DAY = 24 * 60 + 5;
export const GAME_END_LABEL = formatMinuteOfDay(GAME_END_MINUTE_OF_DAY);
export const LOCK_TIME_LABEL = formatMinuteOfDay(FINALIZE_MINUTE_OF_DAY);

/** "12:05 AM" — a wall-clock time as copy, for every place that names the lock. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minuteOfDay % 60).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

/**
 * Day D locks at its lock instant (12:05 AM on D + 1): steps freeze and the result is computed.
 * Skips for D close at that same instant (see canChangeSkip). Returns the latest date that is
 * allowed to be finalized right now.
 */
export function lastFinalizableDate(now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  // The lock is less than two days after a day starts, so one of these three dates has passed it.
  for (const back of [0, -1, -2]) {
    const date = addDays(today, back);
    if (now.getTime() >= lockInstant(date, timeZone)) return date;
  }
  throw new Error(`No lockable date before ${today}`);
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

/**
 * The instant a local wall-clock time happens in `timeZone`, e.g. 21:15 on 2026-10-21 in Los Angeles.
 * `minuteOfDay` may run past 24 * 60 into the next calendar day.
 */
export function zonedInstant(date: string, minuteOfDay: number, timeZone: string): number {
  const [y, m, d] = addDays(date, Math.floor(minuteOfDay / (24 * 60))).split("-").map(Number);
  const minute = minuteOfDay % (24 * 60);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  // Guess with the offset at the wall time, then correct once: right even on daylight-saving days.
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
}

/** When the game window closes on `date`, local time: what the Today badge counts down to. */
export const gameEndInstant = (date: string, timeZone: string) => zonedInstant(date, GAME_END_MINUTE_OF_DAY, timeZone);

/** When `date` locks: FINALIZE_MINUTE_OF_DAY after that day's local midnight. */
export const lockInstant = (date: string, timeZone: string) => zonedInstant(date, FINALIZE_MINUTE_OF_DAY, timeZone);

/** A skip for `date` can be claimed or undone from that day's start until the day locks. */
export function canChangeSkip(date: string, now: Date, timeZone: string): boolean {
  return localDate(now, timeZone) >= date && now.getTime() < lockInstant(date, timeZone);
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
