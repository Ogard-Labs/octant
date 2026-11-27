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
import {
  createHostReadModelCache,
  type HostReadModelCache,
} from "@octant/client-runtime/host-federation-merged-reads";
import {
  createDefaultDeviceKeyStore,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime/remote-pairing-client";
import type { OctantHostBridge } from "../shell/hostBridge";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";
import { syncHubComputersInWindow, withHubComputerDismissals } from "./hubWindowComputers";
import { createPairedComputerFetch } from "./pairedComputerFetch";

/** How often a window on a hub member reads the hub's members again, so one the hub drops leaves. */
const HUB_COMPUTERS_REFRESH_MS = 5 * 60 * 1_000;
/** The least time between two rounds of asking paired computers where their hub's relay is. */
const RELAY_LEARN_SPACING_MS = 30_000;

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
  /** Each paired computer's last reading of its threads and asks, kept stale when it stops answering. */
  readonly cache: HostReadModelCache;
}

export function useHostFederationLifecycle(
  hostBridge?: Pick<
    OctantHostBridge,
    | "forgetRemoteServerPages"
    | "forgetPairedComputer"
    | "requestPairedComputer"
    | "introduceWindowToHub"
    | "answerPairedComputerRelaySigning"
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
  const introduceToHub = useRef(hostBridge?.introduceWindowToHub);
  introduceToHub.current = hostBridge?.introduceWindowToHub;

  const built = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const deviceKeyStore = createDefaultDeviceKeyStore();
      const storage = createBrowserHostRegistryStorage();
      const registry = createClientHostRegistry(storage);
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
      const rosterLifecycle = createHostFederationLifecycle({
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
      });
      return {
        lifecycle: withHubComputerDismissals(rosterLifecycle, registry, storage),
        rosterLifecycle,
        transports,
        registry,
        deviceKeyStore,
        storage,
        cache,
      };
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (built === undefined) return;
    let cancelled = false;
    const { storage, rosterLifecycle, ...stackOnly } = built;
    // A desktop window on a hub member lists the hub's other members too. Only
    // the desktop offers the introduction; a browser joins a hub as a guest.
    const syncHubComputers = async (): Promise<void> => {
      const introduce = introduceToHub.current;
      const request = requestComputer.current;
      if (introduce === undefined || request === undefined) return;
      await syncHubComputersInWindow({
        bridge: { introduceWindowToHub: introduce, requestPairedComputer: request },
        stack: stackOnly,
        storage,
        removeHost: (hostId) => rosterLifecycle.removeLocal(hostId),
      }).catch(() => undefined);
    };
    // In the desktop app each paired computer tells main where its hub's relay
    // is, answering only at home; main keeps the address from that answer, so
    // the window keeps nothing. A browser never relays and never asks.
    let learnedAt = 0;
    const learnRelays = async (): Promise<void> => {
      if (requestComputer.current === undefined) return;
      // A computer that connects later is asked too, at most twice a minute.
      if (Date.now() - learnedAt < RELAY_LEARN_SPACING_MS) return;
      learnedAt = Date.now();
      // Loaded only in the desktop app, which alone relays: the main chunk has
      // no room for the relay client (scripts/initial-renderer-budget.json).
      const { learnRelayAddresses } = await import("@octant/client-runtime/paired-host-relay");
      if (cancelled) return;
      await learnRelayAddresses({
        transports: built.transports,
        remember: () => undefined,
      }).catch(() => undefined);
    };
    void built.lifecycle.sync().then(() => {
      if (cancelled) return;
      setStack(stackOnly);
      void syncHubComputers();
      void learnRelays();
    });
    const refresh = setInterval(() => {
      void syncHubComputers();
      void learnRelays();
    }, HUB_COMPUTERS_REFRESH_MS);
    const stopLearning = built.transports.subscribe(() => void learnRelays());
    return () => {
      cancelled = true;
      clearInterval(refresh);
      stopLearning();
    };
  }, [built]);

  // The window answers main's request to sign a relay admission, and only
  // that: the signer refuses any text but the exact admission for the
  // computer its key is paired with.
  const answerRelaySigning = hostBridge?.answerPairedComputerRelaySigning;
  useEffect(() => {
    if (built === undefined || answerRelaySigning === undefined) return;
    let stop: (() => void) | undefined;
    let ended = false;
    void import("@octant/client-runtime/paired-host-relay").then(
      ({ createRelayAdmissionSigner }) => {
        if (ended) return;
        stop = answerRelaySigning(createRelayAdmissionSigner(built.deviceKeyStore));
      },
    );
    return () => {
      ended = true;
      stop?.();
    };
  }, [built, answerRelaySigning]);

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
