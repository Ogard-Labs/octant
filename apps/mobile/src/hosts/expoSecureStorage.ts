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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
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
