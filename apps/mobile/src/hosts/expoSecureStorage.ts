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

function createWebLocalStorage(): ExpoSecureStringStorage {
  const prefix = "octant.mobile.";
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
