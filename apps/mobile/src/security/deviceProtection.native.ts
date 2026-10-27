import { requireOptionalNativeModule } from "expo";
import {
  createNativeKeyStorageProtectionPort,
  createSecureWindowScreenshotPrivacyPort,
  type OctantDeviceProtectionNativeModule,
} from "./deviceProtectionModule";
import {
  createUnavailableKeyStorageProtectionPort,
  type MobileKeyStorageProtectionPort,
} from "./keyStorageProtectionPort";
import {
  createUnavailableScreenshotPrivacyPort,
  type MobileScreenshotPrivacyPort,
} from "./screenshotPrivacyPort";

// Android only: iOS builds and Expo Go have no such module, so their ports
// stay unavailable and Settings names them so, never as passing.
const native =
  requireOptionalNativeModule<OctantDeviceProtectionNativeModule>("OctantDeviceProtection");

/** One port for the app's life, so Settings shows the choice the window has. */
export const mobileScreenshotPrivacy: MobileScreenshotPrivacyPort =
  native === null
    ? createUnavailableScreenshotPrivacyPort()
    : createSecureWindowScreenshotPrivacyPort(native);

export const mobileKeyStorageProtection: MobileKeyStorageProtectionPort =
  native === null
    ? createUnavailableKeyStorageProtectionPort()
    : createNativeKeyStorageProtectionPort(native);
