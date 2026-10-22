import { redirect, useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/group";
import { Avatar, ErrorNote, Notice } from "../components/ui";
import { PendingButton } from "../components/pending";
import { ManualHistory } from "../components/manual-history";
import { db, formAction, memberOr, origin, rateLimit, requireMember, sid } from "../lib/http.server";
import { createInvite, recordSteps, removeMember, revokeInvite, updateGroup } from "../lib/service";
import { inviteEmail, sendMail } from "../lib/mail.server";
import { env } from "cloudflare:workers";
import { addDays } from "../lib/dates";
import { syncStompers } from "../lib/stompers.server";
import { loadGroupAdmin } from "../lib/pages";

export async function loader({ request }: Route.LoaderArgs) {
  const result = await loadGroupAdmin(db(), sid(request));
  const ctx = memberOr(request, result.auth);
  if (ctx.role !== "admin") throw redirect("/");
  return result.page!;
}

export async function action({ request }: Route.ActionArgs) {
  const { user, group } = await requireMember(request);
  const f = await request.formData();
  const intent = String(f.get("intent"));
  return formAction(async () => {
    if (intent === "correct") {
      const r = await recordSteps(db(), {
        actor: user,
        userId: String(f.get("userId")),
        date: String(f.get("date")),
        steps: Number(f.get("steps")),
        source: "admin",
      });
      return { ok: intent, corrected: r };
    }
    if (intent === "poll") {
      await rateLimit(request, "stompers-poll");
      return { polled: await syncStompers(db(), Date.now(), undefined, { groupId: group.id }) };
    }
    if (intent === "invite") {
      await rateLimit(request, "invite-send");
      const inv = await createInvite(db(), user, group.id, String(f.get("email") ?? ""));
      const link = `${origin(request)}/invite/${inv.token}`;
      const mail = inviteEmail(link, user.name, group.name);
      await sendMail(env, inv.email, mail.subject, mail.html, mail.text);
      return { invited: inv.email, link };
    }
    if (intent === "revoke") await revokeInvite(db(), user, group.id, String(f.get("id")));
    if (intent === "remove") await removeMember(db(), user, group.id, String(f.get("userId")));
    if (intent === "settings")
      await updateGroup(db(), user, group.id, {
        name: String(f.get("name")),
        timezone: String(f.get("timezone")),
        threshold_steps: Number(f.get("threshold_steps")),
        penalty_cents: Math.round(Number(f.get("penalty")) * 100),
        skips_per_month: Number(f.get("skips_per_month")),
      });
    return { ok: intent };
  });
}

export default function GroupPage() {
  const { group, members, invites, today, manualHistory, avatars } = useLoaderData<typeof loader>();
  const inv = useFetcher<typeof action>();
  const settings = useFetcher<typeof action>();
  const correct = useFetcher<typeof action>();
  const poll = useFetcher<typeof action>();
  const polled = poll.data && "polled" in poll.data ? poll.data.polled : null;
  const failedNames = polled?.filter((r) => !r.ok).map((r) => members.find((m) => m.id === r.userId)?.name ?? "Unknown");
  const invited = inv.data && "invited" in inv.data ? inv.data : null;
  const corrected = correct.data && "corrected" in correct.data ? correct.data.corrected : null;

  return (
    <div className="space-y-4">
      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Invite someone</h2>
        <p className="mt-1 text-sm text-muted">The link only works for the email you enter. It expires in 7 days.</p>
        <inv.Form method="post" className="mt-4 flex gap-2" onSubmit={(e) => setTimeout(() => (e.target as HTMLFormElement).reset(), 0)}>
          <input type="hidden" name="intent" value="invite" />
          <input name="email" type="email" required placeholder="friend@example.com" className="input" />
          <PendingButton className="btn-primary shrink-0" busy={inv.state !== "idle"} pendingLabel="Sending…">Send invite</PendingButton>
        </inv.Form>
        {invited && (
          <Notice>
            Invite emailed to {invited.invited}. You can also text them the link:
            <span className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-field px-2 py-1 font-mono text-xs">{invited.link}</code>
              <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => navigator.clipboard.writeText(invited.link ?? "")}>Copy</button>
            </span>
          </Notice>
        )}
        <ErrorNote error={inv.data && "error" in inv.data ? inv.data.error : null} />

        {invites.length > 0 && (
          <ul className="mt-4 divide-y divide-line/60 rounded-xl border border-line">
            {invites.map((i) => (
              <InviteRow key={i.id} i={i} timezone={group.timezone} />
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Members · {members.length}</h2>
        <ul className="mt-3 divide-y divide-line/60">
          {members.map((m) => (
            <MemberRow key={m.id} m={m} avatar={avatars[m.id]} />
          ))}
        </ul>
      </section>

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Correct steps</h2>
        <p className="mt-1 text-sm text-muted">Fix someone's number for any past day. If that day's already final, the result gets recomputed. Every change is logged.</p>
        <correct.Form method="post" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <input type="hidden" name="intent" value="correct" />
          <select name="userId" required className="input col-span-2 sm:col-span-1">
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <input name="date" type="date" required defaultValue={addDays(today, -1)} max={today} className="input" />
          <input name="steps" type="number" inputMode="numeric" min={0} max={150000} required placeholder="Steps" className="input sm:!w-32" />
          <PendingButton className="btn-primary col-span-2 sm:col-span-1" busy={correct.state !== "idle"}>Set</PendingButton>
        </correct.Form>
        {corrected && <Notice>Set {corrected.steps.toLocaleString("en-US")} steps for {corrected.date}.</Notice>}
        <ErrorNote error={correct.data && "error" in correct.data ? correct.data.error : null} />
      </section>

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Poll Stompers</h2>
        <p className="mt-1 text-sm text-muted">Pull today's and yesterday's steps now instead of waiting for the 30-minute schedule. Manual and admin entries stay as they are.</p>
        <poll.Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="poll" />
          <PendingButton className="btn-primary w-full" busy={poll.state !== "idle"} pendingLabel="Polling…">Poll now</PendingButton>
        </poll.Form>
        {polled && !polled.length && <Notice>No members have linked a Stompers account.</Notice>}
        {polled && polled.length > 0 && (
          <Notice>
            Polled {polled.length} {polled.length === 1 ? "account" : "accounts"}: {polled.filter((r) => r.ok).length} ok
            {failedNames && failedNames.length > 0 && `, failed: ${failedNames.join(", ")}`}.
          </Notice>
        )}
        <ErrorNote error={poll.data && "error" in poll.data ? poll.data.error : null} />
      </section>

      <ManualHistory entries={manualHistory} timezone={group.timezone} showNames />

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Rules</h2>
        <settings.Form method="post" className="mt-4 grid grid-cols-2 gap-3">
          <input type="hidden" name="intent" value="settings" />
          <div className="col-span-2">
            <label className="label">Group name</label>
            <input name="name" defaultValue={group.name} className="input" />
          </div>
          <div>
            <label className="label">Daily goal</label>
            <input name="threshold_steps" type="number" defaultValue={group.threshold_steps} className="input" />
          </div>
          <div>
            <label className="label">Penalty ($)</label>
            <input name="penalty" type="number" step="0.01" defaultValue={group.penalty_cents / 100} className="input" />
          </div>
          <div>
            <label className="label">Skips / month</label>
            <input name="skips_per_month" type="number" defaultValue={group.skips_per_month} className="input" />
          </div>
          <div>
            <label className="label">Timezone</label>
            <input name="timezone" defaultValue={group.timezone} className="input" />
          </div>
          <div className="col-span-2">
            <PendingButton className="btn-primary w-full" busy={settings.state !== "idle"}>Save rules</PendingButton>
            {settings.data && "ok" in settings.data && <Notice>Saved. Changes apply to days finalized from now on.</Notice>}
            <ErrorNote error={settings.data && "error" in settings.data ? settings.data.error : null} />
          </div>
        </settings.Form>
        <p className="mt-4 text-xs text-muted">Lowest steps under the goal pays. Ties: everyone tied pays. No sync = 0 steps. The game ends at 9:00 PM; days lock at 9:15 PM. Skips stay open until midnight.</p>
      </section>
    </div>
  );
}

function InviteRow({ i, timezone }: { i: { id: string; email: string; expires_at: number }; timezone: string }) {
  const f = useFetcher();
  return (
    <li className="flex items-center justify-between px-3 py-2.5 text-sm">
      <span>
        <span className="text-strong">{i.email}</span>
        <span className="ml-2 text-xs text-muted">pending · expires {new Date(i.expires_at).toLocaleDateString("en-US", { timeZone: timezone })}</span>
      </span>
      <f.Form method="post">
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="id" value={i.id} />
        <PendingButton className="inline-flex items-center gap-1 text-xs text-coral hover:underline disabled:opacity-50" busy={f.state !== "idle"} pendingLabel="Revoking…">Revoke</PendingButton>
      </f.Form>
    </li>
  );
}

function MemberRow({ m, avatar }: { m: { id: string; name: string; email: string; role: string }; avatar?: number }) {
  const f = useFetcher<typeof action>();
  return (
    <li className="flex items-center gap-3 py-3">
      <Avatar id={m.id} name={m.name} size={34} version={avatar} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {m.name} {m.role === "admin" && <span className="ml-1 rounded bg-lime/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-lime">admin</span>}
        </div>
        <div className="truncate text-xs text-muted">{m.email}</div>
      </div>
      {m.role !== "admin" && (
        <f.Form method="post" onSubmit={(e) => !confirm(`Remove ${m.name}? They stop counting from today.`) && e.preventDefault()}>
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="userId" value={m.id} />
          <PendingButton className="btn-danger !px-3 !py-1.5 text-xs" busy={f.state !== "idle"} pendingLabel="Removing…">Remove</PendingButton>
        </f.Form>
      )}
    </li>
  );
}
