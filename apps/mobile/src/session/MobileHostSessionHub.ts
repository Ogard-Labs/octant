import {
  createConnectionSupervisor,
  createRemoteSessionBridge,
  type ConnectionSupervisor,
  type RemoteDeviceKeyStore,
  type RemoteSessionBridge,
  type RemoteSessionBridgeState,
} from "@octant/client-runtime";
import type { MobileHostRegistration } from "../hosts/HostRegistry";

export type MobileHostHealthKind =
  | "idle"
  | "connecting"
  | "ready"
  | "stale"
  | "unavailable"
  | "unauthorized"
  | "incompatible";

export interface MobileHostHealth {
  readonly hostId: string;
  readonly origin: string;
  readonly label: string;
  readonly kind: MobileHostHealthKind;
  readonly detail?: string;
}

export interface MobileHostSessionSlot {
  readonly registration: MobileHostRegistration;
  readonly bridge: RemoteSessionBridge;
  readonly supervisor: ConnectionSupervisor;
  readonly state: RemoteSessionBridgeState;
}

function healthKind(state: RemoteSessionBridgeState): MobileHostHealthKind {
  switch (state.kind) {
    case "idle":
      return "idle";
    case "connecting":
    case "negotiating":
    case "authenticating":
    case "reconnecting":
      return "connecting";
    case "ready":
      return "ready";
    case "stale":
      return "stale";
    case "unavailable":
      return "unavailable";
    case "unauthorized":
      return "unauthorized";
    case "incompatible":
      return "incompatible";
  }
}

export interface MobileHostSessionHub {
  readonly syncRegistrations: (registrations: ReadonlyArray<MobileHostRegistration>) => void;
  readonly slots: () => ReadonlyArray<MobileHostSessionSlot>;
  readonly health: () => ReadonlyArray<MobileHostHealth>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bridgeForOrigin: (origin: string) => RemoteSessionBridge | undefined;
  readonly supervisorForOrigin: (origin: string) => ConnectionSupervisor | undefined;
  readonly disconnectAll: () => void;
}

/**
 * One RemoteSessionBridge per paired host origin. Shared device key store;
 * revoke/remove of one origin does not disconnect the others.
 */
export function createMobileHostSessionHub(input: {
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly webBuildVersion: string;
}): MobileHostSessionHub {
  const bridges = new Map<string, RemoteSessionBridge>();
  const unsubscribers = new Map<string, () => void>();
  const supervisors = new Map<string, ConnectionSupervisor>();
  const registrations = new Map<string, MobileHostRegistration>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const removeBridge = (origin: string): void => {
    unsubscribers.get(origin)?.();
    unsubscribers.delete(origin);
    supervisors.get(origin)?.stop();
    supervisors.delete(origin);
    bridges.get(origin)?.disconnect();
    bridges.delete(origin);
  };

  const ensureBridge = (registration: MobileHostRegistration): RemoteSessionBridge => {
    const existing = bridges.get(registration.origin);
    if (existing !== undefined) return existing;
    const bridge = createRemoteSessionBridge({
      fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
      webBuildVersion: input.webBuildVersion,
      deviceKeyStore: input.deviceKeyStore,
    });
    const supervisor = createConnectionSupervisor({ bridge, origin: registration.origin });
    bridges.set(registration.origin, bridge);
    supervisors.set(registration.origin, supervisor);
    const unsubscribeBridge = bridge.subscribe(() => {
      emit();
    });
    const unsubscribeSupervisor = supervisor.subscribe(() => {
      emit();
    });
    unsubscribers.set(registration.origin, () => {
      unsubscribeBridge();
      unsubscribeSupervisor();
    });
    supervisor.start();
    return bridge;
  };

  return {
    syncRegistrations(next) {
      const nextOrigins = new Set(next.map((host) => host.origin));
      for (const origin of unsubscribers.keys()) {
        if (nextOrigins.has(origin)) continue;
        removeBridge(origin);
        registrations.delete(origin);
      }
      for (const registration of next) {
        const previous = registrations.get(registration.origin);
        if (
          previous !== undefined &&
          previous.credentialGeneration !== registration.credentialGeneration
        ) {
          removeBridge(registration.origin);
        }
        registrations.set(registration.origin, registration);
        ensureBridge(registration);
      }
      emit();
    },
    slots() {
      const result: MobileHostSessionSlot[] = [];
      for (const registration of registrations.values()) {
        const bridge = bridges.get(registration.origin);
        if (bridge === undefined) continue;
        const supervisor = supervisors.get(registration.origin);
        if (supervisor === undefined) continue;
        result.push({ registration, bridge, supervisor, state: bridge.getState() });
      }
      return result;
    },
    health() {
      return this.slots().map((slot) => {
        const kind = healthKind(slot.state);
        const detail =
          "reason" in slot.state && typeof slot.state.reason === "string"
            ? slot.state.reason
            : undefined;
        const supervisorStatus = slot.supervisor.status();
        const supervisorDetail =
          supervisorStatus.kind === "waiting-to-retry"
            ? "Reconnecting to this host."
            : supervisorStatus.kind === "offline"
              ? "Waiting for the network."
              : undefined;
        const detailParts: ReadonlyArray<string> = [detail, supervisorDetail].filter(
          (value): value is string => value !== undefined,
        );
        return {
          hostId: slot.registration.hostId,
          origin: slot.registration.origin,
          label: slot.registration.label,
          kind,
          ...(detailParts.length === 0
            ? {}
            : {
                detail: detailParts.join(" · "),
              }),
        };
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bridgeForOrigin(origin) {
      return bridges.get(origin);
    },
    supervisorForOrigin(origin) {
      return supervisors.get(origin);
    },
    disconnectAll() {
      for (const origin of unsubscribers.keys()) removeBridge(origin);
      registrations.clear();
      emit();
    },
  };
}
