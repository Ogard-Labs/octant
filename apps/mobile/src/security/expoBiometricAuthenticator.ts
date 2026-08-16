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
        });
        if (result.success) return "confirmed";
        return "denied";
      } catch {
        return "unavailable";
      }
    },
  };
}
