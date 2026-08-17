import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  exerciseRemoteChatMutation,
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

async function readyBridge(): Promise<ReturnType<typeof createRemoteSessionBridge>> {
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
          activity: [],
        });
      }
      if (method === "GET" && path === "/api/projects/bootstrap") {
        return Response.json({
          active: [
            {
              id: "30000000-0000-4000-8000-000000000001",
              name: "Remote Chat",
              lifecycle: "active",
              pinned: true,
              rank: "0/1",
              version: 1,
              createdAt: now,
              updatedAt: now,
              type: "chat",
            },
            {
              id: "30000000-0000-4000-8000-000000000002",
              name: "Remote Work",
              lifecycle: "active",
              pinned: false,
              rank: "0/1",
              version: 1,
              createdAt: now,
              updatedAt: now,
              type: "work",
              binding: { canonicalRoot: "/opaque/work" },
              bindingRevisionId: "30000000-0000-4000-8000-000000000012",
            },
            {
              id: "30000000-0000-4000-8000-000000000003",
              name: "Remote Code",
              lifecycle: "active",
              pinned: false,
              rank: "1/3",
              version: 1,
              createdAt: now,
              updatedAt: now,
              type: "code",
              binding: { canonicalRoot: "/opaque/repo" },
              bindingRevisionId: "30000000-0000-4000-8000-000000000013",
              codeAccessPersistence: "current-session",
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

describe("RemoteShellView", () => {
  it("shows host freshness and exercises Chat mutation when ready", async () => {
    const user = userEvent.setup();
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByText("This Mac")).toBeInTheDocument();
    expect(mapBridgeStateToHostHealth(bridge.getState())).toBe("healthy");

    await user.click(screen.getByRole("button", { name: "Verify Chat mutation" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Verify Chat mutation succeeded over the remote session/i),
      ).toBeInTheDocument(),
    );
  });

  it("exercises Work and Code mutations from their mode panels", async () => {
    const user = userEvent.setup();
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Verify Work mutation" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Verify Work mutation succeeded over the remote session/i),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Code" }));
    await user.click(screen.getByRole("button", { name: "Verify Code mutation" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Verify Code mutation succeeded over the remote session/i),
      ).toBeInTheDocument(),
    );
  });

  it("preserves drafts across stale transitions and blocks offline mutations", async () => {
    const user = userEvent.setup();
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    const draft = await screen.findByLabelText("Composer draft");
    await user.type(draft, "offline-safe draft");
    bridge.connection()?.disconnect();
    await waitFor(() => expect(bridge.getState().kind).toBe("stale"));

    expect(screen.getByDisplayValue("offline-safe draft")).toBeInTheDocument();
    await expect(exerciseRemoteChatMutation({ bridge })).rejects.toThrow(/disconnected/i);
    expect(screen.getByRole("button", { name: "Verify Chat mutation" })).toBeDisabled();
  });

  it("marks local-host-only surfaces unavailable without action buttons", async () => {
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByText("Local host only")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();
    expect(screen.getByText("Provider credentials")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable remotely").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("shows preview as context-bound instead of sending an invalid metadata request", async () => {
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByText("Previews")).toBeInTheDocument();
    expect(screen.getByText("Available in Project context")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview metadata/i })).not.toBeInTheDocument();
  });

  it("shows Project Overview, device self-service, and host health label", async () => {
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    expect(await screen.findByRole("region", { name: "Project Overview" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Remote Chat")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "This browser device" })).toBeInTheDocument();
    expect(await screen.findByText("Remote browser", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke all/i })).not.toBeInTheDocument();
  });

  it("keeps stale Project Overview labeling while host identity stays visible", async () => {
    const bridge = await readyBridge();
    render(<RemoteShellView bridge={bridge} onReset={vi.fn()} />);

    await screen.findByDisplayValue("Remote Chat");
    bridge.connection()?.disconnect();
    await waitFor(() => expect(bridge.getState().kind).toBe("stale"));

    expect(screen.getByText("This Mac")).toBeInTheDocument();
    expect(screen.getByText("Stale connection")).toBeInTheDocument();
    expect(screen.getByText(/Project snapshot stale/i)).toBeInTheDocument();
    expect(screen.getByText(/Stale snapshot · read-only/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Remote Chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
  });
});
