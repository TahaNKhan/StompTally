import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { Route } from "./+types/invite";
import { AuthCard, ErrorNote } from "../components/ui";
import { PendingButton } from "../components/pending";
import { db, formAction, origin, rateLimit, sid } from "../lib/http.server";
import { loadInvitePage } from "../lib/pages";
import { AppError, completeInvite, previewInvite, startInviteAcceptance } from "../lib/service";
import { confirmInviteEmail, sendMail } from "../lib/mail.server";
import { env } from "cloudflare:workers";

export async function loader({ request, params }: Route.LoaderArgs) {
  try {
    const { invite: raw, user } = await loadInvitePage(db(), params.token, sid(request));
    const inv = { email: raw.email, groupName: raw.group_name, inviter: raw.inviter };
    // Returning from the confirm email with a matching session: finish joining.
    if (user && user.email === inv.email) {
      await completeInvite(db(), user, params.token);
      throw redirect("/?joined=1");
    }
    return { invite: inv, error: null as string | null, signedInAs: user?.email ?? null };
  } catch (e) {
    if (e instanceof AppError) return { invite: null, error: e.message, signedInAs: null };
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  return formAction(async () => {
    await rateLimit(request, "invite");
    const f = await request.formData();
    const s = await startInviteAcceptance(db(), params.token, String(f.get("name") ?? ""));
    // Log in, then land back on this invite page, which completes the join.
    const link = `${origin(request)}/auth/${s.loginToken}?next=${encodeURIComponent(`/invite/${params.token}`)}`;
    const inv = await previewInvite(db(), params.token);
    const mail = confirmInviteEmail(link, inv.groupName);
    await sendMail(env, s.email, mail.subject, mail.html, mail.text);
    return { sent: s.email };
  });
}

export default function Invite() {
  const { invite, error, signedInAs } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  if (!invite)
    return (
      <AuthCard title="Invite unavailable">
        <ErrorNote error={error} />
        <a href="/login" className="btn-ghost mt-4 w-full">Go to login</a>
      </AuthCard>
    );
  if (data && "sent" in data)
    return (
      <AuthCard title="Check your email" subtitle={`We sent a confirm link to ${data.sent}.`}>
        <p className="text-center text-sm text-muted">Tap it to join {invite.groupName}. This makes sure the invite is only used by the person it was sent to.</p>
      </AuthCard>
    );
  return (
    <AuthCard
      title={`Join ${invite.groupName}`}
      subtitle={
        <>
          <span className="text-zinc-200">{invite.inviter}</span> invited <span className="text-zinc-200">{invite.email}</span>
        </>
      }
    >
      <ul className="mb-5 space-y-2 text-sm text-zinc-300">
        <li>👟 Lowest steps under 10k each day owes <b className="text-lime">$5</b></li>
        <li>🤝 Ties: everyone tied pays</li>
        <li>🛡️ 3 skip days a month, claimed before noon the next day</li>
      </ul>
      {signedInAs && signedInAs !== invite.email && (
        <p className="mb-4 rounded-xl border border-amber/30 bg-amber/10 px-3 py-2 text-sm text-amber">
          You're logged in as {signedInAs}. This invite is for {invite.email}.
        </p>
      )}
      <Form method="post">
        <label className="label">What should we call you?</label>
        <input name="name" required maxLength={40} className="input" placeholder="First name" autoFocus />
        <ErrorNote error={data && "error" in data ? data.error : null} />
        <PendingButton className="btn-primary mt-4 w-full" busy={nav.state !== "idle"} pendingLabel="Sending…">
          Send confirm link to {invite.email}
        </PendingButton>
      </Form>
    </AuthCard>
  );
}
