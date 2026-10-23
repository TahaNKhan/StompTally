// Browser check of the staleness refresh, against a real build and a throwaway local D1.
//   node scripts/refresh-e2e.mjs
// What only a browser can prove: the 30-minute timer fires, and coming back after a long gap
// refetches without waiting for it -- which is the case that goes wrong in an installed iOS app,
// where a backgrounded page's timers are frozen.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const BASE = `http://localhost:${port}`;
const TZ = "America/Los_Angeles";
const work = mkdtempSync(join(tmpdir(), "stomp-ref-"));
const persist = join(work, "state");
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });

let server;
try {
  wrangler("d1", "migrations", "apply", "stomp-tally", "--local", "--persist-to", persist);
  const now = Date.now(), hash = createHash("sha256").update("ref-session").digest("hex");
  writeFileSync(join(work, "seed.sql"), `
    INSERT INTO users VALUES ('u1','ann@example.com','Ann Lee',${now});
    INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES ('g1','Crew','${TZ}','2026-10-01',${now});
    INSERT INTO memberships VALUES ('g1','u1','admin','2026-10-01',NULL);
    INSERT INTO step_entries (user_id,date,steps,source,updated_at) VALUES ('u1',date('now'),8120,'manual',${now});
    INSERT INTO sessions VALUES ('${hash}','u1',${now + 864e5});`);
  wrangler("d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--file", join(work, "seed.sql"));
  execFileSync("npx", ["react-router", "build"], { stdio: "pipe" });
  server = spawn("npx", ["wrangler", "dev", "--port", String(port), "--local", "--persist-to", persist, "--var", `APP_URL:${BASE}`],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", detached: true });
  for (let i = 0; i < 180; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: TZ, locale: "en-US" });
    await context.addCookies([{ name: "st_session", value: "ref-session", url: BASE }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const pass = (m) => console.log(`✓ ${m}`);

    // Count loader requests, so "it refreshed" is proven by traffic rather than by a label.
    const loads = [];
    page.on("request", (r) => { if (/\.data(\?|$)/.test(r.url())) loads.push(Date.now()); });

    // A fake clock from the start, so "a long gap passed" is a jump in time rather than a wait.
    await page.clock.install({ time: Date.now() });
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => /Updated /.test(document.body.innerText), null, { timeout: 20_000 });
    const firstLabel = await page.evaluate(() => document.body.innerText.match(/Updated [^\n]*/)?.[0] ?? "");
    assert.match(firstLabel, /Updated (just now|[0-9]+ min ago)/, `the freshness line should be on screen, read "${firstLabel}"`);
    pass(`the line reports the last fetch: "${firstLabel}"`);

    // Reopening after a long gap. setFixedTime moves the clock WITHOUT firing timers, which is
    // exactly what a backgrounded iOS app does: its timers are frozen while the wall clock moves on.
    // So this proves the wake-up path, not the interval.
    // Always advance from the PAGE's clock, never the test process's: setFixedTime to an earlier
    // instant moves the page backwards in time, which is a different scenario entirely.
    const pageNow = () => page.evaluate(() => Date.now());
    const gap = loads.length;
    await page.clock.setFixedTime((await pageNow()) + 45 * 60_000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(1500);
    assert.ok(loads.length > gap, `reopening after 45 minutes must refetch, saw ${loads.length - gap} loads`);
    pass("reopening after 45 minutes refetched, without waiting for the timer");

    // Still fresh: coming back must NOT refetch, or every glance at the phone costs a round trip.
    const fresh = loads.length;
    await page.clock.setFixedTime((await pageNow()) + 5 * 60_000);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(1200);
    assert.equal(loads.length, fresh, "coming back within the interval must not refetch");
    pass("reopening while the data is fresh refetched nothing");

    // The interval itself, while the app stays open. setFixedTime freezes the clock from here on,
    // so hand it a real clock to advance and let the 30-minute timer actually come due.
    await page.clock.install({ time: await pageNow() });
    await page.clock.runFor(31 * 60_000);
    await page.waitForTimeout(1500);
    assert.ok(loads.length > fresh, `31 minutes open must refetch, saw ${loads.length - fresh} loads`);
    pass(`31 minutes of the app being open refetched the page (${loads.length - fresh} load)`);

    // Tapping the line refreshes on demand: the escape hatch when a device clock is wrong.
    const tapped = loads.length;
    await page.getByRole("button", { name: /Updated|Refreshing/ }).click();
    await page.waitForTimeout(1500);
    assert.ok(loads.length > tapped, `tapping the line must refetch, saw ${loads.length - tapped} loads`);
    pass("tapping the freshness line refetched on demand");

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    pass("no page errors");
  } finally { await browser.close(); }
} finally {
  if (server?.pid) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* exited */ }
    server.stdout.destroy(); server.stderr.destroy();
  }
  rmSync(work, { recursive: true, force: true });
}
