import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import { sha256 } from "./crypto";
import { loadToday, loadMonth, loadHistory, loadMe, loadGroupAdmin, loadLoginState, loadInvitePage } from "./pages";

const NOW = Date.parse("2026-11-01T06:30:00Z"); // Oct 31, 23:30 PDT
function fixture(timezone = "America/Los_Angeles") {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  let hops = 0;
  const db: Db = {
    async all(q, ...p) { hops++; return sql.prepare(q).all(...p as any[]) as any; },
    async first(q, ...p) { hops++; return sql.prepare(q).get(...p as any[]) as any ?? null; },
    async run(q, ...p) { hops++; return { changes: Number(sql.prepare(q).run(...p as any[]).changes) }; },
    async batch(ss) { hops++; for (const s of ss) sql.prepare(s.sql).run(...s.params as any[]); },
    async query() { throw new Error("Page reads must use one SQL statement, not a batch of statements"); },
  };
  sql.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run("u", "u@example.com", "User", NOW);
  sql.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run("v", "v@example.com", "Friend", NOW);
  sql.prepare("INSERT INTO users VALUES (?, ?, ?, ?)").run("x", "x@example.com", "Stranger", NOW);
  sql.prepare("INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES (?,?,?,?,?)").run("g", "Crew", timezone, "2026-10-01", NOW);
  sql.prepare("INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES (?,?,?,?,?)").run("other", "Private crew", timezone, "2026-10-01", NOW);
  sql.exec("INSERT INTO memberships VALUES ('g','u','admin','2026-10-01',NULL), ('g','v','member','2026-10-01',NULL), ('other','x','admin','2026-10-01',NULL)");
  sql.exec("INSERT INTO step_entries VALUES ('u','2026-10-31',9000,'manual',1), ('v','2026-10-31',12000,'manual',1), ('x','2026-10-31',55555,'manual',1), ('u','2026-11-01',10000,'manual',1)");
  sql.exec("INSERT INTO skip_claims VALUES ('g','u','2026-10-30','consumed',1), ('g','u','2026-10-31','pending',1), ('other','x','2026-10-31','pending',1)");
  sql.exec("INSERT INTO day_results VALUES ('g','2026-10-29',3000,'[\"u\"]','penalty',1), ('other','2026-10-29',123,'[\"x\"]','penalty',1)");
  sql.exec("INSERT INTO penalties VALUES ('g','u','2026-10-29',500), ('other','x','2026-10-29',99900)");
  sql.exec("INSERT INTO settlements VALUES ('g','2026-10','dinner',1)");
  return { db, sql, hops: () => hops, reset: () => { hops = 0; } };
}
async function ready(timezone?: string) {
  const f = fixture(timezone);
  for (const [token, user, expiry] of [["valid", "u", NOW + 60_000], ["member", "v", NOW + 60_000], ["expired", "u", NOW - 1]] as const) {
    f.sql.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(await sha256(token), user, expiry);
  }
  return f;
}

describe("page read budget", () => {
  for (const [name, load] of [
    ["Today", (db: Db, sid: string) => loadToday(db, sid, NOW)],
    ["Month", (db: Db, sid: string) => loadMonth(db, sid, undefined, NOW)],
    ["explicit Month", (db: Db, sid: string) => loadMonth(db, sid, "2026-10", NOW)],
    ["Ledger", (db: Db, sid: string) => loadHistory(db, sid, NOW)],
    ["Me", (db: Db, sid: string) => loadMe(db, sid, NOW)],
    ["Group", (db: Db, sid: string) => loadGroupAdmin(db, sid, NOW)],
  ] as const) {
    it(`${name}: exactly one DB call including auth`, async () => {
      const f = await ready();
      const r = await load(f.db, "valid");
      expect(r.page).not.toBeNull();
      expect(r.page?.shell.user.id).toBe("u");
      expect(f.hops()).toBe(1);
    });
    it(`${name}: bad/expired session leaks no rows`, async () => {
      const f = await ready();
      for (const token of ["wrong", "expired"]) {
        f.reset();
        const r = await load(f.db, token);
        expect(r.page).toBeNull();
        expect(r.auth.user).toBeNull();
        expect(r.auth.rows.every((rows) => rows.length === 0)).toBe(true);
        expect(f.hops()).toBe(1);
      }
    });
  }
  it("no cookie: no DB call", async () => {
    const f = await ready();
    expect((await loadToday(f.db, null, NOW)).page).toBeNull();
    expect(f.hops()).toBe(0);
  });
  it("login: one call even with a session cookie", async () => {
    const f = await ready();
    expect(await loadLoginState(f.db, "valid", NOW)).toEqual({ bootstrapped: true, loggedIn: true });
    expect(f.hops()).toBe(1);
  });
});

describe("page data", () => {
  it("Today stays group scoped and uses local October, not UTC November", async () => {
    const f = await ready();
    const p = (await loadToday(f.db, "valid", NOW)).page!;
    expect(p.today.date).toBe("2026-10-31");
    expect(p.yesterday.date).toBe("2026-10-30");
    expect(p.today.rows.map((r) => r.name).sort()).toEqual(["Friend", "User"]);
    expect(p.today.preview.skipsConsumed).toEqual(["u"]);
    expect(p.skipsUsedToday.u).toBe(2);
    expect(p.pot).toBe(500);
    expect(p.totals.find((t) => t.userId === "u")?.cents).toBe(500);
    expect(JSON.stringify(p)).not.toContain("Stranger");
  });
  it("Month preserves penalties, settlement and row shapes", async () => {
    const f = await ready();
    const p = (await loadMonth(f.db, "valid", undefined, NOW)).page!;
    expect(p.month).toBe("2026-10");
    expect(p.days).toHaveLength(31);
    expect(p.days[28].payers).toEqual(["u"]);
    expect(p.potCents).toBe(500);
    expect(p.settlement?.note).toBe("dinner");
    expect(p.steps.some((r) => r.user_id === "x")).toBe(false);
  });
  it("month boundary skip counts are independent", async () => {
    const f = await ready();
    const nov = Date.parse("2026-11-01T09:00:00Z");
    f.sql.prepare("UPDATE sessions SET expires_at = ?").run(nov + 60_000);
    const p = (await loadToday(f.db, "valid", nov)).page!;
    expect(p.today.date).toBe("2026-11-01");
    expect(p.skipsUsedToday.u).toBe(0);
    expect(p.skipsUsedYesterday.u).toBe(2);
    expect(p.pot).toBe(0);
  });
  it("positive UTC+14 timezone remains correct", async () => {
    const f = await ready("Pacific/Kiritimati");
    const p = (await loadToday(f.db, "valid", NOW)).page!;
    expect(p.today.date).toBe("2026-11-01");
    expect(p.yesterday.date).toBe("2026-10-31");
    expect(p.skipsUsedYesterday.u).toBe(2);
  });
  it("non-admin context is flagged and no private invite list is returned", async () => {
    const f = await ready();
    const p = (await loadGroupAdmin(f.db, "member", NOW)).page!;
    expect(p.isAdmin).toBe(false);
    expect(p.invites).toEqual([]);
  });
  it("invite preview + session in one DB call", async () => {
    const f = await ready();
    f.sql.prepare("INSERT INTO invites VALUES (?,?,?,?,?,?,NULL,NULL,?)").run("i", "g", "v@example.com", await sha256("inv"), "u", NOW+60_000, NOW);
    const r = await loadInvitePage(f.db, "inv", "valid", NOW);
    expect(r.invite.email).toBe("v@example.com");
    expect(r.user?.id).toBe("u");
    expect(f.hops()).toBe(1);
  });
});
