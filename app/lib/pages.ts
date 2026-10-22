// One-query page loaders.
//
// Each page uses one SELECT with an auth CTE and independently JSON-aggregated datasets.
// No JOIN fan-out, no duplicated layout fetch, and no application-side sequential queries.
// All datasets are scoped to the caller's group in SQL; invalid sessions yield empty datasets.
//
// "Today" depends on the group's timezone, which we don't know until the query returns. So we fetch
// a small fixed UTC-based date window that contains today/yesterday/this month for ANY timezone
// (UTC-12..UTC+14), then pick the exact local dates in JS.
import type { Db, Stmt } from "./db";
import { sha256 } from "./crypto";
import { AppError, type Group, type User } from "./service";
import { addDays, addMonths, gameEndInstant, isDate, localDate, lockInstant, monthOf } from "./dates";
import { buildDay, buildMonth, inMonth, type ClaimRow, type EntryRow, type MemberRow, type PenaltyRow, type ResultRow, type SettlementRow } from "./views";

export type Ctx = { user: User; group: Group; role: "admin" | "member"; joinedDate: string; avatarVersion: number | null };
type PageStmt = Stmt & { columns: string[] };
type Q = (sql: string, columns: string[], ...extra: unknown[]) => PageStmt;

/** Aggregate a result set without JOIN fan-out. All names come from fixed source code, never input. */
function jsonRows(sql: string, columns: string[]) {
  const fields = columns.flatMap((c) => [`'${c}'`, `r.${c}`]).join(", ");
  return `(SELECT json_group_array(json_object(${fields})) FROM (${sql}) r)`;
}
const CTX_COLUMNS = ["id", "email", "name", "role", "joined_date", "g_id", "g_name", "g_timezone", "g_threshold", "g_penalty", "g_skips", "g_start", "avatar_v"];
const MEMBER_COLUMNS = ["id", "name", "email", "role", "joined_date", "left_date", "avatar_v"];
const ENTRY_COLUMNS = ["user_id", "date", "steps", "updated_at", "raw_steps", "game_steps", "source"];
const CLAIM_COLUMNS = ["user_id", "date", "status"];
const RESULT_COLUMNS = ["date", "min_steps", "loser_ids", "outcome"];
const PENALTY_COLUMNS = ["user_id", "date", "cents"];
const SETTLEMENT_COLUMNS = ["month", "note", "settled_at"];
const HISTORY_COLUMNS = ["month", "cents", "losses", "note", "settled_at"];
const INVITE_COLUMNS = ["id", "email", "expires_at", "created_at"];
const MANUAL_COLUMNS = ["id", "user_id", "name", "actor_name", "date", "steps", "previous_steps", "previous_source", "raw_steps", "game_steps", "created_at"];
export type ManualStepLog = { id: number; user_id: string; name: string; actor_name: string; date: string; steps: number; previous_steps: number | null; previous_source: string | null; raw_steps: number | null; game_steps: number | null; created_at: number };
const MANUAL_LOG = `SELECT e.*,u.name,a.name AS actor_name FROM manual_step_entries e
  JOIN users u ON u.id=e.user_id JOIN users a ON a.id=e.actor_id`;

// ?1 = sha256(session id), ?2 = now (ms). Extra params start at ?3.
const AUTH_CTE = `WITH me AS (
  SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id_hash = ?1 AND s.expires_at > ?2
), ctx AS (
  SELECT m.group_id AS gid, m.role, m.joined_date FROM memberships m
  WHERE m.user_id = (SELECT id FROM me) AND m.left_date IS NULL
  ORDER BY m.joined_date LIMIT 1
) `;
const GID = "(SELECT gid FROM ctx)";

const CTX_SELECT = `SELECT me.id, me.email, me.name, ctx.role, ctx.joined_date,
  g.id AS g_id, g.name AS g_name, g.timezone AS g_timezone, g.threshold_steps AS g_threshold,
  g.penalty_cents AS g_penalty, g.skips_per_month AS g_skips, g.start_date AS g_start,
  (SELECT a.updated_at FROM user_avatars a WHERE a.user_id = me.id) AS avatar_v
  FROM me LEFT JOIN ctx ON 1 LEFT JOIN groups g ON g.id = ctx.gid`;

// avatar_v is the photo's updated_at (null = no photo). It versions the image URL for caching; bytes are never read here.
const MEMBERS = `SELECT u.id, u.name, u.email, m.role, m.joined_date, m.left_date,
  (SELECT a.updated_at FROM user_avatars a WHERE a.user_id = u.id) AS avatar_v
  FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.group_id = ${GID} ORDER BY m.joined_date, u.name`;
// ?3 = from date (inclusive), ?4 = to date (exclusive)
const ENTRIES = `SELECT e.user_id, e.date, e.steps, e.updated_at, e.raw_steps, e.game_steps, e.source FROM step_entries e
  WHERE e.date >= ?3 AND e.date < ?4 AND e.user_id IN (SELECT user_id FROM memberships WHERE group_id = ${GID})`;
const CLAIMS = `SELECT user_id, date, status FROM skip_claims WHERE group_id = ${GID} AND date >= ?3 AND date < ?4`;
const RESULTS = `SELECT date, min_steps, loser_ids, outcome FROM day_results WHERE group_id = ${GID} AND date >= ?3 AND date < ?4`;
const PENALTIES = `SELECT user_id, date, cents FROM penalties WHERE group_id = ${GID} AND date >= ?3 AND date < ?4`;
// ?3 = from month 'YYYY-MM' (inclusive), ?4 = to month (exclusive)
const SETTLEMENTS = `SELECT month, note, settled_at FROM settlements WHERE group_id = ${GID} AND month >= ?3 AND month < ?4`;

const SYNC_COLUMNS = ["user_id", "last_synced_at", "consecutive_failures"];
type SyncRow = { user_id: string; last_synced_at: number | null; consecutive_failures: number };
const SYNC_STATUS = `SELECT user_id, last_synced_at, consecutive_failures FROM stompers_accounts
  WHERE user_id IN (SELECT user_id FROM memberships WHERE group_id = ${GID} AND left_date IS NULL)`;

export type Authed = { user: User | null; ctx: Ctx | null; rows: any[][] };

/** Auth and independently aggregated page datasets in ONE SQL statement and ONE network call. */
export async function runAuthed(db: Db, sid: string | null | undefined, now: number, build: (q: Q) => PageStmt[] = () => []): Promise<Authed> {
  if (!sid) return { user: null, ctx: null, rows: [] };
  const hash = await sha256(sid);
  const params: unknown[] = [hash, now];
  const q: Q = (sql, columns, ...extra) => {
    const offset = params.length - 2;
    params.push(...extra);
    return { sql: sql.replace(/\?(\d+)/g, (m, n) => Number(n) >= 3 ? `?${Number(n) + offset}` : m), params: [], columns };
  };
  const sets = [{ sql: CTX_SELECT, columns: CTX_COLUMNS }, ...build(q)];
  const result = await db.first<Record<string, string>>(
    AUTH_CTE + "SELECT " + sets.map((s, i) => `${jsonRows(s.sql, s.columns)} AS data${i}`).join(", "),
    ...params,
  );
  const res = sets.map((_, i) => JSON.parse(result?.[`data${i}`] ?? "[]") as any[]);
  const r = res[0]?.[0];
  if (!r) return { user: null, ctx: null, rows: res.slice(1) };
  const user: User = { id: r.id, email: r.email, name: r.name };
  const ctx: Ctx | null = r.g_id
    ? {
        user,
        role: r.role,
        joinedDate: r.joined_date,
        avatarVersion: r.avatar_v ?? null,
        group: {
          id: r.g_id,
          name: r.g_name,
          timezone: r.g_timezone,
          threshold_steps: r.g_threshold,
          penalty_cents: r.g_penalty,
          skips_per_month: r.g_skips,
          start_date: r.g_start,
        },
      }
    : null;
  return { user, ctx, rows: res.slice(1) };
}

export const shellOf = (ctx: Ctx) => ({ user: ctx.user, groupName: ctx.group.name, isAdmin: ctx.role === "admin", myAvatar: ctx.avatarVersion });

/** user id -> photo version, for members that have one. */
export const avatarVersions = (members: { id: string; avatar_v?: number | null }[]) =>
  Object.fromEntries(members.filter((m) => m.avatar_v != null).map((m) => [m.id, m.avatar_v as number]));

const utcDate = (now: number) => new Date(now).toISOString().slice(0, 10);

// ───────────────────────────── pages ─────────────────────────────

export async function loadToday(db: Db, sid: string | null | undefined, now = Date.now()) {
  // Local "today" is within [utc-1, utc+1]; local "yesterday" ≥ utc-2. Start at that month's 1st so
  // month totals and per-month skip counts are complete (nothing can be dated after today).
  const u = utcDate(now);
  const lo = `${monthOf(addDays(u, -2))}-01`;
  const hi = addDays(u, 2);
  const a = await runAuthed(db, sid, now, (q) => [q(MEMBERS, MEMBER_COLUMNS), q(ENTRIES, ENTRY_COLUMNS, lo, hi), q(CLAIMS, CLAIM_COLUMNS, lo, hi), q(RESULTS, RESULT_COLUMNS, lo, hi), q(PENALTIES, PENALTY_COLUMNS, lo, hi), q(SYNC_STATUS, SYNC_COLUMNS)]);
  if (!a.ctx) return { auth: a, page: null };
  const [members, entries, claims, results, penalties, syncRows] = a.rows as [MemberRow[], EntryRow[], ClaimRow[], ResultRow[], PenaltyRow[], SyncRow[]];
  const { group, user } = a.ctx;
  const today = localDate(new Date(now), group.timezone);
  const yesterday = addDays(today, -1);
  const month = monthOf(today);
  const current = members.filter((m) => m.left_date === null);
  const todayDay = buildDay(today, current, entries, claims, results, group);
  const yesterdayDay = buildDay(yesterday, current, entries, claims, results, group);
  const used = (userId: string, m: string) => claims.filter((c) => c.user_id === userId && inMonth(c.date, m)).length;
  const mv = buildMonth(month, members, results, penalties, claims, entries, null);
  return {
    auth: a,
    page: {
      shell: shellOf(a.ctx),
      me: user.id,
      group: { threshold: group.threshold_steps, penalty: group.penalty_cents, skips: group.skips_per_month },
      today: todayDay,
      yesterday: yesterdayDay,
      skipsUsedToday: Object.fromEntries(todayDay.rows.map((r) => [r.userId, used(r.userId, month)])),
      skipsUsedYesterday: Object.fromEntries(yesterdayDay.rows.map((r) => [r.userId, used(r.userId, monthOf(yesterday))])),
      totals: mv.totals,
      pot: mv.potCents,
      sync: Object.fromEntries(syncRows.map((r) => [r.user_id, { syncedAt: r.last_synced_at, failures: r.consecutive_failures }])),
      avatars: avatarVersions(members),
      gameEndsAt: gameEndInstant(today, group.timezone),
      locksAt: lockInstant(today, group.timezone),
      now,
    },
  };
}

export async function loadMonth(db: Db, sid: string | null | undefined, ym: string | undefined, now = Date.now()) {
  const explicit = ym && /^\d{4}-\d{2}$/.test(ym) ? ym : null;
  const u = utcDate(now);
  // Without an explicit month, the local month is month(utc-1) or month(utc+1) (usually the same).
  const fromMonth = explicit ?? monthOf(addDays(u, -1));
  const toMonth = addMonths(explicit ?? monthOf(addDays(u, 1)), 1); // exclusive
  const lo = `${fromMonth}-01`;
  const hi = `${toMonth}-01`;
  const a = await runAuthed(db, sid, now, (q) => [
    q(MEMBERS, MEMBER_COLUMNS),
    q(RESULTS, RESULT_COLUMNS, lo, hi),
    q(PENALTIES, PENALTY_COLUMNS, lo, hi),
    q(CLAIMS, CLAIM_COLUMNS, lo, hi),
    q(ENTRIES, ENTRY_COLUMNS, lo, hi),
    q(SETTLEMENTS, SETTLEMENT_COLUMNS, fromMonth, toMonth),
  ]);
  if (!a.ctx) return { auth: a, page: null };
  const [members, results, penalties, claims, entries, settlements] = a.rows as [MemberRow[], ResultRow[], PenaltyRow[], ClaimRow[], EntryRow[], SettlementRow[]];
  const { group } = a.ctx;
  const today = localDate(new Date(now), group.timezone);
  const month = explicit ?? monthOf(today);
  const s = settlements.find((x) => x.month === month);
  const mv = buildMonth(month, members, results, penalties, claims, entries, s ? { note: s.note, settled_at: s.settled_at } : null);
  return { auth: a, page: { shell: shellOf(a.ctx), ...mv, avatars: avatarVersions(members), today, current: monthOf(today), startMonth: monthOf(group.start_date) } };
}

export async function loadHistory(db: Db, sid: string | null | undefined, now = Date.now()) {
  const a = await runAuthed(db, sid, now, (q) => [
    q(`SELECT p.month, p.cents, p.losses, s.note, s.settled_at FROM
         (SELECT substr(date, 1, 7) AS month, SUM(cents) AS cents, COUNT(*) AS losses FROM penalties WHERE group_id = ${GID} GROUP BY month) p
       LEFT JOIN settlements s ON s.group_id = ${GID} AND s.month = p.month ORDER BY p.month DESC`, HISTORY_COLUMNS),
  ]);
  if (!a.ctx) return { auth: a, page: null };
  const rows = a.rows[0] as { month: string; cents: number; losses: number; note: string | null; settled_at: number | null }[];
  return {
    auth: a,
    page: { shell: shellOf(a.ctx), rows, isAdmin: a.ctx.role === "admin", current: monthOf(localDate(new Date(now), a.ctx.group.timezone)) },
  };
}

export async function loadMe(db: Db, sid: string | null | undefined, now = Date.now()) {
  const u = utcDate(now), lo = addDays(u, -2), hi = addDays(u, 2);
  const a = await runAuthed(db, sid, now, q => [q(
    "SELECT stompers_uid,username,last_attempt_at,last_synced_at,last_error FROM stompers_accounts WHERE user_id=(SELECT id FROM me)",
    ["stompers_uid", "username", "last_attempt_at", "last_synced_at", "last_error"],
  ), q(`SELECT user_id,date,steps,updated_at FROM step_entries WHERE user_id=(SELECT id FROM me) AND date>=?3 AND date<?4`,
    ["user_id", "date", "steps", "updated_at"], lo, hi),
    q(RESULTS, RESULT_COLUMNS, lo, hi),
    q(`${MANUAL_LOG} WHERE e.user_id=(SELECT id FROM me) AND e.group_id=${GID} ORDER BY e.created_at DESC,e.id DESC LIMIT 20`, MANUAL_COLUMNS),
    q("SELECT updated_at FROM user_avatars WHERE user_id=(SELECT id FROM me)", ["updated_at"]),
  ]);
  if (!a.ctx) return { auth: a, page: null };
  const g = a.ctx.group;
  const today = localDate(new Date(now), g.timezone), yesterday = addDays(today, -1);
  const entries = a.rows[1] as EntryRow[], results = a.rows[2] as ResultRow[];
  const manualDay = (date: string) => ({ date, steps: entries.find(e => e.date === date)?.steps ?? null, finalized: results.some(r => r.date === date) });
  return {
    auth: a,
    page: { shell: shellOf(a.ctx), user: a.ctx.user, timezone: g.timezone,
      stompers: (a.rows[0][0] ?? null) as { stompers_uid: string; username: string | null; last_attempt_at: number | null; last_synced_at: number | null; last_error: string | null } | null,
      today: manualDay(today), yesterday: manualDay(yesterday), manualHistory: a.rows[3] as ManualStepLog[],
      avatars: avatarVersions([{ id: a.ctx.user.id, avatar_v: (a.rows[4][0] as { updated_at: number } | undefined)?.updated_at ?? null }]),
      rules: { threshold: g.threshold_steps, penalty: g.penalty_cents, skips: g.skips_per_month } },
  };
}

export async function loadGroupAdmin(db: Db, sid: string | null | undefined, now = Date.now()) {
  const a = await runAuthed(db, sid, now, (q) => [
    q(MEMBERS, MEMBER_COLUMNS),
    // ?2 (now) is already bound by the auth CTE.
    q(`SELECT id, email, expires_at, created_at FROM invites
       WHERE group_id = ${GID} AND (SELECT role FROM ctx) = 'admin'
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC`, INVITE_COLUMNS),
    q(`${MANUAL_LOG} WHERE e.group_id=${GID} AND (SELECT role FROM ctx)='admin' ORDER BY e.created_at DESC,e.id DESC LIMIT 50`, MANUAL_COLUMNS),
  ]);
  if (!a.ctx) return { auth: a, page: null };
  const [members, invites, manualHistory] = a.rows as [MemberRow[], { id: string; email: string; expires_at: number; created_at: number }[], ManualStepLog[]];
  return {
    auth: a,
    page: {
      shell: shellOf(a.ctx),
      isAdmin: a.ctx.role === "admin",
      group: a.ctx.group,
      members: members.filter((m) => m.left_date === null),
      avatars: avatarVersions(members),
      invites,
      manualHistory,
      today: localDate(new Date(now), a.ctx.group.timezone),
    },
  };
}

// ───────────────────────────── actions ─────────────────────────────

export type DayFacts = { finalized: boolean; monthClaims: { date: string; status: string }[] };

/**
 * Auth + everything the Today-page writes need to validate `date`, in one round trip:
 * whether that day is final, and the caller's skip claims in that month.
 */
export async function loadActionCtx(db: Db, sid: string | null | undefined, date: string | null, now = Date.now()) {
  const ok = date !== null && isDate(date);
  const m = ok ? monthOf(date!) : null;
  const a = await runAuthed(db, sid, now, (q) =>
    ok
      ? [
          q(`SELECT 1 AS f FROM day_results WHERE group_id = ${GID} AND date = ?3`, ["f"], date),
          q(`SELECT date, status FROM skip_claims WHERE group_id = ${GID} AND user_id = (SELECT id FROM me) AND date >= ?3 AND date < ?4`, ["date", "status"], `${m}-01`, `${addMonths(m!, 1)}-01`),
        ]
      : [],
  );
  const facts: DayFacts | null = ok && a.ctx ? { finalized: (a.rows[0] ?? []).length > 0, monthClaims: (a.rows[1] ?? []) as DayFacts["monthClaims"] } : null;
  return { auth: a, facts };
}

// ───────────────────────────── public pages ─────────────────────────────

export async function loadLoginState(db: Db, sid: string | null | undefined, now = Date.now()) {
  const r = await db.first<{ b: number; logged: number }>(
    `SELECT EXISTS(SELECT 1 FROM users) AS b,
      EXISTS(SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?) AS logged`,
    sid ? await sha256(sid) : "", now,
  );
  return { bootstrapped: !!r?.b, loggedIn: !!r?.logged };
}

export type InviteRow = {
  id: string;
  group_id: string;
  email: string;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  group_name: string;
  inviter: string;
};

export function checkInvite(inv: InviteRow | undefined | null, now: number): InviteRow {
  if (!inv) throw new AppError(404, "This invite link isn't valid.");
  if (inv.revoked_at) throw new AppError(410, "This invite was revoked. Ask for a new one.");
  if (inv.accepted_at) throw new AppError(410, "This invite was already used. Just log in.");
  if (inv.expires_at < now) throw new AppError(410, "This invite expired. Ask for a new one.");
  return inv;
}

export const INVITE_SELECT = `SELECT i.id, i.group_id, i.email, i.expires_at, i.accepted_at, i.revoked_at, g.name AS group_name, u.name AS inviter
  FROM invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?`;

/** Invite preview + who's logged in, one round trip. Throws AppError for bad invites. */
export async function loadInvitePage(db: Db, token: string, sid: string | null | undefined, now = Date.now()) {
  const row = await db.first<{ invite: string; me: string }>(
    `SELECT ${jsonRows(INVITE_SELECT.replace("?", "?1"), ["id", "group_id", "email", "expires_at", "accepted_at", "revoked_at", "group_name", "inviter"])} AS invite,
     ${jsonRows("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?2 AND s.expires_at > ?3", ["id", "email", "name"])} AS me`,
    await sha256(token), sid ? await sha256(sid) : "", now,
  );
  const inv = JSON.parse(row?.invite ?? "[]") as InviteRow[];
  const me = JSON.parse(row?.me ?? "[]") as User[];
  return { invite: checkInvite(inv[0], now), user: me[0] ?? null };
}
