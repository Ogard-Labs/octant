import {
  LOCAL_HOST_ID,
  decodeHostId,
  type HostHealth,
  type HostId,
  type HostIdentity,
} from "@octant/contracts/host";
import {
  forgetHostCredential,
  type ClientHostKind,
  type ClientHostRegistration,
  type ClientHostRegistry,
} from "./hostFederationRegistry";
import type { FederatedTransportState, HostFederationTransports } from "./hostFederationTransports";
import {
  mergeAllHostsReadModels,
  rejectQueuedAuthorityMutation,
  type AuthorityMutationDecision,
  type FederatedHostReadFreshness,
  type FederatedHostState,
  type HostReadModelCache,
} from "./hostFederationMergedReads";
import type { RemoteDeviceKeyStore } from "./remotePairingClient";
import type { RemoteSessionBridge } from "./remoteSessionBridge";
import { remoteRevokeSelf, type RemoteRevokeSelfResult } from "./remoteDeviceSelfService";

/**
 * Per-host compatibility / auth / expiry / reconnect / revocation lifecycle
 * for Post-preview B6.
 *
 * One host failing, expiring, or being revoked never blocks healthy hosts or
 * the shell. Stale caches stay read-only; mutations are never queued.
 */

/** Design §8 vocabulary. Maps to HostHealth via `mapLifecycleStateToHostHealth`. */
export type FederatedHostLifecycleState =
  | "connecting"
  | "ready"
  | "stale"
  | "incompatible"
  | "unauthorized"
  | "unavailable";

export type FederatedHostLifecycleReasonCode =
  | "expired"
  | "revoked"
  | "lost-key"
  | "host-changed"
  | "offline"
  | "incompatible";

export interface FederatedHostLifecycleActions {
  readonly canReconnect: boolean;
  readonly canRevoke: boolean;
  readonly canRemove: boolean;
}

export interface FederatedHostLifecycleExpiry {
  /** True when the host credential/session is known expired. */
  readonly expired: boolean;
  readonly expiresAt?: string;
}

export interface FederatedHostLifecycleSnapshot {
  readonly hostId: HostId;
  readonly kind: ClientHostKind;
  readonly displayName: string;
  readonly state: FederatedHostLifecycleState;
  /** Shared HostHealth vocabulary (`ready` → `healthy`). */
  readonly health: HostHealth;
  readonly reason?: string;
  readonly reasonCode?: FederatedHostLifecycleReasonCode;
  readonly actions: FederatedHostLifecycleActions;
  readonly expiry?: FederatedHostLifecycleExpiry;
  /** Last known durable replay cursor for this host (reconnect resume hint). */
  readonly replayCursor?: string;
  readonly lastReadyAt?: string;
}

export interface HostFederationReconnectResult {
  readonly ok: boolean;
  readonly hostId: HostId;
  readonly replayCursor?: string;
  readonly reason?: string;
}

export interface HostFederationRevokeResult {
  readonly ok: boolean;
  readonly hostId: HostId;
  readonly localCredentialRemoved: boolean;
  readonly warning?: string;
}

export interface HostFederationRemoveResult {
  readonly ok: boolean;
  readonly hostId: HostId;
  readonly localCredentialRemoved: boolean;
}

export interface HostFederationLifecycleOptions {
  readonly registry: ClientHostRegistry;
  readonly transports: HostFederationTransports;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly cache?: HostReadModelCache;
  /**
   * Injectable revoke-self for tests. Production defaults to
   * `remoteRevokeSelf` against the host's session bridge.
   */
  readonly revokeSelf?: (bridge: RemoteSessionBridge) => Promise<RemoteRevokeSelfResult>;
}

export interface HostFederationRevokeOptions {
  readonly revokeSelf?: (bridge: RemoteSessionBridge) => Promise<RemoteRevokeSelfResult>;
}

export interface HostFederationLifecycle {
  /** Rebuild snapshots from registry + transports. */
  readonly sync: () => Promise<void>;
  /** Recompute from current transport states (after bridge events). */
  readonly observeTransportChange: () => void;
  readonly list: () => ReadonlyArray<FederatedHostLifecycleSnapshot>;
  readonly get: (hostId: HostId | string) => FederatedHostLifecycleSnapshot | undefined;
  /**
   * Reconnect one host. Resumes that host's session from its durable replay
   * cursor metadata without touching other hosts.
   */
  readonly reconnect: (hostId: HostId | string) => Promise<HostFederationReconnectResult>;
  /**
   * Host-side revoke-self (when possible) then clear only that host's local
   * credential, registry entry, transport, and cache.
   */
  readonly revoke: (
    hostId: HostId | string,
    options?: HostFederationRevokeOptions,
  ) => Promise<HostFederationRevokeResult>;
  /**
   * Remove a remote host locally without host-side revoke. Never removes
   * the local host.
   */
  readonly removeLocal: (hostId: HostId | string) => Promise<HostFederationRemoveResult>;
  /** Authority-bearing mutation gate — never queues offline work. */
  readonly mutationDecision: (hostId: HostId | string, action: string) => AuthorityMutationDecision;
  readonly toHostIdentities: () => ReadonlyArray<HostIdentity>;
  /**
   * All-hosts completeness: every registered host gets a row, connected or
   * not. A host that has never been fetched is empty rather than absent.
   */
  readonly toFederatedHostStates: () => ReadonlyArray<FederatedHostState>;
  readonly subscribe: (listener: () => void) => () => void;
}

export function federatedLifecycleStateFromTransport(
  state: FederatedTransportState,
): FederatedHostLifecycleState {
  switch (state.kind) {
    case "local-ready":
    case "ready":
      return "ready";
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
    case "idle":
      return "unavailable";
  }
}

export function mapLifecycleStateToHostHealth(state: FederatedHostLifecycleState): HostHealth {
  switch (state) {
    case "ready":
      return "healthy";
    case "connecting":
      return "connecting";
    case "stale":
      return "stale";
    case "incompatible":
      return "incompatible";
    case "unauthorized":
      return "unauthorized";
    case "unavailable":
      return "unavailable";
  }
}

function freshnessForLifecycle(state: FederatedHostLifecycleState): FederatedHostReadFreshness {
  return state === "ready" ? "ready" : state;
}

function reasonFromTransport(state: FederatedTransportState): string | undefined {
  if ("reason" in state && typeof state.reason === "string") return state.reason;
  return undefined;
}

function reasonCodeFromTransport(
  state: FederatedTransportState,
): FederatedHostLifecycleReasonCode | undefined {
  if (state.kind === "unauthorized" && "reasonCode" in state && state.reasonCode !== undefined) {
    return state.reasonCode;
  }
  if (state.kind === "incompatible") return "incompatible";
  if (state.kind === "unavailable" || state.kind === "idle") return "offline";
  return undefined;
}

function actionsFor(input: {
  readonly kind: ClientHostKind;
  readonly state: FederatedHostLifecycleState;
  readonly reasonCode?: FederatedHostLifecycleReasonCode;
}): FederatedHostLifecycleActions {
  const canRemove = input.kind === "remote";
  const terminalAuth =
    input.state === "unauthorized" &&
    (input.reasonCode === "expired" ||
      input.reasonCode === "revoked" ||
      input.reasonCode === "lost-key" ||
      input.reasonCode === "host-changed");
  const canReconnect =
    input.kind === "remote" &&
    !terminalAuth &&
    (input.state === "stale" || input.state === "unavailable" || input.state === "connecting");
  const canRevoke = input.kind === "remote" && input.state === "ready";
  return { canReconnect, canRevoke, canRemove };
}

function expiryFor(input: {
  readonly state: FederatedHostLifecycleState;
  readonly reasonCode?: FederatedHostLifecycleReasonCode;
}): FederatedHostLifecycleExpiry | undefined {
  if (input.reasonCode === "expired") {
    return { expired: true };
  }
  if (input.reasonCode === "revoked") {
    return { expired: false };
  }
  return undefined;
}

function snapshotFrom(input: {
  readonly registration: ClientHostRegistration;
  readonly transportState: FederatedTransportState | undefined;
}): FederatedHostLifecycleSnapshot {
  const state =
    input.transportState !== undefined
      ? federatedLifecycleStateFromTransport(input.transportState)
      : input.registration.enabled
        ? "unavailable"
        : "unavailable";
  const reason =
    input.transportState !== undefined ? reasonFromTransport(input.transportState) : undefined;
  const reasonCode =
    input.transportState !== undefined
      ? reasonCodeFromTransport(input.transportState)
      : ("offline" as const);
  const actions = actionsFor({
    kind: input.registration.kind,
    state,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  });
  const expiry = expiryFor({
    state,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  });
  return {
    hostId: input.registration.hostId,
    kind: input.registration.kind,
    displayName: input.registration.displayName,
    state,
    health: mapLifecycleStateToHostHealth(state),
    ...(reason !== undefined ? { reason } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    actions,
    ...(expiry !== undefined ? { expiry } : {}),
    ...(input.registration.cacheMetadata?.lastReplayCursor !== undefined
      ? { replayCursor: input.registration.cacheMetadata.lastReplayCursor }
      : {}),
    ...(input.registration.cacheMetadata?.lastReadyAt !== undefined
      ? { lastReadyAt: input.registration.cacheMetadata.lastReadyAt }
      : {}),
  };
}

export function createHostFederationLifecycle(
  options: HostFederationLifecycleOptions,
): HostFederationLifecycle {
  const listeners = new Set<() => void>();
  let snapshots: FederatedHostLifecycleSnapshot[] = [];
  let registrations = new Map<string, ClientHostRegistration>();
  let transportUnsubscribe: (() => void) | undefined;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Every registered host gets a cache row, connected or not, so it never
   * drops out of `hostStates`. A host with fetched items presents `stale` on
   * disconnect regardless of the specific cause (existing behavior); a host
   * that has never been fetched seeds an empty row at its own lifecycle
   * freshness so a person can see it waiting rather than see nothing.
   */
  const markCacheForState = (input: {
    readonly hostId: HostId;
    readonly displayName: string;
    readonly state: FederatedHostLifecycleState;
  }) => {
    if (options.cache === undefined) return;
    if (input.state === "ready") {
      const existing = options.cache.get(input.hostId);
      options.cache.put({
        hostId: input.hostId,
        hostDisplayName: input.displayName,
        freshness: "ready",
        items: existing?.items ?? [],
      });
      return;
    }
    const existing = options.cache.get(input.hostId);
    if (existing !== undefined && existing.items.length > 0) {
      options.cache.markStale(input.hostId);
      return;
    }
    // Ready-empty → unavailable must refresh freshness, not keep "ready".
    options.cache.put({
      hostId: input.hostId,
      hostDisplayName: input.displayName,
      freshness: freshnessForLifecycle(input.state),
      items: existing?.items ?? [],
    });
  };

  const rebuildFromTransports = () => {
    const next: FederatedHostLifecycleSnapshot[] = [];
    for (const registration of registrations.values()) {
      const slot = options.transports.get(registration.hostId);
      const snapshot = snapshotFrom({
        registration,
        transportState: slot?.state,
      });
      next.push(snapshot);
      markCacheForState({
        hostId: snapshot.hostId,
        displayName: snapshot.displayName,
        state: snapshot.state,
      });
    }
    next.sort((left, right) => {
      if (left.hostId === LOCAL_HOST_ID) return -1;
      if (right.hostId === LOCAL_HOST_ID) return 1;
      return left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0;
    });
    snapshots = next;
    emit();
  };

  const ensureTransportSubscription = () => {
    if (transportUnsubscribe !== undefined) return;
    transportUnsubscribe = options.transports.subscribe(() => {
      rebuildFromTransports();
    });
  };

  const clearHostLocally = async (
    hostId: HostId,
  ): Promise<{
    readonly localCredentialRemoved: boolean;
  }> => {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error("Cannot remove the local host from the federation lifecycle.");
    }
    const registration = registrations.get(hostId) ?? (await options.registry.get(hostId));
    await options.transports.disconnectHost(hostId);
    const removed = await options.registry.removeRemote(hostId);
    const handle = removed?.credential ?? registration?.credential;
    let localCredentialRemoved = true;
    try {
      await forgetHostCredential(options.deviceKeyStore, handle);
    } catch {
      localCredentialRemoved = false;
    }
    options.cache?.remove(hostId);
    registrations.delete(hostId);
    rebuildFromTransports();
    return { localCredentialRemoved };
  };

  return {
    async sync() {
      const listed = await options.registry.list();
      registrations = new Map(listed.map((entry) => [entry.hostId as string, entry]));
      await options.transports.syncEnabledHosts();
      ensureTransportSubscription();
      rebuildFromTransports();
    },

    observeTransportChange() {
      rebuildFromTransports();
    },

    list() {
      return snapshots;
    },

    get(hostId) {
      const id = decodeHostId(hostId);
      return snapshots.find((entry) => entry.hostId === id);
    },

    async reconnect(hostId) {
      const id = decodeHostId(hostId);
      if (id === LOCAL_HOST_ID) {
        return {
          ok: false,
          hostId: id,
          reason: "The local host does not reconnect through the remote session bridge.",
        };
      }
      const snapshot = snapshots.find((entry) => entry.hostId === id);
      if (snapshot === undefined) {
        return { ok: false, hostId: id, reason: `Unknown host ${id}.` };
      }
      if (!snapshot.actions.canReconnect) {
        return {
          ok: false,
          hostId: id,
          reason:
            snapshot.reasonCode === "expired" || snapshot.reasonCode === "revoked"
              ? `Host ${id} requires re-pairing (${snapshot.reasonCode}).`
              : `Host ${id} is ${snapshot.state} and cannot reconnect.`,
        };
      }
      const slot = options.transports.get(id);
      const bridge = slot?.bridge;
      if (bridge === undefined) {
        return { ok: false, hostId: id, reason: `No transport bridge for host ${id}.` };
      }
      const replayCursor = snapshot.replayCursor;
      bridge.reconnect();
      rebuildFromTransports();
      return {
        ok: true,
        hostId: id,
        ...(replayCursor !== undefined ? { replayCursor } : {}),
      };
    },

    async revoke(hostId, revokeOptions) {
      const id = decodeHostId(hostId);
      if (id === LOCAL_HOST_ID) {
        throw new Error("Cannot revoke the local host.");
      }
      const slot = options.transports.get(id);
      const bridge = slot?.bridge;
      const revokeSelf =
        revokeOptions?.revokeSelf ??
        options.revokeSelf ??
        ((sessionBridge: RemoteSessionBridge) => remoteRevokeSelf({ bridge: sessionBridge }));

      let warning: string | undefined;
      let revokedRemotely = false;
      if (
        bridge !== undefined &&
        snapshots.find((entry) => entry.hostId === id)?.state === "ready"
      ) {
        try {
          const remoteResult = await revokeSelf(bridge);
          revokedRemotely = true;
          if (!remoteResult.localCredentialRemoved && remoteResult.warning !== undefined) {
            warning = remoteResult.warning;
          }
        } catch (error) {
          // Host-side revoke is best-effort when isolating a bad host; local
          // cleanup still proceeds so the shell is not blocked.
          warning =
            error instanceof Error
              ? `Host revoke failed (${error.message}); cleared local credential and cache.`
              : "Host revoke failed; cleared local credential and cache.";
        }
      }

      const cleared = await clearHostLocally(id);
      return {
        ok: true,
        hostId: id,
        localCredentialRemoved: cleared.localCredentialRemoved || revokedRemotely,
        ...(warning !== undefined ? { warning } : {}),
      };
    },

    async removeLocal(hostId) {
      const id = decodeHostId(hostId);
      const cleared = await clearHostLocally(id);
      return {
        ok: true,
        hostId: id,
        localCredentialRemoved: cleared.localCredentialRemoved,
      };
    },

    mutationDecision(hostId, action) {
      const id = decodeHostId(hostId);
      const snapshot = snapshots.find((entry) => entry.hostId === id);
      const freshness = freshnessForLifecycle(snapshot?.state ?? "unavailable");
      return rejectQueuedAuthorityMutation({ hostId: id, freshness, action });
    },

    toHostIdentities() {
      return snapshots.map((entry) => ({
        hostId: entry.hostId,
        displayName: entry.displayName,
        health: entry.health,
        capabilities:
          entry.kind === "local"
            ? ["chat", "work", "code"]
            : (registrations.get(entry.hostId)?.lastKnownCapabilities ?? ["chat", "work", "code"]),
      }));
    },

    toFederatedHostStates() {
      if (options.cache !== undefined) {
        return mergeAllHostsReadModels(options.cache.list()).hostStates;
      }
      return snapshots.map((entry) => ({
        hostId: entry.hostId,
        hostDisplayName: entry.displayName,
        freshness: freshnessForLifecycle(entry.state),
        itemCount: 0,
      }));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
