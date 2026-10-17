import { Form, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/setup";
import { AuthCard, ErrorNote } from "../components/ui";
import { db, formAction, origin, rateLimit } from "../lib/http.server";
import { bootstrap, createLoginToken, isBootstrapped } from "../lib/service";
import { loginEmail, sendMail } from "../lib/mail.server";
import { env } from "cloudflare:workers";

// First-run only: creates the admin + group. Locked forever once any user exists.
export async function loader() {
  if (await isBootstrapped(db())) throw redirect("/login");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  return formAction(async () => {
    await rateLimit(request, "setup");
    const f = await request.formData();
    const setupKey = String(f.get("setup_key") ?? "");
    if (!env.SETUP_KEY || setupKey !== env.SETUP_KEY) return { error: "Wrong setup key." };
    const email = String(f.get("email") ?? "");
    await bootstrap(db(), {
      email,
      name: String(f.get("name") ?? ""),
      groupName: String(f.get("group") ?? "Stompers"),
      timezone: String(f.get("timezone") ?? "America/Los_Angeles"),
    });
    const t = await createLoginToken(db(), email);
    const link = `${origin(request)}/auth/${t!.token}`;
    const mail = loginEmail(link);
    await sendMail(env, t!.user.email, mail.subject, mail.html, mail.text);
    return { sent: t!.user.email };
  });
}

export default function Setup() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  if (data && "sent" in data)
    return (
      <AuthCard title="You're set up" subtitle={`Login link sent to ${data.sent}.`}>
        <p className="text-center text-sm text-muted">Open it on this device to get in. Then invite the crew from the ⚙️ Group page.</p>
      </AuthCard>
    );
  return (
    <AuthCard title="Set up Stomp Tally" subtitle="One-time setup. You'll be the admin.">
      <Form method="post" className="space-y-4">
        <div>
          <label className="label">Setup key</label>
          <input name="setup_key" type="password" required className="input" placeholder="From wrangler secret SETUP_KEY" />
        </div>
        <div>
          <label className="label">Your name</label>
          <input name="name" required className="input" placeholder="Taha" />
        </div>
        <div>
          <label className="label">Your email</label>
          <input name="email" type="email" required className="input" />
        </div>
        <div>
          <label className="label">Group name</label>
          <input name="group" defaultValue="Stompers" className="input" />
        </div>
        <div>
          <label className="label">Timezone</label>
          <input name="timezone" defaultValue="America/Los_Angeles" className="input" />
        </div>
        <ErrorNote error={data && "error" in data ? data.error : null} />
        <button className="btn-primary w-full" disabled={nav.state !== "idle"}>Create group</button>
      </Form>
    </AuthCard>
  );
}
