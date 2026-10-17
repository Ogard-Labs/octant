import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import type { OctantHostBridge } from "../shell/hostBridge";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";
import { createPairedComputerFetch } from "./pairedComputerFetch";

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

export function useHostFederationLifecycle(
  hostBridge?: Pick<
    OctantHostBridge,
    "forgetRemoteServerPages" | "forgetPairedComputer" | "requestPairedComputer"
  >,
): HostFederationStack | undefined {
  const [stack, setStack] = useState<HostFederationStack | undefined>();
  // Read when a host is cleared, not when the stack is built, so a bridge that
  // arrives later is still used.
  const forgetPages = useRef(hostBridge?.forgetRemoteServerPages);
  forgetPages.current = hostBridge?.forgetRemoteServerPages;
  const forgetComputer = useRef(hostBridge?.forgetPairedComputer);
  forgetComputer.current = hostBridge?.forgetPairedComputer;
  const requestComputer = useRef(hostBridge?.requestPairedComputer);
  requestComputer.current = hostBridge?.requestPairedComputer;

  const built = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const deviceKeyStore = createDefaultDeviceKeyStore();
      const registry = createClientHostRegistry(createBrowserHostRegistryStorage());
      const transports = createHostFederationTransports({
        registry,
        deviceKeyStore,
        // In the desktop app this window's page policy reaches loopback only, so
        // a paired computer is reached through the main process; anywhere else
        // the page's own fetch is the transport.
        fetch: (input, init) => {
          const request = requestComputer.current;
          return request === undefined
            ? globalThis.fetch(input, init)
            : createPairedComputerFetch({ requestPairedComputer: request })(input, init);
        },
      });
      const cache = createHostReadModelCache();
      return {
        lifecycle: createHostFederationLifecycle({
          registry,
          transports,
          deviceKeyStore,
          cache,
          onHostCleared: async (hostId, origin) => {
            const outcome = await forgetPages.current?.(hostId);
            // The desktop's pin goes with the host, so a computer removed from
            // here cannot be reached again until it is paired again.
            const pin = origin === undefined ? undefined : await forgetComputer.current?.(origin);
            if (outcome?.status === "incomplete") {
              throw new Error(
                outcome.message ??
                  "Removed, but Octant couldn't clear everything its pages stored on this computer.",
              );
            }
            if (pin?.status === "forgotten" && pin.warning !== undefined) {
              throw new Error(pin.warning);
            }
          },
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

/**
 * The window's federation stack, for the Settings section that pairs a
 * computer into it. Undefined until the stack has read the registry once.
 */
export const HostFederationStackContext = createContext<HostFederationStack | undefined>(undefined);

export function useHostFederationStack(): HostFederationStack | undefined {
  return useContext(HostFederationStackContext);
}
