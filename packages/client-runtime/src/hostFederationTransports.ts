import {
  LOCAL_HOST_ID,
  decodeEntityId,
  decodeGlobalEntityReference,
  decodeHostId,
  type GlobalEntityReference,
  type HostId,
} from "@octant/contracts/host";
import {
  createRemoteSessionBridge,
  type RemoteSessionBridge,
  type RemoteSessionBridgeState,
} from "./remoteSessionBridge";
import type { RemoteDeviceKeyStore } from "./remotePairingClient";
import type { AuthenticatedRequestInput, RemoteConnection } from "./remoteConnection";
import type {
  ClientHostKind,
  ClientHostRegistration,
  ClientHostRegistry,
} from "./hostFederationRegistry";

/**
 * Concurrent direct host transports for Post-preview B2.
 *
 * Maintains an independent `hostId →` session/connection map. Reuses
 * `createRemoteSessionBridge` / `RemoteConnection` for remotes. Local/`This Mac`
 * is always present when enabled and never blocked by remote failures.
 *
 * Non-goals: host-to-host communication, offline mutation queues.
 */

export type FederatedTransportState = RemoteSessionBridgeState | { readonly kind: "local-ready" };

export interface FederatedHostTransportSlot {
  readonly hostId: HostId;
  readonly kind: ClientHostKind;
  readonly displayName: string;
  readonly origin?: string;
  readonly state: FederatedTransportState;
  readonly bridge?: RemoteSessionBridge;
  readonly connection?: RemoteConnection;
}

/** Authenticated product port for one remote host (compatible with MobileRemoteTransport). */
export interface FederatedRemoteTransport {
  readonly hostId: string;
  readonly authenticatedFetch: (input: AuthenticatedRequestInput) => Promise<Response>;
}

export interface HostFederationFanOutResult<T> {
  readonly hostId: HostId;
  readonly status: "fulfilled" | "rejected";
  readonly value?: T;
  readonly reason?: unknown;
}

export interface HostFederationTransportFactory {
  readonly createRemoteBridge: (registration: ClientHostRegistration) => RemoteSessionBridge;
}

export interface HostFederationTransportsOptions {
  readonly registry: ClientHostRegistry;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly webBuildVersion?: string;
  /** Injectable for tests; production uses `createRemoteSessionBridge`. */
  readonly factory?: HostFederationTransportFactory;
}

export interface HostFederationTransports {
  /** Sync transport slots from the registry: enabled hosts only. */
  readonly syncEnabledHosts: () => Promise<void>;
  readonly list: () => ReadonlyArray<FederatedHostTransportSlot>;
  readonly get: (hostId: HostId | string) => FederatedHostTransportSlot | undefined;
  /** Remote authenticated fetch port when the host bridge is ready. */
  readonly remoteTransportFor: (hostId: HostId | string) => FederatedRemoteTransport | undefined;
  /**
   * Disconnect and drop one host's transport without touching others.
   * Local/`This Mac` cannot be removed this way — disable it via the registry.
   */
  readonly disconnectHost: (hostId: HostId | string) => Promise<void>;
  /**
   * Fan-out across current slots with `Promise.allSettled` isolation.
   * One rejection never clears other hosts' sessions.
   */
  readonly fanOut: <T>(
    execute: (slot: FederatedHostTransportSlot) => Promise<T>,
  ) => Promise<ReadonlyArray<HostFederationFanOutResult<T>>>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly disconnectAll: () => void;
}

const DEFAULT_WEB_BUILD_VERSION = "0.1.0";

function defaultFactory(input: {
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly fetch: typeof globalThis.fetch;
  readonly webBuildVersion: string;
}): HostFederationTransportFactory {
  return {
    createRemoteBridge: () =>
      createRemoteSessionBridge({
        fetch: input.fetch,
        webBuildVersion: input.webBuildVersion,
        deviceKeyStore: input.deviceKeyStore,
      }),
  };
}

function localSlot(registration: ClientHostRegistration): FederatedHostTransportSlot {
  return {
    hostId: registration.hostId,
    kind: "local",
    displayName: registration.displayName,
    state: { kind: "local-ready" },
  };
}

function remoteSlot(
  registration: ClientHostRegistration,
  bridge: RemoteSessionBridge,
): FederatedHostTransportSlot {
  const state = bridge.getState();
  const connection = bridge.connection();
  return {
    hostId: registration.hostId,
    kind: "remote",
    displayName: registration.displayName,
    ...(registration.origin !== undefined ? { origin: registration.origin } : {}),
    state,
    bridge,
    ...(connection !== undefined ? { connection } : {}),
  };
}

/**
 * Build a validated `{ hostId, entityId }` reference. Colliding entity IDs on
 * different hosts remain distinct because hostId is part of identity.
 */
export function globalEntityReference(
  hostId: HostId | string,
  entityId: string,
): GlobalEntityReference {
  return decodeGlobalEntityReference({
    hostId: decodeHostId(hostId),
    entityId: decodeEntityId(entityId),
  });
}

/**
 * True when two refs address the same global entity (same host + entity).
 * Same entityId on different hosts does **not** collide.
 */
export function federatedEntityRefsCollide(
  left: GlobalEntityReference,
  right: GlobalEntityReference,
): boolean {
  return left.hostId === right.hostId && left.entityId === right.entityId;
}

/**
 * Execute against only the owning/selected host. Never fans out a command.
 */
export async function routeToOwningHost<T>(input: {
  readonly transports: HostFederationTransports;
  readonly ref: GlobalEntityReference;
  readonly execute: (slot: FederatedHostTransportSlot) => Promise<T>;
}): Promise<T> {
  const slot = input.transports.get(input.ref.hostId);
  if (slot === undefined) {
    throw new Error(`No transport for owning host ${input.ref.hostId}.`);
  }
  return input.execute(slot);
}

export function createHostFederationTransports(
  options: HostFederationTransportsOptions,
): HostFederationTransports {
  const webBuildVersion = options.webBuildVersion ?? DEFAULT_WEB_BUILD_VERSION;
  const factory =
    options.factory ??
    defaultFactory({
      deviceKeyStore: options.deviceKeyStore,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      webBuildVersion,
    });

  const bridges = new Map<string, RemoteSessionBridge>();
  const unsubscribers = new Map<string, () => void>();
  const registrations = new Map<string, ClientHostRegistration>();
  const listeners = new Set<() => void>();
  let localRegistration: ClientHostRegistration | undefined;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const dropRemote = (hostId: string) => {
    const unsubscribe = unsubscribers.get(hostId);
    if (unsubscribe !== undefined) {
      unsubscribe();
      unsubscribers.delete(hostId);
    }
    const bridge = bridges.get(hostId);
    if (bridge !== undefined) {
      bridge.disconnect();
      bridges.delete(hostId);
    }
    registrations.delete(hostId);
  };

  const ensureRemote = (registration: ClientHostRegistration): RemoteSessionBridge => {
    const hostId = registration.hostId;
    const existing = bridges.get(hostId);
    if (existing !== undefined) {
      registrations.set(hostId, registration);
      return existing;
    }
    const bridge = factory.createRemoteBridge(registration);
    bridges.set(hostId, bridge);
    registrations.set(hostId, registration);
    unsubscribers.set(
      hostId,
      bridge.subscribe(() => {
        emit();
      }),
    );
    if (registration.origin !== undefined) {
      bridge.resume(registration.origin);
    }
    return bridge;
  };

  const buildSlots = (): FederatedHostTransportSlot[] => {
    const slots: FederatedHostTransportSlot[] = [];
    if (localRegistration !== undefined && localRegistration.enabled) {
      slots.push(localSlot(localRegistration));
    }
    for (const registration of registrations.values()) {
      const bridge = bridges.get(registration.hostId);
      if (bridge === undefined) continue;
      slots.push(remoteSlot(registration, bridge));
    }
    return slots;
  };

  return {
    async syncEnabledHosts() {
      const listed = await options.registry.list();
      const enabled = listed.filter((host) => host.enabled);
      const nextRemoteIds = new Set(
        enabled.filter((host) => host.kind === "remote").map((host) => host.hostId as string),
      );

      for (const hostId of [...bridges.keys()]) {
        if (!nextRemoteIds.has(hostId)) {
          dropRemote(hostId);
        }
      }

      localRegistration = enabled.find((host) => host.kind === "local");

      for (const registration of enabled) {
        if (registration.kind !== "remote") continue;
        ensureRemote(registration);
      }
      emit();
    },

    list() {
      return buildSlots();
    },

    get(hostId) {
      const id = decodeHostId(hostId);
      return buildSlots().find((slot) => slot.hostId === id);
    },

    remoteTransportFor(hostId) {
      const id = decodeHostId(hostId);
      if (id === LOCAL_HOST_ID) return undefined;
      const bridge = bridges.get(id);
      if (bridge === undefined) return undefined;
      if (bridge.getState().kind !== "ready") return undefined;
      const connection = bridge.connection();
      if (connection === undefined) return undefined;
      return {
        hostId: id,
        authenticatedFetch: (input) => connection.authenticatedFetch(input),
      };
    },

    async disconnectHost(hostId) {
      const id = decodeHostId(hostId);
      if (id === LOCAL_HOST_ID) {
        throw new Error(
          "Cannot disconnect the local This Mac transport via revoke; update the registry instead.",
        );
      }
      dropRemote(id);
      emit();
    },

    async fanOut(execute) {
      const slots = buildSlots();
      const settled = await Promise.allSettled(slots.map((slot) => execute(slot)));
      return settled.map(
        (result, index): HostFederationFanOutResult<Awaited<ReturnType<typeof execute>>> => {
          const hostId = slots[index]!.hostId;
          if (result.status === "fulfilled") {
            return { hostId, status: "fulfilled", value: result.value };
          }
          return { hostId, status: "rejected", reason: result.reason };
        },
      );
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    disconnectAll() {
      for (const hostId of [...bridges.keys()]) {
        dropRemote(hostId);
      }
      localRegistration = undefined;
      emit();
    },
  };
}
