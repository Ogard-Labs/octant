import {
  makeSecretServiceCredentialStore,
  makeWindowsCredentialStore,
  type CredentialPurgeStore,
  type CredentialStore,
  type SecretServiceNamespace,
} from "@octant/host-runtime";
import {
  makeKeychainCredentialPurgeStore,
  makeKeychainCredentialStore,
  type KeychainServiceFamily,
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
      /** SSH sign-in keys Octant made for registered servers, in their own Keychain service. */
      readonly sshKeys: CredentialStore;
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
      /** SSH sign-in keys Octant made for registered servers, under their own attribute. */
      readonly sshKeys: CredentialStore;
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
      readonly sshKeys?: undefined;
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
      readonly sshKeys?: undefined;
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
  readonly serviceFamily?: KeychainServiceFamily;
}): Promise<DesktopCredentialBackend> {
  if (options.platform === "darwin") {
    const keychain = {
      storeScope: options.storeScope,
      serviceFamily: options.serviceFamily ?? "octant",
    } as const;
    return {
      kind: "keychain",
      store: makeKeychainCredentialStore(options.keychainHelperPath, keychain),
      purgeStore: makeKeychainCredentialPurgeStore(options.keychainHelperPath, keychain),
      replicaDeviceKeys: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "replica-device-key",
      }),
      replicaStoreCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "replica-store-credential",
      }),
      canvasPublicShareSecrets: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "canvas-public-share-secret",
      }),
      mcpServerCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "mcp-server-credential",
      }),
      desktopProviderCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "desktop-provider-credential",
      }),
      pushPlatformCredentials: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "push-platform-credential",
      }),
      sshKeys: makeKeychainCredentialStore(options.keychainHelperPath, {
        ...keychain,
        namespace: "ssh-key",
      }),
    };
  }
  if (options.platform === "linux") {
    // Nightly's test host names its own `service` values; Octant's are unchanged.
    const family = options.serviceFamily ?? "octant";
    const store = (namespace: SecretServiceNamespace) =>
      makeSecretServiceCredentialStore({ namespace, family });
    return {
      kind: "secret-service",
      store: store("provider"),
      replicaDeviceKeys: store("replica-device-key"),
      replicaStoreCredentials: store("replica-store-credential"),
      canvasPublicShareSecrets: store("canvas-public-share-secret"),
      mcpServerCredentials: store("mcp-server-credential"),
      desktopProviderCredentials: store("desktop-provider-credential"),
      pushPlatformCredentials: store("push-platform-credential"),
      sshKeys: store("ssh-key"),
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
