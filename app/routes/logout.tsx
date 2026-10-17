import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { db, getCookie, SESSION_COOKIE, sessionCookie } from "../lib/http.server";
import { destroySession } from "../lib/service";

export async function action({ request }: Route.ActionArgs) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (sid) await destroySession(db(), sid);
  return redirect("/login", { headers: { "Set-Cookie": sessionCookie(request, null) } });
}

export async function loader() {
  return redirect("/");
}
