import { isIosDevice } from "./install-banner";

export const IOS_STANDALONE_ATTRIBUTE = "data-ios-standalone";

export type StandaloneContext = { userAgent: string; maxTouchPoints: number; standalone: boolean };

/** True only for an iPhone or iPad running the site from the home screen, not in a Safari tab. */
export function isIosStandalone(context: StandaloneContext) {
  return isIosDevice(context) && context.standalone;
}

/**
 * Runs inline in <head> before first paint, so the status bar strip and extra padding are there
 * from the first frame. Self-contained: it is serialized into the page and cannot import anything.
 * Its checks must match isIosDevice and isIosStandalone; the tests compare the two.
 */
export const IOS_STANDALONE_BOOT_SCRIPT = `(function(){try{var n=navigator;var ios=/iPhone|iPod|iPad/.test(n.userAgent)||(/Macintosh/.test(n.userAgent)&&n.maxTouchPoints>1);if(ios&&(n.standalone===true||matchMedia("(display-mode: standalone)").matches))document.documentElement.setAttribute(${JSON.stringify(IOS_STANDALONE_ATTRIBUTE)},"")}catch(e){}})();`;
