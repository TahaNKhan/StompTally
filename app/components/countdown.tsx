import { useEffect, useState } from "react";
import { countdownLabel, msUntilLabelChanges } from "../lib/countdown";

/**
 * Live "N hrs / mins / secs" until `target`. The server renders the first label; after that the
 * browser sleeps until the text would change, so it redraws once an hour, then once a minute,
 * and only ticks every second in the final minute. `onDone` fires once when the target passes.
 */
export function Countdown({ target, serverNow, onDone }: { target: number; serverNow: number; onDone?: () => void }) {
  // Seed from the server's clock so hydration matches; switch to the device clock after mount.
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const wait = msUntilLabelChanges(target, current);
      if (wait === Infinity) { onDone?.(); return; }
      timer = setTimeout(tick, wait);
    };
    tick();
    // A phone that sleeps pauses timers; catch up as soon as the page is visible again.
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [target, onDone]);

  const label = countdownLabel(target, now);
  return <time dateTime={new Date(target).toISOString()} suppressHydrationWarning>{label ?? "now"}</time>;
}
