import * as LocalAuthentication from "expo-local-authentication";
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
          // Android's default also accepts Class 2 biometrics, such as a
          // camera face unlock a photo can fool. Face ID and Touch ID are
          // Class 3, so Android asks for the same strength or the device
          // credential.
          biometricsSecurityLevel: "strong",
        });
        if (result.success) return "confirmed";
        return "denied";
      } catch {
        return "unavailable";
      }
    },
  };
}
