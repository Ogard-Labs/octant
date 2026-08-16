/**
 * The platform fields this renderer reads, typed structurally rather than taken
 * from `Navigator`: `userAgentData` is not in the DOM lib, and a plain object
 * lets a caller state the platform it means instead of mutating a global.
 */
export interface PlatformNavigator {
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
  readonly platform?: string | undefined;
}

/**
 * Report whether this renderer runs on Apple hardware.
 *
 * Keyboard chords are why this exists. On macOS the `Ctrl` chords belong to
 * Cocoa text editing — `Ctrl+K` deletes to the end of the line in every text
 * field — so an app surface that claims one takes an editing command away from
 * the whole app. `Cmd` chords are the app's to claim there; `Ctrl` chords are
 * the app's to claim everywhere else.
 *
 * The global is read at call time, never at module load, so the answer follows
 * the environment the caller is actually running in.
 */
export function isApplePlatform(
  navigatorLike: PlatformNavigator | undefined = globalThis.navigator,
): boolean {
  return /^(mac|iphone|ipad|ipod)/i.test(reportedPlatform(navigatorLike));
}

function reportedPlatform(navigatorLike: PlatformNavigator | undefined): string {
  // `userAgentData.platform` ("macOS") is the supported reading. `platform`
  // ("MacIntel") is deprecated but is what current WebKit still answers, and
  // this app ships in a WebKit-hosted window.
  const reported = navigatorLike?.userAgentData?.platform ?? "";
  if (reported.length > 0) return reported;
  return navigatorLike?.platform ?? "";
}
