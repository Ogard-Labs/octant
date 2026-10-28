import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
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

// Expo Go has no such module, so its ports stay unavailable and Settings names
// them so, never as passing.
const native =
  requireOptionalNativeModule<OctantDeviceProtectionNativeModule>("OctantDeviceProtection");
const ios = Platform.OS === "ios";

/** One port for the app's life, so Settings shows the choice the window has. */
export const mobileScreenshotPrivacy: MobileScreenshotPrivacyPort =
  native === null
    ? createUnavailableScreenshotPrivacyPort()
    : createSecureWindowScreenshotPrivacyPort(
        native,
        ios ? "app-switcher-and-recording" : "screenshots-recording-and-recents",
      );

export const mobileKeyStorageProtection: MobileKeyStorageProtectionPort =
  native === null
    ? createUnavailableKeyStorageProtectionPort()
    : createNativeKeyStorageProtectionPort(native, ios ? "ios-keychain" : "android-keystore");
