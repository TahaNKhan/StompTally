import type { ManualStepLog } from "../lib/pages";
import { formatDay } from "../lib/dates";
import { fmtSteps } from "./ui";

export function ManualHistory({ entries, timezone, showNames = false }: { entries: ManualStepLog[]; timezone: string; showNames?: boolean }) {
  return (
    <section className="card p-5 rise">
      <h2 className="font-display text-lg font-bold">Manual step changes</h2>
      <p className="mt-1 text-xs text-muted">Each saved entry is kept. Previous scores and API counts show what changed.</p>
      {!entries.length ? <p className="mt-3 text-sm text-muted">No manual changes yet.</p> : <ol className="mt-3 divide-y divide-line/60">
        {entries.map(entry => <li key={entry.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-semibold">{showNames ? `${entry.name} · ` : ""}{formatDay(entry.date)}</span>
            <span className="font-display font-bold tabular-nums">{fmtSteps(entry.previous_steps)} → {fmtSteps(entry.steps)}</span>
          </div>
          <div className="mt-1 text-xs text-muted">{entry.actor_name} · {new Date(entry.created_at).toLocaleString("en-US", { timeZone: timezone })} (group time)</div>
          <div className="mt-1 text-xs text-muted">Previous: {entry.previous_source ?? "no entry"}{entry.raw_steps != null && entry.game_steps != null ? ` · Walking ${fmtSteps(entry.raw_steps)} · Game ${fmtSteps(entry.game_steps)}` : ""}</div>
        </li>)}
      </ol>}
    </section>
  );
}
