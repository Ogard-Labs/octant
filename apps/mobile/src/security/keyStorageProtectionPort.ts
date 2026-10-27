/**
 * Where the platform keeps the key material behind Octant's secure storage
 * (device signing keys, host registry). `unavailable` means this build cannot
 * tell, and is never read as protected.
 */
export type KeyStorageProtection = "secure-hardware" | "software" | "unavailable";

/**
 * Which platform store holds that storage. The two say different things:
 * Android's keystore holds the key that encrypts Octant's keys; iOS keeps
 * Octant's keys themselves as Keychain items, encrypted under keys the Secure
 * Enclave protects, readable only while unlocked, and never restored onto
 * another device (`hosts/expoSecureStorage.ts` writes them that way).
 */
export type KeyStorageVault = "android-keystore" | "ios-keychain";

export interface MobileKeyStorageProtectionPort {
  /** `unreported` for a build that has no native answer. */
  readonly vault: KeyStorageVault | "unreported";
  readonly probe: () => Promise<KeyStorageProtection>;
}

/** Web and builds without the native module do not report it. */
export function createUnavailableKeyStorageProtectionPort(): MobileKeyStorageProtectionPort {
  return {
    vault: "unreported",
    async probe() {
      return "unavailable";
    },
  };
}

export function describeKeyStorageProtection(
  protection: KeyStorageProtection,
  vault: KeyStorageVault | "unreported",
): string {
  if (protection === "unavailable" || vault === "unreported") {
    return "This build does not report where Octant's keys are held.";
  }
  if (vault === "ios-keychain") {
    return protection === "secure-hardware"
      ? "Octant's keys are kept in this phone's Keychain, encrypted under keys its Secure Enclave protects. They can be read only while the phone is unlocked, and a backup cannot carry them to another device."
      : "This device has no Secure Enclave, so the Keychain protects Octant's keys in software only. A backup cannot carry them to another device.";
  }
  return protection === "secure-hardware"
    ? "Octant's keys are encrypted with a key held in this phone's secure hardware."
    : "This phone offers no secure hardware for keys, so Octant's keys are protected by software storage only.";
}
