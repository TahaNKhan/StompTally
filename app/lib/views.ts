// Pure view builders: turn already-fetched rows into page data. No I/O.
import { computeDay } from "./rules";
import { daysInMonth } from "./dates";
import type { Group } from "./service";

export type MemberRow = { id: string; name: string; email: string; role: string; joined_date: string; left_date: string | null };
export type EntryRow = { user_id: string; date: string; steps: number; updated_at: number };
export type ClaimRow = { user_id: string; date: string; status: string };
export type ResultRow = { date: string; min_steps: number | null; loser_ids: string; outcome: string };
export type PenaltyRow = { user_id: string; date: string; cents: number };
export type SettlementRow = { month: string; note: string | null; settled_at: number };

export const inMonth = (date: string, month: string) => date.startsWith(month + "-");

export function activeOn(m: { joined_date: string; left_date: string | null }, date: string) {
  return m.joined_date <= date && (m.left_date === null || m.left_date > date);
}

/** Live (or final) board for one day. `members` should already exclude people who left. */
export function buildDay(date: string, members: MemberRow[], entries: EntryRow[], claims: ClaimRow[], results: ResultRow[], group: Group) {
  const byUser = new Map(entries.filter((e) => e.date === date).map((e) => [e.user_id, e]));
  const claimSet = new Set(claims.filter((c) => c.date === date).map((c) => c.user_id));
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
  return { date, rows, preview, finalized: results.some((r) => r.date === date) };
}

/** Month summary. Rows outside `month` are ignored, so callers can pass a wider window. */
export function buildMonth(
  month: string,
  members: MemberRow[],
  allResults: ResultRow[],
  allPenalties: PenaltyRow[],
  allClaims: ClaimRow[],
  allEntries: EntryRow[],
  settlement: { note: string | null; settled_at: number } | null,
) {
  const results = allResults.filter((r) => inMonth(r.date, month));
  const penalties = allPenalties.filter((p) => inMonth(p.date, month));
  const skips = allClaims.filter((c) => inMonth(c.date, month));
  const steps = allEntries.filter((e) => inMonth(e.date, month)).map((e) => ({ user_id: e.user_id, date: e.date, steps: e.steps }));
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
    days: daysInMonth(month).map((date) => {
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
