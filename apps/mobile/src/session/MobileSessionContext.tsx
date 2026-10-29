import { mobileRemoteFetch } from "../runtime/mobileRemoteFetch";
import { createMobileListenerFetch } from "../runtime/mobileListenerFetch";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createExpoSecureDeviceKeyStore,
  createInMemoryExpoSecureStringStorage,
  createRemoteSessionBridge,
  type MobileRemoteTransport,
  type RemoteSessionBridge,
  type RemoteSessionBridgeState,
} from "@octant/client-runtime";
import { MOBILE_PRODUCT_NAME } from "../copy";
import { mobileBuildVersion } from "./mobileBuildVersion";
import { createStableTransports } from "./stableTransports";
import {
  createExpoSecureStringStorage,
  removeLegacyWebDeviceKeyCatalog,
} from "../hosts/expoSecureStorage";
import {
  createInMemoryMobileHostRegistryStorage,
  createMobileHostRegistry,
  type MobileHostRegistry,
  type MobileHostRegistration,
} from "../hosts/HostRegistry";
import { createGuestHubStore, reopenGuestHub, type GuestHubStore } from "../hosts/hubGuestFlow";
import type { MobileMockScenario } from "../dev/mobileMockScenario";
import {
  createMobileHostSessionHub,
  type MobileHostHealth,
  type MobileHostSessionHub,
} from "./MobileHostSessionHub";
import {
  createMobileHostRemover,
  disconnectLiveMobileSession,
  refreshLiveMobileSession,
} from "./mobileSessionLifecycle";

export type MobileInboxHostFilter = "all" | string;

export interface MobileSessionContextValue {
  readonly environment:
    | { readonly kind: "live" }
    | {
        readonly kind: "mock";
        readonly scenarioId: MobileMockScenario["id"];
        readonly label: string;
      };
  readonly registry: MobileHostRegistry;
  /** The hub this phone joined as a guest, if any. */
  readonly guestHubStore: GuestHubStore;
  readonly deviceKeyStore: ReturnType<typeof createExpoSecureDeviceKeyStore>;
  /** Primary bridge used by PairingPanel connect/resume flows. */
  readonly bridge: RemoteSessionBridge;
  readonly bridgeState: RemoteSessionBridgeState;
  readonly hosts: ReadonlyArray<MobileHostRegistration>;
  /** False until the first read of the stored host list has finished. */
  readonly hostsLoaded: boolean;
  /** Set when the stored host list could not be read; cleared by the next good read. */
  readonly hostsError: string | undefined;
  readonly health: ReadonlyArray<MobileHostHealth>;
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
  readonly transport: MobileRemoteTransport | undefined;
  readonly transportForHost: (hostId: string) => MobileRemoteTransport | undefined;
  readonly refreshHosts: () => Promise<void>;
  readonly resumeHost: (origin: string) => void;
  readonly inboxHostFilter: MobileInboxHostFilter;
  readonly setInboxHostFilter: (filter: MobileInboxHostFilter) => void;
  readonly placementHostId: string | undefined;
  readonly setPlacementHostId: (hostId: string | undefined) => void;
  readonly hub: MobileHostSessionHub;
}

// Defined here because the shared copy file is owned elsewhere in this change.
const HOSTS_UNREADABLE = "Couldn't read your paired computers. Pair again to continue.";

const MobileSessionContext = createContext<MobileSessionContextValue | undefined>(undefined);

function LiveMobileSessionProvider(props: { readonly children: ReactNode }) {
  // Earlier web builds persisted device signing keys in localStorage; run the
  // one-time cleanup before switching this session's device-key store to
  // memory storage so upgrading users don't leave that key material behind.
  const secureStorage = useMemo(() => {
    removeLegacyWebDeviceKeyCatalog();
    return createExpoSecureStringStorage();
  }, []);
  const registryStorage = useMemo(() => createExpoSecureStringStorage({ persistWeb: true }), []);
  const deviceKeyStore = useMemo(
    () => createExpoSecureDeviceKeyStore({ storage: secureStorage }),
    [secureStorage],
  );
  const registry = useMemo(() => createMobileHostRegistry(registryStorage), [registryStorage]);
  const guestHubStore = useMemo(() => createGuestHubStore(registryStorage), [registryStorage]);
  const listenerFetch = useMemo(
    () =>
      createMobileListenerFetch({
        deviceKeyStore,
        pinnedTransport: mobilePinnedListenerTransport,
        platformFetch: mobileRemoteFetch,
      }),
    [deviceKeyStore],
  );
  const hub = useMemo(
    () =>
      createMobileHostSessionHub({
        fetch: listenerFetch,
        webBuildVersion: mobileBuildVersion(),
        deviceKeyStore,
      }),
    [deviceKeyStore, listenerFetch],
  );
  /** Pairing flows still use a dedicated bridge that writes into the shared key store. */
  const bridge = useMemo(
    () =>
      createRemoteSessionBridge({
        fetch: listenerFetch,
        webBuildVersion: mobileBuildVersion(),
        deviceKeyStore,
      }),
    [deviceKeyStore, listenerFetch],
  );
  const lifetime = useRef(new AbortController());
  const [bridgeState, setBridgeState] = useState<RemoteSessionBridgeState>(bridge.getState);
  const [hosts, setHosts] = useState<ReadonlyArray<MobileHostRegistration>>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostsError, setHostsError] = useState<string | undefined>();
  const [health, setHealth] = useState<ReadonlyArray<MobileHostHealth>>([]);
  const [hubEpoch, setHubEpoch] = useState(0);
  const [inboxHostFilter, setInboxHostFilter] = useState<MobileInboxHostFilter>("all");
  const [placementHostId, setPlacementHostId] = useState<string | undefined>();

  useEffect(() => bridge.subscribe(setBridgeState), [bridge]);
  useEffect(() => hub.subscribe(() => setHubEpoch((value) => value + 1)), [hub]);

  useEffect(() => {
    const current = new AbortController();
    lifetime.current = current;
    return () => {
      // A pending secure-storage read must not reconnect hosts after vault teardown.
      current.abort();
      disconnectLiveMobileSession({ bridge, hub });
    };
  }, [bridge, hub]);

  const refreshHosts = useCallback(async () => {
    const signal = lifetime.current.signal;
    let read: Awaited<ReturnType<typeof refreshLiveMobileSession>>;
    try {
      read = await refreshLiveMobileSession({ registry, hub, signal });
    } catch {
      if (signal.aborted) return;
      setHostsError(HOSTS_UNREADABLE);
      setHostsLoaded(true);
      return;
    }
    if (read === undefined || signal.aborted) return;
    setHostsLoaded(true);
    if (read.kind === "unreadable") {
      setHostsError(HOSTS_UNREADABLE);
      return;
    }
    setHostsError(undefined);
    const listed = read.hosts;
    setHosts(listed);
    setHealth(hub.health());
    if (placementHostId !== undefined && !listed.some((host) => host.hostId === placementHostId)) {
      setPlacementHostId(listed[0]?.hostId);
    } else if (placementHostId === undefined && listed[0] !== undefined) {
      setPlacementHostId(listed[0].hostId);
    }
  }, [hub, placementHostId, registry]);

  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  // When the app opens, a hub this phone joined as a guest is asked for its
  // roster again, so a removed member disappears and a new one is asked to
  // admit the phone. It runs once; a hub that cannot be reached changes nothing.
  const removeHost = useMemo(
    () => createMobileHostRemover({ registry, hub, deviceKeyStore }),
    [deviceKeyStore, hub, registry],
  );
  const guestHubReopened = useRef(false);
  useEffect(() => {
    if (guestHubReopened.current) return;
    guestHubReopened.current = true;
    const signal = lifetime.current.signal;
    void reopenGuestHub({
      store: guestHubStore,
      transport: mobilePinnedListenerTransport,
      deviceKeyStore,
      registry,
      removeHost,
    })
      .then((outcome) => {
        if (!signal.aborted && (outcome.status === "updated" || outcome.status === "removed")) {
          return refreshHosts();
        }
        return undefined;
      })
      .catch(() => undefined);
  }, [deviceKeyStore, guestHubStore, refreshHosts, registry, removeHost]);

  useEffect(() => {
    setHealth(hub.health());
  }, [hub, hubEpoch]);

  const buildTransports = useRef(createStableTransports()).current;
  const transports = useMemo(() => {
    void hubEpoch;
    return buildTransports(hub.slots());
  }, [buildTransports, hub, hubEpoch]);

  const transport = useMemo(() => {
    if (inboxHostFilter !== "all") {
      return transports.find((entry) => entry.hostId === inboxHostFilter);
    }
    return transports[0];
  }, [inboxHostFilter, transports]);

  const transportForHost = useCallback(
    (hostId: string) => transports.find((entry) => entry.hostId === hostId),
    [transports],
  );

  const value: MobileSessionContextValue = {
    environment: { kind: "live" },
    registry,
    guestHubStore,
    deviceKeyStore,
    bridge,
    bridgeState,
    hosts,
    hostsLoaded,
    hostsError,
    health,
    transports,
    transport,
    transportForHost,
    refreshHosts,
    resumeHost: (origin) => {
      hub.supervisorForOrigin(origin)?.retryNow();
      bridge.resume(origin);
    },
    inboxHostFilter,
    setInboxHostFilter,
    placementHostId,
    setPlacementHostId,
    hub,
  };

  return (
    <MobileSessionContext.Provider value={value}>{props.children}</MobileSessionContext.Provider>
  );
}

function MockMobileSessionProvider(props: {
  readonly children: ReactNode;
  readonly scenario: MobileMockScenario;
}) {
  const storage = useMemo(() => createInMemoryExpoSecureStringStorage(), []);
  const deviceKeyStore = useMemo(() => createExpoSecureDeviceKeyStore({ storage }), [storage]);
  const registry = useMemo(
    () => createMobileHostRegistry(createInMemoryMobileHostRegistryStorage()),
    [],
  );
  const guestHubStore = useMemo(
    () => createGuestHubStore(createInMemoryMobileHostRegistryStorage()),
    [],
  );
  const bridge = useMemo(
    () =>
      createRemoteSessionBridge({
        fetch: async () => new Response("Mock mode does not connect to hosts.", { status: 503 }),
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/mock`,
        deviceKeyStore,
      }),
    [deviceKeyStore],
  );
  const hub = useMemo(
    () =>
      createMobileHostSessionHub({
        fetch: async () => new Response("Mock mode does not connect to hosts.", { status: 503 }),
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/mock`,
        deviceKeyStore,
      }),
    [deviceKeyStore],
  );
  const [inboxHostFilter, setInboxHostFilter] = useState<MobileInboxHostFilter>("all");
  const [placementHostId, setPlacementHostId] = useState<string | undefined>(
    props.scenario.hosts[0]?.hostId,
  );

  const transportForHost = useCallback(
    (hostId: string) => props.scenario.transports.find((entry) => entry.hostId === hostId),
    [props.scenario.transports],
  );
  const transport = useMemo(() => {
    if (inboxHostFilter !== "all") return transportForHost(inboxHostFilter);
    return props.scenario.transports[0];
  }, [inboxHostFilter, props.scenario.transports, transportForHost]);

  const value: MobileSessionContextValue = {
    environment: {
      kind: "mock",
      scenarioId: props.scenario.id,
      label: props.scenario.label,
    },
    registry,
    guestHubStore,
    deviceKeyStore,
    bridge,
    bridgeState: bridge.getState(),
    hosts: props.scenario.hosts,
    hostsLoaded: true,
    hostsError: undefined,
    health: props.scenario.health,
    transports: props.scenario.transports,
    transport,
    transportForHost,
    refreshHosts: async () => undefined,
    resumeHost: () => undefined,
    inboxHostFilter,
    setInboxHostFilter,
    placementHostId,
    setPlacementHostId,
    hub,
  };

  return (
    <MobileSessionContext.Provider value={value}>{props.children}</MobileSessionContext.Provider>
  );
}

export function MobileSessionProvider(props: {
  readonly children: ReactNode;
  readonly mockScenario?: MobileMockScenario | undefined;
}) {
  if (props.mockScenario !== undefined) {
    return (
      <MockMobileSessionProvider scenario={props.mockScenario}>
        {props.children}
      </MockMobileSessionProvider>
    );
  }
  return <LiveMobileSessionProvider>{props.children}</LiveMobileSessionProvider>;
}

export function useMobileSession(): MobileSessionContextValue {
  const value = useContext(MobileSessionContext);
  if (value === undefined) {
    throw new Error("useMobileSession requires MobileSessionProvider.");
  }
  return value;
}
