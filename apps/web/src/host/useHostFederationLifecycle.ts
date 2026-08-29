import { useEffect, useMemo, useState } from "react";
import { createClientHostRegistry } from "@octant/client-runtime/host-federation-registry";
import { createHostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import {
  createHostFederationLifecycle,
  type HostFederationLifecycle,
} from "@octant/client-runtime/host-federation-lifecycle";
import { createHostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import { createDefaultDeviceKeyStore } from "@octant/client-runtime/remote-pairing-client";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";

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
      const registry = createClientHostRegistry(createBrowserHostRegistryStorage());
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
