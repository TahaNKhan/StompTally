export const THEME_STORAGE_KEY = "theme";

export type ThemeChoice = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = ["auto", "light", "dark"];

/** Unknown or missing stored values fall back to following the system. */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return THEME_CHOICES.find((choice) => choice === value) ?? "auto";
}

export function resolveTheme(choice: ThemeChoice, systemPrefersLight: boolean): ResolvedTheme {
  if (choice === "auto") return systemPrefersLight ? "light" : "dark";
  return choice;
}

export const THEME_COLOR: Record<ResolvedTheme, string> = { dark: "#09090c", light: "#f6f6f1" };

/**
 * Runs inline in <head> before first paint, so a light-mode user never sees a dark flash.
 * Must stay self-contained: it is serialized into the page and cannot import anything.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(c!=="light"&&c!=="dark")c="auto";var l=c==="light"||(c==="auto"&&matchMedia("(prefers-color-scheme: light)").matches);var t=l?"light":"dark";document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",l?${JSON.stringify(THEME_COLOR.light)}:${JSON.stringify(THEME_COLOR.dark)})}catch(e){}})();`;
