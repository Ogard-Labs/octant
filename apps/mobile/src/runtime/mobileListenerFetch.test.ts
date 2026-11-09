import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryDeviceKeyStore,
  type ListenerOriginTrust,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createMobileListenerFetch } from "./mobileListenerFetch";

const PINNED_ORIGIN = "https://100.101.102.103:8443";
const PIN = `sha256-${Buffer.alloc(32, 1).toString("base64url")}`;

function storeWith(trusts: Record<string, ListenerOriginTrust>): RemoteDeviceKeyStore {
  const store = createInMemoryDeviceKeyStore();
  return {
    ...store,
    findByOrigin: async (origin) => {
      const trust = trusts[origin];
      if (trust === undefined) return undefined;
      return {
        keyId: "key",
        origin,
        hostId: decodeStableHostId("11111111-1111-4111-8111-111111111111"),
        deviceId: "device",
        credentialGeneration: 1,
        hostKeyFingerprint: "f".repeat(64),
        listenerTrust: trust,
      };
    },
  };
}

function setup(store: RemoteDeviceKeyStore, available = true) {
  const pinnedFetch = vi.fn(async () => new Response("pinned"));
  const pinnedTransport = vi.fn<PinnedListenerTransportPort>(() =>
    available ? { status: "available", fetch: pinnedFetch } : { status: "unavailable" },
  );
  const platformFetch = vi.fn(async () => new Response("platform"));
  const fetch = createMobileListenerFetch({
    deviceKeyStore: store,
    pinnedTransport,
    platformFetch,
  });
  return { fetch, pinnedFetch, pinnedTransport, platformFetch };
}

describe("the phone's session fetch", () => {
  it("persists only the listener trust and refuses a late response after the device key is forgotten", async () => {
    const store = createInMemoryDeviceKeyStore();
    const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const keyId = await store.set(pair, { origin: PINNED_ORIGIN, hostId });
    const previous: ListenerOriginTrust = { current: { kind: "pinned", pin: PIN } };
    const next: ListenerOriginTrust = {
      ...previous,
      staged: {
        trust: { kind: "pinned", pin: `sha256-${"B".repeat(43)}` },
        until: "2026-11-14T10:00:00.000Z",
      },
    };
    await store.updateMetadata(keyId, {
      deviceId: "device",
      credentialGeneration: 1,
      hostKeyFingerprint: "f".repeat(64),
      listenerTrust: previous,
    });
    const phone = setup(store);
    await phone.fetch(`${PINNED_ORIGIN}/api/remote/hello`);
    const call = phone.pinnedTransport.mock.calls[0]?.[0];
    if (call?.onTrust === undefined) throw new Error("expected trust persistence");
    await store.updateMetadata(keyId, {
      deviceId: "device",
      credentialGeneration: 2,
      hostKeyFingerprint: "f".repeat(64),
      listenerTrust: previous,
    });
    await call.onTrust(previous, next);
    expect(await store.findByOrigin(PINNED_ORIGIN)).toMatchObject({
      credentialGeneration: 2,
      listenerTrust: next,
    });
    await store.remove(keyId);
    await expect(call.onTrust(previous, next)).rejects.toThrow("pairing changed");
    expect(await store.findByOrigin(PINNED_ORIGIN)).toBeUndefined();
    expect(phone.platformFetch).not.toHaveBeenCalled();
  });
  it("reaches a pinned host only through the pinned transport, held to its recorded trust", async () => {
    const trust: ListenerOriginTrust = { current: { kind: "pinned", pin: PIN } };
    const phone = setup(storeWith({ [PINNED_ORIGIN]: trust }));

    const response = await phone.fetch(`${PINNED_ORIGIN}/api/remote/session`, { method: "POST" });

    await expect(response.text()).resolves.toBe("pinned");
    expect(phone.pinnedTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: PINNED_ORIGIN,
        trust,
        hostId: "11111111-1111-4111-8111-111111111111",
        onTrust: expect.any(Function),
      }),
    );
    expect(phone.platformFetch).not.toHaveBeenCalled();
  });

  it("refuses a pinned host rather than use the platform fetch when no pinned transport exists", async () => {
    const phone = setup(
      storeWith({ [PINNED_ORIGIN]: { current: { kind: "pinned", pin: PIN } } }),
      false,
    );

    await expect(phone.fetch(`${PINNED_ORIGIN}/api/remote/session`)).rejects.toThrow(
      "can't check that computer's own certificate",
    );
    expect(phone.platformFetch).not.toHaveBeenCalled();
  });

  it("refuses when the pairing record cannot be read, rather than fall back", async () => {
    const store: RemoteDeviceKeyStore = {
      ...createInMemoryDeviceKeyStore(),
      findByOrigin: async () => {
        throw new Error("secure storage locked");
      },
    };
    const phone = setup(store);

    await expect(phone.fetch(`${PINNED_ORIGIN}/api/remote/session`)).rejects.toThrow(
      "secure storage locked",
    );
    expect(phone.platformFetch).not.toHaveBeenCalled();
    expect(phone.pinnedFetch).not.toHaveBeenCalled();
  });

  it("uses the platform fetch for a host paired with a certificate the platform trusts", async () => {
    const origin = "https://studio.tail1234.ts.net";
    const phone = setup(storeWith({ [origin]: { current: { kind: "platform" } } }));

    await phone.fetch(`${origin}/api/remote/session`);

    expect(phone.platformFetch).toHaveBeenCalledTimes(1);
    expect(phone.pinnedTransport).not.toHaveBeenCalled();
  });
});
