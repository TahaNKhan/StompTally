import { describe, expect, it } from "vitest";
import { IOS_STANDALONE_ATTRIBUTE, IOS_STANDALONE_BOOT_SCRIPT, isIosStandalone } from "./ios-standalone";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

const cases = [
  { name: "iPhone home screen app", userAgent: IPHONE, maxTouchPoints: 5, standalone: true, expected: true },
  { name: "iPhone in a Safari tab", userAgent: IPHONE, maxTouchPoints: 5, standalone: false, expected: false },
  { name: "iPad home screen app (Mac user agent, touch)", userAgent: MAC, maxTouchPoints: 5, standalone: true, expected: true },
  { name: "real Mac, installed browser app", userAgent: MAC, maxTouchPoints: 0, standalone: true, expected: false },
  { name: "Android installed app", userAgent: ANDROID, maxTouchPoints: 5, standalone: true, expected: false },
];

describe("isIosStandalone", () => {
  it.each(cases)("$name", ({ expected, ...context }) => {
    expect(isIosStandalone(context)).toBe(expected);
  });
});

describe("boot script agrees with isIosStandalone", () => {
  function run(userAgent: string, maxTouchPoints: number, standalone: boolean, displayModeStandalone = false) {
    const attributes: Record<string, string> = {};
    const nav = { userAgent, maxTouchPoints, standalone };
    const doc = { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } } };
    new Function("navigator", "matchMedia", "document", IOS_STANDALONE_BOOT_SCRIPT)(nav, () => ({ matches: displayModeStandalone }), doc);
    return IOS_STANDALONE_ATTRIBUTE in attributes;
  }

  it.each(cases)("$name", ({ userAgent, maxTouchPoints, standalone, expected }) => {
    expect(run(userAgent, maxTouchPoints, standalone)).toBe(expected);
  });

  it("also accepts the display-mode media query when navigator.standalone is missing", () => {
    expect(run(IPHONE, 5, false, true)).toBe(true);
    expect(run(ANDROID, 5, false, true)).toBe(false);
  });

  it("never throws when the browser blocks the checks", () => {
    const hostile = { get userAgent(): string { throw new Error("denied"); } };
    expect(() => new Function("navigator", "matchMedia", "document", IOS_STANDALONE_BOOT_SCRIPT)(hostile, () => ({ matches: false }), {})).not.toThrow();
  });
});
