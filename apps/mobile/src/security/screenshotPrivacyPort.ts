import type { ScreenshotPrivacyMode } from "@octant/domain";

export interface MobileScreenshotPrivacyPort {
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
