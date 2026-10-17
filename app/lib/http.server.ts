// Request helpers shared by route loaders/actions.
import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import { d1Db } from "./db";
import { AppError } from "./service";
import { runAuthed, type Authed, type Ctx } from "./pages";
import { requestDb } from "./request-db.server";

export const SESSION_COOKIE = "st_session";

export function db() {
  return requestDb.getStore()?.db ?? d1Db(env.DB);
}

export function getCookie(request: Request, name: string) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export const sid = (request: Request) => getCookie(request, SESSION_COOKIE);

export function sessionCookie(request: Request, sid: string | null) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return sid
    ? `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function origin(request: Request) {
  return env.APP_URL || new URL(request.url).origin;
}

/** Turn a one-batch page result into a logged-in member context, or redirect. */
export function memberOr(request: Request, a: Authed): Ctx {
  if (!a.user) throw redirect(`/login?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  if (!a.ctx) throw redirect("/no-group");
  return a.ctx;
}

/** Actions also resolve session + membership in one DB call, not two chained reads. */
export async function requireMember(request: Request) {
  return memberOr(request, await runAuthed(db(), sid(request), Date.now()));
}

/** Turn AppErrors into form errors; rethrow everything else. */
export async function formAction<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

/** Basic per-IP rate limit, backed by the Workers rate-limit binding when present. */
export async function rateLimit(request: Request, key: string) {
  const limiter = (env as unknown as { RATE_LIMITER?: RateLimit }).RATE_LIMITER;
  if (!limiter) return;
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const { success } = await limiter.limit({ key: `${key}:${ip}` });
  if (!success) throw new AppError(429, "Slow down a bit and try again in a minute.");
}
