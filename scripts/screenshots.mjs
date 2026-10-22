// Regenerates the README screenshots from invented data on a throwaway local database.
// Never touches production: it seeds a temp D1 under os.tmpdir() and logs in with a seeded session.
//   node scripts/screenshots.mjs        (needs Chromium; set CHROMIUM to override /usr/bin/chromium)
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

// A free port per run, so a server left over from an earlier run can never answer for this one.
const PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const BASE = `http://localhost:${PORT}`;
const TZ = "America/Los_Angeles";
const SESSION_ID = "screenshot-session";
const OUT = process.env.SHOTS_OUT || new URL("../screenshots/", import.meta.url).pathname;
const SCHEME = process.env.SHOTS_SCHEME === "light" ? "light" : "dark";
// SHOTS_AFTER_LOCK=1 seeds a lock for today, so Today shows the 21:15-to-midnight state (locked, skips open).
const AFTER_LOCK = process.env.SHOTS_AFTER_LOCK === "1";

const people = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Alex Rivera", email: "alex@example.com", stompers: "alexwalks", base: 13200 },
  { id: "00000000-0000-4000-8000-000000000002", name: "Jordan Lee", email: "jordan@example.com", stompers: "jordanlee", base: 11800 },
  { id: "00000000-0000-4000-8000-000000000003", name: "Sam Patel", email: "sam@example.com", stompers: "sampatel", base: 9400 },
  { id: "00000000-0000-4000-8000-000000000004", name: "Riley Chen", email: "riley@example.com", stompers: "rileyc", base: 10600 },
  { id: "00000000-0000-4000-8000-000000000005", name: "Casey Morgan", email: "casey@example.com", stompers: "caseym", base: 8200 },
];
const GROUP = "00000000-0000-4000-8000-0000000000aa";
const me = people[0];

const localDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Deterministic pseudo-random so reruns produce the same pictures for the same dates.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function buildSeed(now) {
  const today = localDate(now), yesterday = addDays(today, -1);
  const monthStart = addDays(today.slice(0, 7) + "-01", -30).slice(0, 7) + "-01"; // previous month, so the ledger has two rows
  const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const rows = [];
  const insert = (table, values) => rows.push(`INSERT INTO ${table} VALUES (${values.map(q).join(",")});`);
  const rand = rng(7);

  insert("groups", [GROUP, "Sample Crew", TZ, 10000, 500, 3, monthStart, now]);
  for (const p of people) {
    insert("users", [p.id, p.email, p.name, now]);
    insert("memberships", [GROUP, p.id, p === me ? "admin" : "member", monthStart, null]);
    insert("stompers_accounts", [p.id, `fake-uid-${p.stompers}`, p.stompers, now, now - 20 * 60_000, now - 20 * 60_000, null, 0, null]);
  }
  // Optional invented faces (SHOTS_FACES=dir with alex.jpg, jordan.jpg, riley.jpg) so the README can show photos.
  if (process.env.SHOTS_FACES) {
    const faces = { alex: people[0], jordan: people[1], riley: people[3] };
    for (const [file, person] of Object.entries(faces)) {
      const hex = readFileSync(join(process.env.SHOTS_FACES, `${file}.jpg`)).toString("hex");
      rows.push(`INSERT INTO user_avatars VALUES ('${person.id}', X'${hex}', 'image/jpeg', ${hex.length / 2}, ${now});`);
    }
  }
  const sessionHash = createHash("sha256").update(SESSION_ID).digest("hex");
  insert("sessions", [sessionHash, me.id, now + 30 * 864e5]);

  const penaltyTotals = {};
  for (let date = monthStart; date <= yesterday; date = addDays(date, 1)) {
    const steps = people.map((p) => Math.round(p.base * (0.7 + rand() * 0.75)));
    people.forEach((p, i) => insert("step_entries", [p.id, date, steps[i], "stompers", now, steps[i], steps[i], `fake-game-${date}`, now]));
    const min = Math.min(...steps);
    const losers = people.filter((_, i) => steps[i] === min && min < 10000);
    insert("day_results", [GROUP, date, min, JSON.stringify(losers.map((l) => l.id)), losers.length ? "penalty" : "no_loser", now]);
    for (const l of losers) { insert("penalties", [GROUP, l.id, date, 500]); penaltyTotals[date.slice(0, 7)] = (penaltyTotals[date.slice(0, 7)] ?? 0) + 1; }
  }
  // Days lock at 21:15, so yesterday is always final. With SHOTS_AFTER_LOCK, today is locked too.
  const todaySteps = [8120, 6340, 7210, 9040, 3980];
  people.forEach((p, i) => insert("step_entries", [p.id, today, todaySteps[i] + (i === 1 ? 0.5 : 0), "stompers", now - 20 * 60_000, todaySteps[i] - 300, todaySteps[i] + (i === 1 ? 0.5 : 0), `fake-game-${today}`, now - 20 * 60_000]));
  if (AFTER_LOCK) {
    const lowest = people[todaySteps.indexOf(Math.min(...todaySteps))];
    insert("day_results", [GROUP, today, Math.min(...todaySteps), JSON.stringify([lowest.id]), "penalty", now - 25 * 60_000]);
    insert("penalties", [GROUP, lowest.id, today, 500]);
  }
  rows.push(`INSERT INTO settlements VALUES ('${GROUP}', '${monthStart.slice(0, 7)}', 'Paid for tacos', ${now - 5 * 864e5});`);
  rows.push(`INSERT INTO manual_step_entries (group_id,user_id,actor_id,date,steps,previous_steps,previous_source,raw_steps,game_steps,created_at) VALUES ('${GROUP}','${me.id}','${me.id}','${today}',8400,8120,'stompers',7820,8120,${now - 3_600_000});`);
  rows.push(`INSERT INTO invites VALUES ('inv-1','${GROUP}','friend@example.com','hash-1','${me.id}',${now + 6 * 864e5},NULL,NULL,${now - 3_600_000});`);
  return { sql: rows.join("\n"), today };
}

async function waitForServer(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("dev server exited early");
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server did not start");
}

const work = mkdtempSync(join(tmpdir(), "stomp-shots-"));
const persist = join(work, "state");
let server;
try {
  const run = (args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });
  run(["d1", "migrations", "apply", "stomp-tally", "--local", "--persist-to", persist]);
  const now = Date.now();
  const seed = buildSeed(now);
  writeFileSync(join(work, "seed.sql"), seed.sql);
  run(["d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--file", join(work, "seed.sql")]);

  server = spawn("npx", ["vite", "dev", "--port", String(PORT), "--strictPort"], { env: { ...process.env, STOMP_PERSIST: persist, SETUP_KEY: "unused", APP_URL: BASE }, stdio: "pipe", detached: true });
  const serverLog = [];
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => serverLog.push(String(chunk)));
  await waitForServer(BASE, server);

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    // SHOTS_IOS=standalone fakes an iPhone home screen app (iOS user agent + navigator.standalone).
    // SHOTS_FAKE_INSET=59 additionally stands in for the notch-sized safe area that desktop browsers report as 0.
    const ios = process.env.SHOTS_IOS === "standalone";
    const context = await browser.newContext({
      ...(ios ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", hasTouch: true, isMobile: true } : {}), viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: "reduce", colorScheme: SCHEME, timezoneId: TZ, locale: "en-US" });
    await context.addCookies([{ name: "st_session", value: SESSION_ID, url: BASE }]);
    if (ios) await context.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    const page = await context.newPage();
    // Phone-sized frames keep the fixed bottom nav at the bottom, as on a real device.
    const pages = [["today", "/", 1180], ["month", "/month", 1000], ["ledger", "/history", 844], ["me", "/me", 1100], ["group", "/group", 1100]];
    const only = process.env.SHOTS_ONLY?.split(",");
    for (const [name, path, height] of pages.filter(([name]) => !only || only.includes(name))) {
      await page.setViewportSize({ width: 390, height });
      if (process.env.SHOTS_DEBUG) {
        page.on("console", (m) => ["error", "warning"].includes(m.type()) && console.log(`  [console.${m.type()}] ${m.text().slice(0, 260)}`));
        page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e.message).slice(0, 260)}`));
      }
      const response = await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      if (!response?.ok()) {
        await page.waitForTimeout(1500); // the dev server logs after it responds
        console.error((await response?.text())?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1200));
        console.error(serverLog.join("").slice(-3000));
        throw new Error(`${path} returned HTTP ${response?.status()}; refusing to save an error page`);
      }
      if (ios && process.env.SHOTS_FAKE_INSET) {
        // Desktop browsers report a 0 px safe area. Substitute a notch-sized value in the real rules to see the result.
        await page.addStyleTag({ content: `:root[data-ios-standalone] .page-top { padding-top: max(calc(${process.env.SHOTS_FAKE_INSET}px + 0.5rem), 1rem) !important; }
          :root[data-ios-standalone] body::before { height: ${process.env.SHOTS_FAKE_INSET}px !important; }` });
        await page.evaluate(() => window.scrollTo(0, 190)); // scroll content up under the status bar
      }
      await page.waitForTimeout(400);
      const probe = await page.evaluate(() => {
        const wrapper = document.querySelector(".page-top");
        const strip = getComputedStyle(document.body, "::before");
        return {
          theme: document.documentElement.dataset.theme,
          body: getComputedStyle(document.body).backgroundColor,
          at: location.pathname,
          iosStandalone: document.documentElement.hasAttribute("data-ios-standalone"),
          padTop: wrapper ? getComputedStyle(wrapper).paddingTop : null,
          stripHeight: strip.content === "none" ? null : strip.height,
          stripBlur: strip.content === "none" ? null : strip.backdropFilter,
        };
      });
      console.log(`  ${name}: ${response.status()} ${JSON.stringify({ ...probe, title: await page.title(), h1: (await page.locator('h1,h2').first().innerText().catch(() => '')).slice(0, 60) })}`);
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      console.log(`✓ screenshots/${name}.png`);
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server?.pid) {
    // npx starts Vite as a child; signal the whole group and wait, or it outlives this script.
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* exited cleanly */ }
    server.stdout.destroy();
    server.stderr.destroy();
  }
  rmSync(work, { recursive: true, force: true });
}
