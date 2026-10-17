import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/me";
import { Avatar, ErrorNote, LogoutButton } from "../components/ui";
import { PendingButton } from "../components/pending";
import { db, formAction, memberOr, requireMember, sid } from "../lib/http.server";
import { renameSelf } from "../lib/service";
import { loadMe } from "../lib/pages";

export async function loader({ request }: Route.LoaderArgs) {
  const result = await loadMe(db(), sid(request));
  memberOr(request, result.auth);
  return result.page!;
}

export async function action({ request }: Route.ActionArgs) {
  const { user } = await requireMember(request);
  const f = await request.formData();
  return formAction(async () => {
    await renameSelf(db(), user, String(f.get("name") ?? ""));
    return { renamed: true };
  });
}

export default function Me() {
  const { user, rules } = useLoaderData<typeof loader>();
  const rename = useFetcher<typeof action>();

  return (
    <div className="space-y-4">
      <section className="card p-5 rise">
        <div className="flex items-center gap-4">
          <Avatar id={user.id} name={user.name} size={52} />
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
        <h2 className="font-display text-lg font-bold">How it works</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-zinc-300">
          <li>✏️ Log your <b>Stompers</b> step count on the Today tab (after power-ups, not Apple Health).</li>
          <li>👟 Lowest under {rules.threshold.toLocaleString("en-US")} each day owes <b className="text-lime">${rules.penalty / 100}</b>. Ties: everyone tied pays.</li>
          <li>🫥 Didn't log? That counts as 0.</li>
          <li>🛡️ {rules.skips} skips a month. Claim one before noon the next day. It's only used up if it saves you.</li>
          <li>🔒 Each day locks at noon the next day. After that only the admin can fix it.</li>
        </ul>
      </section>

      <LogoutButton />
    </div>
  );
}
