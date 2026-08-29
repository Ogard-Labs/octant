import type { ClientHostRegistryStorage } from "@octant/client-runtime/host-federation-registry";

/**
 * Shared durable storage for the browser federation registry.
 * Pairing and Settings must use the same key so a paired host appears in the
 * multi-host lifecycle panel without a second write path.
 */
export function createBrowserHostRegistryStorage(): ClientHostRegistryStorage {
  return {
    async getItem(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    async setItem(key, value) {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Ignore quota / private-mode failures; registry stays ephemeral.
      }
    },
    async deleteItem(key) {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Ignore.
      }
    },
  };
}
