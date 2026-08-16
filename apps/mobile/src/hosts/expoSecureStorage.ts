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

/**
 * SecureStore on native; localStorage (or memory) on web/Node so Expo web and
 * unit tests can pair without native vault APIs.
 */
export function createExpoSecureStringStorage(): ExpoSecureStringStorage {
  const isDom = typeof document !== "undefined";
  const isNode =
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions.node !== undefined;

  if (isDom) {
    return typeof globalThis.localStorage === "undefined"
      ? createMemoryStringStorage()
      : createWebLocalStorage();
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
