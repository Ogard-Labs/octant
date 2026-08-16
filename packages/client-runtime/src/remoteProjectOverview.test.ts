import { describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  createRemoteProjectSnapshotRegistry,
  fetchRemoteProjectBootstrap,
} from "./remoteProjectOverview";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function readyBridge(server: ReturnType<typeof createFakeRemoteServer>) {
  const pairingStore = createInMemoryDeviceKeyStore();
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  const deviceId = "22222222-2222-4222-8222-222222222222";
  server.registerDevice({
    deviceId,
    publicKeyPem: pem,
    fingerprint: fingerprintFromPem(pem),
  });
  const deviceKeyId = await pairingStore.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  const bridge = createRemoteSessionBridge({
    fetch: server.fetch,
    deviceKeyStore: pairingStore,
  });
  bridge.connect({
    ticketId: TICKET_ID,
    hostId,
    deviceId,
    credentialGeneration: 1,
    deviceKeyId,
    origin: ORIGIN,
  });
  const start = Date.now();
  while (bridge.getState().kind !== "ready") {
    if (Date.now() - start > 5000) throw new Error("Timed out waiting for ready.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return bridge;
}

describe("remoteProjectOverview", () => {
  it("fetches project bootstrap and preserves snapshots in memory", async () => {
    const server = createFakeRemoteServer({
      handleProductRequest({ method, path }) {
        if (method === "GET" && path === "/api/projects/bootstrap") {
          return Response.json({
            active: [
              {
                id: "30000000-0000-4000-8000-000000000001",
                name: "Snapshot Project",
                lifecycle: "active",
                pinned: true,
                rank: "0/1",
                version: 1,
                createdAt: "2026-08-03T00:00:00.000Z",
                updatedAt: "2026-08-03T00:00:00.000Z",
                type: "chat",
              },
            ],
            archived: [],
            availability: [],
            memory: [],
          });
        }
        return Response.json({ ok: true });
      },
    });
    const bridge = await readyBridge(server);
    const registry = createRemoteProjectSnapshotRegistry();
    const bootstrap = await fetchRemoteProjectBootstrap({ bridge });
    registry.write(bootstrap);
    bridge.connection()?.disconnect();
    expect(registry.read()?.active[0]?.name).toBe("Snapshot Project");
    await expect(fetchRemoteProjectBootstrap({ bridge })).rejects.toMatchObject({
      category: "offline",
    });
  });
});
