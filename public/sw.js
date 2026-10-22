// Stomp Tally service worker: keeps the app readable with no signal.
//
// Three caches, split by how long an entry stays valid:
//   shell  -- the manifest and icons. Same bytes for everyone, refreshed on a version bump.
//   assets -- build output whose names carry a content hash, so a hit is always current.
//   pages  -- server-rendered boards and their `.data` payloads. These are PRIVATE: they hold
//             names, step counts and money for whoever was signed in when they were fetched.
//
// The private cache is dropped whenever the browser lands on a signed-out page, so signing out on
// a shared phone does not leave the previous person's board readable offline.
//
// Every page arrives with `Cache-Control: private, no-store`, and the Cache API refuses to store a
// response carrying `no-store`. So each page is re-wrapped with a storable header before it goes in
// -- the app's header governs the browser's own HTTP cache, which is a separate thing, and this
// worker is the only thing that reads this cache back.

const VERSION = "v1";
const SHELL = `stomp-shell-${VERSION}`;
const ASSETS = `stomp-assets-${VERSION}`;
const PAGES = `stomp-pages-${VERSION}`;
const LAST_PAGE_KEY = "/__stomp/last-page-at";

// Pages that only render when nobody is signed in. Hitting one means the old session is gone.
const SIGNED_OUT = [/^\/login/, /^\/setup/, /^\/auth\//, /^\/invite\//];
const SHELL_FILES = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

/** A build-output URL: `/assets/name-Ab12Cd.js`. The hash is what makes it safe to cache forever. */
const isHashedAsset = (pathname) => pathname.startsWith("/assets/");
/** React Router asks for `<route>.data` on every client-side navigation. */
const isRouteData = (pathname) => pathname.endsWith(".data");
const isSignedOutPage = (pathname) => SIGNED_OUT.some((re) => re.test(pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Individually, so one missing file cannot fail the whole install.
      await Promise.all(SHELL_FILES.map((file) => cache.add(file).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS, PAGES]);
      await Promise.all((await caches.keys()).filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "cached-at") return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGES);
      const hit = await cache.match(LAST_PAGE_KEY);
      event.ports[0]?.postMessage({ at: hit ? Number(await hit.text()) : null });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Fonts come from Google; everything else must be ours, or this would proxy the whole web.
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!isFont && url.origin !== self.location.origin) return;

  if (request.mode === "navigate") event.respondWith(handleDocument(request, url));
  else if (isRouteData(url.pathname)) event.respondWith(handleRouteData(request));
  else if (isHashedAsset(url.pathname) || isFont) event.respondWith(cacheFirst(request, ASSETS));
  else event.respondWith(staleWhileRevalidate(request, ASSETS));
});

/**
 * A page. Fresh copy when the network answers, the cached copy when it does not. Redirects are
 * never stored: a logged-out bounce to /login cached under "/" would outlive the session.
 */
async function handleDocument(request, url) {
  try {
    const response = await fetch(request);
    // A signed-out page reached over the network means the old session is gone, so the private
    // cache goes with it. This runs only AFTER a successful fetch: wiping first would empty the
    // cache and then fail to refill it, which is exactly how a phone with no signal loses /login.
    // A redirect is never stored under its own URL -- that would pin the next visit to the target.
    if (isSignedOutPage(url.pathname)) await caches.delete(PAGES);
    if (response.ok && !response.redirected) await put(PAGES, request, response.clone(), true);
    return response;
  } catch {
    const cached = await caches.open(PAGES).then((cache) => cache.match(request, { ignoreSearch: true }));
    return cached ?? offlinePage();
  }
}

/** A client-side navigation's data. Same rule as a document: network first, cache as the fallback. */
async function handleRouteData(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await put(PAGES, request, response.clone(), true);
    return response;
  } catch {
    const cached = await caches.open(PAGES).then((cache) => cache.match(request, { ignoreSearch: true }));
    // A missed navigation must not blow up the page: an empty 200 lets the router keep the board
    // it already rendered instead of showing an error boundary.
    return cached ?? new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

/** Build output and fonts: the filename already proves freshness, so never wait for the network. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Opaque font responses have status 0 and cannot be inspected; they are still worth keeping.
  if (response.ok || response.type === "opaque") await put(cacheName, request, response.clone());
  return response;
}

/** Icons and avatars: show what we have, refresh it in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok || response.type === "opaque") await put(cacheName, request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  // Nothing cached and no network. A 504 so the page's own <img>/error handling runs, rather than a
  // rejected promise, which surfaces as an uncaught fetch error in the console.
  return (await network) ?? new Response("", { status: 504, statusText: "Offline" });
}

/**
 * Store a response, and for pages record when, so the app can say how old the board is.
 * `storable` rewrites the Cache-Control header: the Cache API rejects any response marked
 * `no-store`, which is what every page and data payload here carries.
 */
async function put(cacheName, request, response, isPage = false) {
  const cache = await caches.open(cacheName);
  // Opaque responses -- cross-origin fonts, whose headers this code cannot read -- have status 0 and
  // cannot be rebuilt. They also cannot carry `no-store`, so they are stored exactly as they arrived.
  await cache.put(request, response.type === "opaque" ? response : storable(response, isPage));
  if (isPage) await cache.put(LAST_PAGE_KEY, new Response(String(Date.now())));
}

/** A copy safe to store: same body and type, an explicit max-age, and never a `no-store`. */
function storable(response, isPage) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `private, max-age=${isPage ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 365}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Shown for a page the person never opened while online. Self-contained, and themed by the
 * system preference because a service worker cannot read the app's stored theme choice.
 */
function offlinePage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Offline · Stomp Tally</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1.5rem;
    background:#09090c;color:#ececf1;font:16px/1.5 system-ui,-apple-system,sans-serif}
  main{max-width:22rem;text-align:center;border:1px solid #23232d;background:#121218;border-radius:1rem;padding:2rem}
  h1{margin:.75rem 0 0;font-size:1.35rem}
  p{margin:.5rem 0 0;color:#8b8b98;font-size:.9rem}
  a{display:inline-block;margin-top:1.5rem;padding:.65rem 1.25rem;border-radius:.6rem;
    background:#b6f35c;color:#09090c;font-weight:600;text-decoration:none}
  @media (prefers-color-scheme:light){
    body{background:#f6f6f1;color:#1c1c22}
    main{background:#fff;border-color:#dedfd4}
    p{color:#6b6b78}
  }
</style></head><body><main>
<div style="font-size:2rem">📵</div>
<h1>You're offline</h1>
<p>This page was not opened while you had a signal. Pages you have already visited still work.</p>
<a href="/">Back to today</a>
</main></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
