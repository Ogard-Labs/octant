/**
 * Proves mobile create+view Chat uses the same host-authenticated product path
 * as desktop follow-ups (journal/SQLite on a real host; fake server here).
 */
import { describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createMobileChatWithFirstTurn,
  listMobileInbox,
  loadMobileChatThread,
  type MobileRemoteTransport,
} from "./mobileInboxClient";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);
const now = "2026-08-05T18:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000099";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";

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

describe("mobile chat create over remote session", () => {
  it("creates a Chat thread on the host and lists/loads it from mobile", async () => {
    let createdTitle = "";
    let firstPrompt = "";
    let threadVersion = 1;

    const thread = () => ({
      id: threadId,
      title: createdTitle || "Untitled",
      lifecycle: "active",
      providerInstanceId,
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: threadVersion,
      createdAt: now,
      updatedAt: now,
    });

    const server = createFakeRemoteServer({
      handleProductRequest({ method, path, body }) {
        if (method === "POST" && path === "/api/chat/commands") {
          const payload = (body ?? {}) as {
            kind?: string;
            title?: string;
            prompt?: string;
          };
          if (payload.kind === "create-chat-thread") {
            createdTitle = payload.title ?? "Untitled";
            threadVersion = 1;
            return Response.json({ kind: "thread-created", thread: thread() });
          }
          if (payload.kind === "send-chat-turn") {
            firstPrompt = payload.prompt ?? "";
            threadVersion = 2;
            return new Response(null, { status: 200 });
          }
        }
        if (method === "GET" && path === `/api/chat/threads/${threadId}`) {
          return Response.json({
            thread: thread(),
            turns: [],
            lastSequence: firstPrompt.length > 0 ? 1 : 0,
            contents: [],
            attachments: [],
            citations: [],
            workItems: [],
            workListVersion: 1,
            followUpVersion: 1,
          });
        }
        if (method === "GET" && path === "/api/chat/bootstrap") {
          return Response.json({
            settings: {
              defaultResearchEnabled: false,
              defaultResearchRouting: "automatic",
              defaultPersonalityInstructions: "Be calm.",
              version: 1,
              updatedAt: now,
            },
            threads: createdTitle.length > 0 ? [thread()] : [],
          });
        }
        if (method === "GET" && path === "/api/work/threads/bootstrap") {
          return Response.json({ threads: [] });
        }
        if (method === "GET" && path === "/api/code/bootstrap") {
          return Response.json({
            settings: {
              defaultExecutionPolicy: "approval-gated",
              defaultPermissionPersistence: "current-session",
              version: 1,
              updatedAt: now,
            },
            threads: [],
            checkouts: [],
          });
        }
        if (method === "POST" && path === "/api/code/board") {
          return Response.json({
            version: 1,
            query: { version: 1 },
            cards: [],
            generatedAt: now,
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
    const connection = bridge.connection();
    if (connection === undefined) throw new Error("Expected authenticated connection.");

    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: (request) => connection.authenticatedFetch(request),
    };

    const row = await createMobileChatWithFirstTurn({
      transport,
      prompt: "Create a shared host chat from mobile",
    });
    expect(row).toMatchObject({
      hostId,
      mode: "chat",
      threadId,
      title: "Create a shared host chat from mobile",
    });

    const inbox = await listMobileInbox(transport);
    expect(inbox.some((entry) => entry.threadId === threadId)).toBe(true);

    const view = await loadMobileChatThread(transport, threadId);
    expect(view.thread.id).toBe(threadId);
    expect(view.thread.title).toBe("Create a shared host chat from mobile");
    expect(firstPrompt).toBe("Create a shared host chat from mobile");
  });
});
