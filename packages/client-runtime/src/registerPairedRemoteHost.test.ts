import { describe, expect, it } from "vitest";
import { LOCAL_HOST_ID, decodeHostId } from "@octant/contracts/host";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
} from "./hostFederationRegistry";
import { registerPairedRemoteHost } from "./registerPairedRemoteHost";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";

describe("registerPairedRemoteHost", () => {
  it("upserts a remote registration from pairing approval facts", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registerPairedRemoteHost({
      registry,
      approval: {
        ticketId: "44444444-4444-4444-8444-444444444444",
        hostId: decodeStableHostId(HOST_ID),
        deviceId: DEVICE_ID,
        credentialGeneration: 2,
        deviceKeyId: KEY_ID,
        origin: "https://studio.tailnet:8443",
      },
      displayName: "Studio",
      hostKeyFingerprint: "a".repeat(64),
    });

    const listed = await registry.list();
    expect(listed.map((entry) => entry.hostId)).toEqual([LOCAL_HOST_ID, decodeHostId(HOST_ID)]);
    const remote = await registry.get(HOST_ID);
    expect(remote).toEqual({
      hostId: decodeHostId(HOST_ID),
      kind: "remote",
      displayName: "Studio",
      origin: "https://studio.tailnet:8443",
      enabled: true,
      credential: {
        keyId: KEY_ID,
        credentialGeneration: 2,
        hostKeyFingerprint: "a".repeat(64),
        deviceId: DEVICE_ID,
      },
    });
  });

  it("refuses an empty display name", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await expect(
      registerPairedRemoteHost({
        registry,
        approval: {
          ticketId: "44444444-4444-4444-8444-444444444444",
          hostId: decodeStableHostId(HOST_ID),
          deviceId: DEVICE_ID,
          credentialGeneration: 1,
          deviceKeyId: KEY_ID,
          origin: "https://studio.tailnet:8443",
        },
        displayName: "   ",
        hostKeyFingerprint: "a".repeat(64),
      }),
    ).rejects.toThrow(/display name/i);
  });
});
