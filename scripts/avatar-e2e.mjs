// End-to-end check of the one-photo-per-person flow in a real browser against a throwaway local D1.
//   node scripts/avatar-e2e.mjs <photo-one> <photo-two>
// Seeds a throwaway database, never production.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [photoOne, photoTwo] = process.argv.slice(2);
assert(photoOne && photoTwo, "usage: node scripts/avatar-e2e.mjs <photo-one> <photo-two>");

const port = await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const BASE = `http://localhost:${port}`;
const work = mkdtempSync(join(tmpdir(), "stomp-av-"));
const persist = join(work, "state");
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: "pipe", encoding: "utf8" });
const sql = (query) => JSON.parse(wrangler("d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--command", query, "--json"))[0].results;

let server;
try {
  wrangler("d1", "migrations", "apply", "stomp-tally", "--local", "--persist-to", persist);
  const now = Date.now(), hash = createHash("sha256").update("e2e-session").digest("hex");
  writeFileSync(join(work, "seed.sql"), `
    INSERT INTO users VALUES ('u1','ann@example.com','Ann Lee',${now}),('u2','ben@example.com','Ben Ray',${now}),('u3','cy@example.com','Cy Fox',${now});
    INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES ('g1','Crew','UTC','2026-10-01',${now}),('g2','Other','UTC','2026-10-01',${now});
    INSERT INTO memberships VALUES ('g1','u1','admin','2026-10-01',NULL),('g1','u2','member','2026-10-01',NULL),('g2','u3','admin','2026-10-01',NULL);
    INSERT INTO sessions VALUES ('${hash}','u1',${now + 864e5});
    INSERT INTO sessions VALUES ('${createHash("sha256").update("e2e-ben").digest("hex")}','u2',${now + 864e5});
    INSERT INTO sessions VALUES ('${createHash("sha256").update("e2e-cy").digest("hex")}','u3',${now + 864e5});`);
  wrangler("d1", "execute", "stomp-tally", "--local", "--persist-to", persist, "--file", join(work, "seed.sql"));

  server = spawn("npx", ["vite", "dev", "--port", String(port), "--strictPort"], { env: { ...process.env, STOMP_PERSIST: persist, SETUP_KEY: "x", APP_URL: BASE }, stdio: "pipe", detached: true });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

  const rows = () => sql("SELECT user_id, content_type, byte_size, updated_at, hex(substr(image,1,3)) AS magic FROM user_avatars");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.addCookies([{ name: "st_session", value: "e2e-session", url: BASE }]);
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/me`, { waitUntil: "load" });
    const pass = (m) => console.log(`✓ ${m}`);

    assert.equal(rows().length, 0); pass("starts with no photo");

    // 1. Upload a 1 MB, 4000x3000 photo
    await page.setInputFiles('input[type=file]', photoOne);
    await page.getByText("Photo saved.").waitFor({ timeout: 15000 });
    let r = rows(); assert.equal(r.length, 1);
    assert.equal(r[0].content_type, "image/jpeg"); assert.equal(r[0].magic, "FFD8FF");
    assert(r[0].byte_size < 65536, `stored ${r[0].byte_size} bytes`);
    pass(`upload: 1 row, ${r[0].byte_size} bytes stored (from ~1000 KB), real JPEG bytes`);
    const firstStamp = r[0].updated_at;

    // 2. The image is served, and only to the owner's group
    const served = await context.request.get(`${BASE}/avatar/u1`);
    assert.equal(served.status(), 200); assert.equal(served.headers()["content-type"], "image/jpeg");
    assert.equal(served.headers()["x-content-type-options"], "nosniff");
    assert.equal((await served.body()).length, r[0].byte_size);
    pass("served as image/jpeg, nosniff, same bytes as stored");
    const ben = await (await browser.newContext()).request.get(`${BASE}/avatar/u1`, { headers: { cookie: "st_session=e2e-ben" } });
    assert.equal(ben.status(), 200); pass("a group member can see it");
    const cy = await (await browser.newContext()).request.get(`${BASE}/avatar/u1`, { headers: { cookie: "st_session=e2e-cy" }, maxRedirects: 0 });
    assert.equal(cy.status(), 404); pass("someone in another group gets 404");
    const anon = await (await browser.newContext()).request.get(`${BASE}/avatar/u1`, { maxRedirects: 0 });
    assert.notEqual(anon.status(), 200); pass(`a logged-out visitor gets ${anon.status()}, not the photo`);

    // 3. The page really shows it
    await page.waitForFunction(() => [...document.images].some((i) => i.src.includes("/avatar/u1") && i.naturalWidth > 0));
    pass("the <img> loads on the page");

    // 4. Replace with a second photo: still exactly one row
    await new Promise((r) => setTimeout(r, 20));
    await page.setInputFiles('input[type=file]', photoTwo);
    await page.waitForFunction((s) => document.body.innerText.includes("Photo saved.") , null, { timeout: 15000 });
    await page.waitForFunction(async (s) => (await (await fetch("/me")).text()).includes(`v=`) , null, { timeout: 15000 });
    r = rows(); assert.equal(r.length, 1, "replace must not add a second row");
    assert(r[0].updated_at > firstStamp, "replacement is newer");
    pass("replace: still exactly 1 row, newer version");

    // 5. Delete: really gone
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByText("Photo deleted.").waitFor({ timeout: 15000 });
    assert.equal(rows().length, 0); pass("delete: 0 rows left in D1");
    assert.equal((await context.request.get(`${BASE}/avatar/u1`)).status(), 404); pass("deleted photo returns 404");
    assert.equal(await page.getByRole("button", { name: "Delete" }).count(), 0); pass("Delete button is gone once there is no photo");

    // 6. Upload again after deleting
    await page.setInputFiles('input[type=file]', photoTwo);
    await page.getByText("Photo saved.").waitFor({ timeout: 15000 });
    assert.equal(rows().length, 1); pass("upload after delete: exactly 1 row");

    // 7. Bad files are refused and the photo stays
    const before = rows()[0].updated_at;
    const bad = await context.request.post(`${BASE}/me`, { multipart: { intent: "avatar-upload", photo: { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html>not an image</html>") } } });
    assert.equal(rows().length, 1); assert.equal(rows()[0].updated_at, before);
    pass(`a non-image upload (HTTP ${bad.status()}) leaves the existing photo untouched`);

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
