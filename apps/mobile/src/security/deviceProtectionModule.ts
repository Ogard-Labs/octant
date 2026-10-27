import { decideScreenshotPrivacyMode, type ScreenshotPrivacyMode } from "@octant/domain";
import type {
  KeyStorageProtection,
  MobileKeyStorageProtectionPort,
} from "./keyStorageProtectionPort";
import type { MobileScreenshotPrivacyPort } from "./screenshotPrivacyPort";

/**
 * The in-tree Android module (`modules/octant-device-protection`). iOS and web
 * builds have none, so they keep the unavailable ports.
 */
export interface OctantDeviceProtectionNativeModule {
  /** Sets or clears the window's secure flag; answers `applied` or `unavailable`. */
  readonly setSecureWindow: (secure: boolean) => Promise<unknown>;
  /** Answers `secure-hardware`, `software`, or `unknown`. */
  readonly keyStorageProtection: () => Promise<unknown>;
}

/**
 * Screenshot privacy through Android's secure-window flag, which keeps the
 * whole window out of screenshots, screen recording, and the recents preview.
 * It covers every screen rather than only those showing thread content, so no
 * screen can be missed. The native module starts with the flag set, and this
 * port starts in `hide-in-recents` to match; the choice lasts for the session
 * only, so every launch starts protected.
 */
export function createSecureWindowScreenshotPrivacyPort(
  native: OctantDeviceProtectionNativeModule,
): MobileScreenshotPrivacyPort {
  let mode: ScreenshotPrivacyMode = "hide-in-recents";
  return {
    available: true,
    async getMode() {
      return mode;
    },
    async setMode(next) {
      mode = next;
    },
    async apply(next) {
      const secure = decideScreenshotPrivacyMode(next).preferNativeCaptureBlock;
      try {
        return (await native.setSecureWindow(secure)) === "applied" ? "applied" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}

/** A damaged or failed answer reads as unavailable, never as protected. */
export function createNativeKeyStorageProtectionPort(
  native: OctantDeviceProtectionNativeModule,
): MobileKeyStorageProtectionPort {
  return {
    async probe(): Promise<KeyStorageProtection> {
      try {
        const answer = await native.keyStorageProtection();
        return answer === "secure-hardware" || answer === "software" ? answer : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
