import { describe, expect, it } from "vitest";
import { shouldShowInstallBanner, type InstallContext } from "./install-banner";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
const base: InstallContext = { userAgent: IPHONE, maxTouchPoints: 5, standalone: false, dismissed: false };

describe("install banner", () => {
  it("shows on iPhone Safari in a browser tab", () => {
    expect(shouldShowInstallBanner(base)).toBe(true);
  });
  it("shows on iPad, which reports a Mac user agent but has touch", () => {
    expect(shouldShowInstallBanner({ ...base, userAgent: MAC, maxTouchPoints: 5 })).toBe(true);
  });
  it("stays hidden on a real Mac, on Android, once installed, and once dismissed", () => {
    expect(shouldShowInstallBanner({ ...base, userAgent: MAC, maxTouchPoints: 0 })).toBe(false);
    expect(shouldShowInstallBanner({ ...base, userAgent: ANDROID })).toBe(false);
    expect(shouldShowInstallBanner({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallBanner({ ...base, dismissed: true })).toBe(false);
  });
});
