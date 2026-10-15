import { useEffect, useMemo, useState } from "react";
import {
  createClientHostRegistry,
  type ClientHostRegistry,
} from "@octant/client-runtime/host-federation-registry";
import {
  createHostFederationTransports,
  type HostFederationTransports,
} from "@octant/client-runtime/host-federation-transports";
import {
  createHostFederationLifecycle,
  type HostFederationLifecycle,
} from "@octant/client-runtime/host-federation-lifecycle";
import { createHostReadModelCache } from "@octant/client-runtime/host-federation-merged-reads";
import {
  createDefaultDeviceKeyStore,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime/remote-pairing-client";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";

/**
 * Boot the shared Post-preview B6 lifecycle stack for Settings / shell chrome.
 * Safe when IndexedDB / localStorage are unavailable — falls back to empty
 * in-memory device keys and an empty durable registry.
 */
export interface HostFederationStack {
  readonly lifecycle: HostFederationLifecycle;
  readonly transports: HostFederationTransports;
  /** The paired hosts' records, with each one's device key id and listener trust. */
  readonly registry: ClientHostRegistry;
  /** The device keys the paired sessions sign with. */
  readonly deviceKeyStore: RemoteDeviceKeyStore;
}

export function useHostFederationLifecycle(): HostFederationStack | undefined {
  const [stack, setStack] = useState<HostFederationStack | undefined>();

  const built = useMemo(() => {
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
      return {
        lifecycle: createHostFederationLifecycle({
          registry,
          transports,
          deviceKeyStore,
          cache,
        }),
        transports,
        registry,
        deviceKeyStore,
      };
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (built === undefined) return;
    let cancelled = false;
    void built.lifecycle.sync().then(() => {
      if (!cancelled) setStack(built);
    });
    return () => {
      cancelled = true;
    };
  }, [built]);

  return stack;
}
