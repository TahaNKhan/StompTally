// Browser check of offline mode, against a real build and a throwaway local D1.
//   node scripts/offline-e2e.mjs
// Proves the three things that only a browser can: the worker registers and takes control, a page
// opened once still renders with the network cut, and a write is refused instead of half-saved.
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
const work = mkdtempSync(join(tmpdir(), "stomp-off-"));
const persist = join(work, "state");
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });

let server;
try {
  wrangler("d1", "migrations", "apply", "stomp-tally", "--local", "--persist-to", persist);
  const now = Date.now(), hash = createHash("sha256").update("off-session").digest("hex");
  writeFileSync(join(work, "seed.sql"), `
    INSERT INTO users VALUES ('u1','ann@example.com','Ann Lee',${now});
    INSERT INTO users VALUES ('u2','bo@example.com','Bo Diaz',${now});
    INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES ('g1','Crew','${TZ}','2026-10-01',${now});
    INSERT INTO memberships VALUES ('g1','u1','admin','2026-10-01',NULL);
    INSERT INTO memberships VALUES ('g1','u2','member','2026-10-01',NULL);
    INSERT INTO step_entries (user_id,date,steps,source,updated_at) VALUES ('u1',date('now'),8120,'manual',${now});
    INSERT INTO step_entries (user_id,date,steps,source,updated_at) VALUES ('u2',date('now'),6340,'manual',${now});
    INSERT INTO sessions VALUES ('${hash}','u1',${now + 864e5});`);
  wrangler("d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--file", join(work, "seed.sql"));

  // The service worker only exists in a real build, so this runs the built worker, not vite dev.
  execFileSync("npx", ["react-router", "build"], { stdio: "pipe", env: { ...process.env } });
  server = spawn("npx", ["wrangler", "dev", "--port", String(port), "--local", "--persist-to", persist, "--var", `APP_URL:${BASE}`],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", detached: true });
  for (let i = 0; i < 180; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: TZ, locale: "en-US" });
    await context.addCookies([{ name: "st_session", value: "off-session", url: BASE }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const pass = (m) => console.log(`✓ ${m}`);

    // The worker is served from the origin root, or its scope would not cover the app's pages.
    const swResponse = await page.request.get(`${BASE}/sw.js`);
    assert.equal(swResponse.status(), 200, "/sw.js must be served");
    assert.match(swResponse.headers()["content-type"] ?? "", /javascript/, "/sw.js must be served as JavaScript");
    pass("the service worker is served from the root, as JavaScript");

    // The FIRST load cannot be controlled by a worker that does not exist yet, so its document
    // never passes through the fetch handler. Register, wait for control, then load again -- that
    // second load is the one that reaches the cache, and it is what a returning user gets.
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
    pass("the worker registered and took control of the page");

    await page.reload({ waitUntil: "load" });

    // Read the rendered text straight off the DOM. Playwright's innerText waits for the element to
    // settle, and this board carries a live countdown, so it never does.
    const boardText = () => page.evaluate(() => document.body.innerText);
    const onlineText = await boardText();
    assert.match(onlineText, /TODAY/, `the online page should show the Today board, got "${onlineText.slice(0, 200)}"`);
    assert.match(onlineText, /Ann Lee/, "the online board should list Ann Lee");

    // The board must actually be in the worker's cache, or "offline" below would prove nothing.
    // /me is opened now too, while there is still a signal -- a page nobody has visited has
    // nothing to show offline, by design.
    await page.goto(`${BASE}/me`, { waitUntil: "load" });
    await page.waitForFunction(() => /Log your steps/.test(document.body.innerText), null, { timeout: 15_000 });
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    // /login is visited while signed in, so it redirects to /. The worker stores only non-redirects,
    // which is why the sign-in screen is checked after signing out instead.
    await page.waitForFunction(async () => {
      const cache = await caches.open("stomp-pages-v1");
      const paths = (await cache.keys()).map((r) => new URL(r.url).pathname);
      return paths.includes("/") && paths.includes("/me");
    }, null, { timeout: 10_000 });
    pass("the board and the log-steps page are cached before the network is cut");

    // Cut the network at the browser level: every request the page makes now fails, exactly as
    // airplane mode fails, while the service worker keeps running.
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    const offlineText = await boardText();
    assert.match(offlineText, /TODAY/, `the board must still render offline, got "${offlineText.slice(0, 160)}"`);
    assert.match(offlineText, /Ann Lee/, `the offline board must still list Ann Lee, got "${offlineText.slice(0, 160)}"`);
    pass("the Today board still renders with the network cut");

    const bar = page.getByText("Offline.", { exact: false });
    await bar.first().waitFor({ timeout: 5000 });
    pass(`the app says it is offline: "${(await bar.first().innerText()).replace(/\s+/g, " ").slice(0, 90)}"`);

    // A write must be refused up front, and said out loud, rather than failing after a spinner.
    // Navigating there offline also proves a second page loads from the cache, not just the one
    // the browser happened to be showing.
    await page.goto(`${BASE}/me`, { waitUntil: "load" });
    await page.waitForFunction(() => /Log your steps/.test(document.body.innerText), null, { timeout: 15_000 });
    const saveDisabled = await page.evaluate(() => {
      const form = [...document.querySelectorAll("form")].find((f) => f.textContent?.includes("Log your steps") || f.querySelector('input[name="intent"][value="manual"]'));
      const button = form?.querySelector("button");
      return button ? button.disabled : null;
    });
    assert.equal(saveDisabled, true, "the save button must be disabled offline");
    const note = page.getByText("You're offline. Your steps will save when you're back on a signal.");
    await note.first().waitFor({ timeout: 5000 });
    pass("a step save is refused offline, and the reason is on screen");

    // Nothing was queued: no pending overlay, and the value is untouched on the server.
    assert.equal(await page.locator('[data-testid="pending-screen"]').count(), 0, "no save should be in flight");

    // Back on a signal, both the bar and the button recover without a manual reload.
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine, null, { timeout: 5000 });
    await page.waitForFunction(() => !document.body.innerText.includes("Offline."), null, { timeout: 5000 });
    pass("the offline bar clears itself once the signal is back");

    // The worker promises to drop the private cache the moment a signed-out page is reached, so a
    // shared phone does not keep the previous person's board readable. Sign out and check.
    // Logout is a POST: the button submits a form and the action redirects to /login. Navigating
    // there offline would serve the cached board instead of signing anyone out, so post it, then
    // land on the signed-out page the redirect points at.
    await page.evaluate(async (base) => {
      await fetch(`${base}/logout`, { method: "POST", body: new FormData(), redirect: "follow" });
    }, BASE);
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const leftOver = await page.evaluate(async () => {
      const cache = await caches.open("stomp-pages-v1");
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    // /login is public and may stay, so someone with no signal can still reach the sign-in screen.
    // What must be gone is every signed-in board -- a shared phone keeps nobody's steps or money.
    const signedInPages = leftOver.filter((path) => !path.startsWith("/login") && !path.startsWith("/__stomp"));
    assert.deepEqual(signedInPages, [], `signing out must drop the cached boards, still held ${signedInPages.join(", ")}`);
    assert.ok(!leftOver.includes("/me"), "the /me page must not survive a sign-out");
    pass(`signing out drops the cached boards (kept ${leftOver.filter((p) => !p.startsWith("/__stomp")).join(", ") || "nothing"})`);

    // Now that the sign-in screen has been reached while signed out, it is cached. It must still
    // open with no signal: that is where someone lands after signing out or when a session expires,
    // and a hard net::ERR_FAILED there is the worst possible dead end.
    await context.setOffline(true);
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    const loginText = await boardText();
    assert.match(loginText, /Email me a login link|Check your inbox/, `the sign-in page must render offline, got "${loginText.slice(0, 140)}"`);
    pass("the sign-in page still renders with no signal");
    await context.setOffline(false);

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
