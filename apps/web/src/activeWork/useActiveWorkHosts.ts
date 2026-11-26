import { createRemoteProductFetch, type RemoteSessionBridge } from "@octant/client-runtime";
import {
  createActiveWorkClient,
  type ActiveWorkClient,
} from "@octant/client-runtime/active-work-client";
import type {
  FederatedHostLifecycleSnapshot,
  FederatedHostLifecycleState,
} from "@octant/client-runtime/host-federation-lifecycle";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import {
  isEnvironmentSelected,
  type EnvironmentSelection,
} from "@octant/client-runtime/environment-selection";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { useMemo } from "react";
import type { ActiveWorkHost } from "./useActiveWork";

// As for every paired-computer client: the session owns the destination, so
// the base URL only shapes the path, and no window capability leaves here.
const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";

const pairedClients = new WeakMap<RemoteSessionBridge, ActiveWorkClient>();

/** One client per session, so a new session never shows what an earlier one was answered. */
export function pairedActiveWorkClient(bridge: RemoteSessionBridge): ActiveWorkClient {
  const existing = pairedClients.get(bridge);
  if (existing !== undefined) return existing;
  const created = createActiveWorkClient({
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge }),
  });
  pairedClients.set(bridge, created);
  return created;
}

export interface ActiveWorkHostsInput {
  readonly localName: string;
  /** The window's own host port. */
  readonly local: Parameters<typeof createActiveWorkClient>[0];
  /** Moves with the window's own change feed. */
  readonly localRevision: unknown;
  readonly snapshots: ReadonlyArray<FederatedHostLifecycleSnapshot>;
  readonly transports?: Pick<HostFederationTransports, "get"> | undefined;
  /** Moves with the window's existing refresh of its paired computers. */
  readonly pairedRevision: unknown;
  /** The sidebar's Environments filter; a computer it leaves out is neither read nor named. */
  readonly selection?: EnvironmentSelection;
}

/** This computer first, then every computer the window is paired with, each over its own session. */
export function useActiveWorkHosts(input: ActiveWorkHostsInput): ReadonlyArray<ActiveWorkHost> {
  const { localName, local, localRevision, snapshots, transports, pairedRevision, selection } =
    input;
  const localClient = useMemo(() => createActiveWorkClient(local), [local]);
  return useMemo(
    () =>
      [
        {
          hostId: String(LOCAL_HOST_ID),
          name: localName,
          reach: "ready" as const,
          client: localClient,
          revision: localRevision,
        },
        ...snapshots
          .filter((snapshot) => String(snapshot.hostId) !== String(LOCAL_HOST_ID))
          .map((snapshot) => {
            const bridge = transports?.get(snapshot.hostId)?.bridge;
            return {
              hostId: String(snapshot.hostId),
              name: snapshot.displayName,
              reach: reachOf(snapshot.state),
              ...(snapshot.lastReadyAt === undefined ? {} : { lastReadyAt: snapshot.lastReadyAt }),
              ...(bridge === undefined ? {} : { client: pairedActiveWorkClient(bridge) }),
              revision: pairedRevision,
            };
          }),
      ].filter((host) => selection === undefined || isEnvironmentSelected(selection, host.hostId)),
    [localName, localClient, localRevision, snapshots, transports, pairedRevision, selection],
  );
}

function reachOf(state: FederatedHostLifecycleState): ActiveWorkHost["reach"] {
  switch (state) {
    case "ready":
      return "ready";
    case "connecting":
      return "connecting";
    case "unauthorized":
      return "refused";
    case "stale":
    case "incompatible":
    case "unavailable":
      return "unreachable";
  }
}
