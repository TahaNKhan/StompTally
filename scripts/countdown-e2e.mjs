// Browser check that the Today "locks in" countdown is wired up for real, against a throwaway
// local D1.   node scripts/countdown-e2e.mjs
// This covers the part only a browser can prove: the server's lock instant reaches the badge, and
// the badge renders a label that agrees with the wall clock. The label math itself, and how it
// ticks between units, is pinned by app/lib/countdown.test.ts -- driving a fake clock from here
// only ever measured Playwright's own batching, so there is no fake clock in this script.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { countdownLabel } from "../app/lib/countdown.ts";
import { GAME_END_LABEL, LOCK_TIME_LABEL } from "../app/lib/dates.ts";

const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const BASE = `http://localhost:${port}`;
const TZ = "America/Los_Angeles";
const work = mkdtempSync(join(tmpdir(), "stomp-cd-"));
const persist = join(work, "state");
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });

let server;
try {
  wrangler("d1", "migrations", "apply", "stomp-tally", "--local", "--persist-to", persist);
  const now = Date.now(), hash = createHash("sha256").update("cd-session").digest("hex");
  writeFileSync(join(work, "seed.sql"), `
    INSERT INTO users VALUES ('u1','ann@example.com','Ann Lee',${now});
    INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES ('g1','Crew','${TZ}','2026-10-01',${now});
    INSERT INTO memberships VALUES ('g1','u1','admin','2026-10-01',NULL);
    INSERT INTO sessions VALUES ('${hash}','u1',${now + 864e5});`);
  wrangler("d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--file", join(work, "seed.sql"));
  server = spawn("npx", ["vite", "dev", "--port", String(port), "--strictPort"], { env: { ...process.env, STOMP_PERSIST: persist, SETUP_KEY: "x", APP_URL: BASE }, stdio: "pipe", detached: true });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: TZ });
    await context.addCookies([{ name: "st_session", value: "cd-session", url: BASE }]);
    const errors = [];
    const pass = (m) => console.log(`✓ ${m}`);

    // Load as a real browser does, on the real clock, so "today" is whatever the server decides.
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const requests = []; page.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await page.goto(`${BASE}/`, { waitUntil: "load" });

    // The badge belongs to Today, which is the second card; the first is Yesterday, already locked
    // and showing the static lock time instead. Scope to Today by its label.
    const todayCard = page.locator("section.card").filter({ hasText: "TODAY" });
    const header = (await todayCard.innerText()).split("\n").slice(0, 4).join(" / ");
    assert.match(header, /Live · ends in|Final in|Waiting for final counts/, `the open day should show the live badge, header read "${header}"`);

    // The day has two instants: the game window shuts at 9:00 PM and the day locks at 9:15. Which
    // one the badge counts to depends on the real time, and once the lock has passed there is no
    // countdown left to show -- so this script passes at any hour, checking whichever state it lands in.
    const badge = page.locator("time");
    if ((await badge.count()) === 0) {
      assert.match(header, /Waiting for final counts/, `with no countdown left the badge should say it is waiting, read "${header}"`);
      pass(`past the ${LOCK_TIME_LABEL} lock, so Today waits for the result instead of counting`);
    } else {
      const target = Date.parse(await badge.getAttribute("datetime"));
      const shown = new Date(target).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
      assert.ok([GAME_END_LABEL, LOCK_TIME_LABEL].includes(shown), `the badge should count to ${GAME_END_LABEL} or ${LOCK_TIME_LABEL} Pacific, counted to ${shown}`);
      pass(`server sent ${shown} Pacific as the next instant (${Math.round((target - Date.now()) / 60_000)} min away)`);

      // The label is read a moment after the clock sample, so accept either side of that gap: at a
      // unit boundary the label may legitimately have just flipped. Anything else means the badge is
      // showing a time the server did not send.
      const { label, before, after } = await page.evaluate(() => {
        const before = Date.now();
        const label = document.querySelector("time").textContent;
        return { label, before, after: Date.now() };
      });
      const plausible = new Set([countdownLabel(target, before), countdownLabel(target, after), "now"]);
      assert.ok(plausible.has(label), `badge shows "${label}", but ${new Date(before).toISOString()} to ${new Date(after).toISOString()} before that instant reads ${[...plausible].join(" or ")}`);
      pass(`badge counts down on its own ("${label}" with the real clock)`);
    }

    const polled = requests.filter((path) => path.endsWith(".data"));
    assert.deepEqual(polled, [], `rendering the badge should not need a data reload, saw ${polled.join(", ")}`);

    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`); pass("no page errors");
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
