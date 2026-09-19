import { decodeStableHostId } from "@octant/contracts/remote-access";
import { describe, expect, it, vi } from "vitest";
import {
  disconnectLiveMobileSession,
  refreshLiveMobileSession,
  finishLiveMobilePairing,
} from "./mobileSessionLifecycle";

describe("live mobile session lifecycle", () => {
  it("does not reconnect when a saved-host read completes after the vault closes", async () => {
    const hosts = [
      {
        hostId: "host",
        origin: "https://host.example",
        label: "Host",
        keyId: "key",
        credentialGeneration: 1,
        hostKeyFingerprint: "fingerprint",
      },
    ];
    let finishRead = () => {};
    const registry = {
      list: () =>
        new Promise<typeof hosts>((resolve) => {
          finishRead = () => resolve(hosts);
        }),
    };
    const hub = { syncRegistrations: vi.fn() };
    const lifetime = new AbortController();
    const refreshing = refreshLiveMobileSession({ registry, hub, signal: lifetime.signal });
    lifetime.abort();
    finishRead();
    expect(await refreshing).toBeUndefined();
    expect(hub.syncRegistrations).not.toHaveBeenCalled();
    const reopened = await refreshLiveMobileSession({
      registry: { list: async () => hosts },
      hub,
      signal: new AbortController().signal,
    });
    expect(reopened).toEqual(hosts);
    expect(hub.syncRegistrations).toHaveBeenCalledExactlyOnceWith(hosts);
  });

  it("saves an approved pairing without connecting if the vault closes during the save", async () => {
    const registration = {
      hostId: "00000000-0000-4000-8000-000000000001",
      origin: "https://host.example",
      label: "Host",
      keyId: "key",
      credentialGeneration: 1,
      hostKeyFingerprint: "fingerprint",
    };
    const approval = {
      ticketId: "ticket",
      hostId: decodeStableHostId(registration.hostId),
      deviceId: "device",
      deviceKeyId: "key",
      credentialGeneration: 1,
      origin: registration.origin,
    };
    let saved = () => {};
    const registry = {
      upsert: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            saved = resolve;
          }),
      ),
    };
    const bridge = { connect: vi.fn() };
    const lifetime = new AbortController();
    const pending = finishLiveMobilePairing({
      registry,
      registration,
      approval,
      bridge,
      signal: lifetime.signal,
    });
    lifetime.abort();
    saved();
    expect(await pending).toBe(false);
    expect(registry.upsert).toHaveBeenCalledWith(registration);
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(
      await finishLiveMobilePairing({
        registry: { upsert: async () => {} },
        registration,
        approval,
        bridge,
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    expect(bridge.connect).toHaveBeenCalledExactlyOnceWith(approval);
  });

  it("disconnects the dedicated bridge and every host bridge during vault teardown", () => {
    const bridge = { disconnect: vi.fn() };
    const hub = { disconnectAll: vi.fn() };

    disconnectLiveMobileSession({ bridge, hub });

    expect(bridge.disconnect).toHaveBeenCalledOnce();
    expect(hub.disconnectAll).toHaveBeenCalledOnce();
  });
});
