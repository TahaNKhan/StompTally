import { Form, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/auth";
import { AuthCard } from "../components/ui";
import { db, sessionCookie } from "../lib/http.server";
import { AppError, redeemLoginToken } from "../lib/service";

// GET shows a confirm button (so email link scanners that prefetch URLs don't burn the token).
export async function loader({ request }: Route.LoaderArgs) {
  const next = new URL(request.url).searchParams.get("next") ?? "/";
  return { next: next.startsWith("/") && !next.startsWith("//") ? next : "/" };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const nextRaw = String(form.get("next") ?? "/");
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  try {
    const sid = await redeemLoginToken(db(), params.token);
    return redirect(next, { headers: { "Set-Cookie": sessionCookie(request, sid) } });
  } catch (e) {
    if (e instanceof AppError) return redirect("/login?expired=1");
    throw e;
  }
}

export default function Auth() {
  const { next } = useLoaderData<typeof loader>();
  return (
    <AuthCard title="One tap left" subtitle="Confirm to finish logging in.">
      <Form method="post">
        <input type="hidden" name="next" value={next} />
        <button className="btn-primary w-full" autoFocus>Continue</button>
      </Form>
    </AuthCard>
  );
}
