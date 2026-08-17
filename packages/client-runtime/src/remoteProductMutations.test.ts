import { describe, expect, it } from "vitest";
import { decodeChatCommand, decodeCodeCommand, decodeWorkThreadCommand } from "@octant/contracts";
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

const now = "2026-08-03T00:00:00.000Z";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";
const workThread = {
  id: "20000000-0000-4000-8000-000000000001",
  projectId: "30000000-0000-4000-8000-000000000001",
  title: "Remote Work",
  lifecycle: "active" as const,
  providerInstanceId,
  modelId: "model-a",
  version: 1,
  createdAt: now,
  updatedAt: now,
};

async function readyBridge(): Promise<ReturnType<typeof createRemoteSessionBridge>> {
  const server = createFakeRemoteServer({
    handleProductRequest({ method, path, body }) {
      if (method === "GET" && path === "/api/chat/bootstrap") {
        return Response.json({
          settings: {
            defaultProviderInstanceId: providerInstanceId,
            defaultModelId: "model-a",
            defaultResearchEnabled: false,
            defaultResearchRouting: "automatic",
            defaultPersonalityInstructions: "Be concise.",
            version: 1,
            updatedAt: now,
          },
          threads: [],
        });
      }
      if (method === "POST" && path === "/api/chat/commands") {
        const command = decodeChatCommand(body);
        if (command.kind !== "update-chat-settings") {
          return Response.json({ category: "invalid" }, { status: 400 });
        }
        return Response.json({
          kind: "settings-updated",
          settings: { ...command, kind: undefined, version: 2, updatedAt: now },
        });
      }
      if (method === "GET" && path === "/api/work/threads/bootstrap") {
        return Response.json({ threads: [workThread] });
      }
      if (method === "POST" && path === "/api/work/threads/commands") {
        const command = decodeWorkThreadCommand(body);
        if (command.kind !== "rename-work-thread") {
          return Response.json({ category: "invalid" }, { status: 400 });
        }
        return Response.json({
          kind: "thread-updated",
          thread: { ...workThread, title: command.title, version: 2 },
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
          activity: [],
        });
      }
      if (method === "POST" && path === "/api/code/commands") {
        const command = decodeCodeCommand(body);
        if (command.kind !== "update-code-settings") {
          return Response.json({ category: "invalid" }, { status: 400 });
        }
        return Response.json({
          kind: "settings-updated",
          settings: { ...command, kind: undefined, version: 2, updatedAt: now },
        });
      }
      return Response.json({ ok: true });
    },
  });
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
  await waitUntil(() => bridge.getState().kind === "ready");
  return bridge;
}

describe("remoteProductMutations", () => {
  it("exercises mode-valid reads and mutations when ready", async () => {
    const bridge = await readyBridge();
    await expect(exerciseRemoteChatSurface({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteChatMutation({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteWorkSurface({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteWorkMutation({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteCodeSurface({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteCodeMutation({ bridge })).resolves.toEqual({ ok: true });
  });

  it("exercises auxiliary remote surfaces when ready", async () => {
    const bridge = await readyBridge();
    await expect(exerciseRemoteProviderSurface({ bridge })).resolves.toEqual({ ok: true });
    await expect(exerciseRemoteSettingsSurface({ bridge })).resolves.toEqual({ ok: true });
  });

  it("fails closed for authority mutations when stale without queueing", async () => {
    const bridge = await readyBridge();
    bridge.connection()?.disconnect();
    await waitUntil(() => bridge.getState().kind === "stale");

    await expect(exerciseRemoteChatMutation({ bridge })).rejects.toMatchObject({
      category: "offline",
      message: expect.stringMatching(/disconnected/i),
    });
  });
});
