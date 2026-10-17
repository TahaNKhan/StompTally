import { describe, expect, it } from "vitest";
import { canClaimSkip, computeDay } from "./rules";
import { addDays, lastFinalizableDate, localDate, daysInMonth } from "./dates";

const rules = { thresholdSteps: 10_000, penaltyCents: 500 };
const five = ["a", "b", "c", "d", "e"];

describe("computeDay", () => {
  it("no loser when everyone hits 10k", () => {
    const r = computeDay({ memberIds: five, steps: { a: 10000, b: 12000, c: 15000, d: 10001, e: 20000 }, skipClaims: [] }, rules);
    expect(r.outcome).toBe("no_loser");
    expect(r.loserIds).toEqual([]);
    expect(r.penalties).toEqual([]);
    expect(r.minSteps).toBe(10000);
  });

  it("exactly 10,000 is safe", () => {
    const r = computeDay({ memberIds: ["a", "b"], steps: { a: 10000, b: 30000 }, skipClaims: [] }, rules);
    expect(r.outcome).toBe("no_loser");
  });

  it("lowest under 10k pays $5", () => {
    const r = computeDay({ memberIds: five, steps: { a: 9999, b: 12000, c: 4000, d: 11000, e: 8000 }, skipClaims: [] }, rules);
    expect(r.loserIds).toEqual(["c"]);
    expect(r.penalties).toEqual([{ userId: "c", cents: 500 }]);
    expect(r.outcome).toBe("penalty");
  });

  it("only the lowest pays, not everyone under 10k", () => {
    const r = computeDay({ memberIds: ["a", "b", "c"], steps: { a: 9000, b: 8000, c: 7000 }, skipClaims: [] }, rules);
    expect(r.penalties.map((p) => p.userId)).toEqual(["c"]);
  });

  it("tie at the min: both pay", () => {
    const r = computeDay({ memberIds: five, steps: { a: 5000, b: 5000, c: 12000, d: 11000, e: 13000 }, skipClaims: [] }, rules);
    expect(r.loserIds.sort()).toEqual(["a", "b"]);
    expect(r.penalties).toHaveLength(2);
  });

  it("missing data counts as 0 steps", () => {
    const r = computeDay({ memberIds: five, steps: { a: 3000, b: 12000, c: 12000, d: 12000 }, skipClaims: [] }, rules);
    expect(r.loserIds).toEqual(["e"]);
    expect(r.minSteps).toBe(0);
  });

  it("two people with no data tie at 0 and both pay", () => {
    const r = computeDay({ memberIds: five, steps: { a: 3000, b: 12000, c: 12000 }, skipClaims: [] }, rules);
    expect(r.loserIds.sort()).toEqual(["d", "e"]);
  });

  it("ignores non-members' steps", () => {
    const r = computeDay({ memberIds: ["a", "b"], steps: { a: 12000, b: 11000, z: 0 }, skipClaims: [] }, rules);
    expect(r.outcome).toBe("no_loser");
  });

  it("claimed skip saves the loser, nobody else pays", () => {
    const r = computeDay({ memberIds: five, steps: { a: 2000, b: 6000, c: 12000, d: 12000, e: 12000 }, skipClaims: ["a"] }, rules);
    expect(r.loserIds).toEqual(["a"]);
    expect(r.penalties).toEqual([]);
    expect(r.skipsConsumed).toEqual(["a"]);
    expect(r.outcome).toBe("skipped");
  });

  it("unneeded skip claim is released", () => {
    const r = computeDay({ memberIds: five, steps: { a: 2000, b: 6000, c: 12000, d: 12000, e: 12000 }, skipClaims: ["b"] }, rules);
    expect(r.penalties).toEqual([{ userId: "a", cents: 500 }]);
    expect(r.skipsReleased).toEqual(["b"]);
    expect(r.skipsConsumed).toEqual([]);
  });

  it("skip claim on a no-loser day is released", () => {
    const r = computeDay({ memberIds: ["a", "b"], steps: { a: 12000, b: 11000 }, skipClaims: ["a"] }, rules);
    expect(r.skipsReleased).toEqual(["a"]);
    expect(r.outcome).toBe("no_loser");
  });

  it("tie where only one has a skip: one saved, other pays", () => {
    const r = computeDay({ memberIds: five, steps: { a: 5000, b: 5000, c: 12000, d: 12000, e: 12000 }, skipClaims: ["a"] }, rules);
    expect(r.skipsConsumed).toEqual(["a"]);
    expect(r.penalties).toEqual([{ userId: "b", cents: 500 }]);
    expect(r.outcome).toBe("penalty");
  });

  it("tie where both skip: nobody pays", () => {
    const r = computeDay({ memberIds: ["a", "b", "c"], steps: { a: 5000, b: 5000, c: 12000 }, skipClaims: ["a", "b"] }, rules);
    expect(r.penalties).toEqual([]);
    expect(r.outcome).toBe("skipped");
  });

  it("empty group", () => {
    expect(computeDay({ memberIds: [], steps: {}, skipClaims: [] }, rules).outcome).toBe("no_loser");
  });
});

describe("canClaimSkip", () => {
  it("allows up to the monthly limit", () => {
    expect(canClaimSkip(0, 3)).toBe(true);
    expect(canClaimSkip(2, 3)).toBe(true);
    expect(canClaimSkip(3, 3)).toBe(false);
  });
});

describe("dates", () => {
  const tz = "America/Los_Angeles";
  it("local date respects timezone", () => {
    // 2026-10-17 05:00 UTC = Oct 16 22:00 PDT
    expect(localDate(new Date("2026-10-17T05:00:00Z"), tz)).toBe("2026-10-16");
  });
  it("finalize cutoff is noon next day", () => {
    // Oct 17 11:59 PDT -> Oct 16 not yet final -> last finalizable = Oct 15
    expect(lastFinalizableDate(new Date("2026-10-17T18:59:00Z"), tz)).toBe("2026-10-15");
    // Oct 17 12:00 PDT -> Oct 16 final
    expect(lastFinalizableDate(new Date("2026-10-17T19:00:00Z"), tz)).toBe("2026-10-16");
  });
  it("addDays crosses months", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("daysInMonth", () => {
    expect(daysInMonth("2028-02")).toHaveLength(29);
    expect(daysInMonth("2026-10")[30]).toBe("2026-10-31");
  });
});
