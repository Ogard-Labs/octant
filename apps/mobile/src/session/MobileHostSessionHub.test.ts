import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteSessionBridge,
  type RemoteDeviceKeyStore,
  type RemoteSessionBridge,
  type RemoteSessionBridgeState,
} from "@octant/client-runtime";
import { createMobileHostSessionHub } from "./MobileHostSessionHub";
import type { MobileHostRegistration } from "../hosts/HostRegistry";

vi.mock("@octant/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octant/client-runtime")>();
  return {
    ...actual,
    createRemoteSessionBridge: vi.fn((options: { deviceKeyStore: RemoteDeviceKeyStore }) => {
      let state: RemoteSessionBridgeState = { kind: "idle" };
      const listeners = new Set<(next: RemoteSessionBridgeState) => void>();
      const bridge = {
        getState: () => state,
        subscribe: (listener: (next: RemoteSessionBridgeState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        connect: vi.fn(),
        resume: vi.fn((origin: string) => {
          state = {
            kind: "ready",
            hostId: origin.includes("studio") ? "host-studio" : "host-b",
            displayName: origin.includes("studio") ? "Studio" : "Laptop",
          };
          for (const listener of listeners) listener(state);
        }),
        forgetDeviceKey: vi.fn(async () => undefined),
        stageDeviceKeyRotation: vi.fn(async () => {
          throw new Error("Device key rotation is not part of this test double.");
        }),
        reconnect: vi.fn(),
        disconnect: vi.fn(() => {
          state = { kind: "idle" };
        }),
        connection: vi.fn(() => undefined),
      } satisfies RemoteSessionBridge;
      void options;
      return bridge;
    }),
  };
});

const studio: MobileHostRegistration = {
  hostId: "host-studio",
  origin: "https://studio.example",
  label: "Studio",
  keyId: "key-a",
  credentialGeneration: 1,
  hostKeyFingerprint: "fp-a",
};

const laptop: MobileHostRegistration = {
  hostId: "host-laptop",
  origin: "https://laptop.example",
  label: "Laptop",
  keyId: "key-b",
  credentialGeneration: 1,
  hostKeyFingerprint: "fp-b",
};

describe("MobileHostSessionHub", () => {
  beforeEach(() => {
    vi.mocked(createRemoteSessionBridge).mockClear();
  });

  it("resumes each registered host and reports health independently", () => {
    const hub = createMobileHostSessionHub({
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      webBuildVersion: "Octant-mobile/0.1.0",
    });
    hub.syncRegistrations([studio, laptop]);
    expect(hub.slots()).toHaveLength(2);
    expect(
      hub
        .health()
        .map((entry) => entry.label)
        .sort(),
    ).toEqual(["Laptop", "Studio"]);
    expect(hub.health().every((entry) => entry.kind === "ready")).toBe(true);
  });

  it("disconnects only the removed host when the registry shrinks", () => {
    const hub = createMobileHostSessionHub({
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      webBuildVersion: "Octant-mobile/0.1.0",
    });
    hub.syncRegistrations([studio, laptop]);
    const laptopBridge = hub.bridgeForOrigin(laptop.origin)!;
    hub.syncRegistrations([studio]);
    expect(hub.slots()).toHaveLength(1);
    expect(hub.slots()[0]?.registration.hostId).toBe("host-studio");
    expect(laptopBridge.disconnect).toHaveBeenCalled();
    expect(hub.bridgeForOrigin(studio.origin)?.disconnect).not.toHaveBeenCalled();
  });

  it("recreates a host bridge when its credential generation advances", () => {
    const hub = createMobileHostSessionHub({
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      webBuildVersion: "Octant-mobile/0.1.0",
    });
    hub.syncRegistrations([studio]);
    const originalBridge = hub.bridgeForOrigin(studio.origin);

    hub.syncRegistrations([
      {
        ...studio,
        credentialGeneration: 2,
        keyId: "key-a-rotated",
        hostKeyFingerprint: "fp-a-rotated",
      },
    ]);

    const refreshedBridge = hub.bridgeForOrigin(studio.origin);
    expect(refreshedBridge).toBeDefined();
    expect(refreshedBridge).not.toBe(originalBridge);
    expect(originalBridge?.disconnect).toHaveBeenCalledOnce();
    expect(refreshedBridge?.resume).toHaveBeenCalledWith(studio.origin);
    expect(hub.slots()[0]?.registration.credentialGeneration).toBe(2);
    expect(vi.mocked(createRemoteSessionBridge)).toHaveBeenCalledTimes(2);
  });

  it("reuses a host bridge while its credential generation is unchanged", () => {
    const hub = createMobileHostSessionHub({
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      webBuildVersion: "Octant-mobile/0.1.0",
    });
    hub.syncRegistrations([studio]);
    const originalBridge = hub.bridgeForOrigin(studio.origin);

    hub.syncRegistrations([{ ...studio, label: "Studio renamed" }]);

    expect(hub.bridgeForOrigin(studio.origin)).toBe(originalBridge);
    expect(originalBridge?.disconnect).not.toHaveBeenCalled();
    expect(vi.mocked(createRemoteSessionBridge)).toHaveBeenCalledOnce();
  });
});
