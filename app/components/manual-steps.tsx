import { useFetcher } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { action } from "../routes/me";
import { ErrorNote, fmtSteps } from "./ui";
import { PendingButton } from "./pending";
import { formatDay } from "../lib/dates";

export function LogSteps({ today, yesterday, myToday, myYesterday }: { today: string; yesterday: string | null; myToday: number | null; myYesterday: number | null | undefined }) {
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
                className={`rounded-md px-2.5 py-1 font-medium capitalize transition ${day === k ? "bg-fg/10 text-strong" : "text-muted"}`}
              >
                {k}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Set a manual step count for {formatDay(date)}. This changes your tally for that day.
        {current != null && <> Currently <b className="text-strong">{fmtSteps(current)}</b>.</>}
      </p>
      <p className="mt-2 text-xs text-muted">Each save is kept in the change log. Stompers pulls keep updating your API counts and leave your manual score in place.</p>
      <f.Form ref={formRef} method="post" className="mt-4 flex gap-2">
        <input type="hidden" name="intent" value="manual" />
        <input type="hidden" name="date" value={date} />
        <input
          key={date}
          name="steps"
          aria-label="Manual steps"
          type="number"
          inputMode="numeric"
          min={0}
          max={150000}
          required
          placeholder={current != null ? String(current) : "e.g. 11240"}
          className="input font-display text-lg tabular-nums"
        />
        <PendingButton className="btn-primary shrink-0 !px-5" busy={f.state !== "idle"}>
          {current != null ? "Update" : "Save"}
        </PendingButton>
      </f.Form>
      {saved && <p className="mt-2 text-xs text-lime">✓ Saved</p>}
      <ErrorNote error={f.data && "error" in f.data ? f.data.error : null} />
      {yesterday && <p className="mt-2 text-xs text-muted">The game ends at 9:00 PM; days lock at 9:15 PM. Update anytime before then.</p>}
    </section>
  );
}
