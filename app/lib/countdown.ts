const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The unit the label counts in, for `left` milliseconds remaining. */
const unitFor = (left: number) => (left >= HOUR ? HOUR : left >= MINUTE ? MINUTE : SECOND);
const NAMES = new Map([[HOUR, "hr"], [MINUTE, "min"], [SECOND, "sec"]]);

/**
 * Text for a countdown to `target`: whole hours, then whole minutes, then seconds. Values are
 * rounded down, except the last second, so "59 mins" really means at least 59 minutes remain.
 */
export function countdownLabel(target: number, now: number): string | null {
  const left = target - now;
  if (left <= 0) return null;
  const unit = unitFor(left);
  const count = unit === SECOND ? Math.ceil(left / SECOND) : Math.floor(left / unit);
  return `${count} ${NAMES.get(unit)}${count === 1 ? "" : "s"}`;
}

/** Milliseconds until the label above reads differently, so a timer can sleep until exactly then. */
export function msUntilLabelChanges(target: number, now: number): number {
  const left = target - now;
  if (left <= 0) return Infinity;
  const unit = unitFor(left);
  // Hours and minutes floor, so they change when `left` drops to the multiple at or below it.
  // Seconds ceil, so they change when `left` drops just under the multiple below it.
  if (unit === SECOND) return left - (Math.ceil(left / SECOND) - 1) * SECOND;
  const remainder = left % unit;
  return remainder === 0 ? 1 : remainder + 1;
}
