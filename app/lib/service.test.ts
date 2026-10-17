import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import * as svc from "./service";

function sqliteDb(): Db {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON");
  d.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  const norm = (p: unknown[]) => p.map((v) => (v === undefined ? null : v)) as any[];
  return {
    async all(sql, ...p) { return d.prepare(sql).all(...norm(p)) as any; },
    async first(sql, ...p) { return (d.prepare(sql).get(...norm(p)) as any) ?? null; },
    async query(stmts) {
      d.exec("BEGIN");
      try {
        const rows = stmts.map((s) => d.prepare(s.sql).all(...norm(s.params)) as any[]);
        d.exec("COMMIT");
        return rows;
      } catch (e) { d.exec("ROLLBACK"); throw e; }
    },
    async run(sql, ...p) { return { changes: Number(d.prepare(sql).run(...norm(p)).changes) }; },
    async batch(stmts) {
      d.exec("BEGIN");
      try { for (const s of stmts) d.prepare(s.sql).run(...norm(s.params)); d.exec("COMMIT"); }
      catch (e) { d.exec("ROLLBACK"); throw e; }
    },
  };
}

// Oct 1 2026, 09:00 PDT
const T0 = Date.parse("2026-10-01T16:00:00Z");
const H = 3600_000;
const D = 24 * H;

async function setup() {
  const db = sqliteDb();
  await svc.bootstrap(db, { email: "Taha@Example.com", name: "Taha", groupName: "Stompers", timezone: "America/Los_Angeles" }, T0);
  const taha = (await db.first<svc.User>("SELECT id, email, name FROM users"))!;
  const m = (await svc.getMembership(db, taha.id))!;
  const friends: svc.User[] = [];
  for (const n of ["ali", "omar", "zaid", "sam"]) {
    const inv = await svc.createInvite(db, taha, m.group.id, `${n}@example.com`, T0);
    const s = await svc.startInviteAcceptance(db, inv.token, n, T0);
    await svc.completeInvite(db, s.user, inv.token, T0);
    friends.push(s.user);
  }
  return { db, taha, group: m.group, friends };
}

describe("bootstrap + auth", () => {
  it("bootstrap only once", async () => {
    const { db } = await setup();
    await expect(svc.bootstrap(db, { email: "x@y.com", name: "x", groupName: "g", timezone: "UTC" })).rejects.toThrow(/Already/);
  });

  it("magic link: single use, expires, unknown email is silent", async () => {
    const { db } = await setup();
    expect(await svc.createLoginToken(db, "nobody@example.com", T0)).toBeNull();
    const t = (await svc.createLoginToken(db, "TAHA@example.com", T0))!;
    const sid = await svc.redeemLoginToken(db, t.token, T0 + 60_000);
    expect((await svc.getSessionUser(db, sid, T0 + 60_000))?.name).toBe("Taha");
    await expect(svc.redeemLoginToken(db, t.token, T0 + 60_000)).rejects.toThrow();
    const t2 = (await svc.createLoginToken(db, "taha@example.com", T0))!;
    await expect(svc.redeemLoginToken(db, t2.token, T0 + 21 * 60_000)).rejects.toThrow(/expired/);
  });

  it("logout kills the session", async () => {
    const { db, taha } = await setup();
    const sid = await svc.createSession(db, taha.id, T0);
    await svc.destroySession(db, sid);
    expect(await svc.getSessionUser(db, sid, T0)).toBeNull();
  });
});

describe("invites", () => {
  it("5 members after setup", async () => {
    const { db, group } = await setup();
    expect(await svc.listMembers(db, group.id)).toHaveLength(5);
  });

  it("invite is bound to its email", async () => {
    const { db, taha, group, friends } = await setup();
    const inv = await svc.createInvite(db, taha, group.id, "new@example.com", T0);
    await expect(svc.completeInvite(db, friends[0], inv.token, T0)).rejects.toThrow(/different email/);
  });

  it("invite is single-use, expires, and can be revoked", async () => {
    const { db, taha, group } = await setup();
    const inv = await svc.createInvite(db, taha, group.id, "a@b.com", T0);
    await expect(svc.previewInvite(db, inv.token, T0 + 8 * D)).rejects.toThrow(/expired/);
    await svc.revokeInvite(db, taha, group.id, inv.id, T0);
    await expect(svc.previewInvite(db, inv.token, T0)).rejects.toThrow(/revoked/);
    const inv2 = await svc.createInvite(db, taha, group.id, "c@d.com", T0);
    const s = await svc.startInviteAcceptance(db, inv2.token, "C", T0);
    await svc.completeInvite(db, s.user, inv2.token, T0);
    await expect(svc.completeInvite(db, s.user, inv2.token, T0)).rejects.toThrow(/already used/);
  });

  it("re-inviting revokes the old link", async () => {
    const { db, taha, group } = await setup();
    const a = await svc.createInvite(db, taha, group.id, "x@y.com", T0);
    await svc.createInvite(db, taha, group.id, "x@y.com", T0);
    await expect(svc.previewInvite(db, a.token, T0)).rejects.toThrow(/revoked/);
  });

  it("only admins invite; existing members can't be invited", async () => {
    const { db, taha, group, friends } = await setup();
    await expect(svc.createInvite(db, friends[0], group.id, "z@z.com", T0)).rejects.toThrow(/Admins/);
    await expect(svc.createInvite(db, taha, group.id, "ali@example.com", T0)).rejects.toThrow(/already/);
  });
});

describe("steps + finalize", () => {
  const set = async (db: Db, u: svc.User, date: string, steps: number, now = T0) =>
    svc.recordSteps(db, { actor: u, userId: u.id, date, steps, source: "manual" }, now);

  it("lowest under 10k pays; missing = 0; ties both pay", async () => {
    const { db, taha, group, friends } = await setup();
    const [ali, omar, zaid, sam] = friends;
    await set(db, taha, "2026-10-01", 12000);
    await set(db, ali, "2026-10-01", 8000);
    await set(db, omar, "2026-10-01", 15000);
    await set(db, zaid, "2026-10-01", 11000);
    // sam: nothing -> 0 -> sam pays
    // Oct 2: ali + omar tie at 5000
    for (const [u, s] of [[taha, 12000], [ali, 5000], [omar, 5000], [zaid, 11000], [sam, 20000]] as const) await set(db, u, "2026-10-02", s, T0 + D);

    // Oct 3 12:00 PDT: both days finalizable
    const done = await svc.finalizeDue(db, Date.parse("2026-10-03T19:00:00Z"));
    expect(done.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    const mv = await svc.monthView(db, group, "2026-10");
    const owed = Object.fromEntries(mv.totals.map((t) => [t.name, t.cents]));
    expect(owed).toMatchObject({ sam: 500, ali: 500, omar: 500, Taha: 0, zaid: 0 });
    expect(mv.potCents).toBe(1500);
  });

  it("doesn't finalize before noon next day, and is idempotent", async () => {
    const { db } = await setup();
    expect(await svc.finalizeDue(db, Date.parse("2026-10-02T18:59:00Z"))).toEqual([]);
    expect(await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"))).toHaveLength(1);
    expect(await svc.finalizeDue(db, Date.parse("2026-10-02T20:00:00Z"))).toEqual([]);
  });

  it("self-report window: today or yesterday until noon, never future", async () => {
    const { db, taha } = await setup();
    // Oct 10, 09:00 PDT
    const morning = Date.parse("2026-10-10T16:00:00Z");
    await expect(set(db, taha, "2026-10-11", 1, morning)).rejects.toThrow(/future/);
    await expect(set(db, taha, "2026-10-08", 1, morning)).rejects.toThrow(/today or yesterday/);
    await set(db, taha, "2026-10-10", 12000, morning);
    await set(db, taha, "2026-10-09", 9000, morning); // yesterday, before noon: allowed
    await set(db, taha, "2026-10-09", 11000, morning); // overwrite allowed
    // Oct 10, 12:05 PDT: yesterday is final now
    const noon = Date.parse("2026-10-10T19:05:00Z");
    await svc.finalizeDue(db, noon);
    await expect(set(db, taha, "2026-10-09", 20000, noon)).rejects.toThrow(/final/);
    const row = await db.first<{ steps: number }>("SELECT steps FROM step_entries WHERE user_id = ? AND date = '2026-10-09'", taha.id);
    expect(row?.steps).toBe(11000);
  });

  it("rejects bad step values", async () => {
    const { db, taha } = await setup();
    for (const bad of [-1, 1.5, 150_001, NaN]) await expect(set(db, taha, "2026-10-01", bad)).rejects.toThrow(/whole number/);
  });

  it("can't report steps for someone else", async () => {
    const { db, friends } = await setup();
    await expect(svc.recordSteps(db, { actor: friends[0], userId: friends[1].id, date: "2026-10-01", steps: 1, source: "manual" }, T0)).rejects.toThrow(/own steps/);
  });

  it("admin correction re-finalizes a closed day", async () => {
    const { db, taha, group, friends } = await setup();
    for (const u of [taha, ...friends]) await set(db, u, "2026-10-01", 12000);
    await set(db, friends[0], "2026-10-01", 3000);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    expect((await svc.monthView(db, group, "2026-10")).potCents).toBe(500);
    await svc.recordSteps(db, { actor: taha, userId: friends[0].id, date: "2026-10-01", steps: 14000, source: "admin" }, Date.parse("2026-10-05T19:00:00Z"));
    expect((await svc.monthView(db, group, "2026-10")).potCents).toBe(0);
  });
});

describe("skips", () => {
  it("claimed skip saves the loser; nobody else pays", async () => {
    const { db, taha, group, friends } = await setup();
    for (const u of [taha, ...friends]) await svc.recordSteps(db, { actor: u, userId: u.id, date: "2026-10-01", steps: u === friends[0] ? 2000 : 12000, source: "manual" }, T0);
    await svc.claimSkip(db, friends[0], "2026-10-01", T0);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    const mv = await svc.monthView(db, group, "2026-10");
    expect(mv.potCents).toBe(0);
    expect(mv.days[0].outcome).toBe("skipped");
    expect(mv.days[0].skippers).toEqual([friends[0].id]);
  });

  it("unneeded claim is released and doesn't count against the 3", async () => {
    const { db, taha, friends } = await setup();
    for (const u of [taha, ...friends]) await svc.recordSteps(db, { actor: u, userId: u.id, date: "2026-10-01", steps: 12000, source: "manual" }, T0);
    await svc.claimSkip(db, taha, "2026-10-01", T0);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM skip_claims WHERE user_id = ?", taha.id);
    expect(n?.n).toBe(0);
  });

  it("max 3 per month, resets next month", async () => {
    const { db, taha } = await setup();
    const now = Date.parse("2026-10-05T16:00:00Z");
    for (const d of ["2026-10-03", "2026-10-04", "2026-10-05"]) await svc.claimSkip(db, taha, d, now);
    await expect(svc.claimSkip(db, taha, "2026-10-02", now)).rejects.toThrow(/all 3/);
    await svc.cancelSkip(db, taha, "2026-10-05", now);
    await svc.claimSkip(db, taha, "2026-10-02", now);
    await svc.claimSkip(db, taha, "2026-11-01", Date.parse("2026-11-01T16:00:00Z"));
  });

  it("can't skip future or finalized days", async () => {
    const { db, taha } = await setup();
    await expect(svc.claimSkip(db, taha, "2026-10-02", T0)).rejects.toThrow(/today/);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    await expect(svc.claimSkip(db, taha, "2026-10-01", Date.parse("2026-10-02T19:00:00Z"))).rejects.toThrow(/final/);
  });

  it("tie: skipper saved, other pays", async () => {
    const { db, taha, group, friends } = await setup();
    const [ali, omar] = friends;
    for (const u of [taha, ...friends]) await svc.recordSteps(db, { actor: u, userId: u.id, date: "2026-10-01", steps: u === ali || u === omar ? 4000 : 12000, source: "manual" }, T0);
    await svc.claimSkip(db, ali, "2026-10-01", T0);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    const mv = await svc.monthView(db, group, "2026-10");
    expect(mv.days[0].payers).toEqual([omar.id]);
  });
});

describe("membership", () => {
  it("removed member stops counting from the day they leave", async () => {
    const { db, taha, group, friends } = await setup();
    await svc.removeMember(db, taha, group.id, friends[3].id, T0);
    for (const u of [taha, ...friends.slice(0, 3)]) await svc.recordSteps(db, { actor: u, userId: u.id, date: "2026-10-01", steps: 12000, source: "manual" }, T0);
    await svc.finalizeDue(db, Date.parse("2026-10-02T19:00:00Z"));
    expect((await svc.monthView(db, group, "2026-10")).potCents).toBe(0);
  });
});
