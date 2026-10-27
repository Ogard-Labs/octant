import type { ExpoSecureStringStorage } from "@octant/client-runtime";

const MEMORY = new Map<string, string>();

function createMemoryStringStorage(): ExpoSecureStringStorage {
  return {
    async getItem(key) {
      return MEMORY.get(key) ?? null;
    },
    async setItem(key, value) {
      MEMORY.set(key, value);
    },
    async deleteItem(key) {
      MEMORY.delete(key);
    },
  };
}

const WEB_STORAGE_PREFIX = "octant.mobile.";

/**
 * Web builds before the device-key/registry storage split (see
 * LiveMobileSessionProvider) wrote device signing keys into localStorage
 * under this key, shared with host-registry and appearance data through the
 * same prefixed store. This is that key's storage-side identifier, matching
 * the catalog key `createExpoSecureDeviceKeyStore` in `@octant/client-runtime`
 * still uses today.
 */
const LEGACY_DEVICE_KEY_CATALOG_KEY = "octant.remote.device-keys.v1";

function createWebLocalStorage(): ExpoSecureStringStorage {
  const prefix = WEB_STORAGE_PREFIX;
  return {
    async getItem(key) {
      try {
        return globalThis.localStorage?.getItem(prefix + key) ?? null;
      } catch {
        return MEMORY.get(key) ?? null;
      }
    },
    async setItem(key, value) {
      try {
        globalThis.localStorage?.setItem(prefix + key, value);
      } catch {
        MEMORY.set(key, value);
      }
    },
    async deleteItem(key) {
      try {
        globalThis.localStorage?.removeItem(prefix + key);
      } catch {
        MEMORY.delete(key);
      }
    },
  };
}

export interface ExpoSecureStringStorageOptions {
  /**
   * Persist non-secret app data in browser localStorage. Device key storage
   * leaves this disabled so private signing keys remain session-scoped.
   */
  readonly persistWeb?: boolean;
}

/**
 * SecureStore on native; session memory on web/Node by default. Web callers
 * that only store non-secret app data must explicitly opt into localStorage.
 */
export function createExpoSecureStringStorage(
  options: ExpoSecureStringStorageOptions = {},
): ExpoSecureStringStorage {
  const isDom = typeof document !== "undefined";
  const isNode =
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions.node !== undefined;

  if (isDom) {
    return options.persistWeb === true && typeof globalThis.localStorage !== "undefined"
      ? createWebLocalStorage()
      : createMemoryStringStorage();
  }
  if (isNode) {
    return createMemoryStringStorage();
  }

  // Native Expo / React Native (no document, no Node).
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  const { Platform } = require("react-native") as typeof import("react-native");
  if (Platform.OS === "ios") {
    iosKeychain ??= createThisDeviceKeychainStorage(SecureStore);
    return iosKeychain;
  }
  return {
    async getItem(key) {
      return SecureStore.getItemAsync(key);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key);
    },
  };
}

/** The expo-secure-store calls the iOS Keychain storage makes. */
export type KeychainCalls = Pick<
  typeof import("expo-secure-store"),
  "getItemAsync" | "setItemAsync" | "deleteItemAsync" | "WHEN_UNLOCKED_THIS_DEVICE_ONLY"
>;

/**
 * expo-secure-store's own default service. Items an earlier build wrote there
 * carry its default accessibility, `WHEN_UNLOCKED`, which an encrypted or
 * iCloud backup restores onto another device.
 */
const EARLIER_KEYCHAIN_OPTIONS = {} as const;
const THIS_DEVICE_KEYCHAIN_SERVICE = "octant.this-device";

/** One for the app, so every caller shares its one queue. */
let iosKeychain: ExpoSecureStringStorage | undefined;

/**
 * Octant's iOS secure storage: Keychain items readable only while the phone
 * is unlocked and never restored onto another device, so a device signing key
 * stays on the phone that paired, as Android's disabled backup keeps it there.
 * The Keychain keeps an item's accessibility when it is written again, so an
 * item an earlier build wrote is moved to a separate service on its first read
 * (written there, then removed from the old one) rather than rewritten in
 * place. Every call runs after the one before it: a write landing while a read
 * moves an item would otherwise be overwritten by the older value.
 */
export function createThisDeviceKeychainStorage(store: KeychainCalls): ExpoSecureStringStorage {
  const thisDevice = {
    keychainService: THIS_DEVICE_KEYCHAIN_SERVICE,
    keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    getItem: (key) =>
      inTurn(async () => {
        const current = await store.getItemAsync(key, thisDevice);
        if (current !== null) return current;
        const earlier = await store.getItemAsync(key, EARLIER_KEYCHAIN_OPTIONS);
        if (earlier === null) return null;
        await store.setItemAsync(key, earlier, thisDevice);
        await store.deleteItemAsync(key, EARLIER_KEYCHAIN_OPTIONS);
        return earlier;
      }),
    setItem: (key, value) =>
      inTurn(async () => {
        await store.setItemAsync(key, value, thisDevice);
        await store.deleteItemAsync(key, EARLIER_KEYCHAIN_OPTIONS);
      }),
    deleteItem: (key) =>
      inTurn(async () => {
        await store.deleteItemAsync(key, thisDevice);
        await store.deleteItemAsync(key, EARLIER_KEYCHAIN_OPTIONS);
      }),
  };
}

/**
 * One-time upgrade cleanup: delete the device-key catalog an earlier web
 * build persisted in localStorage, without touching the host-registry or
 * appearance entries that intentionally still live under the same prefix.
 * Call this before installing the memory-backed device-key store so
 * upgrading users don't leave private signing keys sitting in the weaker,
 * script-accessible store after the app stops reading them. Idempotent, and
 * safe when localStorage is unavailable or throws (Safari private mode).
 */
export function removeLegacyWebDeviceKeyCatalog(): void {
  if (typeof document === "undefined") return;
  try {
    globalThis.localStorage?.removeItem(WEB_STORAGE_PREFIX + LEGACY_DEVICE_KEY_CATALOG_KEY);
  } catch {
    // Storage disabled or blocked: nothing to clean up.
  }
}
