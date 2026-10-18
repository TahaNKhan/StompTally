// Regenerates the README screenshots from invented data on a throwaway local database.
// Never touches production: it seeds a temp D1 under os.tmpdir() and logs in with a seeded session.
//   node scripts/screenshots.mjs        (needs Chromium; set CHROMIUM to override /usr/bin/chromium)
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const TZ = "America/Los_Angeles";
const SESSION_ID = "screenshot-session";
const OUT = new URL("../screenshots/", import.meta.url).pathname;

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
  // Yesterday is still open until noon in the group's timezone, so leave it unfinalized and live.
  rows.push(`DELETE FROM penalties WHERE date='${yesterday}'; DELETE FROM day_results WHERE date='${yesterday}';`);
  const todaySteps = [8120, 6340, 7210, 9040, 3980];
  people.forEach((p, i) => insert("step_entries", [p.id, today, todaySteps[i] + (i === 1 ? 0.5 : 0), "stompers", now - 20 * 60_000, todaySteps[i] - 300, todaySteps[i] + (i === 1 ? 0.5 : 0), `fake-game-${today}`, now - 20 * 60_000]));
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

  server = spawn("npx", ["vite", "dev", "--port", String(PORT), "--strictPort"], { env: { ...process.env, STOMP_PERSIST: persist, SETUP_KEY: "unused", APP_URL: BASE }, stdio: "pipe" });
  const serverLog = [];
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => serverLog.push(String(chunk)));
  await waitForServer(BASE, server);

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: "reduce", timezoneId: TZ, locale: "en-US" });
    await context.addCookies([{ name: "st_session", value: SESSION_ID, url: BASE }]);
    const page = await context.newPage();
    // Phone-sized frames keep the fixed bottom nav at the bottom, as on a real device.
    const pages = [["today", "/", 1180], ["month", "/month", 1000], ["ledger", "/history", 844], ["me", "/me", 1100], ["group", "/group", 1100]];
    for (const [name, path, height] of pages) {
      await page.setViewportSize({ width: 390, height });
      const response = await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      if (!response?.ok()) {
        console.error(serverLog.join("").slice(-3000));
        throw new Error(`${path} returned HTTP ${response?.status()}; refusing to save an error page`);
      }
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      console.log(`✓ screenshots/${name}.png`);
    }
  } finally {
    await browser.close();
  }
} finally {
  server?.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
}
