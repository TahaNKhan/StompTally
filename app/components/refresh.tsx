import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { cachedAgo } from "../lib/offline";
import { isStale, readLastRefresh, REFRESH_INTERVAL_MS, writeLastRefresh } from "../lib/refresh";
import { useOnline } from "./offline-bar";

/**
 * Keeps the page's data from going stale, and reports when it was last fetched.
 *
 * An interval alone is not enough for an installed app. iOS freezes a backgrounded PWA's timers,
 * so a phone left overnight comes back showing yesterday's board with no timer due to fire. Being
 * reopened is the signal that can be trusted, so a wake, a back/forward cache restore and regaining
 * signal all funnel into the same stale check the interval uses.
 */
export function useAutoRefresh() {
  const { revalidate, state } = useRevalidator();
  const online = useOnline();
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  // The listeners below are registered once, so they read the current time through a ref.
  const latest = useRef<number | null>(null);
  const inFlight = useRef(false);

  const markRefreshed = useCallback((at: number) => {
    latest.current = at;
    setLastRefresh(at);
    writeLastRefresh(window.localStorage, at);
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await revalidate();
    } catch {
      // A background refresh that fails leaves the current board on screen rather than throwing the
      // page into an error boundary. The next tick tries again; the offline strip explains why.
    } finally {
      inFlight.current = false;
    }
  }, [revalidate]);

  // The server rendered this page a moment ago, so its data is fresh -- unless the browser is
  // offline, where the page actually came from the service worker's cache and is not new data.
  useEffect(() => {
    if (navigator.onLine) markRefreshed(Date.now());
    else latest.current = readLastRefresh(window.localStorage);
  }, [markRefreshed]);

  // The timestamp follows the router, not this hook. Watching the router's own state means every
  // completed fetch counts -- including one another component started, like the post-lock reload.
  const wasLoading = useRef(false);
  useEffect(() => {
    if (state === "loading") wasLoading.current = true;
    else if (wasLoading.current) { wasLoading.current = false; markRefreshed(Date.now()); }
  }, [state, markRefreshed]);

  const refreshIfStale = useCallback(() => {
    if (isStale(latest.current, Date.now())) void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshIfStale();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshIfStale]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    // visibilitychange covers a phone waking or a tab switching. pageshow covers a back/forward
    // cache restore, which resumes the page without ever firing visibilitychange. online covers
    // signal coming back, where the board on screen is from before the gap.
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("pageshow", onReturn);
    window.addEventListener("online", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("pageshow", onReturn);
      window.removeEventListener("online", onReturn);
    };
  }, [refreshIfStale]);

  return { lastRefresh, refreshing: state === "loading", refresh, online };
}

/**
 * "Updated 5 min ago", tappable to refresh now. Hidden offline, where the strip above already says
 * the board is old and why nothing can be saved.
 */
export function FreshnessLine() {
  const { lastRefresh, refreshing, refresh, online } = useAutoRefresh();
  // The label is only as precise as whole minutes, so it needs recomputing no more often than that.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!online || lastRefresh === null) return null;
  const ago = cachedAgo(lastRefresh, Date.now()) ?? "just now";
  const stale = isStale(lastRefresh, Date.now());
  return (
    <div className="flex justify-end">
      <button
        type="button"
        title="Refresh now"
        onClick={() => void refresh()}
        disabled={refreshing}
        className={`rounded-lg px-1 text-xs transition hover:text-soft disabled:opacity-60 ${stale ? "text-amber" : "text-muted"}`}
      >
        {refreshing ? "Refreshing…" : `Updated ${ago} ↻`}
      </button>
    </div>
  );
}
