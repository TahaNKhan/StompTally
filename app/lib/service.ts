// All server-side business logic. Takes a Db so it runs against D1 in prod and node:sqlite in tests.
import type { Db } from "./db";
import { stmt } from "./db";
import { isEmail, newId, normalizeEmail, randomToken, sha256 } from "./crypto";
import { computeDay, canClaimSkip } from "./rules";
import { addDays, daysInMonth, isDate, lastFinalizableDate, localDate, monthOf } from "./dates";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SESSION_TTL = 60 * DAY;
export const LOGIN_TTL = 20 * 60_000;
export const INVITE_TTL = 7 * DAY;
export const MAX_STEPS = 150_000;

export type User = { id: string; email: string; name: string };
export type Group = {
  id: string;
  name: string;
  timezone: string;
  threshold_steps: number;
  penalty_cents: number;
  skips_per_month: number;
  start_date: string;
};
export type Membership = { group_id: string; user_id: string; role: "admin" | "member"; joined_date: string; left_date: string | null };

export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const audit = (groupId: string | null, actorId: string | null, action: string, payload: unknown, now: number) =>
  stmt("INSERT INTO audit_log (group_id, actor_id, action, payload, at) VALUES (?, ?, ?, ?, ?)", groupId, actorId, action, JSON.stringify(payload ?? null), now);

// ───────────────────────────── bootstrap ─────────────────────────────

/** Creates the first admin + group. Only works while there are no users at all. */
export async function bootstrap(db: Db, input: { email: string; name: string; groupName: string; timezone: string }, now = Date.now()) {
  const count = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  if ((count?.n ?? 0) > 0) throw new AppError(403, "Already set up");
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new AppError(400, "Invalid email");
  const userId = newId();
  const groupId = newId();
  const today = localDate(new Date(now), input.timezone);
  await db.batch([
    stmt("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)", userId, email, input.name.trim() || email, now),
    stmt("INSERT INTO groups (id, name, timezone, start_date, created_at) VALUES (?, ?, ?, ?, ?)", groupId, input.groupName.trim() || "Stompers", input.timezone, today, now),
    stmt("INSERT INTO memberships (group_id, user_id, role, joined_date) VALUES (?, ?, 'admin', ?)", groupId, userId, today),
    audit(groupId, userId, "bootstrap", { email }, now),
  ]);
  return { userId, groupId };
}

export async function isBootstrapped(db: Db) {
  const r = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return (r?.n ?? 0) > 0;
}

// ───────────────────────────── auth ─────────────────────────────

/** Issues a login token for an existing user. Returns null (silently) for unknown emails. */
export async function createLoginToken(db: Db, rawEmail: string, now = Date.now()) {
  const email = normalizeEmail(rawEmail);
  const user = await db.first<User>("SELECT id, email, name FROM users WHERE email = ?", email);
  if (!user) return null;
  const token = randomToken();
  await db.run("INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256(token), user.id, now + LOGIN_TTL);
  return { token, user };
}

/** Single-use login token -> session. */
export async function redeemLoginToken(db: Db, token: string, now = Date.now()) {
  const hash = await sha256(token);
  const row = await db.first<{ user_id: string; expires_at: number; used_at: number | null }>(
    "SELECT user_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?",
    hash,
  );
  if (!row || row.used_at || row.expires_at < now) throw new AppError(400, "That login link is invalid or expired. Request a new one.");
  const res = await db.run("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now, hash);
  if (res.changes !== 1) throw new AppError(400, "That login link was already used.");
  return createSession(db, row.user_id, now);
}

export async function createSession(db: Db, userId: string, now = Date.now()) {
  const sid = randomToken();
  await db.batch([
    stmt("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256(sid), userId, now + SESSION_TTL),
    stmt("DELETE FROM sessions WHERE expires_at < ?", now),
    stmt("DELETE FROM login_tokens WHERE expires_at < ?", now - DAY),
  ]);
  return sid;
}

export async function getSessionUser(db: Db, sid: string | null | undefined, now = Date.now()) {
  if (!sid) return null;
  return db.first<User>(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?",
    await sha256(sid),
    now,
  );
}

export async function destroySession(db: Db, sid: string) {
  await db.run("DELETE FROM sessions WHERE id_hash = ?", await sha256(sid));
}

// ───────────────────────────── groups / membership ─────────────────────────────

export async function getMembership(db: Db, userId: string) {
  // One group per user for now (5 friends). Returns their active group.
  const row = await db.first<Membership & Group>(
    `SELECT m.group_id, m.user_id, m.role, m.joined_date, m.left_date,
            g.id, g.name, g.timezone, g.threshold_steps, g.penalty_cents, g.skips_per_month, g.start_date
     FROM memberships m JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = ? AND m.left_date IS NULL ORDER BY m.joined_date LIMIT 1`,
    userId,
  );
  if (!row) return null;
  const group: Group = {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    threshold_steps: row.threshold_steps,
    penalty_cents: row.penalty_cents,
    skips_per_month: row.skips_per_month,
    start_date: row.start_date,
  };
  return { group, role: row.role, joinedDate: row.joined_date };
}

export async function listMembers(db: Db, groupId: string) {
  return db.all<{ id: string; name: string; email: string; role: string; joined_date: string; left_date: string | null }>(
    `SELECT u.id, u.name, u.email, m.role, m.joined_date, m.left_date
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_date, u.name`,
    groupId,
  );
}

function activeOn(m: { joined_date: string; left_date: string | null }, date: string) {
  return m.joined_date <= date && (m.left_date === null || m.left_date > date);
}

export async function updateGroup(db: Db, actor: User, groupId: string, patch: Partial<Pick<Group, "name" | "timezone" | "threshold_steps" | "penalty_cents" | "skips_per_month">>, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  const g = await db.first<Group>("SELECT * FROM groups WHERE id = ?", groupId);
  if (!g) throw new AppError(404, "Group not found");
  const next = { ...g, ...patch };
  if (!next.name.trim()) throw new AppError(400, "Name required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next.timezone });
  } catch {
    throw new AppError(400, "Unknown timezone");
  }
  for (const [k, lo, hi] of [["threshold_steps", 1000, 100000], ["penalty_cents", 0, 100000], ["skips_per_month", 0, 31]] as const) {
    const v = next[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new AppError(400, `Invalid ${k}`);
  }
  await db.batch([
    stmt("UPDATE groups SET name = ?, timezone = ?, threshold_steps = ?, penalty_cents = ?, skips_per_month = ? WHERE id = ?", next.name.trim(), next.timezone, next.threshold_steps, next.penalty_cents, next.skips_per_month, groupId),
    audit(groupId, actor.id, "group.update", patch, now),
  ]);
}

async function requireAdmin(db: Db, userId: string, groupId: string) {
  const m = await db.first<{ role: string }>("SELECT role FROM memberships WHERE group_id = ? AND user_id = ? AND left_date IS NULL", groupId, userId);
  if (m?.role !== "admin") throw new AppError(403, "Admins only");
}

export async function removeMember(db: Db, actor: User, groupId: string, userId: string, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  if (userId === actor.id) throw new AppError(400, "You can't remove yourself");
  const g = await db.first<Group>("SELECT * FROM groups WHERE id = ?", groupId);
  const today = localDate(new Date(now), g!.timezone);
  await db.batch([
    stmt("UPDATE memberships SET left_date = ? WHERE group_id = ? AND user_id = ? AND left_date IS NULL", today, groupId, userId),
    stmt("DELETE FROM sessions WHERE user_id = ?", userId),
    audit(groupId, actor.id, "member.remove", { userId }, now),
  ]);
}

// ───────────────────────────── invites ─────────────────────────────

export async function createInvite(db: Db, actor: User, groupId: string, rawEmail: string, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) throw new AppError(400, "Invalid email");
  const existing = await db.first(
    "SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.email = ? AND m.left_date IS NULL",
    groupId,
    email,
  );
  if (existing) throw new AppError(409, "They're already in the group");
  const token = randomToken();
  const id = newId();
  await db.batch([
    // Re-inviting the same email revokes their older pending invites.
    stmt("UPDATE invites SET revoked_at = ? WHERE group_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL", now, groupId, email),
    stmt("INSERT INTO invites (id, group_id, email, token_hash, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, groupId, email, await sha256(token), actor.id, now + INVITE_TTL, now),
    audit(groupId, actor.id, "invite.create", { email }, now),
  ]);
  return { id, token, email };
}

export async function listPendingInvites(db: Db, groupId: string, now = Date.now()) {
  return db.all<{ id: string; email: string; expires_at: number; created_at: number }>(
    "SELECT id, email, expires_at, created_at FROM invites WHERE group_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    groupId,
    now,
  );
}

export async function revokeInvite(db: Db, actor: User, groupId: string, inviteId: string, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  await db.batch([
    stmt("UPDATE invites SET revoked_at = ? WHERE id = ? AND group_id = ? AND accepted_at IS NULL", now, inviteId, groupId),
    audit(groupId, actor.id, "invite.revoke", { inviteId }, now),
  ]);
}

async function loadInvite(db: Db, token: string, now: number) {
  const inv = await db.first<{ id: string; group_id: string; email: string; expires_at: number; accepted_at: number | null; revoked_at: number | null; group_name: string; inviter: string }>(
    `SELECT i.id, i.group_id, i.email, i.expires_at, i.accepted_at, i.revoked_at, g.name AS group_name, u.name AS inviter
     FROM invites i JOIN groups g ON g.id = i.group_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?`,
    await sha256(token),
  );
  if (!inv) throw new AppError(404, "This invite link isn't valid.");
  if (inv.revoked_at) throw new AppError(410, "This invite was revoked. Ask for a new one.");
  if (inv.accepted_at) throw new AppError(410, "This invite was already used. Just log in.");
  if (inv.expires_at < now) throw new AppError(410, "This invite expired. Ask for a new one.");
  return inv;
}

export async function previewInvite(db: Db, token: string, now = Date.now()) {
  const inv = await loadInvite(db, token, now);
  return { email: inv.email, groupName: inv.group_name, inviter: inv.inviter };
}

/**
 * Step 1 of accepting: the invitee confirms their name, and we email a single-use link to the
 * INVITED address. Possession of the invite link alone is not enough to join.
 */
export async function startInviteAcceptance(db: Db, token: string, name: string, now = Date.now()) {
  const inv = await loadInvite(db, token, now);
  let user = await db.first<User>("SELECT id, email, name FROM users WHERE email = ?", inv.email);
  if (!user) {
    const id = newId();
    const display = name.trim().slice(0, 40) || inv.email.split("@")[0];
    await db.run("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)", id, inv.email, display, now);
    user = { id, email: inv.email, name: display };
  }
  const login = await createLoginToken(db, inv.email, now);
  return { email: inv.email, loginToken: login!.token, user };
}

/** Step 2: after the emailed link logs them in, finish joining if the session email matches. */
export async function completeInvite(db: Db, user: User, token: string, now = Date.now()) {
  const inv = await loadInvite(db, token, now);
  if (normalizeEmail(user.email) !== normalizeEmail(inv.email)) throw new AppError(403, "This invite was sent to a different email.");
  const g = await db.first<Group>("SELECT * FROM groups WHERE id = ?", inv.group_id);
  const today = localDate(new Date(now), g!.timezone);
  const res = await db.run("UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL", now, inv.id);
  if (res.changes !== 1) throw new AppError(410, "This invite was already used.");
  await db.batch([
    stmt(
      `INSERT INTO memberships (group_id, user_id, role, joined_date) VALUES (?, ?, 'member', ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET left_date = NULL, joined_date = excluded.joined_date`,
      inv.group_id,
      user.id,
      today,
    ),
    audit(inv.group_id, user.id, "invite.accept", { email: user.email }, now),
  ]);
  return { groupId: inv.group_id };
}

// ───────────────────────────── steps ─────────────────────────────

async function isFinalized(db: Db, groupId: string, date: string) {
  return !!(await db.first("SELECT 1 FROM day_results WHERE group_id = ? AND date = ?", groupId, date));
}

/**
 * Record steps for a day (the Stompers number, after power-ups).
 * Self-reports: today, or yesterday until it finalizes at noon. Never a finalized day.
 * Admin edits can touch any past day; editing a finalized day re-finalizes it.
 */
export async function recordSteps(
  db: Db,
  input: { actor: User; userId: string; date: string; steps: number; source: "manual" | "admin" },
  now = Date.now(),
) {
  const m = await getMembership(db, input.userId);
  if (!m) throw new AppError(403, "Not in a group");
  const { group } = m;
  if (!isDate(input.date)) throw new AppError(400, "date must be YYYY-MM-DD");
  if (!Number.isInteger(input.steps) || input.steps < 0 || input.steps > MAX_STEPS) throw new AppError(400, `Steps must be a whole number from 0 to ${MAX_STEPS.toLocaleString("en-US")}`);
  const today = localDate(new Date(now), group.timezone);
  const finalized = await isFinalized(db, group.id, input.date);

  if (input.source === "admin") {
    await requireAdmin(db, input.actor.id, group.id);
    if (input.date > today) throw new AppError(400, "Can't set steps in the future");
  } else {
    if (input.actor.id !== input.userId) throw new AppError(403, "You can only report your own steps");
    if (input.date > today) throw new AppError(400, "Can't log steps for the future");
    if (input.date < addDays(today, -1)) throw new AppError(400, "You can only log today or yesterday");
    if (finalized) throw new AppError(409, "That day is already final. Ask an admin to correct it.");
  }

  await db.batch([
    stmt(
      `INSERT INTO step_entries (user_id, date, steps, source, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET steps = excluded.steps, source = excluded.source, updated_at = excluded.updated_at`,
      input.userId,
      input.date,
      input.steps,
      input.source,
      now,
    ),
    ...(input.source === "admin" ? [audit(group.id, input.actor.id, "steps.admin_set", { userId: input.userId, date: input.date, steps: input.steps }, now)] : []),
  ]);

  if (finalized) await finalizeDay(db, group, input.date, now, { force: true });
  return { date: input.date, steps: input.steps };
}

// ───────────────────────────── skips ─────────────────────────────

export async function claimSkip(db: Db, user: User, date: string, now = Date.now()) {
  const m = await getMembership(db, user.id);
  if (!m) throw new AppError(403, "Not in a group");
  const { group } = m;
  if (!isDate(date)) throw new AppError(400, "Bad date");
  const today = localDate(new Date(now), group.timezone);
  if (date > today) throw new AppError(400, "You can only skip today or a day that isn't final yet");
  if (date < m.joinedDate) throw new AppError(400, "You weren't in the group yet");
  if (await isFinalized(db, group.id, date)) throw new AppError(409, "That day is already final");
  const used = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM skip_claims WHERE group_id = ? AND user_id = ? AND substr(date, 1, 7) = ?",
    group.id,
    user.id,
    monthOf(date),
  );
  const already = await db.first("SELECT 1 FROM skip_claims WHERE group_id = ? AND user_id = ? AND date = ?", group.id, user.id, date);
  if (already) return;
  if (!canClaimSkip(used?.n ?? 0, group.skips_per_month)) throw new AppError(409, `You've used all ${group.skips_per_month} skips this month`);
  await db.batch([
    stmt("INSERT INTO skip_claims (group_id, user_id, date, status, created_at) VALUES (?, ?, ?, 'pending', ?)", group.id, user.id, date, now),
    audit(group.id, user.id, "skip.claim", { date }, now),
  ]);
}

export async function cancelSkip(db: Db, user: User, date: string, now = Date.now()) {
  const m = await getMembership(db, user.id);
  if (!m) throw new AppError(403, "Not in a group");
  if (await isFinalized(db, m.group.id, date)) throw new AppError(409, "That day is already final");
  await db.batch([
    stmt("DELETE FROM skip_claims WHERE group_id = ? AND user_id = ? AND date = ? AND status = 'pending'", m.group.id, user.id, date),
    audit(m.group.id, user.id, "skip.cancel", { date }, now),
  ]);
}

// ───────────────────────────── finalize ─────────────────────────────

export async function finalizeDay(db: Db, group: Group, date: string, now = Date.now(), opts: { force?: boolean } = {}) {
  if (!opts.force && (await isFinalized(db, group.id, date))) return null;
  const members = await listMembers(db, group.id);
  const memberIds = members.filter((m) => activeOn(m, date)).map((m) => m.id);
  const entries = await db.all<{ user_id: string; steps: number }>(
    `SELECT user_id, steps FROM step_entries WHERE date = ? AND user_id IN (SELECT user_id FROM memberships WHERE group_id = ?)`,
    date,
    group.id,
  );
  const claims = await db.all<{ user_id: string }>("SELECT user_id FROM skip_claims WHERE group_id = ? AND date = ?", group.id, date);
  const result = computeDay(
    { memberIds, steps: Object.fromEntries(entries.map((e) => [e.user_id, e.steps])), skipClaims: claims.map((c) => c.user_id) },
    { thresholdSteps: group.threshold_steps, penaltyCents: group.penalty_cents },
  );

  await db.batch([
    stmt("DELETE FROM penalties WHERE group_id = ? AND date = ?", group.id, date),
    ...result.penalties.map((p) => stmt("INSERT INTO penalties (group_id, user_id, date, cents) VALUES (?, ?, ?, ?)", group.id, p.userId, date, p.cents)),
    ...result.skipsConsumed.map((u) => stmt("UPDATE skip_claims SET status = 'consumed' WHERE group_id = ? AND user_id = ? AND date = ?", group.id, u, date)),
    ...result.skipsReleased.map((u) => stmt("DELETE FROM skip_claims WHERE group_id = ? AND user_id = ? AND date = ?", group.id, u, date)),
    stmt(
      `INSERT INTO day_results (group_id, date, min_steps, loser_ids, outcome, finalized_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, date) DO UPDATE SET min_steps = excluded.min_steps, loser_ids = excluded.loser_ids, outcome = excluded.outcome, finalized_at = excluded.finalized_at`,
      group.id,
      date,
      result.minSteps,
      JSON.stringify(result.loserIds),
      result.outcome,
      now,
    ),
  ]);
  return result;
}

/** Cron entry point: finalize every unfinalized day up to the cutoff, for every group. */
export async function finalizeDue(db: Db, now = Date.now()) {
  const groups = await db.all<Group>("SELECT * FROM groups");
  const done: { groupId: string; date: string; outcome: string }[] = [];
  for (const g of groups) {
    const cutoff = lastFinalizableDate(new Date(now), g.timezone);
    const last = await db.first<{ d: string | null }>("SELECT MAX(date) AS d FROM day_results WHERE group_id = ?", g.id);
    let date = last?.d ? addDays(last.d, 1) : g.start_date;
    // Bounded catch-up in case cron was down.
    for (let i = 0; date <= cutoff && i < 62; i++, date = addDays(date, 1)) {
      const r = await finalizeDay(db, g, date, now);
      if (r) done.push({ groupId: g.id, date, outcome: r.outcome });
    }
  }
  return done;
}

// ───────────────────────────── read models ─────────────────────────────

export async function todayBoard(db: Db, group: Group, now = Date.now()) {
  const today = localDate(new Date(now), group.timezone);
  const yesterday = addDays(today, -1);
  const members = (await listMembers(db, group.id)).filter((m) => m.left_date === null);
  const load = async (date: string) => {
    const entries = await db.all<{ user_id: string; steps: number; updated_at: number }>(
      "SELECT user_id, steps, updated_at FROM step_entries WHERE date = ?",
      date,
    );
    const claims = await db.all<{ user_id: string }>("SELECT user_id FROM skip_claims WHERE group_id = ? AND date = ?", group.id, date);
    const byUser = new Map(entries.map((e) => [e.user_id, e]));
    const claimSet = new Set(claims.map((c) => c.user_id));
    const rows = members
      .filter((m) => activeOn(m, date))
      .map((m) => ({
        userId: m.id,
        name: m.name,
        steps: byUser.get(m.id)?.steps ?? null,
        updatedAt: byUser.get(m.id)?.updated_at ?? null,
        skipClaimed: claimSet.has(m.id),
      }))
      .sort((a, b) => (b.steps ?? -1) - (a.steps ?? -1));
    const preview = computeDay(
      { memberIds: rows.map((r) => r.userId), steps: Object.fromEntries(rows.map((r) => [r.userId, r.steps ?? 0])), skipClaims: [...claimSet] },
      { thresholdSteps: group.threshold_steps, penaltyCents: group.penalty_cents },
    );
    const result = await db.first<{ outcome: string; loser_ids: string }>("SELECT outcome, loser_ids FROM day_results WHERE group_id = ? AND date = ?", group.id, date);
    return { date, rows, preview, finalized: !!result };
  };
  const month = monthOf(today);
  const skipCounts = await db.all<{ user_id: string; month: string; n: number }>(
    "SELECT user_id, substr(date, 1, 7) AS month, COUNT(*) AS n FROM skip_claims WHERE group_id = ? AND substr(date, 1, 7) IN (?, ?) GROUP BY user_id, month",
    group.id,
    month,
    monthOf(yesterday),
  );
  const skipsUsed = (userId: string, m: string) => skipCounts.find((s) => s.user_id === userId && s.month === m)?.n ?? 0;
  return { today: await load(today), yesterday: await load(yesterday), skipsUsed, month };
}

export async function monthView(db: Db, group: Group, month: string) {
  const members = (await listMembers(db, group.id));
  const days = daysInMonth(month);
  const results = await db.all<{ date: string; min_steps: number | null; loser_ids: string; outcome: string }>(
    "SELECT date, min_steps, loser_ids, outcome FROM day_results WHERE group_id = ? AND substr(date, 1, 7) = ?",
    group.id,
    month,
  );
  const penalties = await db.all<{ user_id: string; date: string; cents: number }>(
    "SELECT user_id, date, cents FROM penalties WHERE group_id = ? AND substr(date, 1, 7) = ?",
    group.id,
    month,
  );
  const skips = await db.all<{ user_id: string; date: string; status: string }>(
    "SELECT user_id, date, status FROM skip_claims WHERE group_id = ? AND substr(date, 1, 7) = ?",
    group.id,
    month,
  );
  const steps = await db.all<{ user_id: string; date: string; steps: number }>(
    `SELECT user_id, date, steps FROM step_entries WHERE substr(date, 1, 7) = ? AND user_id IN (SELECT user_id FROM memberships WHERE group_id = ?)`,
    month,
    group.id,
  );
  const settlement = await db.first<{ note: string | null; settled_at: number }>("SELECT note, settled_at FROM settlements WHERE group_id = ? AND month = ?", group.id, month);
  const resultBy = new Map(results.map((r) => [r.date, r]));
  const totals = members
    .map((m) => ({
      userId: m.id,
      name: m.name,
      cents: penalties.filter((p) => p.user_id === m.id).reduce((s, p) => s + p.cents, 0),
      losses: penalties.filter((p) => p.user_id === m.id).length,
      skipsUsed: skips.filter((s) => s.user_id === m.id).length,
      active: m.left_date === null,
    }))
    .filter((t) => t.active || t.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  return {
    month,
    days: days.map((date) => {
      const r = resultBy.get(date);
      return {
        date,
        outcome: (r?.outcome ?? null) as "no_loser" | "penalty" | "skipped" | null,
        minSteps: r?.min_steps ?? null,
        loserIds: r ? (JSON.parse(r.loser_ids) as string[]) : [],
        payers: penalties.filter((p) => p.date === date).map((p) => p.user_id),
        skippers: skips.filter((s) => s.date === date && s.status === "consumed").map((s) => s.user_id),
      };
    }),
    totals,
    potCents: penalties.reduce((s, p) => s + p.cents, 0),
    steps,
    settlement,
    names: Object.fromEntries(members.map((m) => [m.id, m.name])),
  };
}

export async function history(db: Db, groupId: string) {
  return db.all<{ month: string; cents: number; losses: number; note: string | null; settled_at: number | null }>(
    `SELECT p.month, p.cents, p.losses, s.note, s.settled_at FROM
       (SELECT substr(date, 1, 7) AS month, SUM(cents) AS cents, COUNT(*) AS losses FROM penalties WHERE group_id = ? GROUP BY month) p
     LEFT JOIN settlements s ON s.group_id = ? AND s.month = p.month ORDER BY p.month DESC`,
    groupId,
    groupId,
  );
}

export async function settleMonth(db: Db, actor: User, groupId: string, month: string, note: string, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, "Bad month");
  await db.batch([
    stmt(
      `INSERT INTO settlements (group_id, month, note, settled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, month) DO UPDATE SET note = excluded.note, settled_at = excluded.settled_at`,
      groupId,
      month,
      note.slice(0, 200) || null,
      now,
    ),
    audit(groupId, actor.id, "month.settle", { month, note }, now),
  ]);
}

export async function unsettleMonth(db: Db, actor: User, groupId: string, month: string, now = Date.now()) {
  await requireAdmin(db, actor.id, groupId);
  await db.batch([stmt("DELETE FROM settlements WHERE group_id = ? AND month = ?", groupId, month), audit(groupId, actor.id, "month.unsettle", { month }, now)]);
}

export async function renameSelf(db: Db, user: User, name: string) {
  const n = name.trim().slice(0, 40);
  if (!n) throw new AppError(400, "Name required");
  await db.run("UPDATE users SET name = ? WHERE id = ?", n, user.id);
}
