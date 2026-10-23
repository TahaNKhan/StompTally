import { describe, expect, it } from "vitest";
import { countdownLabel, msUntilLabelChanges } from "./countdown";
import { gameEndInstant, GAME_END_LABEL, LOCK_TIME_LABEL, lockInstant, zonedInstant } from "./dates";

const S = 1000, M = 60 * S, H = 60 * M;
const T = 1_000_000_000_000;

describe("countdownLabel", () => {
  it.each([
    [3 * H + 20 * M, "3 hrs 20 mins"],
    [3 * H + 1 * M, "3 hrs 1 min"],
    [90 * M, "1 hr 30 mins"],
    [2 * H - 1, "1 hr 59 mins"],
    [1 * H, "1 hr"],
    [1 * H - 1, "59 mins"],
    [2 * M, "2 mins"],
    [61 * S, "1 min"],
    [60 * S, "1 min"],
    [59 * S, "59 secs"],
    [2 * S, "2 secs"],
    [1 * S, "1 sec"],
    [1, "1 sec"],
  ])("%i ms left reads %s", (left, label) => {
    expect(countdownLabel(T + left, T)).toBe(label);
  });

  it("returns null once the target has passed", () => {
    expect(countdownLabel(T, T)).toBeNull();
    expect(countdownLabel(T - 5, T)).toBeNull();
  });
});

describe("msUntilLabelChanges", () => {
  // Walk the clock forward by exactly the returned wait: the label must change every step, and
  // waking even 1 ms earlier must still show the old label. That proves no wasted redraws.
  it("wakes exactly when the label changes, never sooner", () => {
    const target = T + 2 * H + 3 * M + 4 * S + 500;
    let now = T;
    let label = countdownLabel(target, now);
    const seen = [label];
    while (label) {
      const wait = msUntilLabelChanges(target, now);
      expect(countdownLabel(target, now + wait - 1)).toBe(label);
      now += wait;
      const next = countdownLabel(target, now);
      expect(next).not.toBe(label);
      label = next;
      seen.push(label);
    }
    expect(seen.slice(0, 3)).toEqual(["2 hrs 3 mins", "2 hrs 2 mins", "2 hrs 1 min"]);
    expect(seen).toContain("2 hrs");
    expect(seen).toContain("1 hr 59 mins");
    expect(seen).toContain("1 hr");
    expect(seen).toContain("59 mins");
    expect(seen).toContain("1 min");
    expect(seen).toContain("59 secs");
    expect(seen.at(-2)).toBe("1 sec");
    expect(seen.at(-1)).toBeNull();
  });

  it("redraws once a minute until the last minute, not every second", () => {
    const target = T + 5 * H;
    let now = T, wakes = 0;
    while (target - now > 60 * S) { now += msUntilLabelChanges(target, now); wakes++; }
    // The label changes on each minute boundary: 300 minutes down to 1, never once per second.
    expect(wakes).toBeLessThanOrEqual(300);
    expect(wakes).toBeGreaterThan(200);
  });

  it("is Infinity after the target", () => {
    expect(msUntilLabelChanges(T, T)).toBe(Infinity);
  });
});

describe("the day's two instants", () => {
  const tz = "America/Los_Angeles";
  it("is 21:15 Pacific in summer time (PDT, UTC-7)", () => {
    expect(new Date(lockInstant("2026-10-21", tz)).toISOString()).toBe("2026-10-22T04:15:00.000Z");
  });
  it("is 21:15 Pacific in winter time (PST, UTC-8)", () => {
    expect(new Date(lockInstant("2026-11-02", tz)).toISOString()).toBe("2026-11-03T05:15:00.000Z");
  });
  it("is right on the day daylight saving ends and the day it starts", () => {
    expect(new Date(lockInstant("2026-11-01", tz)).toISOString()).toBe("2026-11-02T05:15:00.000Z");
    expect(new Date(lockInstant("2026-03-08", tz)).toISOString()).toBe("2026-03-09T04:15:00.000Z");
  });
  it("works east of UTC and at UTC", () => {
    expect(new Date(zonedInstant("2026-10-21", 21 * 60 + 15, "Pacific/Kiritimati")).toISOString()).toBe("2026-10-21T07:15:00.000Z");
    expect(new Date(zonedInstant("2026-10-21", 21 * 60 + 15, "UTC")).toISOString()).toBe("2026-10-21T21:15:00.000Z");
  });
  it("ends the game at 9:00 PM and locks 15 minutes later", () => {
    expect(GAME_END_LABEL).toBe("9:00 PM");
    expect(LOCK_TIME_LABEL).toBe("9:15 PM");
    // Same day, same zone: the lock is always exactly 15 minutes after the game window shuts.
    for (const date of ["2026-10-21", "2026-11-02", "2026-03-08"]) {
      expect(lockInstant(date, tz) - gameEndInstant(date, tz)).toBe(15 * 60_000);
    }
  });
});
