import type {
  MobileRemoteTransport,
  RemoteConnection,
  RemoteSessionBridgeState,
} from "@octant/client-runtime";

type SlotConnection = Pick<RemoteConnection, "authenticatedFetch">;

export interface TransportSlot {
  readonly registration: { readonly hostId: string };
  readonly bridge: { readonly connection: () => SlotConnection | undefined };
  readonly state: RemoteSessionBridgeState;
}

/**
 * Builds the usable transports for the paired hosts and keeps object and array
 * identity while nothing a screen could care about changed. The hub emits on
 * every connection tick, and screens refetch their whole inbox whenever the
 * transports array identity changes, so rebuilding it per emit made every tick
 * a full refetch.
 */
export function createStableTransports(): (
  slots: ReadonlyArray<TransportSlot>,
) => ReadonlyArray<MobileRemoteTransport> {
  const byHost = new Map<
    string,
    {
      readonly connection: SlotConnection;
      readonly kind: "ready" | "stale";
      readonly transport: MobileRemoteTransport;
    }
  >();
  let previous: ReadonlyArray<MobileRemoteTransport> = [];

  return (slots) => {
    const next: MobileRemoteTransport[] = [];
    const seen = new Set<string>();
    for (const slot of slots) {
      const kind = slot.state.kind;
      if (kind !== "ready" && kind !== "stale") continue;
      const connection = slot.bridge.connection();
      if (connection === undefined) continue;
      const hostId = slot.registration.hostId;
      seen.add(hostId);
      const cached = byHost.get(hostId);
      if (cached !== undefined && cached.connection === connection && cached.kind === kind) {
        next.push(cached.transport);
        continue;
      }
      const transport: MobileRemoteTransport = {
        hostId,
        authenticatedFetch: (request) => connection.authenticatedFetch(request),
      };
      byHost.set(hostId, { connection, kind, transport });
      next.push(transport);
    }
    for (const hostId of byHost.keys()) {
      if (!seen.has(hostId)) byHost.delete(hostId);
    }
    const unchanged =
      next.length === previous.length && next.every((entry, index) => entry === previous[index]);
    if (unchanged) return previous;
    previous = next;
    return next;
  };
}
