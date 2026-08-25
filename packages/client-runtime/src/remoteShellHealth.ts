import type { HostHealth, HostIdentity } from "@octant/contracts/host";
import { decodeHostId } from "@octant/contracts/host";
import type { RemoteSessionBridgeState } from "./remoteSessionBridge";

/** Maps the remote session bridge state to the shared HostHealth vocabulary. */
export function mapBridgeStateToHostHealth(state: RemoteSessionBridgeState): HostHealth {
  switch (state.kind) {
    case "ready":
      return "healthy";
    case "connecting":
    case "negotiating":
    case "authenticating":
    case "reconnecting":
      return "connecting";
    case "stale":
      return "stale";
    case "incompatible":
      return "incompatible";
    case "unauthorized":
      return "unauthorized";
    case "unavailable":
      return "unavailable";
    case "idle":
      return "connecting";
  }
}

export function buildRemoteHostObservation(input: {
  readonly state: RemoteSessionBridgeState;
  readonly displayName?: string;
}): ReadonlyArray<HostIdentity> {
  const hostId = hostIdFromBridgeState(input.state);
  if (hostId === undefined) return [];
  return [
    {
      hostId: decodeHostId(hostId),
      displayName: input.displayName ?? hostDisplayNameFromState(input.state) ?? "This Mac",
      health: mapBridgeStateToHostHealth(input.state),
      capabilities: ["chat", "work", "code"],
    },
  ];
}

function hostIdFromBridgeState(state: RemoteSessionBridgeState): string | undefined {
  if (state.kind === "idle") return undefined;
  if ("hostId" in state && state.hostId !== undefined) return state.hostId;
  return undefined;
}

function hostDisplayNameFromState(state: RemoteSessionBridgeState): string | undefined {
  if ("displayName" in state && typeof state.displayName === "string") return state.displayName;
  return undefined;
}

export function canExecuteRemoteProductMutation(state: RemoteSessionBridgeState): boolean {
  return state.kind === "ready";
}
