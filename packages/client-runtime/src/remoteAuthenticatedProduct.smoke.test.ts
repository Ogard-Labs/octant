// In-process substitute for LAN/Tailscale browser hardware smokes.
//
// Exercises the full authenticated remote product path in-process: pairing device
// key registration, session bridge negotiation, device-proof authenticatedFetch,
// and one successful mutation/read per Chat/Work/Code plus auxiliary surfaces.
// HTTPS transport is covered separately by apps/server remoteGateway.https.smoke.test.ts.

import { describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  exerciseRemoteChatMutation,
  exerciseRemoteChatSurface,
  exerciseRemoteCodeMutation,
  exerciseRemoteCodeSurface,
  exerciseRemoteWorkMutation,
  exerciseRemoteWorkSurface,
  exerciseRemoteProviderSurface,
  exerciseRemoteSettingsSurface,
} from "./remoteProductMutations";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

describe("remote authenticated product smoke", () => {
  it("pairs, authenticates, and exercises the remote product matrix", async () => {
    const now = "2026-08-03T00:00:00.000Z";
    const server = createFakeRemoteServer({
      handleProductRequest({ method, path }) {
        if (method === "GET" && path === "/api/chat/bootstrap") {
          return Response.json({
            settings: {
              defaultResearchEnabled: false,
              defaultResearchRouting: "automatic",
              defaultPersonalityInstructions: "Be concise.",
              version: 1,
              updatedAt: now,
            },
            threads: [],
          });
        }
        if (method === "GET" && path === "/api/work/threads/bootstrap") {
          return Response.json({
            threads: [
              {
                id: "20000000-0000-4000-8000-000000000001",
                projectId: "30000000-0000-4000-8000-000000000001",
                title: "Remote Work",
                lifecycle: "active",
                providerInstanceId: "10000000-0000-4000-8000-000000000001",
                modelId: "model-a",
                version: 1,
                createdAt: now,
                updatedAt: now,
              },
            ],
          });
        }
        if (method === "GET" && path === "/api/code/bootstrap") {
          return Response.json({
            settings: {
              defaultExecutionPolicy: "plan",
              defaultPermissionPersistence: "current-session",
              version: 1,
              updatedAt: now,
            },
            threads: [],
            checkouts: [],
          });
        }
        return Response.json({ ok: true });
      },
    });
    const pairingStore = createInMemoryDeviceKeyStore();
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
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
    await waitUntil(() => bridge.getState().kind === "ready");
    expect(server.productProofVerified()).toBe(false);

    await exerciseRemoteChatSurface({ bridge });
    await exerciseRemoteChatMutation({ bridge });
    await exerciseRemoteWorkSurface({ bridge });
    await exerciseRemoteWorkMutation({ bridge });
    await exerciseRemoteCodeSurface({ bridge });
    await exerciseRemoteCodeMutation({ bridge });
    await exerciseRemoteProviderSurface({ bridge });
    await exerciseRemoteSettingsSurface({ bridge });

    expect(server.productProofVerified()).toBe(true);
  });
});
