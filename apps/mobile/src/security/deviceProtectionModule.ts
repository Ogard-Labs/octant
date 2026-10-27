import { decideScreenshotPrivacyMode, type ScreenshotPrivacyMode } from "@octant/domain";
import type {
  KeyStorageProtection,
  KeyStorageVault,
  MobileKeyStorageProtectionPort,
} from "./keyStorageProtectionPort";
import type {
  MobileScreenshotPrivacyPort,
  ScreenshotProtectionCoverage,
} from "./screenshotPrivacyPort";

/**
 * The in-tree module (`modules/octant-device-protection`), with an Android
 * and an iOS side. Web builds have none, so they keep the unavailable ports.
 */
export interface OctantDeviceProtectionNativeModule {
  /**
   * Turns the platform's capture protection on or off: Android's secure-window
   * flag, or the iOS cover. Answers `applied` or `unavailable`.
   */
  readonly setSecureWindow: (secure: boolean) => Promise<unknown>;
  /** Answers `secure-hardware`, `software`, or `unknown`. */
  readonly keyStorageProtection: () => Promise<unknown>;
}

/**
 * Screenshot privacy through the native module, which covers every screen
 * rather than only those showing thread content, so no screen can be missed.
 * On Android that is the secure-window flag (screenshots, screen recording,
 * and the recents preview); on iOS a cover over the app in the app switcher
 * and while the screen is recorded or mirrored. The native module starts
 * protected, and this port starts in `hide-in-recents` to match; the choice
 * lasts for the session only, so every launch starts protected.
 */
export function createSecureWindowScreenshotPrivacyPort(
  native: OctantDeviceProtectionNativeModule,
  coverage: ScreenshotProtectionCoverage,
): MobileScreenshotPrivacyPort {
  let mode: ScreenshotPrivacyMode = "hide-in-recents";
  return {
    available: true,
    coverage,
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
  vault: KeyStorageVault,
): MobileKeyStorageProtectionPort {
  return {
    vault,
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
