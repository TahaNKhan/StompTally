import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/today";
import { Avatar, ErrorNote, fmtSteps, money, Notice, timeAgo } from "../components/ui";
import { db, formAction, requireMember } from "../lib/http.server";
import { cancelSkip, claimSkip, monthView, recordSteps, todayBoard } from "../lib/service";
import { formatDay, monthOf } from "../lib/dates";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, group } = await requireMember(request);
  const board = await todayBoard(db(), group);
  const mv = await monthView(db(), group, board.month);
  return {
    me: user.id,
    group: { threshold: group.threshold_steps, penalty: group.penalty_cents, skips: group.skips_per_month },
    today: board.today,
    yesterday: board.yesterday,
    skipsUsedToday: Object.fromEntries(board.today.rows.map((r) => [r.userId, board.skipsUsed(r.userId, board.month)])),
    skipsUsedYesterday: Object.fromEntries(board.yesterday.rows.map((r) => [r.userId, board.skipsUsed(r.userId, monthOf(board.yesterday.date))])),
    totals: mv.totals,
    pot: mv.potCents,
    now: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user } = await requireMember(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  const date = String(f.get("date"));
  return formAction(async () => {
    if (intent === "skip") await claimSkip(db(), user, date);
    else if (intent === "unskip") await cancelSkip(db(), user, date);
    else if (intent === "manual")
      await recordSteps(db(), { actor: user, userId: user.id, date, steps: Math.round(Number(f.get("steps"))), source: "manual" });
    return { ok: true };
  });
}

type Day = Awaited<ReturnType<typeof loader>>["today"];

function Board({ day, me, threshold, penalty, skips, skipsUsed, now, label, live }: { day: Day; me: string; threshold: number; penalty: number; skips: number; skipsUsed: Record<string, number>; now: number; label: string; live: boolean }) {
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
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">Final</span>
        ) : live ? (
          <span className="flex items-center gap-1.5 rounded-full border border-lime/30 bg-lime/10 px-3 py-1 text-xs font-medium text-lime">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" /> Live · projected
          </span>
        ) : (
          <span className="rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-xs font-medium text-amber">Final at noon</span>
        )}
      </div>

      <ul className="divide-y divide-line/60">
        {day.rows.map((r, i) => {
          const pct = Math.min(100, ((r.steps ?? 0) / max) * 100);
          const hit = (r.steps ?? 0) >= threshold;
          const danger = losers.has(r.userId);
          const color = hit ? "#b6f35c" : danger ? "#ff6b6b" : "#ffc857";
          return (
            <li key={r.userId} className="relative px-5 py-3.5">
              <div className="flex items-center gap-3">
                <span className="w-4 text-center font-display text-sm text-muted">{i + 1}</span>
                <Avatar id={r.userId} name={r.name} size={34} ring={danger ? "#ff6b6b" : undefined} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{r.name}{r.userId === me && <span className="text-muted"> (you)</span>}</span>
                    {r.skipClaimed && <span className="rounded-md bg-sky/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky">🛡️ skip</span>}
                    {danger && !r.skipClaimed && payers.has(r.userId) && (
                      <span className="rounded-md bg-coral/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-coral">{day.finalized ? "" : "on track to owe "}{money(penalty)}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted">
                    {r.steps == null ? "not logged yet · counts as 0" : `logged ${timeAgo(r.updatedAt, now)}`} · {skips - (skipsUsed[r.userId] ?? 0)}/{skips} skips left
                  </div>
                </div>
                <div className="text-right font-display text-lg font-bold tabular-nums" style={{ color }}>
                  {fmtSteps(r.steps)}
                </div>
              </div>
              <div className="relative ml-[3.25rem] mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="bar-grow h-full rounded-full" style={{ width: `${pct}%`, background: color, animationDelay: `${i * 60}ms` }} />
                <div className="absolute top-0 h-full w-px bg-white/40" style={{ left: `${(threshold / max) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      {!day.finalized && mine && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-black/20 px-5 py-3">
          {mine.skipClaimed ? (
            <fetcher.Form method="post" className="flex flex-1 items-center justify-between gap-2">
              <input type="hidden" name="date" value={day.date} />
              <span className="text-sm text-sky">🛡️ Skip claimed. You're safe if you end up last.</span>
              <button name="intent" value="unskip" className="btn-ghost !py-1.5 text-xs">Undo</button>
            </fetcher.Form>
          ) : (
            <fetcher.Form method="post" className="flex flex-1 items-center justify-between gap-2">
              <input type="hidden" name="date" value={day.date} />
              <span className="text-sm text-muted">
                {losers.has(me) ? "You're last right now." : "Rough day?"} {skips - myUsed} skip{skips - myUsed === 1 ? "" : "s"} left this month.
              </span>
              <button
                name="intent"
                value="skip"
                disabled={myUsed >= skips || fetcher.state !== "idle"}
                className="btn-ghost shrink-0 whitespace-nowrap !py-1.5 text-xs"
                onClick={(e) => {
                  if (!confirm(`Use a skip for ${formatDay(day.date)}? It only counts if you'd have paid.`)) e.preventDefault();
                }}
              >
                🛡️ Use skip
              </button>
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
  const myToday = d.today.rows.find((r) => r.userId === d.me)?.steps ?? null;
  const myYesterday = d.yesterday.finalized ? undefined : (d.yesterday.rows.find((r) => r.userId === d.me)?.steps ?? null);

  return (
    <div className="space-y-4">
      {params.get("joined") && <Notice>You're in! Log your Stompers steps below each day.</Notice>}

      <LogSteps today={d.today.date} yesterday={d.yesterday.finalized ? null : d.yesterday.date} myToday={myToday} myYesterday={myYesterday} />

      <div className="grid grid-cols-2 gap-3">
        <div className="card p-4 rise">
          <div className="text-xs font-medium uppercase tracking-wider text-muted">Meal pot</div>
          <div className="mt-1 font-display text-3xl font-bold text-lime">{money(d.pot)}</div>
          <div className="text-xs text-muted">this month</div>
        </div>
        <div className="card p-4 rise" style={{ animationDelay: "60ms" }}>
          <div className="text-xs font-medium uppercase tracking-wider text-muted">You owe</div>
          <div className={`mt-1 font-display text-3xl font-bold ${meTotal?.cents ? "text-coral" : "text-zinc-100"}`}>{money(meTotal?.cents ?? 0)}</div>
          <div className="text-xs text-muted">{meTotal?.losses ?? 0} losing day{meTotal?.losses === 1 ? "" : "s"}</div>
        </div>
      </div>

      {!d.yesterday.finalized && d.yesterday.rows.length > 0 && (
        <Board day={d.yesterday} me={d.me} threshold={d.group.threshold} penalty={d.group.penalty} skips={d.group.skips} skipsUsed={d.skipsUsedYesterday} now={d.now} label="Yesterday" live={false} />
      )}
      <Board day={d.today} me={d.me} threshold={d.group.threshold} penalty={d.group.penalty} skips={d.group.skips} skipsUsed={d.skipsUsedToday} now={d.now} label="Today" live />
    </div>
  );
}

function LogSteps({ today, yesterday, myToday, myYesterday }: { today: string; yesterday: string | null; myToday: number | null; myYesterday: number | null | undefined }) {
  const f = useFetcher<typeof action>();
  const [day, setDay] = useState<"today" | "yesterday">("today");
  const date = day === "today" || !yesterday ? today : yesterday;
  const current = day === "today" ? myToday : myYesterday ?? null;
  const formRef = useRef<HTMLFormElement>(null);
  const saved = f.state === "idle" && f.data && "ok" in f.data;
  useEffect(() => {
    if (saved) formRef.current?.reset();
  }, [saved]);

  return (
    <section className="card p-5 rise">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Log your steps</h2>
        {yesterday && (
          <div className="flex rounded-lg border border-line p-0.5 text-xs">
            {(["today", "yesterday"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setDay(k)}
                className={`rounded-md px-2.5 py-1 font-medium capitalize transition ${day === k ? "bg-white/10 text-white" : "text-muted"}`}
              >
                {k}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Enter your <b className="text-zinc-200">Stompers</b> number (after power-ups) for {formatDay(date)}.
        {current != null && <> Currently <b className="text-zinc-200">{fmtSteps(current)}</b>.</>}
      </p>
      <f.Form ref={formRef} method="post" className="mt-4 flex gap-2">
        <input type="hidden" name="intent" value="manual" />
        <input type="hidden" name="date" value={date} />
        <input
          key={date}
          name="steps"
          type="number"
          inputMode="numeric"
          min={0}
          max={150000}
          required
          placeholder={current != null ? String(current) : "e.g. 11240"}
          className="input font-display text-lg tabular-nums"
        />
        <button className="btn-primary shrink-0 !px-5" disabled={f.state !== "idle"}>
          {f.state !== "idle" ? "Saving…" : current != null ? "Update" : "Save"}
        </button>
      </f.Form>
      {saved && <p className="mt-2 text-xs text-lime">✓ Saved</p>}
      <ErrorNote error={f.data && "error" in f.data ? f.data.error : null} />
      {yesterday && <p className="mt-2 text-xs text-muted">Yesterday locks at noon. Update anytime before then.</p>}
    </section>
  );
}
