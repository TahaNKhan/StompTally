import { Form, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { AuthCard, ErrorNote, Notice } from "../components/ui";
import { PendingButton } from "../components/pending";
import { db, formAction, origin, rateLimit, sid } from "../lib/http.server";
import { createLoginToken } from "../lib/service";
import { loadLoginState } from "../lib/pages";
import { loginEmail, sendMail } from "../lib/mail.server";
import { isEmail } from "../lib/crypto";
import { env } from "cloudflare:workers";

export async function loader({ request }: Route.LoaderArgs) {
  const state = await loadLoginState(db(), sid(request));
  if (!state.bootstrapped) throw redirect("/setup");
  if (state.loggedIn) throw redirect("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  return formAction(async () => {
    await rateLimit(request, "login");
    const form = await request.formData();
    const email = String(form.get("email") ?? "");
    const next = String(form.get("next") ?? "/");
    if (!isEmail(email.trim())) return { error: "Enter a valid email." };
    const t = await createLoginToken(db(), email);
    if (t) {
      const link = `${origin(request)}/auth/${t.token}?next=${encodeURIComponent(next.startsWith("/") ? next : "/")}`;
      const mail = loginEmail(link);
      await sendMail(env, t.user.email, mail.subject, mail.html, mail.text);
    }
    // Same answer whether or not the email exists, so this can't be used to probe membership.
    return { sent: email.trim() };
  });
}

export default function Login() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const [params] = useSearchParams();
  const sent = data && "sent" in data ? data.sent : null;
  return (
    <AuthCard title="Stomp Tally" subtitle="Lowest under 10k pays. Log in with your email.">
      {sent ? (
        <div className="text-center">
          <div className="text-4xl">📬</div>
          <p className="mt-3 font-medium">Check your inbox</p>
          <p className="mt-1 text-sm text-muted">
            If <span className="text-zinc-200">{sent}</span> is in a group, a login link is on its way. It expires in 20 minutes.
          </p>
          <a href="/login" className="btn-ghost mt-6 w-full">Use a different email</a>
        </div>
      ) : (
        <Form method="post">
          <input type="hidden" name="next" value={params.get("next") ?? "/"} />
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" className="input" autoFocus />
          <ErrorNote error={data && "error" in data ? data.error : null} />
          {params.get("expired") && <Notice>That link expired. Grab a fresh one.</Notice>}
          <PendingButton className="btn-primary mt-4 w-full" busy={nav.state !== "idle"} pendingLabel="Sending…">Email me a login link</PendingButton>
          <p className="mt-4 text-center text-xs text-muted">Invite-only. No passwords.</p>
        </Form>
      )}
    </AuthCard>
  );
}
