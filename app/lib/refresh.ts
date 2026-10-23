// Whether the data on screen is still fresh enough to trust, and when it was last fetched.
// Pure and storage-injected, so the rules are testable without a browser.

/**
 * How old the rendered data may get before a background refresh. Deliberately the same 30 minutes
 * the server's cron uses to pull new step counts: refreshing faster cannot show anything newer.
 */
export const REFRESH_INTERVAL_MS = 30 * 60_000;

export const LAST_REFRESH_STORAGE_KEY = "last-refresh-at";

/**
 * True when the data is old enough to refetch. A missing timestamp counts as stale, and so does one
 * in the future: a device clock that moved backwards would otherwise suppress refreshes forever.
 */
export function isStale(lastRefreshAt: number | null, now: number, intervalMs = REFRESH_INTERVAL_MS): boolean {
  if (lastRefreshAt === null || lastRefreshAt > now) return true;
  return now - lastRefreshAt >= intervalMs;
}

/** A stored timestamp, or null when it is missing or junk. Empty reads as 0, hence the trim. */
export function parseLastRefresh(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : null;
}

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;

/** Storage throws in private mode and when cookies are blocked. Nothing here is load-bearing. */
export function readLastRefresh(storage: Readable): number | null {
  try {
    return parseLastRefresh(storage.getItem(LAST_REFRESH_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeLastRefresh(storage: Writable, at: number): void {
  try {
    storage.setItem(LAST_REFRESH_STORAGE_KEY, String(at));
  } catch {
    // Private mode. The app still refreshes; it just forgets the time across reloads.
  }
}
