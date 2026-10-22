import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { Countdown } from "../components/countdown";
import type { Route } from "./+types/today";
import { Avatar, ErrorNote, fmtSteps, money, Notice, timeAgo } from "../components/ui";
import { PendingButton } from "../components/pending";
import { db, formAction, memberOr, requireMember, sid } from "../lib/http.server";
import { AppError, cancelSkip, claimSkip } from "../lib/service";
import { formatDay, LOCK_TIME_LABEL } from "../lib/dates";
import { loadToday } from "../lib/pages";
import { describeSync } from "../lib/views";

export async function loader({ request }: Route.LoaderArgs) {
  const result = await loadToday(db(), sid(request));
  memberOr(request, result.auth);
  return result.page!;
}

export async function action({ request }: Route.ActionArgs) {
  const { user } = await requireMember(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  const date = String(f.get("date"));
  return formAction(async () => {
    if (intent === "skip") await claimSkip(db(), user, date);
    else if (intent === "unskip") await cancelSkip(db(), user, date);
    else throw new AppError(400, "Unknown action. Log manual steps on Me.");
    return { ok: true };
  });
}

type Day = Awaited<ReturnType<typeof loader>>["today"];
type Sync = Awaited<ReturnType<typeof loader>>["sync"];
type Avatars = Awaited<ReturnType<typeof loader>>["avatars"];

/**
 * The Today badge before the day locks. The Stompers game window shuts at 9:00 PM and the day locks
 * at 9:15, so the badge counts to the game end while play is on, then to the lock, then waits for
 * the result. "Waiting" is the honest word for that last stage: the lock run skips a day whose
 * counts are still stale (see finalizeDay), so it can sit there for more than one cron cycle.
 * The stage is seeded from the server's clock so the first paint matches hydration, and each
 * countdown advances the stage when its own instant passes.
 */
function LiveBadge({ gameEndsAt, locksAt, serverNow, onLocked }: { gameEndsAt: number; locksAt: number; serverNow: number; onLocked: () => void }) {
  type Stage = "playing" | "awaiting-lock" | "waiting";
  const [stage, setStage] = useState<Stage>(() =>
    serverNow >= locksAt ? "waiting" : serverNow >= gameEndsAt ? "awaiting-lock" : "playing",
  );
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-lime/30 bg-lime/10 px-3 py-1 text-xs font-medium text-lime">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" />
      {stage === "playing" && <>Live · ends in <Countdown target={gameEndsAt} serverNow={serverNow} onDone={() => setStage("awaiting-lock")} /></>}
      {stage === "awaiting-lock" && <>Final in <Countdown target={locksAt} serverNow={serverNow} onDone={() => { setStage("waiting"); onLocked(); }} /></>}
      {stage === "waiting" && <span>Waiting for final counts…</span>}
    </span>
  );
}

function Board({ day, sync, avatars, me, threshold, penalty, skips, skipsUsed, now, label, live, gameEndsAt, locksAt, onLocked }: { day: Day; sync: Sync; avatars: Avatars; me: string; threshold: number; penalty: number; skips: number; skipsUsed: Record<string, number>; now: number; label: string; live: boolean; gameEndsAt?: number; locksAt?: number; onLocked?: () => void }) {
  const fetcher = useFetcher<typeof action>();
  const max = Math.max(threshold * 1.5, ...day.rows.map((r) => r.steps ?? 0));
  const losers = new Set(day.preview.loserIds);
  const payers = new Set(day.preview.penalties.map((p) => p.userId));
  const mine = day.rows.find((r) => r.userId === me);
  const myUsed = skipsUsed[me] ?? 0;
  const err = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <section className="card overflow-hidden rise">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
          <div className="font-display text-lg font-bold">{formatDay(day.date)}</div>
        </div>
        {day.finalized ? (
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">{live ? "Final · skips till midnight" : "Final"}</span>
        ) : live && gameEndsAt && locksAt ? (
          <LiveBadge gameEndsAt={gameEndsAt} locksAt={locksAt} serverNow={now} onLocked={onLocked!} />
        ) : (
          <span className="rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-xs font-medium text-amber">Locks at {LOCK_TIME_LABEL}</span>
        )}
      </div>

      <ul className="divide-y divide-line/60">
        {day.rows.map((r, i) => {
          const pct = Math.min(100, ((r.steps ?? 0) / max) * 100);
          const hit = (r.steps ?? 0) >= threshold;
          const danger = losers.has(r.userId);
          const color = hit ? "var(--color-lime)" : danger ? "var(--color-coral)" : "var(--color-amber)";
          return (
            <li key={r.userId} className="relative px-5 py-3.5">
              <div className="flex items-center gap-3">
                <span className="w-4 text-center font-display text-sm text-muted">{i + 1}</span>
                <Avatar id={r.userId} name={r.name} size={34} ring={danger ? "var(--color-coral)" : undefined} version={avatars[r.userId]} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{r.name}{r.userId === me && <span className="text-muted"> (you)</span>}</span>
                    {r.skipClaimed && <span className="rounded-md bg-sky/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky">🛡️ skip</span>}
                    {danger && !r.skipClaimed && payers.has(r.userId) && (
                      <span className="rounded-md bg-coral/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-coral">{day.finalized ? "" : "on track to owe "}{money(penalty)}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {r.steps == null ? "not logged yet · counts as 0" : `${r.source === "manual" ? "manual entry" : "logged"} ${timeAgo(r.updatedAt, now)}`} · {skips - (skipsUsed[r.userId] ?? 0)}/{skips} skips left
                  </div>
                  {(() => {
                    const state = describeSync(sync[r.userId], (ts) => timeAgo(ts, now));
                    return state && <div className={`mt-1 text-xs ${state.tone === "warn" ? "text-amber" : "text-muted"}`}>{state.tone === "warn" && "⚠️ "}{state.label}</div>;
                  })()}
                  {r.rawSteps != null && r.gameSteps != null && <div className="mt-1 text-xs text-muted">
                    Walking {fmtSteps(r.rawSteps)} · Game {fmtSteps(r.gameSteps)}{r.source === "stompers" ? " · Higher count used" : r.source === "admin" ? " · Admin override" : " · Manual entry"}
                  </div>}
                </div>
                <div className="text-right font-display text-lg font-bold tabular-nums" style={{ color }}>
                  {fmtSteps(r.steps)}
                </div>
              </div>
              <div className="relative ml-[3.25rem] mt-2 h-1.5 overflow-hidden rounded-full bg-fg/[0.06]">
                <div className="bar-grow h-full rounded-full" style={{ width: `${pct}%`, background: color, animationDelay: `${i * 60}ms` }} />
                <div className="absolute top-0 h-full w-px bg-fg/40" style={{ left: `${(threshold / max) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      {live && mine && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken px-5 py-3">
          {mine.skipClaimed ? (
            <fetcher.Form method="post" className="flex flex-1 items-center justify-between gap-2">
              <input type="hidden" name="date" value={day.date} />
              <span className="text-sm text-sky">🛡️ Skip claimed. You're safe if you end up last.</span>
              <PendingButton name="intent" value="unskip" className="btn-ghost !py-1.5 text-xs" busy={fetcher.state !== "idle"} pendingLabel="Undoing…">Undo</PendingButton>
            </fetcher.Form>
          ) : (
            <fetcher.Form method="post" className="flex flex-1 items-center justify-between gap-2">
              <input type="hidden" name="date" value={day.date} />
              <span className="text-sm text-muted">
                {losers.has(me) ? "You're last right now." : "Rough day?"} {skips - myUsed} skip{skips - myUsed === 1 ? "" : "s"} left this month.
              </span>
              <PendingButton
                name="intent"
                value="skip"
                busy={fetcher.state !== "idle"}
                pendingLabel="Claiming…"
                disabled={myUsed >= skips}
                className="btn-ghost shrink-0 whitespace-nowrap !py-1.5 text-xs"
                onClick={(e) => {
                  if (!confirm(`Use a skip for ${formatDay(day.date)}? It only counts if you'd have paid.`)) e.preventDefault();
                }}
              >
                🛡️ Use skip
              </PendingButton>
            </fetcher.Form>
          )}
          <ErrorNote error={err} />
        </div>
      )}
    </section>
  );
}

export default function Today() {
  const d = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const rv = useRevalidator();
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && rv.revalidate(), 60_000);
    return () => clearInterval(t);
  }, [rv]);
  const meTotal = d.totals.find((t) => t.userId === d.me);
  // The 9:15 lock runs on cron; give it a moment to finish, then load the locked board.
  const reloadAfterLock = useCallback(() => { setTimeout(() => rv.revalidate(), 90_000); }, [rv]);

  return (
    <div className="space-y-4">
      {params.get("joined") && <Notice>You're in! Link Stompers or log manual steps on Me.</Notice>}

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-4 rise">
          <div className="text-xs font-medium uppercase tracking-wider text-muted">Meal pot</div>
          <div className="mt-1 font-display text-3xl font-bold text-lime">{money(d.pot)}</div>
          <div className="text-xs text-muted">this month</div>
        </div>
        <div className="card p-4 rise" style={{ animationDelay: "60ms" }}>
          <div className="text-xs font-medium uppercase tracking-wider text-muted">You owe</div>
          <div className={`mt-1 font-display text-3xl font-bold ${meTotal?.cents ? "text-coral" : "text-strong"}`}>{money(meTotal?.cents ?? 0)}</div>
          <div className="text-xs text-muted">{meTotal?.losses ?? 0} losing day{meTotal?.losses === 1 ? "" : "s"}</div>
        </div>
      </div>

      {!d.yesterday.finalized && d.yesterday.rows.length > 0 && (
        <Board day={d.yesterday} sync={d.sync} avatars={d.avatars} me={d.me} threshold={d.group.threshold} penalty={d.group.penalty} skips={d.group.skips} skipsUsed={d.skipsUsedYesterday} now={d.now} label="Yesterday" live={false} />
      )}
      <Board day={d.today} sync={d.sync} avatars={d.avatars} me={d.me} threshold={d.group.threshold} penalty={d.group.penalty} skips={d.group.skips} skipsUsed={d.skipsUsedToday} now={d.now} label="Today" live gameEndsAt={d.gameEndsAt} locksAt={d.locksAt} onLocked={reloadAfterLock} />
    </div>
  );
}
