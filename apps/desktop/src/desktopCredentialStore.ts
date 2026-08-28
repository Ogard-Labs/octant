import {
  makeSecretServiceCredentialStore,
  probeSecretService,
  type CredentialPurgeStore,
  type CredentialStore,
} from "@octant/host-runtime";
import {
  makeKeychainCredentialPurgeStore,
  makeKeychainCredentialStore,
} from "./keychainCredentialStore";

export type DesktopCredentialBackend =
  | {
      readonly kind: "keychain";
      readonly store: CredentialStore;
      readonly purgeStore: CredentialPurgeStore;
    }
  | {
      readonly kind: "secret-service";
      readonly store: CredentialStore;
      readonly purgeStore?: undefined;
    }
  | {
      readonly kind: "unavailable";
      readonly store?: undefined;
      readonly purgeStore?: undefined;
    };

/**
 * Select the host credential store for this desktop OS.
 *
 * Darwin keeps the Keychain helper. Linux uses the host-runtime Secret Service
 * store (same broker contract as headless). Absence is a value: no fallback
 * file store and no broker when the OS secret service is missing.
 */
export async function resolveDesktopCredentialBackend(options: {
  readonly platform: NodeJS.Platform;
  readonly keychainHelperPath: string;
  readonly storeScope: string;
  readonly probe?: typeof probeSecretService;
}): Promise<DesktopCredentialBackend> {
  if (options.platform === "darwin") {
    return {
      kind: "keychain",
      store: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
      }),
      purgeStore: makeKeychainCredentialPurgeStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
      }),
    };
  }
  if (options.platform === "linux") {
    const availability = await (options.probe ?? probeSecretService)();
    if (!availability.available) return { kind: "unavailable" };
    return {
      kind: "secret-service",
      store: makeSecretServiceCredentialStore(),
    };
  }
  return { kind: "unavailable" };
}
