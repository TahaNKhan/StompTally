import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import { gameSample, linkStompers, readStompers, runStompersSchedule, syncStompers, unlinkStompers, type ApiRead } from "./stompers.server";
import { AppError, bootstrap, createSession, finalizeDue, getMembership, recordSteps } from "./service";
import { loadMe, loadToday } from "./pages";
import { computeDay } from "./rules";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const NEXT = Date.parse("2026-10-18T19:05:00Z");
const TZ = "America/Los_Angeles";
const userUid = "stompers-user";
function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  const norm = (p: unknown[]) => p.map(v => v === undefined ? null : v) as any[];
  const db: Db = {
    async all(q, ...p) { return sql.prepare(q).all(...norm(p)) as any; },
    async first(q, ...p) { return sql.prepare(q).get(...norm(p)) as any ?? null; },
    async run(q, ...p) { return { changes: Number(sql.prepare(q).run(...norm(p)).changes) }; },
    async query(ss) { return ss.map(s => sql.prepare(s.sql).all(...norm(s.params)) as any[]); },
    async batch(ss) {
      sql.exec("BEGIN");
      try { for (const s of ss) sql.prepare(s.sql).run(...norm(s.params)); sql.exec("COMMIT"); }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, sql };
}
function game(day = "17", raw: unknown = 837, adjusted: unknown = 1578.5) {
  return { uid: `game-${day}`, starts_at: `2026-10-${day}T07:00:00Z`, finishes_at: `2026-10-${Number(day) + 1}T07:00:00Z`, time_zone: TZ,
    step_counts: { [userUid]: raw }, game_step_counts: { [userUid]: adjusted } };
}
async function ready() {
  const f = fixture();
  await bootstrap(f.db, { name: "User", email: "u@example.com", groupName: "Friends", timezone: TZ }, NOW);
  const user = (await f.db.first<{ id: string; email: string; name: string }>("SELECT * FROM users"))!;
  const read: ApiRead = async (path, body) => {
    if (path.startsWith("/users/")) return { uid: userUid, username: "user" };
    if (path === "/rooms/getRoom") return { uid: `${userUid}_friends`, current_game_uid: "game-17" };
    if (path === "/games/getRecentGamesByRoomUid") return [];
    return game(String(body.uid).slice(-2));
  };
  await linkStompers(f.db, user, "@user", "username", NOW, read);
  return { ...f, user, read };
}

describe("Stompers daily counts", () => {
  it("uses the higher count without rounding away game fractions", () => {
    expect(gameSample(game(), userUid, TZ).steps).toBe(1578.5);
    expect(gameSample(game("17", 5000, 2000), userUid, TZ).steps).toBe(5000);
    const result = computeDay({ memberIds: ["a", "b"], steps: { a: 837, b: 837.5 }, skipClaims: [] }, { thresholdSteps: 10000, penaltyCents: 500 });
    expect(result.loserIds).toEqual(["a"]);
  });
  it.each([undefined, null, "100", -1, NaN, Infinity, 150001])("rejects missing/invalid counts: %s", bad => {
    expect(() => gameSample({ ...game(), step_counts: { [userUid]: bad } }, userUid, TZ)).toThrow();
    expect(() => gameSample({ ...game(), game_step_counts: { [userUid]: bad } }, userUid, TZ)).toThrow();
  });
  it("accepts real zero counts", () => expect(gameSample(game("17", 0, 0), userUid, TZ).steps).toBe(0));
  it("rejects timezone and partial-day mismatches", () => {
    expect(() => gameSample(game(), userUid, "UTC")).toThrow(/timezone/);
    expect(() => gameSample({ ...game(), starts_at: "2026-10-17T08:00:00Z" }, userUid, TZ)).toThrow(/full local day/);
  });
  it("accepts DST days and timezones with half-hour offsets", () => {
    expect(gameSample({ ...game(), starts_at: "2026-11-01T07:00:00Z", finishes_at: "2026-11-02T08:00:00Z" }, userUid, TZ).date).toBe("2026-11-01");
    expect(gameSample({ ...game(), time_zone: "Asia/Kolkata", starts_at: "2026-10-16T18:30:00Z", finishes_at: "2026-10-17T18:30:00Z" }, userUid, "Asia/Kolkata").date).toBe("2026-10-17");
  });
});

describe("Stompers links and imports", () => {
  it("links usernames or IDs only to the caller and prevents duplicate accounts", async () => {
    const f = await ready();
    await f.db.run("INSERT INTO users VALUES ('other','other@example.com','Other',?)", NOW);
    await expect(linkStompers(f.db, { id: "other", name: "Other", email: "other@example.com" }, "user", "username", NOW, f.read)).rejects.toThrow(/already linked/);
    await linkStompers(f.db, f.user, userUid, "uid", NOW, f.read);
    const sid = await createSession(f.db, f.user.id, NOW);
    expect((await loadMe(f.db, sid, NOW)).page?.stompers?.stompers_uid).toBe(userUid);
    await unlinkStompers(f.db, f.user);
    expect((await loadMe(f.db, sid, NOW)).page?.stompers).toBeNull();
  });
  it("saves both counts and the higher score; exposes both on Today", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, f.read);
    const sid = await createSession(f.db, f.user.id, NOW);
    const row = (await loadToday(f.db, sid, NOW)).page!.today.rows[0];
    expect(row).toMatchObject({ steps: 1578.5, rawSteps: 837, gameSteps: 1578.5, source: "stompers" });
  });
  it("keeps previous counts on read errors and does not finalize stale API data", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, f.read);
    const broken: ApiRead = async () => { throw new AppError(502, "Read failed"); };
    await runStompersSchedule(f.db, NEXT, broken);
    expect(await f.db.first("SELECT steps FROM step_entries")).toMatchObject({ steps: 1578.5 });
    expect(await f.db.first("SELECT * FROM day_results")).toBeNull();
    expect(await f.db.first("SELECT last_error FROM stompers_accounts")).toMatchObject({ last_error: expect.stringContaining("Read failed") });
  });
  it("does not create a zero entry or penalty when the first pull fails", async () => {
    const f = await ready();
    await runStompersSchedule(f.db, NEXT, async () => { throw new AppError(502, "Read failed"); });
    expect(await f.db.first("SELECT * FROM step_entries")).toBeNull();
    expect(await f.db.first("SELECT * FROM penalties")).toBeNull();
  });
  it("refreshes cached yesterday before finalizing even when history omits it", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, f.read);
    const reads: string[] = [];
    const tomorrow: ApiRead = async (path, body) => {
      if (path === "/rooms/getRoom") return { uid: `${userUid}_friends`, current_game_uid: "game-18" };
      if (path === "/games/getRecentGamesByRoomUid") return [];
      reads.push(String(body.uid)); return game(String(body.uid).slice(-2), 10001, 9999);
    };
    await runStompersSchedule(f.db, NEXT, tomorrow);
    expect(reads).toContain("game-17");
    expect(await f.db.first("SELECT outcome,min_steps FROM day_results WHERE date='2026-10-17'")).toMatchObject({ outcome: "no_loser", min_steps: 10001 });
    await syncStompers(f.db, NEXT + 1, f.read);
    expect(await f.db.first("SELECT steps FROM step_entries WHERE date='2026-10-17'")).toMatchObject({ steps: 10001 });
  });
  it("preserves admin scores while updating the two API counts", async () => {
    const f = await ready();
    await recordSteps(f.db, { actor: f.user, userId: f.user.id, date: "2026-10-17", steps: 12000, source: "admin" }, NOW);
    await syncStompers(f.db, NOW, f.read);
    expect(await f.db.first("SELECT steps,raw_steps,game_steps,source FROM step_entries")).toMatchObject({ steps: 12000, raw_steps: 837, game_steps: 1578.5, source: "admin" });
    expect(await finalizeDue(f.db, NEXT)).toHaveLength(1);
  });
  it("keeps each manual save and audits the prior score and API snapshot", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, f.read);
    await recordSteps(f.db, { actor: f.user, userId: f.user.id, date: "2026-10-17", steps: 9000, source: "manual" }, NOW + 1);
    await recordSteps(f.db, { actor: f.user, userId: f.user.id, date: "2026-10-17", steps: 11000, source: "manual" }, NOW + 2);
    const rows = await f.db.all("SELECT * FROM manual_step_entries ORDER BY id");
    expect(rows).toMatchObject([
      { user_id: f.user.id, actor_id: f.user.id, previous_steps: 1578.5, previous_source: "stompers", steps: 9000, raw_steps: 837, game_steps: 1578.5, created_at: NOW + 1 },
      { previous_steps: 9000, previous_source: "manual", steps: 11000, raw_steps: 837, game_steps: 1578.5, created_at: NOW + 2 },
    ]);
    const audits = await f.db.all<{ payload: string }>("SELECT payload FROM audit_log WHERE action='steps.manual_set' ORDER BY id");
    expect(audits.map(a => JSON.parse(a.payload))).toMatchObject([
      { manualEntryId: rows[0].id, previousSteps: 1578.5, steps: 9000 },
      { manualEntryId: rows[1].id, previousSteps: 9000, steps: 11000 },
    ]);
    await syncStompers(f.db, NOW + 3, async (path, body) => path === "/games/getGame" ? game("17", 5000, 6000) : f.read(path, body));
    expect(await f.db.first("SELECT steps,source,raw_steps,game_steps,updated_at FROM step_entries")).toMatchObject({ steps: 11000, source: "manual", raw_steps: 5000, game_steps: 6000, updated_at: NOW + 2 });
    expect(await f.db.all("SELECT * FROM manual_step_entries ORDER BY id")).toEqual(rows);
    const session = await createSession(f.db, f.user.id, NOW);
    const me = (await loadMe(f.db, session, NOW + 3)).page!;
    expect(me.today.steps).toBe(11000);
    expect(me.manualHistory.map(h => h.steps)).toEqual([11000, 9000]);
  });
  it("does not create manual history or audits for invalid or locked saves", async () => {
    const f = await ready();
    const input = { actor: f.user, userId: f.user.id, date: "2026-10-17", steps: -1, source: "manual" as const };
    await expect(recordSteps(f.db, input, NOW)).rejects.toThrow(/whole number/);
    const membership = (await getMembership(f.db, f.user.id))!;
    await f.db.run("INSERT INTO day_results VALUES (?,? ,0,'[]','no_loser',?)", membership.group.id, input.date, NEXT);
    await expect(recordSteps(f.db, { ...input, steps: 5000 }, NEXT)).rejects.toThrow(/final/);
    expect(await f.db.all("SELECT * FROM manual_step_entries")).toEqual([]);
    expect(await f.db.all("SELECT * FROM audit_log WHERE action='steps.manual_set'")).toEqual([]);
  });
  it("does not save an in-flight response after unlinking", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, async (path, body) => {
      if (path === "/games/getGame") await unlinkStompers(f.db, f.user);
      return f.read(path, body);
    });
    expect(await f.db.first("SELECT * FROM step_entries")).toBeNull();
  });
  it("keeps known game IDs when relinking the same account", async () => {
    const f = await ready();
    await syncStompers(f.db, NOW, f.read);
    await linkStompers(f.db, f.user, "user", "username", NOW + 1, f.read);
    expect(await f.db.all("SELECT * FROM stompers_games")).toHaveLength(1);
  });
  it("never finalizes a previous account's fresh counts after changing the link", async () => {
    const f = await ready();
    await syncStompers(f.db, NEXT, f.read);
    await linkStompers(f.db, f.user, "new-user", "username", NEXT + 1, async () => ({ uid: "new-uid", username: "new-user" }));
    expect(await finalizeDue(f.db, NEXT + 2)).toEqual([]);
    expect(await f.db.first("SELECT * FROM penalties")).toBeNull();
  });
});

it("only sends read requests to the fixed API host with no auth", async () => {
  const mock = vi.fn(async () => Response.json({ uid: "user" }));
  vi.stubGlobal("fetch", mock);
  try {
    await readStompers("/users/getProfileByUid", { uid: "user" });
    expect(mock.mock.calls[0]).toMatchObject(["https://api.stompers.com/users/getProfileByUid", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Accept: "application/json" } }]);
    await expect(readStompers("/health/updateStepCount", {})).rejects.toThrow(/Unknown/);
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it("rejects redirects rather than following them", async () => {
  const mock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://example.com" } }));
  vi.stubGlobal("fetch", mock);
  try {
    await expect(readStompers("/users/getProfileByUid", { uid: "user" })).rejects.toThrow(/HTTP 302/);
    expect(mock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
