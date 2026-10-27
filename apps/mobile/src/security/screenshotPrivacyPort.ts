import type { ScreenshotPrivacyMode } from "@octant/domain";

/**
 * What the platform's capture protection keeps Octant's content out of.
 * Android's secure window covers screenshots, screen recording, and the
 * recents preview. iOS offers no public way to keep a screenshot from showing
 * an app, so there the app covers itself in the app switcher's snapshot and
 * while the screen is recorded or mirrored, and says that a screenshot is not
 * blocked.
 */
export type ScreenshotProtectionCoverage =
  | "screenshots-recording-and-recents"
  | "app-switcher-and-recording";

export interface MobileScreenshotPrivacyPort {
  readonly available: boolean;
  /** `none` for a build without native protection; Settings then offers no choice. */
  readonly coverage: ScreenshotProtectionCoverage | "none";
  readonly getMode: () => Promise<ScreenshotPrivacyMode>;
  readonly setMode: (mode: ScreenshotPrivacyMode) => Promise<void>;
  /**
   * Apply native capture-block / blur when the platform supports it.
   * Returns whether the native apply succeeded.
   */
  readonly apply: (mode: ScreenshotPrivacyMode) => Promise<"applied" | "unavailable">;
}

/** In-memory preference + no-op native apply until device APIs are wired. */
export function createUnavailableScreenshotPrivacyPort(
  initial: ScreenshotPrivacyMode = "standard",
): MobileScreenshotPrivacyPort {
  let mode: ScreenshotPrivacyMode = initial;
  return {
    available: false,
    coverage: "none",
    async getMode() {
      return mode;
    },
    async setMode(next) {
      mode = next;
    },
    async apply() {
      return "unavailable";
    },
  };
}

export function describeScreenshotProtection(coverage: ScreenshotProtectionCoverage): string {
  if (coverage === "screenshots-recording-and-recents") {
    return "Screenshots, screen recordings, and the recents preview show no Octant content.";
  }
  return "The app switcher and a recorded or mirrored screen show no Octant content. iOS cannot block a screenshot, so avoid taking one of sensitive thread content.";
}
