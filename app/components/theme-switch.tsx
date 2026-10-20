import { useEffect, useState } from "react";
import { parseThemeChoice, resolveTheme, THEME_CHOICES, THEME_COLOR, THEME_STORAGE_KEY, type ThemeChoice } from "../lib/theme";

const LABELS: Record<ThemeChoice, string> = { auto: "Auto", light: "Light", dark: "Dark" };

function readChoice(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function applyTheme(choice: ThemeChoice) {
  const theme = resolveTheme(choice, matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** Stored per device. Rendered after mount so server and client markup match. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => setChoice(readChoice()), []);

  useEffect(() => {
    if (choice !== "auto") return;
    const query = matchMedia("(prefers-color-scheme: light)");
    const follow = () => applyTheme("auto");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [choice]);

  function choose(next: ThemeChoice) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (private mode): the choice still applies until the page closes.
    }
    setChoice(next);
    applyTheme(next);
  }

  return (
    <section className="card p-5 rise">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">Appearance</h2>
          <p className="mt-1 text-sm text-muted">Auto follows your phone. Saved on this device.</p>
        </div>
        <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border border-line p-0.5 text-xs">
          {THEME_CHOICES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={choice === value}
              onClick={() => choose(value)}
              className={`rounded-md px-2.5 py-1 font-medium transition ${choice === value ? "bg-fg/10 text-strong" : "text-muted"}`}
            >
              {LABELS[value]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
