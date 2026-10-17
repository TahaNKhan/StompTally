import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/month";
import { Avatar, fmtSteps, money } from "../components/ui";
import { db, requireMember } from "../lib/http.server";
import { monthView } from "../lib/service";
import { addMonths, formatMonth, localDate, monthOf } from "../lib/dates";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { group } = await requireMember(request);
  const today = localDate(new Date(), group.timezone);
  const month = params.ym && /^\d{4}-\d{2}$/.test(params.ym) ? params.ym : monthOf(today);
  const mv = await monthView(db(), group, month);
  return { ...mv, today, current: monthOf(today), startMonth: monthOf(group.start_date) };
}

export default function Month() {
  const d = useLoaderData<typeof loader>();
  const first = new Date(`${d.month}-01T12:00:00Z`).getUTCDay();
  const prev = addMonths(d.month, -1);
  const next = addMonths(d.month, 1);
  const stepsBy = new Map(d.steps.map((s) => [`${s.user_id}|${s.date}`, s.steps]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {prev >= d.startMonth ? <Link to={`/month/${prev}`} className="btn-ghost !px-3">←</Link> : <span className="w-11" />}
        <h2 className="font-display text-xl font-bold">{formatMonth(d.month)}</h2>
        {next <= d.current ? <Link to={`/month/${next}`} className="btn-ghost !px-3">→</Link> : <span className="w-11" />}
      </div>

      <section className="card p-5 rise">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Meal pot</div>
            <div className="font-display text-4xl font-bold text-lime">{money(d.potCents)}</div>
          </div>
          {d.settlement ? (
            <span className="rounded-full border border-lime/30 bg-lime/10 px-3 py-1 text-xs font-medium text-lime">✓ Settled{d.settlement.note ? ` · ${d.settlement.note}` : ""}</span>
          ) : (
            d.month < d.current && <span className="rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-xs text-amber">Unpaid</span>
          )}
        </div>
        <ul className="mt-5 space-y-3">
          {d.totals.map((t) => {
            const pct = d.potCents ? (t.cents / d.potCents) * 100 : 0;
            return (
              <li key={t.userId} className="flex items-center gap-3">
                <Avatar id={t.userId} name={t.name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{t.name}</span>
                    <span className={`font-display font-bold tabular-nums ${t.cents ? "text-coral" : "text-muted"}`}>{money(t.cents)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="bar-grow h-full rounded-full bg-coral" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-muted">{t.losses} loss{t.losses === 1 ? "" : "es"} · {t.skipsUsed} skip{t.skipsUsed === 1 ? "" : "s"} used</div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card p-4 rise">
        <div className="mb-2 grid grid-cols-7 text-center text-[11px] font-medium uppercase text-muted">
          {["S", "M", "T", "W", "T", "F", "S"].map((x, i) => <div key={i}>{x}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: first }).map((_, i) => <div key={`b${i}`} />)}
          {d.days.map((day) => {
            const n = Number(day.date.slice(8));
            const future = day.date > d.today;
            const isToday = day.date === d.today;
            const who = day.payers[0] ?? day.skippers[0];
            const base = "relative aspect-square rounded-xl border p-1 text-[11px] flex flex-col items-center justify-between";
            const tone =
              day.outcome === "penalty" ? "border-coral/30 bg-coral/10" :
              day.outcome === "skipped" ? "border-sky/30 bg-sky/10" :
              day.outcome === "no_loser" ? "border-lime/25 bg-lime/[0.07]" :
              future ? "border-transparent bg-white/[0.015] opacity-40" : "border-line bg-white/[0.03]";
            const tip = day.outcome
              ? day.outcome === "no_loser"
                ? "Everyone hit 10k"
                : `${[...day.payers, ...day.skippers].map((u) => d.names[u]).join(", ")} · ${fmtSteps(day.minSteps)}${day.skippers.length ? " (skip used)" : ""}`
              : "";
            return (
              <div key={day.date} className={`${base} ${tone} ${isToday ? "ring-2 ring-lime/60" : ""}`} title={tip}>
                <span className="self-start pl-0.5 text-muted">{n}</span>
                {day.outcome === "penalty" && who && (
                  <span className="flex -space-x-2">
                    {day.payers.slice(0, 2).map((u) => <Avatar key={u} id={u} name={d.names[u] ?? "?"} size={20} />)}
                  </span>
                )}
                {day.outcome === "skipped" && <span className="text-base leading-none">🛡️</span>}
                {day.outcome === "no_loser" && <span className="text-base leading-none">✅</span>}
                {!day.outcome && <span />}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>✅ everyone hit 10k</span>
          <span><span className="inline-block h-2 w-2 rounded-full bg-coral" /> someone paid $5</span>
          <span>🛡️ saved by a skip</span>
        </div>
      </section>

      <section className="card overflow-x-auto p-4 rise">
        <h3 className="mb-3 text-sm font-semibold">Daily steps</h3>
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-muted">
              <th className="py-1 pr-2 text-left font-medium">Day</th>
              {d.totals.map((t) => <th key={t.userId} className="px-1 py-1 text-right font-medium">{t.name.split(" ")[0]}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.days.filter((x) => x.date <= d.today).reverse().map((day) => (
              <tr key={day.date} className="border-t border-line/50">
                <td className="py-1.5 pr-2 text-muted">{Number(day.date.slice(8))}</td>
                {d.totals.map((t) => {
                  const s = stepsBy.get(`${t.userId}|${day.date}`);
                  const paid = day.payers.includes(t.userId);
                  const skipped = day.skippers.includes(t.userId);
                  return (
                    <td key={t.userId} className={`px-1 py-1.5 text-right ${paid ? "font-bold text-coral" : skipped ? "text-sky" : s != null && s >= 10000 ? "text-zinc-200" : "text-muted"}`}>
                      {s == null ? "–" : s >= 1000 ? `${(s / 1000).toFixed(1)}k` : s}
                      {skipped && "🛡️"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
