import {
  makeSecretServiceCredentialStore,
  makeWindowsCredentialStore,
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
      /** Replica device signing keys, in their own Keychain service. */
      readonly replicaDeviceKeys: CredentialStore;
      /** Sync buckets' key pairs, in their own Keychain service. */
      readonly replicaStoreCredentials: CredentialStore;
    }
  | {
      readonly kind: "secret-service";
      readonly store: CredentialStore;
      readonly purgeStore?: undefined;
      /** Replica device signing keys, under their own Secret Service attribute. */
      readonly replicaDeviceKeys: CredentialStore;
      /** Sync buckets' key pairs, under their own Secret Service attribute. */
      readonly replicaStoreCredentials: CredentialStore;
    }
  | {
      readonly kind: "credential-manager";
      readonly store: CredentialStore;
      readonly purgeStore?: undefined;
      readonly replicaDeviceKeys?: undefined;
      readonly replicaStoreCredentials?: undefined;
    }
  | {
      readonly kind: "unavailable";
      readonly store?: undefined;
      readonly purgeStore?: undefined;
      readonly replicaDeviceKeys?: undefined;
      readonly replicaStoreCredentials?: undefined;
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
      replicaDeviceKeys: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "replica-device-key",
      }),
      replicaStoreCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "replica-store-credential",
      }),
    };
  }
  if (options.platform === "linux") {
    const availability = await (options.probe ?? probeSecretService)();
    if (!availability.available) return { kind: "unavailable" };
    return {
      kind: "secret-service",
      store: makeSecretServiceCredentialStore(),
      replicaDeviceKeys: makeSecretServiceCredentialStore({ namespace: "replica-device-key" }),
      replicaStoreCredentials: makeSecretServiceCredentialStore({
        namespace: "replica-store-credential",
      }),
    };
  }
  if (options.platform === "win32") {
    return {
      kind: "credential-manager",
      store: makeWindowsCredentialStore(),
    };
  }
  return { kind: "unavailable" };
}
