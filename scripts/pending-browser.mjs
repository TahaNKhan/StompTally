// Real Chromium regression checks. Run against a local, bootstrapped smoke-test database.
// LOG points to the dev mail log; no real mail is sent. Network gates delay real requests,
// never invent server responses. The test uses local taha@example.com, not a production account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.BASE || "http://localhost:5173";
const log = process.env.LOG;
assert(log, "Set LOG to the dev server mail log");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let gate = null;
  await page.route(`${base}/**`, async (route) => {
    const request = route.request();
    if (gate && gate.match(request)) {
      const current = gate;
      current.count++;
      current.seen();
      await current.release;
    }
    await route.continue();
  });
  const block = (match) => {
    let seen, unlock;
    const arrived = new Promise((r) => { seen = r; });
    const release = new Promise((r) => { unlock = r; });
    const g = { match, count: 0, arrived, release, seen, unlock };
    gate = g;
    return g;
  };
  const show = async (text) => {
    await page.getByTestId("pending-screen").waitFor({ timeout: 3000 });
    assert.match(await page.getByRole("status").innerText(), text);
    assert.equal(await page.getByTestId("page-content").evaluate((el) => el.inert), true);
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
  };
  const clear = async () => {
    await page.getByTestId("pending-screen").waitFor({ state: "detached", timeout: 15000 });
    assert.equal(await page.getByTestId("page-content").evaluate((el) => el.inert), false);
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden");
  };
  const finish = (g) => { if (gate === g) gate = null; g.unlock(); };
  const pass = (m) => console.log(`✓ ${m}`);

  // HTML validation must not start a loader for a request that never submits.
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Email me a login link" }).click();
  assert.equal(await page.getByTestId("pending-screen").count(), 0);
  pass("Invalid form stays idle (no stuck loading screen)");

  // Invalid token: real POST -> /login?expired=1. Loading UI clears after the failure redirect.
  await page.goto(`${base}/auth/not-a-real-token`, { waitUntil: "networkidle" });
  let g = block((r) => new URL(r.url()).pathname.startsWith("/auth/") && r.method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await g.arrived;
  await show(/Logging you in/);
  assert.equal(await page.locator('button[aria-busy="true"]').isDisabled(), true);
  await page.locator('button[aria-busy="true"]').evaluate((el) => el.click());
  assert.equal(g.count, 1);
  finish(g);
  await page.waitForURL(/\/login\?expired=1/);
  await clear();
  pass("Continue responds immediately, blocks duplicate taps, and recovers on an invalid link");

  // Generate a fresh dev login link. Never print it.
  const response = await context.request.post(`${base}/login`, { form: { email: "taha@example.com" } });
  assert.equal(response.status(), 200);
  const matches = [...readFileSync(log, "utf8").matchAll(/\[mail:dev\] to=taha@example\.com[^\n]*\n[^\n]*(http:\/\/[^\s]+\/auth\/[^\s]+)/g)];
  assert(matches.length > 0, "No dev login link found");
  await page.goto(matches.at(-1)[1], { waitUntil: "networkidle" });
  g = block((r) => new URL(r.url()).pathname.startsWith("/auth/") && r.method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await g.arrived;
  await show(/Logging you in/);
  await page.screenshot({ path: process.env.SCREENSHOT || `${process.env.TMPDIR}/stomp-login-loading.png` });
  const redirectGate = block((r) => new URL(r.url()).pathname === "/_.data" && r.method() === "GET");
  g.unlock(); // keep the next-page request held independently
  await redirectGate.arrived;
  await show(/Logging you in|Loading your page/);
  finish(redirectGate);
  await page.waitForURL(`${base}/`);
  await page.getByRole("heading", { name: "Log your steps" }).waitFor();
  await clear();
  pass("Real login shows loading through POST and dashboard redirect, then clears");

  // Page navigation is a real GET, held pending.
  g = block((r) => new URL(r.url()).pathname === "/month.data");
  await page.locator('nav a[href="/month"]').click();
  await g.arrived;
  await show(/Loading your page/);
  finish(g);
  await page.waitForURL(`${base}/month`);
  await clear();
  pass("Tab navigation shows a loading screen and clears on arrival");

  await page.locator('nav a[href="/"]').click();
  await page.waitForURL(`${base}/`);
  await clear();
  let form = page.locator("form").filter({ has: page.locator('input[name="steps"]') });
  await form.locator('input[name="steps"]').fill("14001");
  g = block((r) => r.method() === "POST" && new URL(r.url()).pathname === "/_.data");
  await form.getByRole("button").click();
  await g.arrived;
  await show(/Saving your steps/);
  assert.equal(await form.getByRole("button").isDisabled(), true);
  finish(g);
  await clear();
  await page.getByText("Currently", { exact: false }).filter({ hasText: "14,001" }).waitFor();
  pass("Step save shows loading, preserves form submission, and updates the actual board");

  // Server validation error: bypass browser validation, still send to the real action.
  form = page.locator("form").filter({ has: page.locator('input[name="steps"]') });
  await form.evaluate((el) => { el.noValidate = true; });
  await form.locator('input[name="steps"]').fill("-1");
  g = block((r) => r.method() === "POST" && new URL(r.url()).pathname === "/_.data");
  await form.getByRole("button").click();
  await g.arrived;
  await show(/Saving your steps/);
  finish(g);
  await clear();
  await page.getByText(/Steps must be a whole number/).waitFor();
  assert.equal(await form.locator('input[name="steps"]').inputValue(), "-1");
  pass("Server error clears the loading screen and preserves the input for correction");

  // Background revalidation is silent: exercise the real 60-second interval using the browser clock.
  await page.clock.install();
  await page.reload({ waitUntil: "networkidle" });
  g = block((r) => r.method() === "GET" && new URL(r.url()).pathname === "/_.data");
  await page.clock.runFor(60001);
  await g.arrived;
  assert.equal(await page.getByTestId("pending-screen").count(), 0);
  assert.equal(await page.getByTestId("page-content").evaluate((el) => el.inert), false);
  finish(g);
  await page.clock.resume();
  pass("Automatic background refresh stays silent and interactive");

  await page.locator('nav a[href="/me"]').click();
  await page.waitForURL(`${base}/me`);
  await clear();
  g = block((r) => r.method() === "POST" && new URL(r.url()).pathname === "/logout.data");
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await g.arrived;
  await show(/Logging out/);
  finish(g);
  await page.waitForURL(`${base}/login`);
  await clear();
  pass("Logout shows feedback, then clears after returning to login");
  assert.deepEqual(errors, [], "JavaScript errors");
  console.log("Pending UI browser checks passed. No JavaScript errors.");
} finally { await browser.close(); }
