import type { Db } from "./db";
import { stmt } from "./db";
import { addDays, localDate, localParts } from "./dates";
import { AppError, MAX_STEPS, type User } from "./service";

type Json = Record<string, unknown>;
type Account = { user_id: string; stompers_uid: string; username: string | null; updated_at: number; timezone: string; joined_date: string; start_date: string };
export type Sample = { date: string; gameUid: string; rawSteps: number; gameSteps: number; steps: number };
export type ApiRead = (path: string, body: Json) => Promise<unknown>;
const object = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const uid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);

/** Fixed host, read routes only. Never forward credentials or follow redirects. */
export const readStompers: ApiRead = async (path, body) => {
  if (!["/users/getProfileByUsername", "/users/getProfileByUid", "/rooms/getRoom", "/games/getGame", "/games/getRecentGamesByRoomUid"].includes(path)) throw new Error("Unknown Stompers read route");
  try {
    const response = await fetch(`https://api.stompers.com${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new AppError(502, `Stompers returned HTTP ${response.status}. Try again later.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error("Response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error("stompers.read_failed", JSON.stringify({ path, reason: error instanceof Error ? error.message.slice(0, 200) : "Unknown read error" }));
    throw new AppError(502, "Could not read Stompers. Try again later.");
  }
};

export async function linkStompers(db: Db, user: User, identity: string, kind: string, now = Date.now(), read = readStompers) {
  const value = identity.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value) || !["username", "uid"].includes(kind)) throw new AppError(400, "Enter a Stompers username or user ID.");
  const profile = await read(kind === "uid" ? "/users/getProfileByUid" : "/users/getProfileByUsername", kind === "uid" ? { uid: value } : { username: value });
  if (!object(profile) || !uid(profile.uid)) throw new AppError(400, "Stompers account not found.");
  const existing = await db.first<{ user_id: string }>("SELECT user_id FROM stompers_accounts WHERE stompers_uid = ?", profile.uid);
  if (existing && existing.user_id !== user.id) throw new AppError(409, "That Stompers account is already linked.");
  await db.batch([
    stmt("DELETE FROM stompers_games WHERE user_id = ? AND EXISTS (SELECT 1 FROM stompers_accounts WHERE user_id=? AND stompers_uid<>?)", user.id, user.id, profile.uid),
    stmt(`INSERT INTO stompers_accounts (user_id, stompers_uid, username, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET stompers_uid=excluded.stompers_uid, username=excluded.username,
      updated_at=excluded.updated_at, last_attempt_at=NULL, last_synced_at=NULL, last_error=NULL`,
      user.id, profile.uid, typeof profile.username === "string" ? profile.username : null, now),
  ]);
}

export async function unlinkStompers(db: Db, user: User) {
  await db.batch([stmt("DELETE FROM stompers_accounts WHERE user_id = ?", user.id), stmt("DELETE FROM stompers_games WHERE user_id = ?", user.id)]);
}

/** Require both real numbers and a full local calendar day in the group's timezone. */
export function gameSample(value: unknown, userUid: string, timezone: string): Sample {
  if (!object(value) || !uid(value.uid) || value.time_zone !== timezone) throw new AppError(502, "Stompers game timezone does not match the group.");
  const start = typeof value.starts_at === "string" ? new Date(value.starts_at) : new Date(NaN);
  const end = typeof value.finishes_at === "string" ? new Date(value.finishes_at) : new Date(NaN);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new AppError(502, "Stompers game dates are missing.");
  const first = localParts(start, timezone), last = localParts(end, timezone);
  const midnight = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date)
    .filter(p => ["hour", "minute", "second"].includes(p.type)).every(p => Number(p.value) === 0) && date.getUTCMilliseconds() === 0;
  if (!midnight(start) || !midnight(end) || last.date !== addDays(first.date, 1)) throw new AppError(502, "Stompers game is not one full local day.");
  const raw = object(value.step_counts) ? value.step_counts[userUid] : undefined;
  const game = object(value.game_step_counts) ? value.game_step_counts[userUid] : undefined;
  if (![raw, game].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_STEPS)) throw new AppError(502, "Stompers step counts are missing or invalid.");
  return { date: first.date, gameUid: value.uid, rawSteps: raw as number, gameSteps: game as number, steps: Math.max(raw as number, game as number) };
}

async function syncAccount(db: Db, account: Account, now: number, read: ApiRead) {
  const today = localDate(new Date(now), account.timezone), yesterday = addDays(today, -1);
  const earliest = [yesterday, account.joined_date, account.start_date].sort().at(-1)!;
  const errors: string[] = []; let saved = 0;
  const recordError = (error: unknown) => errors.push(error instanceof AppError ? error.message : "Stompers sync failed. Try again later.");
  try {
    const cached = await db.all<{ game_uid: string }>("SELECT game_uid FROM stompers_games WHERE user_id=? AND date>=? AND date<=?", account.user_id, earliest, today);
    const ids = new Set(cached.map(g => g.game_uid));
    const roomUid = `${account.stompers_uid}_friends`;
    try {
      const room = await read("/rooms/getRoom", { uid: roomUid });
      if (!object(room) || room.uid !== roomUid || !uid(room.current_game_uid)) throw new AppError(502, "No current Stompers game found.");
      ids.add(room.current_game_uid);
    } catch (error) { recordError(error); }
    // The history list can omit the active game. Cache IDs so yesterday stays readable.
    try {
      const history = await read("/games/getRecentGamesByRoomUid", { uid: roomUid, limit: 3 });
      if (!Array.isArray(history)) throw new AppError(502, "Stompers history is invalid.");
      for (const game of history.slice(0, 3)) if (object(game) && uid(game.uid)) ids.add(game.uid);
    } catch (error) { recordError(error); }
    for (const gameUid of ids) {
      try {
        const game = await read("/games/getGame", { uid: gameUid });
        if (!object(game) || game.uid !== gameUid) throw new AppError(502, "Stompers returned the wrong game.");
        const sample = gameSample(game, account.stompers_uid, account.timezone);
        if (sample.date < earliest || sample.date > today) continue;
        const guard = `EXISTS (SELECT 1 FROM stompers_accounts WHERE user_id=? AND stompers_uid=? AND updated_at=?)
          AND NOT EXISTS (SELECT 1 FROM day_results r JOIN memberships m ON m.group_id=r.group_id WHERE m.user_id=? AND r.date=?)`;
        const params = [account.user_id, account.stompers_uid, account.updated_at, account.user_id, sample.date];
        await db.batch([
          stmt(`INSERT INTO stompers_games (user_id,date,game_uid) SELECT ?,?,? WHERE ${guard}
            ON CONFLICT(user_id,date) DO UPDATE SET game_uid=excluded.game_uid`, account.user_id, sample.date, sample.gameUid, ...params),
          stmt(`INSERT INTO step_entries (user_id,date,steps,source,updated_at,raw_steps,game_steps,stompers_game_uid,stompers_synced_at)
            SELECT ?,?,?,'stompers',?,?,?,?,? WHERE ${guard}
            ON CONFLICT(user_id,date) DO UPDATE SET
              steps=CASE WHEN step_entries.source IN ('admin','manual') THEN step_entries.steps ELSE excluded.steps END,
              source=CASE WHEN step_entries.source IN ('admin','manual') THEN step_entries.source ELSE 'stompers' END,
              updated_at=CASE WHEN step_entries.source IN ('admin','manual') THEN step_entries.updated_at ELSE excluded.updated_at END,
              raw_steps=excluded.raw_steps, game_steps=excluded.game_steps,
              stompers_game_uid=excluded.stompers_game_uid, stompers_synced_at=excluded.stompers_synced_at
            WHERE step_entries.stompers_synced_at IS NULL OR step_entries.stompers_synced_at<=excluded.stompers_synced_at`,
            account.user_id, sample.date, sample.steps, now, sample.rawSteps, sample.gameSteps, sample.gameUid, now, ...params),
        ]);
        saved++;
      } catch (error) { recordError(error); }
    }
    if (!saved && !errors.length) errors.push("No steps found for today or yesterday.");
  } catch (error) { recordError(error); }
  await db.run(`UPDATE stompers_accounts SET last_attempt_at=?, last_synced_at=CASE WHEN ? THEN ? ELSE last_synced_at END, last_error=?
    WHERE user_id=? AND stompers_uid=? AND updated_at=? AND (last_attempt_at IS NULL OR last_attempt_at<=?)`,
    now, saved > 0 ? 1 : 0, now, errors.length ? errors.join(" ").slice(0, 500) : null, account.user_id, account.stompers_uid, account.updated_at, now);
  return { userId: account.user_id, saved, ok: errors.length === 0 };
}

export type SyncScope = { userId?: string; groupId?: string };

export async function syncStompers(db: Db, now = Date.now(), read = readStompers, scope: SyncScope = {}) {
  const filters = [scope.userId && ["a.user_id=?", scope.userId], scope.groupId && ["g.id=?", scope.groupId]].filter(Boolean) as [string, string][];
  const accounts = await db.all<Account>(`SELECT a.*,g.timezone,g.start_date,m.joined_date FROM stompers_accounts a
    JOIN memberships m ON m.user_id=a.user_id AND m.left_date IS NULL JOIN groups g ON g.id=m.group_id
    ${filters.length ? `WHERE ${filters.map(([sql]) => sql).join(" AND ")}` : ""}`, ...filters.map(([, value]) => value));
  const results = [];
  // Two users at a time bounds concurrent fetches and keeps individual failures isolated.
  for (let i = 0; i < accounts.length; i += 2) results.push(...await Promise.all(accounts.slice(i, i + 2).map(a => syncAccount(db, a, now, read))));
  return results;
}

/** Pull first; only then lock due days against refreshed counts. */
export async function runStompersSchedule(db: Db, now = Date.now(), read = readStompers) {
  const synced = await syncStompers(db, now, read);
  const { finalizeDue } = await import("./service");
  return { synced, finalized: await finalizeDue(db, now) };
}
