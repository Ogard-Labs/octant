/**
 * Where the platform keystore holds the key that encrypts Octant's secure
 * storage (device signing keys, host registry). `unavailable` means this build
 * cannot tell, and is never read as protected.
 */
export type KeyStorageProtection = "secure-hardware" | "software" | "unavailable";

export interface MobileKeyStorageProtectionPort {
  readonly probe: () => Promise<KeyStorageProtection>;
}

/** iOS, web, and builds without the native module do not report it. */
export function createUnavailableKeyStorageProtectionPort(): MobileKeyStorageProtectionPort {
  return {
    async probe() {
      return "unavailable";
    },
  };
}

export function describeKeyStorageProtection(protection: KeyStorageProtection): string {
  if (protection === "secure-hardware") {
    return "Octant's keys are held in this phone's secure hardware.";
  }
  if (protection === "software") {
    return "This phone offers no secure hardware for keys, so Octant's keys are protected by software storage only.";
  }
  return "This build does not report where Octant's keys are held.";
}
