import { describe, expect, it } from "vitest";
import { isStale, parseLastRefresh, readLastRefresh, REFRESH_INTERVAL_MS, writeLastRefresh } from "./refresh";

const NOW = 1_700_000_000_000;
const M = 60_000;

describe("isStale", () => {
  it("refreshes when nothing has been recorded yet", () => {
    expect(isStale(null, NOW)).toBe(true);
  });
  it("holds the data for the full interval and refreshes on the boundary", () => {
    expect(isStale(NOW - (REFRESH_INTERVAL_MS - 1), NOW)).toBe(false);
    expect(isStale(NOW - REFRESH_INTERVAL_MS, NOW)).toBe(true);
  });
  it("treats a future timestamp as stale", () => {
    // A device clock that jumped backwards must not suppress refreshes for the rest of the day.
    expect(isStale(NOW + 5 * M, NOW)).toBe(true);
  });
  it("matches the server's own cadence, since faster cannot show newer data", () => {
    expect(REFRESH_INTERVAL_MS).toBe(30 * M);
  });
});

describe("parseLastRefresh", () => {
  it("reads a stored millisecond timestamp", () => {
    expect(parseLastRefresh(String(NOW))).toBe(NOW);
  });
  it.each([undefined, null, "", "   ", "not a number", Number.NaN, 0, -1, "{}"])("rejects %s", (raw) => {
    // localStorage gives "" for a key that was cleared, and Number("") is 0, not NaN.
    expect(parseLastRefresh(raw)).toBeNull();
  });
});

describe("readLastRefresh and writeLastRefresh", () => {
  const fake = (initial: Record<string, string> = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      has: (k: string) => store.has(k),
    };
  };

  it("round-trips a timestamp", () => {
    const store = fake();
    writeLastRefresh(store, NOW);
    expect(readLastRefresh(store)).toBe(NOW);
  });

  it("reads null from empty storage", () => {
    expect(readLastRefresh(fake())).toBeNull();
  });

  it("survives a store that throws, as Safari private mode does", () => {
    const hostile = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(() => writeLastRefresh(hostile, NOW)).not.toThrow();
    expect(readLastRefresh(hostile)).toBeNull();
  });
});
