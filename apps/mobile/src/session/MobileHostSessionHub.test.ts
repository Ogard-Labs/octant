import { describe, expect, it, vi } from "vitest";
import type {
  RemoteDeviceKeyStore,
  RemoteSessionBridge,
  RemoteSessionBridgeState,
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
});
