const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * Text for a countdown to `target`. An hour or more left reads as hours AND minutes ("3 hrs 20
 * mins"): "3 hrs" alone hides the twenty and reads like the lock is nearer than it is. Under an
 * hour it is whole minutes, under a minute whole seconds (floored, never below 1, so the last
 * two seconds both read "1 sec" and there is never a "60 secs").
 */
export function countdownLabel(target: number, now: number): string | null {
  const left = target - now;
  if (left <= 0) return null;
  if (left < MINUTE) return plural(Math.max(1, Math.floor(left / SECOND)), "sec");
  const minutes = Math.floor(left / MINUTE);
  if (left < HOUR) return plural(minutes, "min");
  const mins = minutes % 60;
  const hours = plural(Math.floor(minutes / 60), "hr");
  return mins === 0 ? hours : `${hours} ${plural(mins, "min")}`;
}

/** Milliseconds until the label above reads differently, so a timer can sleep until exactly then. */
export function msUntilLabelChanges(target: number, now: number): number {
  const left = target - now;
  if (left <= 0) return Infinity;
  // Under two seconds the only change left is the target itself passing.
  if (left < 2 * SECOND) return left;
  // Seconds floor, minutes floor, and the hour label is built off the minute count, so every label
  // changes on a whole-second or whole-minute boundary: sleep to just past it, never sooner.
  const unit = left < MINUTE ? SECOND : MINUTE;
  const remainder = left % unit;
  return remainder === 0 ? 1 : remainder + 1;
}
