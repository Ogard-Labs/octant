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
  it("reaches a pinned host only through the pinned transport, held to its recorded trust", async () => {
    const trust: ListenerOriginTrust = { current: { kind: "pinned", pin: PIN } };
    const phone = setup(storeWith({ [PINNED_ORIGIN]: trust }));

    const response = await phone.fetch(`${PINNED_ORIGIN}/api/remote/session`, { method: "POST" });

    await expect(response.text()).resolves.toBe("pinned");
    expect(phone.pinnedTransport).toHaveBeenCalledWith({ origin: PINNED_ORIGIN, trust });
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
