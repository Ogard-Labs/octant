import { describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  mapBridgeStateToHostHealth,
  PLATFORM_LISTENER_TRUST,
} from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";
import { RemoteShellView } from "./RemoteShellView";
import { canvasFixture } from "../canvas/test-fixtures";

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
function answerProduct(seen: ProductRequest[], withCanvas = false, withToolPrompt = false) {
  let toolPromptAnswered = false;
  return (input: ProductRequest): Response => {
    seen.push(input);
    const { method, path, body } = input;
    if (withToolPrompt && method === "POST" && path === "/api/extensions/tool-approvals") {
      if ((body as { readonly kind?: string }).kind === "decide") {
        toolPromptAnswered = true;
        return Response.json({ accepted: true });
      }
      return Response.json(
        toolPromptAnswered
          ? []
          : [
              {
                approvalId: "70000000-0000-4000-8000-000000000001",
                threadId: chatThreadId,
                projectId: chatProjectId,
                extensionId: "70000000-0000-4000-8000-000000000002",
                packageId: "70000000-0000-4000-8000-000000000003",
                componentId: "server",
                serverName: "notes",
                providerToolName: "plugin__notes__search",
                mcpToolName: "search",
                inputJson: '{"q":"plan"}',
                requestedAt: now,
                rememberable: true,
              },
            ],
      );
    }
    if (method === "GET" && path === "/api/canvas/thread-reference-cards") {
      return Response.json({
        mode: "chat",
        threadId: chatThreadId,
        projectId: chatProjectId,
        cards: withCanvas
          ? [
              {
                schemaVersion: 1,
                kind: "canvas-reference-card",
                cardId: "20000000-0000-4000-8000-000000000001",
                canvasId: "20000000-0000-4000-8000-000000000002",
                versionId: "20000000-0000-4000-8000-000000000003",
                title: canvasFixture.title,
                scope: {
                  hostId: "local",
                  mode: "chat",
                  workspace: { kind: "chat-virtual", projectId: chatProjectId },
                },
                originThreadId: chatThreadId,
                status: "ready",
                authority: {
                  filesystem: false,
                  shell: false,
                  git: false,
                  network: false,
                  tools: true,
                  subagents: false,
                  executionPolicy: "plan",
                  permissionPersistence: "current-session",
                },
                actorId: "99999999-9999-4999-8999-999999999999",
                providerInstanceId,
                modelId: "model-a",
                createdAt: now,
                actionCount: 0,
              },
            ]
          : [],
      });
    }
    if (withCanvas && method === "GET" && path === "/api/canvas/get") {
      return Response.json({
        kind: "ready",
        workspace: { kind: "chat-virtual", projectId: chatProjectId },
        version: {
          schemaVersion: 1,
          canvasId: "20000000-0000-4000-8000-000000000002",
          versionId: "20000000-0000-4000-8000-000000000003",
          sequence: 1,
          definition: canvasFixture,
          createdBy: { kind: "local-user", actorId: "99999999-9999-4999-8999-999999999999" },
          createdAt: now,
        },
      });
    }
    if (withCanvas && method === "GET" && path === "/api/canvas/history") {
      return Response.json({
        kind: "ready",
        history: {
          canvasId: "20000000-0000-4000-8000-000000000002",
          currentVersionId: "20000000-0000-4000-8000-000000000003",
          entries: [],
        },
      });
    }
    if (withCanvas && method === "GET" && path === "/api/canvas/public-shares") {
      return Response.json({
        schemaVersion: 1,
        kind: "canvas-public-share-list",
        canvasId: "20000000-0000-4000-8000-000000000002",
        enabled: true,
        serviceUrl: "https://shares.example.test",
        shares: [
          {
            publicShareId: "AAAAAAAAAAAAAAAAAAAAAA",
            canvasId: "20000000-0000-4000-8000-000000000002",
            url: "https://shares.example.test/s/AAAAAAAAAAAAAAAAAAAAAA",
            serviceUrl: "https://shares.example.test",
            versionId: "20000000-0000-4000-8000-000000000003",
            sequence: 1,
            publishedAt: now,
            updatedAt: now,
            expiresAt: null,
            passwordProtected: false,
            status: "active",
          },
        ],
      });
    }
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
    if (
      method === "GET" &&
      (path === "/api/work/threads/bootstrap" || path === "/api/work/navigation")
    ) {
      const workThread = {
        id: "20000000-0000-4000-8000-000000000001",
        projectId: "30000000-0000-4000-8000-000000000002",
        title: "Remote Work",
        lifecycle: "active",
        providerInstanceId,
        modelId: "model-a",
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      return Response.json({
        threads: [workThread],
        runtime: [],
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
    if (method === "GET" && path === "/api/replica-sync/status") {
      return Response.json({
        kind: "replica-sync-status",
        thisComputer: "founder",
        members: [
          {
            displayName: "Studio Mac",
            role: { kind: "founder" },
            revoked: false,
            left: false,
            thisComputer: true,
          },
        ],
        status: {
          lastPublish: { kind: "not-available" },
          lastPull: { kind: "not-available" },
          queued: { kind: "not-available" },
        },
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

async function readyBridge(
  seen: ProductRequest[] = [],
  withCanvas = false,
  actsAsHostPerson?: boolean,
  withToolPrompt = false,
) {
  const server = createFakeRemoteServer({
    handleProductRequest: answerProduct(seen, withCanvas, withToolPrompt),
    ...(actsAsHostPerson === undefined ? {} : { actsAsHostPerson }),
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
    hostKeyFingerprint: HOST_KEY_FINGERPRINT,
    listenerTrust: PLATFORM_LISTENER_TRUST,
  });
  await waitUntil(() => bridge.getState().kind === "ready");
  return { bridge, server };
}

describe("RemoteShellView", () => {
  it("passes a local credential cleanup warning after revocation unmounts the shell", async () => {
    const user = userEvent.setup();
    const { bridge } = await readyBridge();
    const onReset = vi.fn();
    vi.spyOn(bridge, "forgetDeviceKey").mockRejectedValueOnce(
      new Error("Local credential cleanup failed."),
    );
    function PairedShell() {
      const state = useSyncExternalStore(bridge.subscribe, bridge.getState);
      return state.kind === "ready" ? (
        <RemoteShellView bridge={bridge} onReset={onReset} />
      ) : (
        <div>Pairing entry</div>
      );
    }
    render(<PairedShell />);

    await user.click(await screen.findByRole("button", { name: "Revoke this device" }));
    expect(await screen.findByText("Pairing entry")).toBeInTheDocument();

    await waitFor(() =>
      expect(onReset).toHaveBeenCalledWith(
        "Remote device was revoked, but this browser could not remove its local credential.",
      ),
    );
  });

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

  it("opens a paired Chat Canvas and copies its public link without owner controls or window authority", async () => {
    const user = userEvent.setup();
    const seen: ProductRequest[] = [];
    const { bridge, server } = await readyBridge(seen, true);
    try {
      render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);
      const threads = await screen.findByRole("navigation", { name: "Chat thread list" });
      await user.click(await within(threads).findByRole("button", { name: chatThread.title }));
      await user.click(await screen.findByRole("button", { name: "Thread actions" }));
      await user.click(await screen.findByRole("menuitemradio", { name: "Show canvas" }));
      await user.click(
        await screen.findByRole("button", { name: new RegExp(canvasFixture.title) }),
      );
      const canvas = await screen.findByRole("dialog", { name: canvasFixture.title });
      await within(canvas).findByText("Q3 Overview");
      await user.click(within(canvas).getByRole("button", { name: "More Canvas actions" }));
      expect(screen.queryByRole("menuitem", { name: "Refine…" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Export…" })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("menuitem", { name: "Share…" }));
      await user.click(await screen.findByRole("button", { name: "Copy link" }));
      expect(await navigator.clipboard.readText()).toBe(
        "https://shares.example.test/s/AAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
      expect(server.productProofVerified()).toBe(true);
      const canvasRequests = seen.filter((request) => request.path.startsWith("/api/canvas/"));
      expect(canvasRequests.some((request) => request.path === "/api/canvas/public-shares")).toBe(
        true,
      );
      expect(
        canvasRequests.every(
          (request) =>
            request.method === "GET" && !request.headers.has("x-octant-window-capability"),
        ),
      ).toBe(true);
    } finally {
      bridge.disconnect();
    }
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

  it("offers a browser the host's own person paired the default modes, and marks local only what the host forwards to no device", async () => {
    const user = userEvent.setup();
    const { bridge } = await readyBridge([], false, true);
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    const localOnly = await screen.findByRole("note", { name: "Local host only surfaces" });
    await waitFor(() => expect(within(localOnly).queryByText("Approvals")).toBeNull());
    expect(within(localOnly).queryByText("Extensions")).toBeNull();
    expect(within(localOnly).queryByText("Provider setup")).toBeNull();
    expect(within(localOnly).getByText("Provider credentials")).toBeInTheDocument();
    expect(within(localOnly).getByText("Remote listener")).toBeInTheDocument();
    expect(within(localOnly).getByText("Host controls")).toBeInTheDocument();
    expect(within(localOnly).queryByText(/cannot bind folders, approve tool use/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Code" }));
    const defaults = await screen.findByRole("region", { name: "Default modes" });
    expect(
      await within(defaults).findByRole("combobox", { name: "Default mode for new threads" }),
    ).toHaveTextContent("Plan");
  });

  it("offers a restricted session no default modes, whether its host says so or does not say", async () => {
    const user = userEvent.setup();
    for (const actsAsHostPerson of [false, undefined]) {
      const { bridge } = await readyBridge([], false, actsAsHostPerson);
      const { unmount } = render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

      const localOnly = await screen.findByRole("note", { name: "Local host only surfaces" });
      expect(within(localOnly).getByText("Approvals")).toBeInTheDocument();
      expect(within(localOnly).getByText("Extensions")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Code" }));
      await screen.findByRole("navigation", { name: "Code thread list" });
      await screen.findByText(/No Code threads on this host yet/i);
      expect(screen.queryByRole("region", { name: "Default modes" })).toBeNull();
      unmount();
    }
  });

  it("shows a waiting tool prompt to the host's own person, who may always allow the tool in its Project", async () => {
    const user = userEvent.setup();
    const seen: ProductRequest[] = [];
    const { bridge } = await readyBridge(seen, false, true, true);
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    const list = await screen.findByRole("navigation", { name: "Chat thread list" });
    await user.click(await within(list).findByRole("button", { name: "Planning from the phone" }));
    expect(await screen.findByRole("button", { name: "Approve once" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Always allow in this Project" }));

    await waitFor(() =>
      expect(
        seen
          .filter((request) => request.path === "/api/extensions/tool-approvals")
          .map((request) => request.body),
      ).toContainEqual({
        kind: "decide",
        approvalId: "70000000-0000-4000-8000-000000000001",
        decision: "approved",
        remember: true,
      }),
    );
  });

  it("shows a restricted session the tool prompt with one approval and a denial, and nothing to remember", async () => {
    const user = userEvent.setup();
    const { bridge } = await readyBridge([], false, false, true);
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    const list = await screen.findByRole("navigation", { name: "Chat thread list" });
    await user.click(await within(list).findByRole("button", { name: "Planning from the phone" }));
    expect(await screen.findByRole("button", { name: "Approve once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow in this Project" })).toBeNull();
  });

  it("shows sync status and the computers read-only, with nothing to set up or revoke", async () => {
    const { bridge } = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(
      await screen.findByText(
        "Setting up sync, joining, and revoking happen in the Octant app on the host machine.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Set up sync · this computer")).toBeInTheDocument();
    for (const name of [
      "Set up sync",
      "Ask to join",
      "Check the store",
      /^Revoke (?!this device)/,
      "Approve…",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
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
