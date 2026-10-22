import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/me";
import { Avatar, ErrorNote, LogoutButton } from "../components/ui";
import { PendingButton } from "../components/pending";
import { db, formAction, memberOr, requireMember, sid } from "../lib/http.server";
import { AppError, recordSteps, renameSelf } from "../lib/service";
import { LogSteps } from "../components/manual-steps";
import { ManualHistory } from "../components/manual-history";
import { ThemeSwitch } from "../components/theme-switch";
import { AvatarUpload } from "../components/avatar-upload";
import { deleteAvatar, saveAvatar } from "../lib/avatars";
import { loadMe } from "../lib/pages";
import { linkStompers, unlinkStompers, syncStompers } from "../lib/stompers.server";
import { rateLimit } from "../lib/http.server";

export async function loader({ request }: Route.LoaderArgs) {
  const result = await loadMe(db(), sid(request));
  memberOr(request, result.auth);
  return result.page!;
}

export async function action({ request }: Route.ActionArgs) {
  const { user } = await requireMember(request);
  const f = await request.formData();
  return formAction(async () => {
    if (f.get("intent") === "manual") {
      const value = String(f.get("steps") ?? "").trim();
      await recordSteps(db(), { actor: user, userId: user.id, date: String(f.get("date") ?? ""), steps: value ? Number(value) : NaN, source: "manual" });
      return { ok: true };
    }
    if (f.get("intent") === "avatar-upload") {
      await rateLimit(request, "avatar.upload");
      const photo = f.get("photo");
      if (!(photo instanceof File)) throw new AppError(400, "Choose a photo first.");
      await saveAvatar(db(), user.id, new Uint8Array(await photo.arrayBuffer()));
      return { avatar: "saved" as const };
    }
    if (f.get("intent") === "avatar-delete") {
      await deleteAvatar(db(), user.id);
      return { avatar: "removed" as const };
    }
    if (f.get("intent") === "stompers") {
      await rateLimit(request, "stompers.link");
      await linkStompers(db(), user, String(f.get("identity") ?? ""), String(f.get("kind") ?? "username"));
      await syncStompers(db(), Date.now(), undefined, { userId: user.id });
      return { linked: true };
    }
    if (f.get("intent") === "unlink-stompers") {
      await unlinkStompers(db(), user);
      return { unlinked: true };
    }
    if (!f.has("name")) throw new AppError(400, "Unknown action.");
    await renameSelf(db(), user, String(f.get("name") ?? ""));
    return { renamed: true };
  });
}

export default function Me() {
  const { user, rules, stompers, timezone, today, yesterday, manualHistory, avatars } = useLoaderData<typeof loader>();
  const rename = useFetcher<typeof action>();
  const link = useFetcher<typeof action>();

  return (
    <div className="space-y-4">
      <section className="card p-5 rise">
        <div className="flex items-center gap-4">
          <Avatar id={user.id} name={user.name} size={52} version={avatars[user.id]} />
          <div className="min-w-0">
            <div className="font-display text-lg font-bold">{user.name}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
        </div>
        <rename.Form method="post" className="mt-4 flex gap-2">
          <input name="name" defaultValue={user.name} maxLength={40} className="input" aria-label="Display name" />
          <PendingButton className="btn-ghost shrink-0" busy={rename.state !== "idle"}>Rename</PendingButton>
        </rename.Form>
        <ErrorNote error={rename.data && "error" in rename.data ? rename.data.error : null} />
      </section>

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">Stompers</h2>
        <p className="mt-1 text-sm text-muted">Steps pull every 30 minutes. The higher of walking steps and game steps counts toward the tally.</p>
        {stompers && <div className="mt-3 text-sm">
          <p>Linked to <b>{stompers.username ? `@${stompers.username}` : stompers.stompers_uid}</b></p>
          <p className="mt-1 break-all text-xs text-muted">User ID: {stompers.stompers_uid}</p>
          <p className="mt-1 text-xs text-muted">{stompers.last_synced_at ? `Last pulled ${new Date(stompers.last_synced_at).toLocaleString("en-US", { timeZone: timezone })} (group time)` : "Waiting for the first step pull."}</p>
          <ErrorNote error={stompers.last_error} />
        </div>}
        <link.Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="stompers" />
          <label className="block text-xs text-muted">Link with
            <select name="kind" className="input mt-1" defaultValue="username"><option value="username">Stompers username</option><option value="uid">Stompers user ID</option></select>
          </label>
          <div className="flex gap-2">
            <input name="identity" defaultValue={stompers?.username ?? ""} maxLength={128} required className="input min-w-0" aria-label="Stompers username or user ID" placeholder="@yourname or user ID" />
            <PendingButton className="btn-primary shrink-0" busy={link.state !== "idle"}>Link</PendingButton>
          </div>
        </link.Form>
        {stompers && <link.Form method="post" className="mt-3">
          <PendingButton name="intent" value="unlink-stompers" className="btn-ghost text-xs" busy={link.state !== "idle"}>Unlink Stompers</PendingButton>
        </link.Form>}
        <ErrorNote error={link.data && "error" in link.data ? link.data.error : null} />
      </section>

      {!today.finalized && <LogSteps today={today.date} yesterday={yesterday.finalized ? null : yesterday.date} myToday={today.steps} myYesterday={yesterday.steps} />}

      <ManualHistory entries={manualHistory} timezone={timezone} />

      <section className="card p-5 rise">
        <h2 className="font-display text-lg font-bold">How it works</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-soft">
          <li>👟 Link <b>Stompers</b> to pull both counts every 30 minutes. The higher count wins. Log manual changes here; each save is kept in the change log.</li>
          <li>👟 Lowest under {rules.threshold.toLocaleString("en-US")} each day owes <b className="text-lime">${rules.penalty / 100}</b>. Ties: everyone tied pays.</li>
          <li>🫥 Didn't log? That counts as 0.</li>
          <li>🛡️ {rules.skips} skips a month. Claim one by midnight, even after the 9:05 PM lock. It's only used up if it saves you.</li>
          <li>🔒 Each day locks at 9:05 PM. After that only the admin can change steps.</li>
        </ul>
      </section>

      <AvatarUpload userId={user.id} name={user.name} version={avatars[user.id] ?? null} />

      <ThemeSwitch />

      <LogoutButton />
    </div>
  );
}
