import { Link, useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/history";
import { money } from "../components/ui";
import { db, formAction, requireMember } from "../lib/http.server";
import { history, settleMonth, unsettleMonth } from "../lib/service";
import { formatMonth, localDate, monthOf } from "../lib/dates";

export async function loader({ request }: Route.LoaderArgs) {
  const { group, role } = await requireMember(request);
  return { rows: await history(db(), group.id), isAdmin: role === "admin", current: monthOf(localDate(new Date(), group.timezone)) };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, group } = await requireMember(request);
  const f = await request.formData();
  return formAction(async () => {
    const month = String(f.get("month"));
    if (f.get("intent") === "unsettle") await unsettleMonth(db(), user, group.id, month);
    else await settleMonth(db(), user, group.id, month, String(f.get("note") ?? ""));
    return { ok: true };
  });
}

export default function History() {
  const { rows, isAdmin, current } = useLoaderData<typeof loader>();
  const lifetime = rows.reduce((s, r) => s + r.cents, 0);
  return (
    <div className="space-y-4">
      <section className="card p-5 rise">
        <div className="text-xs font-medium uppercase tracking-wider text-muted">All-time pot</div>
        <div className="font-display text-4xl font-bold text-lime">{money(lifetime)}</div>
        <div className="text-xs text-muted">{rows.reduce((s, r) => s + r.losses, 0)} losing days total</div>
      </section>
      {rows.length === 0 && <div className="card p-8 text-center text-muted">No losses yet. Keep it that way. 👟</div>}
      {rows.map((r) => (
        <Row key={r.month} r={r} isAdmin={isAdmin} current={current} />
      ))}
    </div>
  );
}

function Row({ r, isAdmin, current }: { r: Awaited<ReturnType<typeof loader>>["rows"][number]; isAdmin: boolean; current: string }) {
  const f = useFetcher();
  return (
    <section className="card p-5 rise">
      <div className="flex items-center justify-between">
        <Link to={`/month/${r.month}`} className="group">
          <div className="font-display text-lg font-bold group-hover:text-lime">{formatMonth(r.month)}</div>
          <div className="text-xs text-muted">{r.losses} losing day{r.losses === 1 ? "" : "s"}{r.month === current ? " · in progress" : ""}</div>
        </Link>
        <div className="text-right">
          <div className="font-display text-2xl font-bold">{money(r.cents)}</div>
          {r.settled_at ? <div className="text-xs text-lime">✓ settled{r.note ? ` · ${r.note}` : ""}</div> : <div className="text-xs text-amber">unpaid</div>}
        </div>
      </div>
      {isAdmin && (
        <f.Form method="post" className="mt-4 flex gap-2">
          <input type="hidden" name="month" value={r.month} />
          {r.settled_at ? (
            <button name="intent" value="unsettle" className="btn-ghost text-xs">Mark unpaid</button>
          ) : (
            <>
              <input name="note" placeholder="e.g. Ruth's Chris, Nov 2" className="input !py-2 text-sm" maxLength={200} />
              <button name="intent" value="settle" className="btn-primary shrink-0 text-xs">Mark settled</button>
            </>
          )}
        </f.Form>
      )}
    </section>
  );
}
