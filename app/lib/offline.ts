// Client-only offline helpers: register the service worker, and expose connection state to the UI.
// Nothing here runs on the server; the service worker itself lives in public/sw.js.

export const SERVICE_WORKER_URL = "/sw.js";

/**
 * A browser only lets a service worker control a page over https, or on localhost for development.
 * One exception, and it must be an exact match: "notlocalhost" is a real domain someone could own.
 */
export function isServiceWorkerOrigin(location: Location) {
  return location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

/** Whether this browser can register a worker here at all. */
export function canRegisterServiceWorker(location: Location) {
  return "serviceWorker" in navigator && isServiceWorkerOrigin(location);
}

/**
 * Register after hydration, never during: the install fetches a handful of files, and competing
 * with the first paint for bandwidth is exactly what makes a slow phone feel slow.
 * Failures are swallowed on purpose -- offline support is a bonus, not a requirement to use the app.
 */
export function registerServiceWorker() {
  if (!canRegisterServiceWorker(window.location)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch(() => {
      // A blocked or unfetchable worker just means no offline mode. Nothing for the user to fix.
    });
  });
}

/**
 * A write needs the server. React Router would queue a form submit and fail later, leaving the
 * person unsure whether their steps were saved; refusing up front and saying so is kinder and true.
 */
export function writesAllowed(online: boolean) {
  return online;
}

export const WRITE_BLOCKED_MESSAGE = "You're offline. Your steps will save when you're back on a signal.";

/** "3 hours ago" from a timestamp, or null when we have never cached a board. */
export function cachedAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
