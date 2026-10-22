import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createExpoSecureDeviceKeyStore,
  createInMemoryExpoSecureStringStorage,
  PLATFORM_LISTENER_TRUST,
} from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryMobileHostRegistryStorage,
  createMobileHostRegistry,
} from "../hosts/HostRegistry";
import {
  disconnectLiveMobileSession,
  createMobileHostRemover,
  removeMobileHost,
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
        new Promise<{ readonly kind: "ok"; readonly hosts: typeof hosts }>((resolve) => {
          finishRead = () => resolve({ kind: "ok", hosts });
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
      registry: { list: async () => ({ kind: "ok" as const, hosts }) },
      hub,
      signal: new AbortController().signal,
    });
    expect(reopened).toEqual({ kind: "ok", hosts });
    expect(hub.syncRegistrations).toHaveBeenCalledExactlyOnceWith(hosts);
  });

  it("keeps live sessions when the stored host list cannot be read", async () => {
    const hub = { syncRegistrations: vi.fn() };
    const read = await refreshLiveMobileSession({
      registry: { list: async () => ({ kind: "unreadable" as const, reason: "corrupt" }) },
      hub,
      signal: new AbortController().signal,
    });

    expect(read).toEqual({ kind: "unreadable", reason: "corrupt" });
    expect(hub.syncRegistrations).not.toHaveBeenCalled();
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
      hostKeyFingerprint: registration.hostKeyFingerprint,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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

  describe("removing a host", () => {
    const firstHostId = "00000000-0000-4000-8000-000000000001";
    const secondHostId = "00000000-0000-4000-8000-000000000002";

    async function pairTwoHosts() {
      const storage = createInMemoryExpoSecureStringStorage();
      const deviceKeyStore = createExpoSecureDeviceKeyStore({ storage });
      const registry = createMobileHostRegistry(createInMemoryMobileHostRegistryStorage());
      const hub = { syncRegistrations: vi.fn() };
      for (const [hostId, origin] of [
        [firstHostId, "https://first.example"],
        [secondHostId, "https://second.example"],
      ] as const) {
        const keyPair = (await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        )) as CryptoKeyPair;
        const keyId = await deviceKeyStore.set(keyPair, {
          origin,
          hostId: decodeStableHostId(hostId),
          deviceId: `device-${hostId}`,
        });
        await deviceKeyStore.updateMetadata(keyId, {
          deviceId: `device-${hostId}`,
          credentialGeneration: 1,
          hostKeyFingerprint: "fingerprint",
          listenerTrust: PLATFORM_LISTENER_TRUST,
        });
        await registry.upsert({
          hostId,
          origin,
          label: origin,
          keyId,
          credentialGeneration: 1,
          hostKeyFingerprint: "fingerprint",
        });
      }
      return { storage, deviceKeyStore, registry, hub };
    }

    it("leaves no device key for the removed host and keeps the other host's key", async () => {
      const { storage, deviceKeyStore, registry, hub } = await pairTwoHosts();
      const listed = await registry.list();
      const [first, second] = listed.kind === "ok" ? listed.hosts : [];

      const result = await removeMobileHost({ hostId: firstHostId, registry, hub, deviceKeyStore });

      expect(result).toEqual({ localCredentialRemoved: true });
      expect(await registry.get(firstHostId)).toBeUndefined();
      expect(await deviceKeyStore.get(first!.keyId)).toBeUndefined();
      expect(await deviceKeyStore.findByOrigin(first!.origin)).toBeUndefined();
      expect(await storage.getItem("octant.remote.device-keys.v1")).not.toContain(first!.keyId);
      expect(await deviceKeyStore.get(second!.keyId)).toBeDefined();
      expect(await deviceKeyStore.findByOrigin(second!.origin)).toBeDefined();
    });

    it("removes a host that cannot be reached without sending anything to it", async () => {
      const { storage, deviceKeyStore, registry, hub } = await pairTwoHosts();
      const unreachable = vi.fn(async () => {
        throw new TypeError("Network request failed");
      });
      vi.stubGlobal("fetch", unreachable);
      try {
        const first = await registry.get(firstHostId);

        const result = await removeMobileHost({
          hostId: firstHostId,
          registry,
          hub,
          deviceKeyStore,
        });

        expect(result).toEqual({ localCredentialRemoved: true });
        expect(unreachable).not.toHaveBeenCalled();
        expect(await registry.get(firstHostId)).toBeUndefined();
        expect(await storage.getItem("octant.remote.device-keys.v1")).not.toContain(first!.keyId);
        const remaining = await registry.list();
        expect(remaining.kind === "ok" ? remaining.hosts.map((host) => host.hostId) : []).toEqual([
          secondHostId,
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps both hosts removed when two removals are started back to back", async () => {
      const { storage, deviceKeyStore, registry, hub } = await pairTwoHosts();
      const remove = createMobileHostRemover({ registry, hub, deviceKeyStore });

      await Promise.all([remove(firstHostId), remove(secondHostId)]);

      expect(await registry.list()).toEqual({ kind: "ok", hosts: [] });
      expect(await storage.getItem("octant.remote.device-keys.v1")).toBeNull();
    });

    it("stops the removed host's session before its key is deleted", async () => {
      const { deviceKeyStore, registry, hub } = await pairTwoHosts();
      const keyStillStoredAtSync: boolean[] = [];
      const first = await registry.get(firstHostId);
      hub.syncRegistrations.mockImplementation(async () => {
        keyStillStoredAtSync.push((await deviceKeyStore.get(first!.keyId)) !== undefined);
      });

      await removeMobileHost({ hostId: firstHostId, registry, hub, deviceKeyStore });

      expect(hub.syncRegistrations).toHaveBeenCalledOnce();
      expect(
        hub.syncRegistrations.mock.calls[0]?.[0].map((host: { hostId: string }) => host.hostId),
      ).toEqual([secondHostId]);
      expect(keyStillStoredAtSync).toEqual([true]);
    });

    it("reports a key that could not be deleted after the host has left the list", async () => {
      const { registry, hub } = await pairTwoHosts();

      const result = await removeMobileHost({
        hostId: firstHostId,
        registry,
        hub,
        deviceKeyStore: {
          remove: async () => {
            throw new Error("secure storage unavailable");
          },
        },
      });

      expect(result).toEqual({ localCredentialRemoved: false });
      expect(await registry.get(firstHostId)).toBeUndefined();
      expect(await registry.get(secondHostId)).toBeDefined();
    });
  });
});
