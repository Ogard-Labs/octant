import {
  createRemoteSessionBridge,
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
  const registrations = new Map<string, MobileHostRegistration>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const removeBridge = (origin: string): void => {
    unsubscribers.get(origin)?.();
    unsubscribers.delete(origin);
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
    bridges.set(registration.origin, bridge);
    unsubscribers.set(
      registration.origin,
      bridge.subscribe(() => {
        emit();
      }),
    );
    bridge.resume(registration.origin);
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
        result.push({ registration, bridge, state: bridge.getState() });
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
        return {
          hostId: slot.registration.hostId,
          origin: slot.registration.origin,
          label: slot.registration.label,
          kind,
          ...(detail === undefined ? {} : { detail }),
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
    disconnectAll() {
      for (const origin of unsubscribers.keys()) removeBridge(origin);
      registrations.clear();
      emit();
    },
  };
}
