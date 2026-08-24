import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import {
  createInMemoryMobileHostRegistryStorage,
  createMobileHostRegistry,
  type MobileHostRegistry,
  type MobileHostRegistration,
} from "../hosts/HostRegistry";
import type { MobileMockScenario } from "../dev/mobileMockScenario";
import {
  createMobileHostSessionHub,
  type MobileHostHealth,
  type MobileHostSessionHub,
} from "./MobileHostSessionHub";
import { disconnectLiveMobileSession } from "./mobileSessionLifecycle";

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
  readonly deviceKeyStore: ReturnType<typeof createExpoSecureDeviceKeyStore>;
  /** Primary bridge used by PairingPanel connect/resume flows. */
  readonly bridge: RemoteSessionBridge;
  readonly bridgeState: RemoteSessionBridgeState;
  readonly hosts: ReadonlyArray<MobileHostRegistration>;
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

const MobileSessionContext = createContext<MobileSessionContextValue | undefined>(undefined);

function transportFromSlot(input: {
  readonly hostId: string;
  readonly bridge: RemoteSessionBridge;
  readonly state: RemoteSessionBridgeState;
}): MobileRemoteTransport | undefined {
  if (input.state.kind !== "ready" && input.state.kind !== "stale") return undefined;
  const connection = input.bridge.connection();
  if (connection === undefined) return undefined;
  return {
    hostId: input.hostId,
    authenticatedFetch: (request) => connection.authenticatedFetch(request),
  };
}

function LiveMobileSessionProvider(props: { readonly children: ReactNode }) {
  const secureStorage = useMemo(() => createExpoSecureStringStorage(), []);
  const registryStorage = useMemo(() => createExpoSecureStringStorage({ persistWeb: true }), []);
  const deviceKeyStore = useMemo(
    () => createExpoSecureDeviceKeyStore({ storage: secureStorage }),
    [secureStorage],
  );
  const registry = useMemo(() => createMobileHostRegistry(registryStorage), [registryStorage]);
  const hub = useMemo(
    () =>
      createMobileHostSessionHub({
        fetch: globalThis.fetch.bind(globalThis),
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore,
      }),
    [deviceKeyStore],
  );
  /** Pairing flows still use a dedicated bridge that writes into the shared key store. */
  const bridge = useMemo(
    () =>
      createRemoteSessionBridge({
        fetch: globalThis.fetch.bind(globalThis),
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore,
      }),
    [deviceKeyStore],
  );
  const [bridgeState, setBridgeState] = useState<RemoteSessionBridgeState>(bridge.getState);
  const [hosts, setHosts] = useState<ReadonlyArray<MobileHostRegistration>>([]);
  const [health, setHealth] = useState<ReadonlyArray<MobileHostHealth>>([]);
  const [hubEpoch, setHubEpoch] = useState(0);
  const [inboxHostFilter, setInboxHostFilter] = useState<MobileInboxHostFilter>("all");
  const [placementHostId, setPlacementHostId] = useState<string | undefined>();

  useEffect(() => bridge.subscribe(setBridgeState), [bridge]);
  useEffect(() => hub.subscribe(() => setHubEpoch((value) => value + 1)), [hub]);

  useEffect(
    () => () => {
      disconnectLiveMobileSession({ bridge, hub });
    },
    [bridge, hub],
  );

  const refreshHosts = useCallback(async () => {
    const listed = await registry.list();
    setHosts(listed);
    hub.syncRegistrations(listed);
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

  useEffect(() => {
    setHealth(hub.health());
  }, [hub, hubEpoch]);

  const transports = useMemo(() => {
    void hubEpoch;
    const next: MobileRemoteTransport[] = [];
    for (const slot of hub.slots()) {
      const transport = transportFromSlot({
        hostId: slot.registration.hostId,
        bridge: slot.bridge,
        state: slot.state,
      });
      if (transport !== undefined) next.push(transport);
    }
    return next;
  }, [hub, hubEpoch]);

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
    deviceKeyStore,
    bridge,
    bridgeState,
    hosts,
    health,
    transports,
    transport,
    transportForHost,
    refreshHosts,
    resumeHost: (origin) => {
      hub.bridgeForOrigin(origin)?.resume(origin);
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
    deviceKeyStore,
    bridge,
    bridgeState: bridge.getState(),
    hosts: props.scenario.hosts,
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
