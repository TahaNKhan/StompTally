import { useEffect, useRef, useState } from "react";
import { countdownLabel, msUntilLabelChanges } from "../lib/countdown";

/**
 * Live "N hrs / mins / secs" until `target`. The server renders the first label; after that the
 * browser sleeps until the text would change, so it redraws once an hour, then once a minute,
 * and only ticks every second in the final minute. `onDone` fires once when the target passes.
 *
 * `onDone` is held in a ref, not in the effect's dependencies: callers pass inline arrows, and a
 * dependency on one would restart the timer on every render -- and since a restart re-reads the
 * clock and sets state, that would loop.
 */
export function Countdown({ target, serverNow, onDone }: { target: number; serverNow: number; onDone?: () => void }) {
  // Seed from the server's clock so hydration matches; switch to the device clock after mount.
  const [now, setNow] = useState(serverNow);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const wait = msUntilLabelChanges(target, current);
      if (wait === Infinity) {
        // Once per target, however many times the effect is torn down and rebuilt.
        if (!finished) { finished = true; done.current?.(); }
        return;
      }
      timer = setTimeout(tick, wait);
    };
    tick();
    // A phone that sleeps pauses timers; catch up as soon as the page is visible again.
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [target]);
  const label = countdownLabel(target, now);
  return <time dateTime={new Date(target).toISOString()} suppressHydrationWarning>{label ?? "now"}</time>;
}
