import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  mapBridgeStateToHostHealth,
} from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";
import { RemoteShellView } from "./RemoteShellView";

const hostId = decodeStableHostId(HOST_ID);
const now = "2026-08-03T00:00:00.000Z";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";
const chatThreadId = "40000000-0000-4000-8000-000000000001";
const chatProjectId = "30000000-0000-4000-8000-000000000001";

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

const chatThread = {
  id: chatThreadId,
  projectId: chatProjectId,
  title: "Planning from the phone",
  lifecycle: "active",
  providerInstanceId,
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be concise.",
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const capabilities = {
  streaming: "supported",
  resume: "unsupported",
  interruption: "supported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "supported",
  usage: "unavailable",
  toolActivity: "unsupported",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unsupported",
  harnessAutoReview: "unsupported",
  nativeAttachments: "unavailable",
  nativeWebResearch: "unavailable",
  appManagedTools: "unavailable",
  citations: "unavailable",
};

interface ProductRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Headers;
}

/** A fake host that answers the reads the remote workspace performs. */
function answerProduct(seen: ProductRequest[]) {
  return (input: ProductRequest): Response => {
    seen.push(input);
    const { method, path, body } = input;
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
        threads: [chatThread],
      });
    }
    if (method === "GET" && path === "/api/chat/navigation") {
      return Response.json({
        threads: [
          {
            id: chatThreadId,
            title: chatThread.title,
            providerInstanceId,
            updatedAt: now,
            lastSequence: 1,
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/chat/threads/${chatThreadId}`) {
      return Response.json({
        thread: chatThread,
        turns: [],
        lastSequence: 1,
        contents: [],
        attachments: [],
        citations: [],
        workItems: [],
        workListVersion: 0,
        followUpVersion: 0,
      });
    }
    if (method === "GET" && path === `/api/chat/threads/${chatThreadId}/events`) {
      return new Response("", {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (method === "POST" && path === "/api/chat/commands") {
      const command = body as { readonly kind?: string };
      if (command.kind === "send-chat-turn") {
        return Response.json({
          kind: "turn-created",
          turn: {
            id: "90000000-0000-4000-8000-000000000001",
            threadId: chatThreadId,
            sequence: 1,
            userMessageRef: {
              contentId: "90000000-0000-4000-8000-000000000002",
              digest: "a".repeat(64),
              byteLength: 5,
            },
            attachmentIds: [],
            attempts: [],
            createdAt: now,
          },
        });
      }
      return Response.json(
        { category: "invalid", message: "Unexpected command." },
        { status: 400 },
      );
    }
    if (method === "GET" && path === "/api/work/threads/bootstrap") {
      return Response.json({
        threads: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            projectId: "30000000-0000-4000-8000-000000000002",
            title: "Remote Work",
            lifecycle: "active",
            providerInstanceId,
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
        activity: [],
      });
    }
    if (method === "GET" && path === "/api/providers/bootstrap") {
      return Response.json({
        instances: [
          {
            id: providerInstanceId,
            displayName: "Codex local",
            driverKind: "codex",
            configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
            enabled: true,
            environmentPolicy: "inherit-host",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
        defaults: { permissionPersistence: "current-session", version: 1 },
        observedStates: [
          {
            instanceId: providerInstanceId,
            readiness: "ready",
            processState: "running",
            models: [
              {
                id: "model-a",
                displayName: "Model A",
                source: "discovered",
                verification: "verified",
                reasoning: "supported",
                inputModalities: ["text"],
                options: [],
              },
            ],
            capabilities,
            observedAt: now,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/projects/bootstrap") {
      return Response.json({
        active: [
          {
            id: chatProjectId,
            name: "Remote Chat",
            lifecycle: "active",
            pinned: true,
            rank: "0/1",
            version: 1,
            createdAt: now,
            updatedAt: now,
            type: "chat",
          },
        ],
        archived: [],
        availability: [],
        memory: [],
      });
    }
    return Response.json(
      { category: "unavailable", message: "Not on this host." },
      { status: 404 },
    );
  };
}

async function readyBridge(seen: ProductRequest[] = []) {
  const server = createFakeRemoteServer({ handleProductRequest: answerProduct(seen) });
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
  return { bridge, server };
}

describe("RemoteShellView", () => {
  it("opens a Chat thread from the paired host and sends a real turn over the remote session", async () => {
    const user = userEvent.setup();
    const seen: ProductRequest[] = [];
    const { bridge, server } = await readyBridge(seen);
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByText("This Mac")).toBeInTheDocument();
    expect(mapBridgeStateToHostHealth(bridge.getState())).toBe("healthy");

    const list = await screen.findByRole("navigation", { name: "Chat thread list" });
    await user.click(await within(list).findByRole("button", { name: "Planning from the phone" }));

    const composer = await screen.findByRole("textbox", { name: /message/i }, { timeout: 5000 });
    await user.type(composer, "Hello");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        seen.some(
          (request) =>
            request.method === "POST" &&
            request.path === "/api/chat/commands" &&
            (request.body as { kind?: string }).kind === "send-chat-turn",
        ),
      ).toBe(true);
    });
    expect(server.productProofVerified()).toBe(true);
    for (const request of seen) {
      expect(request.headers.get("x-octant-window-capability")).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /verify .* mutation/i })).not.toBeInTheDocument();
  });

  it("lists Work threads and explains an empty Code inventory instead of offering probe buttons", async () => {
    const user = userEvent.setup();
    const { bridge } = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Work" }));
    const work = await screen.findByRole("navigation", { name: "Work thread list" });
    expect(await within(work).findByRole("button", { name: "Remote Work" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Code" }));
    await screen.findByRole("navigation", { name: "Code thread list" });
    expect(await screen.findByText(/No Code threads on this host yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /read code bootstrap/i })).not.toBeInTheDocument();
  });

  it("marks local-host-only surfaces unavailable without action buttons", async () => {
    const { bridge } = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByText("Local host only")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();
    expect(screen.getByText("Provider credentials")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable remotely").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("shows device self-service and host health, and turns stale without offering to send", async () => {
    const { bridge } = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByRole("region", { name: "This browser device" })).toBeInTheDocument();
    expect(await screen.findByText("Remote browser", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke all/i })).not.toBeInTheDocument();

    bridge.connection()?.disconnect();
    await waitFor(() => expect(bridge.getState().kind).toBe("stale"));

    expect(screen.getByText("This Mac")).toBeInTheDocument();
    expect(screen.getByText("Connection stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
  });
});
