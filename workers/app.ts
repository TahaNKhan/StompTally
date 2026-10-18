import { createRequestHandler } from "react-router";
import { d1Db } from "../app/lib/db";
import { runStompersSchedule } from "../app/lib/stompers.server";
import { sendMail, stompersFailureEmail } from "../app/lib/mail.server";
import { requestDb } from "../app/lib/request-db.server";

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
    const start = performance.now();
    const metrics = { calls: 0, statements: 0, durationMs: 0 };
    const res = await requestDb.run({ db: d1Db(env.DB, metrics), metrics }, () => requestHandler(request));
    const h = new Headers(res.headers);
    h.set("Server-Timing", `d1;dur=${metrics.durationMs.toFixed(1)}, app;dur=${(performance.now() - start).toFixed(1)}`);
    h.set("X-DB-Calls", String(metrics.calls));
    h.set("X-DB-Statements", String(metrics.statements));
    h.set("Cache-Control", "private, no-store");
    if (res.headers.get("Content-Type")?.includes("text/html")) {
      h.set("X-Frame-Options", "DENY");
      h.set("X-Content-Type-Options", "nosniff");
      h.set("Referrer-Policy", "same-origin");
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runStompersSchedule(d1Db(env.DB), Date.now(), undefined, async (alerts) => {
        for (const alert of alerts) {
          const mail = stompersFailureEmail(`${env.APP_URL}/group`, alert.groupName, alert.members);
          for (const email of alert.adminEmails) await sendMail(env, email, mail.subject, mail.html, mail.text);
        }
      }).then((done) => {
        console.log("stompers.schedule", JSON.stringify(done));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
