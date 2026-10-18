import { describe, expect, it } from "vitest";
import { describeSync, STALE_SYNC_FAILURES } from "./views";

const ago = (ts: number | null) => (ts ? "20m ago" : "never");

describe("describeSync", () => {
  it("hides the line for members without a linked account", () => {
    expect(describeSync(undefined, ago)).toBeNull();
  });
  it("shows freshness for a healthy account", () => {
    expect(describeSync({ syncedAt: 1, failures: 0 }, ago)).toEqual({ label: "Stompers synced 20m ago", tone: "ok" });
  });
  it("says so before the first pull", () => {
    expect(describeSync({ syncedAt: null, failures: 0 }, ago)).toEqual({ label: "Waiting for first Stompers pull", tone: "ok" });
  });
  it("warns once failures reach the stale threshold", () => {
    expect(describeSync({ syncedAt: 1, failures: STALE_SYNC_FAILURES - 1 }, ago)?.tone).toBe("ok");
    expect(describeSync({ syncedAt: 1, failures: STALE_SYNC_FAILURES }, ago)).toMatchObject({ tone: "warn", label: expect.stringContaining("may be stale") });
  });
});
