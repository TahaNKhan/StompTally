import { createRequestHandler } from "react-router";
import { d1Db } from "../app/lib/db";
import { AppError, finalizeDue } from "../app/lib/service";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true });
    const res = await requestHandler(request);
    if (res.headers.get("Content-Type")?.includes("text/html")) {
      const h = new Headers(res.headers);
      h.set("X-Frame-Options", "DENY");
      h.set("X-Content-Type-Options", "nosniff");
      h.set("Referrer-Policy", "same-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      finalizeDue(d1Db(env.DB)).then((done) => {
        if (done.length) console.log("finalized", JSON.stringify(done));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
