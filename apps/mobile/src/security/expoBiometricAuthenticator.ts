import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import type { BiometricAuthenticator } from "./BiometricGate";

export function createExpoBiometricAuthenticator(): BiometricAuthenticator {
  return {
    async hasDeviceCredential() {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      return level !== LocalAuthentication.SecurityLevel.NONE;
    },
    async authenticate(input) {
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: input.promptMessage,
          cancelLabel: "Cancel",
          disableDeviceFallback: false,
          biometricsSecurityLevel: biometricsSecurityLevel(),
        });
        if (result.success) return "confirmed";
        return "denied";
      } catch {
        return "unavailable";
      }
    },
  };
}

/**
 * Android's default also accepts Class 2 biometrics, such as a camera face
 * unlock a photo can fool. Face ID and Touch ID are Class 3, so Android asks
 * for the same strength or the device credential. Android 9 and 10 (API 28
 * and 29) cannot pair Class 3 with the device credential: AndroidX's prompt
 * builder throws on that pair there, on the main thread, which would crash
 * every unlock and approval. Those two versions keep Android's default.
 */
function biometricsSecurityLevel(): "strong" | "weak" {
  return Platform.OS === "android" && (Platform.Version === 28 || Platform.Version === 29)
    ? "weak"
    : "strong";
}
