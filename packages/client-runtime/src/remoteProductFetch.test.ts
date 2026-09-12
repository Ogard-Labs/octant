import { describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createChatClient } from "./chatClient";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteProductFetch } from "./remoteProductFetch";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  createFakeRemoteServer,
  type FakeRemoteServerConfig,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);
const now = "2026-08-03T00:00:00.000Z";

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

async function readyBridge(
  handleProductRequest: NonNullable<FakeRemoteServerConfig["handleProductRequest"]>,
) {
  const server = createFakeRemoteServer({ handleProductRequest });
  const store = createInMemoryDeviceKeyStore();
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  const deviceId = "22222222-2222-4222-8222-222222222222";
  server.registerDevice({ deviceId, publicKeyPem: pem, fingerprint: fingerprintFromPem(pem) });
  const deviceKeyId = await store.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });
  bridge.connect({
    ticketId: TICKET_ID,
    hostId,
    deviceId,
    credentialGeneration: 1,
    deviceKeyId,
    origin: ORIGIN,
  });
  await waitUntil(() => bridge.getState().kind === "ready");
  return { bridge, server };
}

describe("remote product fetch", () => {
  it("lets an ordinary Chat client read and send over the paired session without a window identity", async () => {
    const seen: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
    const { bridge, server } = await readyBridge((input) => {
      seen.push(input);
      if (input.method === "GET" && input.path === "/api/chat/bootstrap") {
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
      if (input.method === "POST" && input.path === "/api/chat/commands") {
        return Response.json({
          kind: "thread-created",
          thread: {
            id: "40000000-0000-4000-8000-000000000001",
            projectId: "30000000-0000-4000-8000-000000000001",
            title: "From the browser",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be concise.",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      return Response.json({ category: "unavailable" }, { status: 404 });
    });
    const chat = createChatClient({
      baseUrl: ORIGIN,
      fetch: createRemoteProductFetch({ bridge }),
      windowCapability: "never-sent",
    });

    const bootstrap = await chat.bootstrap();
    const created = await chat.execute({
      kind: "create-chat-thread",
      title: "From the browser",
      projectId: "30000000-0000-4000-8000-000000000001" as never,
    });

    expect(bootstrap.threads).toEqual([]);
    expect(created.kind).toBe("thread-created");
    expect(server.productProofVerified()).toBe(true);
    expect(seen.map((entry) => entry.path)).toEqual(["/api/chat/bootstrap", "/api/chat/commands"]);
    for (const entry of seen) {
      expect(entry.headers.get("x-octant-window-capability")).toBeNull();
      expect(entry.headers.get("x-octant-device-proof")).not.toBeNull();
    }
    expect(seen[1]?.headers.get("content-type")).toBe("application/json");
    expect(seen[1]?.headers.get("x-octant-command-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]?.body).toMatchObject({ kind: "create-chat-thread" });
  });

  it("sends to the paired host whatever base URL the client was built with, and only its API", async () => {
    const seen: string[] = [];
    const { bridge, server } = await readyBridge(({ path }) => {
      seen.push(path);
      return Response.json({ ok: true });
    });
    const fetch = createRemoteProductFetch({ bridge });

    const response = await fetch("http://127.0.0.1/api/chat/bootstrap");
    expect(response.ok).toBe(true);
    expect(server.productProofVerified()).toBe(true);
    expect(seen).toEqual(["/api/chat/bootstrap"]);
    await expect(fetch(`${ORIGIN}/index.html`)).rejects.toThrow(/paired host/i);
  });

  it("fails closed instead of queueing while the session is disconnected", async () => {
    const { bridge } = await readyBridge(() => Response.json({ ok: true }));
    const fetch = createRemoteProductFetch({ bridge });
    bridge.connection()?.disconnect();
    await waitUntil(() => bridge.getState().kind === "stale");

    await expect(
      fetch(`${ORIGIN}/api/chat/commands`, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/disconnected/i);
  });
});
