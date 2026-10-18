import { useEffect, useState } from "react";
import { INSTALL_BANNER_DISMISSED_KEY, shouldShowInstallBanner } from "../lib/install-banner";

/** Decided after mount so server and client markup match. Storage can be blocked, so reads fail soft. */
function readDismissed() {
  try {
    return localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function InstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(
      shouldShowInstallBanner({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches,
        dismissed: readDismissed(),
      }),
    );
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, "1");
    } catch {
      // Private mode: the banner just returns next visit.
    }
    setVisible(false);
  }

  return (
    <div role="note" className="card mt-2 flex items-center gap-3 p-3 text-sm">
      <span aria-hidden="true" className="text-xl">📲</span>
      <p className="min-w-0 flex-1">
        Add Stomp Tally to your home screen: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </p>
      <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={dismiss}>Got it</button>
    </div>
  );
}
