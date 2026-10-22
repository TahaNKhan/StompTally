import { describe, expect, it } from "vitest";
import { cachedAgo, isServiceWorkerOrigin, writesAllowed, WRITE_BLOCKED_MESSAGE } from "./offline";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

describe("isServiceWorkerOrigin", () => {
  const at = (protocol: string, hostname: string) => isServiceWorkerOrigin({ protocol, hostname } as Location);
  it("allows https, and http only for the two local development hosts", () => {
    expect(at("https:", "steps.tahakhan.dev")).toBe(true);
    expect(at("http:", "localhost")).toBe(true);
    expect(at("http:", "127.0.0.1")).toBe(true);
  });
  it("refuses plain http on a real host, where a worker would not be allowed", () => {
    expect(at("http:", "steps.tahakhan.dev")).toBe(false);
  });
  it("refuses a host that merely ends in localhost", () => {
    // "notlocalhost" is a domain anyone could register; it must not pass a suffix check.
    expect(at("http:", "notlocalhost")).toBe(false);
  });
});

describe("writesAllowed", () => {
  it("allows a write only while the browser reports a connection", () => {
    expect(writesAllowed(true)).toBe(true);
    expect(writesAllowed(false)).toBe(false);
  });
  it("says plainly that the write is refused, not that it failed", () => {
    expect(WRITE_BLOCKED_MESSAGE).toMatch(/offline/i);
    expect(WRITE_BLOCKED_MESSAGE).toMatch(/save/);
  });
});

describe("cachedAgo", () => {
  const now = 1_700_000_000_000;
  it("has nothing to say before the first cached board", () => {
    expect(cachedAgo(null, now)).toBeNull();
  });
  it.each([
    [0, "just now"],
    [89_000, "just now"],
    [5 * 60_000, "5 min ago"],
    [59 * 60_000, "59 min ago"],
    [60 * 60_000, "1 hr ago"],
    [5 * 60 * 60_000, "5 hrs ago"],
    [23 * 60 * 60_000, "23 hrs ago"],
    [24 * 60 * 60_000, "1 day ago"],
    [3 * 24 * 60 * 60_000, "3 days ago"],
  ])("%i ms old reads %s", (age, label) => {
    expect(cachedAgo(now - age, now)).toBe(label);
  });
  it("never counts backwards when the clock is behind the stored time", () => {
    expect(cachedAgo(now + 60_000, now)).toBe("just now");
  });
});

describe("the service worker", () => {
  // The worker is plain JS in public/, so it is not type-checked or imported by the app. These
  // checks pin the rules that would otherwise fail silently, in the browser, only when offline.
  it("caches pages network-first so a signed-in board is never served from a stale cache", () => {
    expect(worker).toMatch(/async function handleDocument/);
    const doc = worker.slice(worker.indexOf("async function handleDocument"), worker.indexOf("async function handleRouteData"));
    expect(doc).toMatch(/await fetch\(request\)/);
    expect(doc).toMatch(/catch/);
  });
  it("clears the private page cache the moment a signed-out page is reached", () => {
    expect(worker).toMatch(/isSignedOutPage/);
    const doc = worker.slice(worker.indexOf("async function handleDocument"), worker.indexOf("async function handleRouteData"));
    expect(doc).toMatch(/caches\.delete\(PAGES\)/);
    // Signing out is a navigate; a POST logout would otherwise slip past.
    expect(worker).toMatch(/request\.method !== "GET"/);
    // The wipe happens only after a fetch that SUCCEEDED. Wiping first empties the cache and then
    // fails to refill it offline, so a phone with no signal loses even the sign-in screen.
    const wipe = doc.indexOf("caches.delete(PAGES)");
    expect(wipe).toBeGreaterThan(doc.indexOf("await fetch(request)"));
    expect(wipe).toBeLessThan(doc.indexOf("await put(PAGES"));
  });
  it("never stores a redirect, which would outlive the session it came from", () => {
    expect(worker).toMatch(/!response\.redirected/);
  });
  it("answers a missed navigation with an empty 200 so the router keeps the board on screen", () => {
    const data = worker.slice(worker.indexOf("async function handleRouteData"), worker.indexOf("async function cacheFirst"));
    expect(data).toMatch(/new Response\("\[\]", \{ status: 200/);
  });
  it("only intercepts its own origin and the font hosts", () => {
    expect(worker).toMatch(/url\.origin !== self\.location\.origin/);
    expect(worker).toMatch(/fonts\.googleapis\.com/);
  });
  it("re-wraps a no-store response before caching it, or the Cache API rejects it", () => {
    // Every page the worker sees carries `Cache-Control: private, no-store` from workers/app.ts.
    // cache.put() refuses those outright, so without this rewrite nothing is ever cached and the
    // app is offline-broken in a way no unit test would otherwise catch.
    expect(worker).toMatch(/function storable/);
    expect(worker).toMatch(/headers\.set\("Cache-Control"/);
    // Responses are not stored raw anywhere: put() is the only writer.
    expect(worker).not.toMatch(/cache\.put\(request, response\)/);
  });
  it("treats hashed build output as immutable and everything else as revalidating", () => {
    expect(worker).toMatch(/pathname\.startsWith\("\/assets\/"\)/);
    expect(worker).toMatch(/async function cacheFirst/);
    expect(worker).toMatch(/async function staleWhileRevalidate/);
  });
});
