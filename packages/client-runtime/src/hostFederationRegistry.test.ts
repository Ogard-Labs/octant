import { describe, expect, it } from "vitest";
import { LOCAL_HOST_DISPLAY_NAME, LOCAL_HOST_ID } from "@octant/contracts/host";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
  credentialHandlesAreIndependent,
  forgetHostCredential,
  type ClientHostRegistration,
} from "./hostFederationRegistry";

const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";

function remoteHost(
  overrides: Partial<ClientHostRegistration> &
    Pick<ClientHostRegistration, "hostId" | "displayName" | "origin" | "credential">,
): ClientHostRegistration {
  return {
    kind: "remote",
    enabled: true,
    ...overrides,
  };
}

describe("ClientHostRegistry (Post-preview B1)", () => {
  it("always lists This Mac / local host even on an empty store", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      hostId: LOCAL_HOST_ID,
      kind: "local",
      displayName: LOCAL_HOST_DISPLAY_NAME,
      enabled: true,
    });
    expect(listed[0]?.credential).toBeUndefined();
  });

  it("upserts independent remote hosts with distinct credential handles", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    const credA = {
      keyId: "key-a",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
      deviceId: "device-a",
    };
    const credB = {
      keyId: "key-b",
      credentialGeneration: 1,
      hostKeyFingerprint: "b".repeat(64),
      deviceId: "device-b",
    };

    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: credA,
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_B as ClientHostRegistration["hostId"],
        displayName: "Travel laptop",
        origin: "https://laptop.tailnet:8443",
        credential: credB,
      }),
    );

    const listed = await registry.list();
    expect(listed).toHaveLength(3);
    expect(listed[0]?.hostId).toBe(LOCAL_HOST_ID);
    const studio = listed.find((h) => h.hostId === HOST_A);
    const laptop = listed.find((h) => h.hostId === HOST_B);
    expect(studio?.credential).toEqual(credA);
    expect(laptop?.credential).toEqual(credB);
    expect(credentialHandlesAreIndependent(studio?.credential, laptop?.credential)).toBe(true);
  });

  it("rejects upsert that would join the same credential keyId across hosts", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    const shared = {
      keyId: "shared-key",
      credentialGeneration: 1,
      hostKeyFingerprint: "c".repeat(64),
    };
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "A",
        origin: "https://a.example",
        credential: shared,
      }),
    );
    await expect(
      registry.upsertRemote(
        remoteHost({
          hostId: HOST_B as ClientHostRegistration["hostId"],
          displayName: "B",
          origin: "https://b.example",
          credential: {
            keyId: "shared-key",
            credentialGeneration: 2,
            hostKeyFingerprint: "d".repeat(64),
          },
        }),
      ),
    ).rejects.toThrow(/must not join across hosts/);

    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_B as ClientHostRegistration["hostId"],
        displayName: "B",
        origin: "https://b.example",
        credential: {
          keyId: "other-key",
          credentialGeneration: 1,
          hostKeyFingerprint: "d".repeat(64),
        },
      }),
    );

    const a = await registry.get(HOST_A);
    const b = await registry.get(HOST_B);
    expect(credentialHandlesAreIndependent(a?.credential, shared)).toBe(false);
    expect(credentialHandlesAreIndependent(a?.credential, b?.credential)).toBe(true);
  });

  it("removing one remote does not drop the other remote or This Mac", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "A",
        origin: "https://a.example",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_B as ClientHostRegistration["hostId"],
        displayName: "B",
        origin: "https://b.example",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const removed = await registry.removeRemote(HOST_A);
    expect(removed?.hostId).toBe(HOST_A);
    expect(removed?.credential?.keyId).toBe("key-a");

    const listed = await registry.list();
    expect(listed.map((h) => h.hostId)).toEqual([LOCAL_HOST_ID, HOST_B]);
    expect(await registry.get(HOST_B)).toMatchObject({
      displayName: "B",
      credential: { keyId: "key-b" },
    });
  });

  it("cannot remove This Mac / local host", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await expect(registry.removeRemote(LOCAL_HOST_ID)).rejects.toThrow(/Cannot remove the local/);
    expect(await registry.list()).toHaveLength(1);
  });

  it("rejects remote upsert without origin or credential handle", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await expect(
      registry.upsertRemote({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        kind: "remote",
        displayName: "A",
        enabled: true,
        credential: {
          keyId: "k",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    ).rejects.toThrow(/origin/);

    await expect(
      registry.upsertRemote({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        kind: "remote",
        displayName: "A",
        origin: "https://a.example",
        enabled: true,
      }),
    ).rejects.toThrow(/credential handle/);
  });

  it("persists across registry instances sharing storage", async () => {
    const storage = createInMemoryClientHostRegistryStorage();
    const first = createClientHostRegistry(storage);
    await first.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "Studio",
        origin: "https://studio.example",
        credential: {
          keyId: "key-a",
          credentialGeneration: 3,
          hostKeyFingerprint: "a".repeat(64),
          deviceId: "dev-a",
        },
      }),
    );

    const second = createClientHostRegistry(storage);
    const listed = await second.list();
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({
      hostId: HOST_A,
      displayName: "Studio",
      credential: { keyId: "key-a", credentialGeneration: 3, deviceId: "dev-a" },
    });
  });

  it("forgets one host credential via RemoteDeviceKeyStore without touching another", async () => {
    const keyStore = createInMemoryDeviceKeyStore();
    // Seed two independent keys the way pairing would.
    const keyPairA = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const keyPairB = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const keyIdA = await keyStore.set(
      { publicKey: keyPairA.publicKey, privateKey: keyPairA.privateKey },
      { origin: "https://a.example", hostId: HOST_A as never },
    );
    const keyIdB = await keyStore.set(
      { publicKey: keyPairB.publicKey, privateKey: keyPairB.privateKey },
      { origin: "https://b.example", hostId: HOST_B as never },
    );

    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "A",
        origin: "https://a.example",
        credential: {
          keyId: keyIdA,
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_B as ClientHostRegistration["hostId"],
        displayName: "B",
        origin: "https://b.example",
        credential: {
          keyId: keyIdB,
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const removed = await registry.removeRemote(HOST_A);
    await forgetHostCredential(keyStore, removed?.credential);

    expect(await keyStore.get(keyIdA)).toBeUndefined();
    expect(await keyStore.get(keyIdB)).toBeDefined();
    expect(await registry.get(HOST_B)).toBeDefined();
    expect(await registry.get(LOCAL_HOST_ID)).toMatchObject({ kind: "local" });
  });

  it("refuses to attach a remote credential handle to This Mac", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await expect(
      registry.update(LOCAL_HOST_ID, {
        credential: {
          keyId: "nope",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    ).rejects.toThrow(/cannot carry a remote device credential/);
  });

  it("updates remote alias and cache metadata without rewriting other hosts", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_A as ClientHostRegistration["hostId"],
        displayName: "A",
        origin: "https://a.example",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: HOST_B as ClientHostRegistration["hostId"],
        displayName: "B",
        origin: "https://b.example",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    await registry.update(HOST_A, {
      displayName: "A renamed",
      cacheMetadata: { lastReadyAt: "2026-08-12T08:00:00.000Z" },
    });

    expect(await registry.get(HOST_A)).toMatchObject({
      displayName: "A renamed",
      cacheMetadata: { lastReadyAt: "2026-08-12T08:00:00.000Z" },
      credential: { keyId: "key-a" },
    });
    expect(await registry.get(HOST_B)).toMatchObject({
      displayName: "B",
      credential: { keyId: "key-b" },
    });
  });
});
