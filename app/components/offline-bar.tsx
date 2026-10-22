import { useEffect, useState } from "react";
import { cachedAgo } from "../lib/offline";

/** Asks the service worker when it last stored a page, so the bar can date the board on screen. */
async function lastCachedAt(): Promise<number | null> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    // A worker that never answers must not hang the banner; the timestamp is a nicety.
    const giveUp = setTimeout(() => resolve(null), 1000);
    channel.port1.onmessage = (event) => { clearTimeout(giveUp); resolve(event.data?.at ?? null); };
    worker.postMessage({ type: "cached-at" }, [channel.port2]);
  });
}

/** True while the browser reports no connection. `navigator.onLine` is a hint, not a guarantee. */
export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  return online;
}

/**
 * The strip above the board when the phone has no signal. It says the board may be old and that
 * nothing can be saved yet, which are the two things a person actually needs to know.
 */
export function OfflineBar() {
  const online = useOnline();
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    if (online) { setAt(null); return; }
    let active = true;
    lastCachedAt().then((value) => { if (active) setAt(value); });
    return () => { active = false; };
  }, [online]);

  if (online) return null;
  const ago = cachedAgo(at, Date.now());
  return (
    <div role="status" className="rise rounded-xl border border-amber/30 bg-amber/10 px-4 py-2.5 text-xs text-amber">
      <span className="font-semibold">Offline.</span>{" "}
      {ago ? <>Showing the board saved {ago}. Steps can't be saved until you're back on a signal.</> : <>Steps can't be saved until you're back on a signal.</>}
    </div>
  );
}
