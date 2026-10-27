import {
  createUnavailableKeyStorageProtectionPort,
  type MobileKeyStorageProtectionPort,
} from "./keyStorageProtectionPort";
import {
  createUnavailableScreenshotPrivacyPort,
  type MobileScreenshotPrivacyPort,
} from "./screenshotPrivacyPort";

/**
 * The web build has no secure window and no keystore to report, so both stay
 * unavailable. The phone build uses the native module (`.native.ts`).
 */
export const mobileScreenshotPrivacy: MobileScreenshotPrivacyPort =
  createUnavailableScreenshotPrivacyPort();

export const mobileKeyStorageProtection: MobileKeyStorageProtectionPort =
  createUnavailableKeyStorageProtectionPort();
