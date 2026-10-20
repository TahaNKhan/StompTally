import { describe, expect, it } from "vitest";
import { parseThemeChoice, resolveTheme, THEME_BOOT_SCRIPT } from "./theme";

describe("theme choice", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["auto", "auto"],
    [null, "auto"],
    [undefined, "auto"],
    ["", "auto"],
    ["solarized", "auto"],
    [42, "auto"],
  ])("parses %j as %s", (stored, expected) => {
    expect(parseThemeChoice(stored)).toBe(expected);
  });

  it("follows the system only in auto", () => {
    expect(resolveTheme("auto", true)).toBe("light");
    expect(resolveTheme("auto", false)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
});

describe("boot script", () => {
  function run(stored: string | null, systemLight: boolean) {
    const meta = { content: "", setAttribute(_: string, v: string) { this.content = v; } };
    const doc = { documentElement: { dataset: {} as Record<string, string> }, querySelector: () => meta };
    new Function("localStorage", "matchMedia", "document", THEME_BOOT_SCRIPT)(
      { getItem: () => stored },
      () => ({ matches: systemLight }),
      doc,
    );
    return { theme: doc.documentElement.dataset.theme, color: meta.content };
  }

  it("applies the saved choice before paint", () => {
    expect(run("light", false)).toEqual({ theme: "light", color: "#f6f6f1" });
    expect(run("dark", true)).toEqual({ theme: "dark", color: "#09090c" });
  });
  it("follows the system when nothing is saved or the value is junk", () => {
    expect(run(null, true).theme).toBe("light");
    expect(run("junk", false).theme).toBe("dark");
  });
  it("never throws when storage is blocked", () => {
    const doc = { documentElement: { dataset: {} }, querySelector: () => null };
    const blocked = { getItem: () => { throw new Error("denied"); } };
    expect(() => new Function("localStorage", "matchMedia", "document", THEME_BOOT_SCRIPT)(blocked, () => ({ matches: false }), doc)).not.toThrow();
  });
});
