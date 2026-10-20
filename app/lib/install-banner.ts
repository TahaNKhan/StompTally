export const INSTALL_BANNER_DISMISSED_KEY = "install-banner-dismissed";

export type InstallContext = {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  dismissed: boolean;
};

// iPadOS 13+ reports a desktop Mac user agent, so touch support tells it apart from a real Mac.
export function isIosDevice({ userAgent, maxTouchPoints }: Pick<InstallContext, "userAgent" | "maxTouchPoints">) {
  return /iPhone|iPod|iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** iOS cannot install a site by itself, so we only hint at it until it runs from the home screen. */
export function shouldShowInstallBanner(context: InstallContext) {
  return isIosDevice(context) && !context.standalone && !context.dismissed;
}
