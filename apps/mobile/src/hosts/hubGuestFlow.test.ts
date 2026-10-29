import {
  NO_LISTENER_PIN,
  type HubMemberId,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  createGuestSigner,
  type GuestHubRecord,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyPair,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryMobileHostRegistryStorage, createMobileHostRegistry } from "./HostRegistry";
import { connectGuestSpokes, createGuestHubStore, finishGuestJoin } from "./hubGuestFlow";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}` as HubMemberId;
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

const member = (
  suffix: string,
  role: RosterMember["role"],
  extra: Partial<RosterMember> = {},
): RosterMember => ({
  memberId: id(suffix),
  name: `member ${suffix}`,
  role,
  identityKeyFingerprint: suffix.repeat(64).slice(0, 64),
  listenerPin: role === "guest" ? NO_LISTENER_PIN : "b".repeat(64),
  privateNames: [],
  addresses: [],
  owner: false,
  ...extra,
});

function roster(...members: ReadonlyArray<RosterMember>): SignedHubRoster {
  return {
    roster: { sequence: 2, members, standbyOrder: [], failoverAfterSeconds: 300 },
    signedBy: { kind: "hub", memberId: id("1") },
    signature: "signature",
  };
}

function recordWith(...spokes: ReadonlyArray<RosterMember>): GuestHubRecord {
  return {
    hub: {
      memberId: String(id("1")),
      name: "Mac mini",
      origin: "https://100.101.102.103:8443",
      pin: "sha256-HUB",
      rosterSigningPublicKey: "key",
    },
    selfMemberId: String(id("9")),
    deviceKeyId: "paired-key",
    roster: roster(
      member("1", "hub", { addresses: ["100.101.102.103"], listenerPort: 8443 }),
      member("9", "guest"),
      ...spokes,
    ),
  };
}

const laptop = member("2", "spoke", { addresses: ["100.101.102.104"], listenerPort: 8443 });
const studio = member("3", "spoke", { addresses: ["100.101.102.105"], listenerPort: 8443 });

async function setup(answers: Readonly<Record<string, "admit" | "refuse" | "down">>) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const signer = await createGuestSigner({ memberId: String(id("9")), keyPair });
  // The phone's key store hands a persisted key back non-extractable and can
  // only persist one it can export, so the paired key is restored that way.
  const restored: RemoteDeviceKeyPair = {
    publicKey: keyPair.publicKey,
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
  };
  const stored = new Map<string, { origin: string; metadata?: unknown }>();
  const deviceKeyStore = {
    get: async (keyId: string): Promise<RemoteDeviceKeyPair | undefined> =>
      keyId === "paired-key" ? restored : undefined,
    set: vi.fn(async (pair: RemoteDeviceKeyPair, options: { readonly origin: string }) => {
      await crypto.subtle.exportKey("pkcs8", pair.privateKey);
      const keyId = `key-${stored.size + 1}`;
      stored.set(keyId, { origin: options.origin });
      return keyId;
    }),
    copyKey: vi.fn(async (sourceKeyId: string, options: { readonly origin: string }) => {
      if (sourceKeyId !== "paired-key") return undefined;
      const keyId = `key-${stored.size + 1}`;
      stored.set(keyId, { origin: options.origin });
      return keyId;
    }),
    remove: vi.fn(async (keyId: string) => {
      stored.delete(keyId);
    }),
    updateMetadata: vi.fn(async (keyId: string, metadata: unknown) => {
      const held = stored.get(keyId);
      if (held !== undefined) stored.set(keyId, { ...held, metadata });
    }),
  } as unknown as RemoteDeviceKeyStore;
  const contacted: string[] = [];
  const transport: PinnedListenerTransportPort = ({ origin }) => ({
    status: "available",
    fetch: async () => {
      contacted.push(origin);
      const answer = Object.entries(answers).find(([host]) => origin.includes(host))?.[1];
      if (answer === "down" || answer === undefined) throw new Error("down");
      return answer === "refuse"
        ? Response.json({ status: "refused", kind: "guest-not-accepted" }, { status: 403 })
        : Response.json({ spokeMemberId: String(id("2")), deviceId: DEVICE_ID }, { status: 201 });
    },
  });
  const registry = createMobileHostRegistry(createInMemoryMobileHostRegistryStorage());
  const removed: string[] = [];
  const removeHost = async (hostId: string) => {
    removed.push(hostId);
    await registry.remove(hostId);
  };
  return { signer, deviceKeyStore, transport, registry, removeHost, stored, contacted, removed };
}

describe("a phone that joined a hub as a guest", () => {
  it("adds each spoke that admitted it as a host reached at the roster's address and pin", async () => {
    const world = await setup({ "100.101.102.104": "admit" });

    const state = await connectGuestSpokes({
      ...world,
      record: recordWith(laptop),
      deviceLabel: "Phone",
    });

    expect(state.spokes).toEqual([{ memberId: String(id("2")), hostId: String(id("2")) }]);
    expect(await world.registry.list()).toEqual({
      kind: "ok",
      hosts: [
        {
          hostId: String(id("2")),
          origin: "https://100.101.102.104:8443",
          label: "member 2",
          keyId: "key-1",
          credentialGeneration: 1,
          hostKeyFingerprint: laptop.identityKeyFingerprint,
        },
      ],
    });
    expect(world.stored.get("key-1")?.metadata).toMatchObject({
      deviceId: DEVICE_ID,
      listenerTrust: { current: { kind: "pinned", pin: expect.stringMatching(/^sha256-/) } },
    });
    expect(world.contacted).toEqual(["https://100.101.102.104:8443"]);
  });

  it("shows a spoke that refused the phone as not accepted and adds no host for it", async () => {
    const world = await setup({ "100.101.102.104": "admit", "100.101.102.105": "refuse" });

    const state = await connectGuestSpokes({
      ...world,
      record: recordWith(laptop, studio),
      deviceLabel: "Phone",
    });

    expect(state.notAccepted).toEqual([{ memberId: String(id("3")), name: "member 3" }]);
    const listed = await world.registry.list();
    expect(listed.kind === "ok" && listed.hosts.map((host) => host.hostId)).toEqual([
      String(id("2")),
    ]);
  });

  it("asks a spoke it could not reach again the next time and does not call it refused", async () => {
    const world = await setup({ "100.101.102.104": "down" });

    const state = await connectGuestSpokes({
      ...world,
      record: recordWith(laptop),
      deviceLabel: "Phone",
    });

    expect(state.spokes).toEqual([]);
    expect(state.notAccepted).toEqual([]);
  });

  it("drops the host of a spoke that left the roster and keeps the others", async () => {
    const world = await setup({ "100.101.102.104": "admit", "100.101.102.105": "admit" });
    const first = await connectGuestSpokes({
      ...world,
      record: recordWith(laptop, studio),
      deviceLabel: "Phone",
    });
    expect(first.spokes).toHaveLength(2);

    const second = await connectGuestSpokes({
      ...world,
      record: recordWith(studio),
      deviceLabel: "Phone",
      previous: first,
    });

    expect(world.removed).toEqual([String(id("2"))]);
    expect(second.spokes.map((spoke) => spoke.memberId)).toEqual([String(id("3"))]);
  });

  it("remembers the hub it joined even when a spoke cannot be added, so the join is not retried", async () => {
    const world = await setup({ "100.101.102.104": "admit" });
    const store = createGuestHubStore(createInMemoryMobileHostRegistryStorage());
    const finish = vi.fn(async () => ({
      status: "joined" as const,
      record: recordWith(laptop),
      signer: world.signer,
    }));

    const joined = await finishGuestJoin({
      ...world,
      registry: {
        upsert: async () => {
          throw new Error("storage is full");
        },
      },
      finish,
      deviceLabel: "Phone",
      store,
    });

    expect(joined).toMatchObject({ status: "joined", state: { spokes: [] } });
    expect((await store.load())?.record.selfMemberId).toBe(String(id("9")));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("waits while the hub has not approved and remembers the hub once it has", async () => {
    const world = await setup({ "100.101.102.104": "admit" });
    const store = createGuestHubStore(createInMemoryMobileHostRegistryStorage());
    const record = recordWith(laptop);

    const waiting = await finishGuestJoin({
      ...world,
      finish: async () => ({ status: "awaiting-approval" }),
      deviceLabel: "Phone",
      store,
    });
    expect(waiting).toEqual({ status: "waiting" });
    expect(await store.load()).toBeUndefined();

    const joined = await finishGuestJoin({
      ...world,
      finish: async () => ({ status: "joined", record, signer: world.signer }),
      deviceLabel: "Phone",
      store,
    });
    expect(joined.status).toBe("joined");
    expect((await store.load())?.deviceLabel).toBe("Phone");

    const declined = await finishGuestJoin({
      ...world,
      finish: async () => ({ status: "refused", kind: "hub-declined" }),
      deviceLabel: "Phone",
      store,
    });
    expect(declined).toEqual({ status: "refused", kind: "hub-declined" });
  });
});
