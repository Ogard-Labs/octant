import {
  makeSecretServiceCredentialStore,
  makeWindowsCredentialStore,
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
      /** Public links' owner secrets, in their own Keychain service. */
      readonly canvasPublicShareSecrets: CredentialStore;
      /** Secrets given to MCP servers a person added by hand, in their own Keychain service. */
      readonly mcpServerCredentials: CredentialStore;
      /** Cloud desktop providers' API keys, in their own Keychain service. */
      readonly desktopProviderCredentials: CredentialStore;
      /** Push credentials of a hub that sends notifications directly, in their own Keychain service. */
      readonly pushPlatformCredentials: CredentialStore;
    }
  | {
      readonly kind: "secret-service";
      readonly store: CredentialStore;
      readonly purgeStore?: undefined;
      /** Replica device signing keys, under their own Secret Service attribute. */
      readonly replicaDeviceKeys: CredentialStore;
      /** Sync buckets' key pairs, under their own Secret Service attribute. */
      readonly replicaStoreCredentials: CredentialStore;
      /** Public links' owner secrets, under their own Secret Service attribute. */
      readonly canvasPublicShareSecrets: CredentialStore;
      /** Secrets given to MCP servers a person added by hand, under their own attribute. */
      readonly mcpServerCredentials: CredentialStore;
      /** Cloud desktop providers' API keys, under their own attribute. */
      readonly desktopProviderCredentials: CredentialStore;
      /** Push credentials of a hub that sends notifications directly, under their own attribute. */
      readonly pushPlatformCredentials: CredentialStore;
    }
  | {
      readonly kind: "credential-manager";
      readonly store: CredentialStore;
      readonly purgeStore?: undefined;
      readonly replicaDeviceKeys?: undefined;
      readonly replicaStoreCredentials?: undefined;
      readonly canvasPublicShareSecrets?: undefined;
      readonly mcpServerCredentials?: undefined;
      readonly desktopProviderCredentials?: undefined;
      readonly pushPlatformCredentials?: undefined;
    }
  | {
      readonly kind: "unavailable";
      readonly store?: undefined;
      readonly purgeStore?: undefined;
      readonly replicaDeviceKeys?: undefined;
      readonly replicaStoreCredentials?: undefined;
      readonly canvasPublicShareSecrets?: undefined;
      readonly mcpServerCredentials?: undefined;
      readonly desktopProviderCredentials?: undefined;
      readonly pushPlatformCredentials?: undefined;
    };

/**
 * Select the host credential store for this desktop OS.
 *
 * Darwin keeps the Keychain helper. Linux uses the host-runtime Secret Service
 * store (same broker contract as headless). The Linux stores are chosen without
 * asking whether a keyring answers: each call reaches the keyring itself, so one
 * that starts after Octant, or is unlocked later, works on the next key without
 * a restart, and one that is missing fails that call with its cause. There is
 * no fallback file store.
 */
export async function resolveDesktopCredentialBackend(options: {
  readonly platform: NodeJS.Platform;
  readonly keychainHelperPath: string;
  readonly storeScope: string;
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
      canvasPublicShareSecrets: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "canvas-public-share-secret",
      }),
      mcpServerCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "mcp-server-credential",
      }),
      desktopProviderCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "desktop-provider-credential",
      }),
      pushPlatformCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        storeScope: options.storeScope,
        namespace: "push-platform-credential",
      }),
    };
  }
  if (options.platform === "linux") {
    return {
      kind: "secret-service",
      store: makeSecretServiceCredentialStore(),
      replicaDeviceKeys: makeSecretServiceCredentialStore({ namespace: "replica-device-key" }),
      replicaStoreCredentials: makeSecretServiceCredentialStore({
        namespace: "replica-store-credential",
      }),
      canvasPublicShareSecrets: makeSecretServiceCredentialStore({
        namespace: "canvas-public-share-secret",
      }),
      mcpServerCredentials: makeSecretServiceCredentialStore({
        namespace: "mcp-server-credential",
      }),
      desktopProviderCredentials: makeSecretServiceCredentialStore({
        namespace: "desktop-provider-credential",
      }),
      pushPlatformCredentials: makeSecretServiceCredentialStore({
        namespace: "push-platform-credential",
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
