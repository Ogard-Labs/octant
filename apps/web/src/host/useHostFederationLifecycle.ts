import { useEffect, useMemo, useState } from "react";
import {
  createClientHostRegistry,
  type ClientHostRegistryStorage,
} from "@octant/client-runtime/host-federation-registry";
import { createHostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import {
  createHostFederationLifecycle,
  type HostFederationLifecycle,
} from "@octant/client-runtime/host-federation-lifecycle";
import { createHostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import { createDefaultDeviceKeyStore } from "@octant/client-runtime/remote-pairing-client";

function createLocalStorageRegistryStorage(): ClientHostRegistryStorage {
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

/**
 * Boot the shared Post-preview B6 lifecycle stack for Settings / shell chrome.
 * Safe when IndexedDB / localStorage are unavailable — falls back to empty
 * in-memory device keys and an empty durable registry.
 */
export function useHostFederationLifecycle(): HostFederationLifecycle | undefined {
  const [lifecycle, setLifecycle] = useState<HostFederationLifecycle>();

  const stack = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const deviceKeyStore = createDefaultDeviceKeyStore();
      const registry = createClientHostRegistry(createLocalStorageRegistryStorage());
      const transports = createHostFederationTransports({
        registry,
        deviceKeyStore,
        fetch: globalThis.fetch.bind(globalThis),
      });
      const cache = createHostReadModelCache();
      return createHostFederationLifecycle({
        registry,
        transports,
        deviceKeyStore,
        cache,
      });
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (stack === undefined) return;
    let cancelled = false;
    void stack.sync().then(() => {
      if (!cancelled) setLifecycle(stack);
    });
    return () => {
      cancelled = true;
    };
  }, [stack]);

  return lifecycle;
}
