import { randomBytes } from "node:crypto";
import { decodeNightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_OPERATION_APPROVAL_VIEW_CHANNELS,
  type CodeOperationApprovalViewPort,
} from "./codeOperationApprovalView";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import { installNightlyCodeApprovals } from "./nightlyCodeApprovals";
import { createNativeMainAuthority } from "./nightlyNativeMainAuthority";

const token = () => randomBytes(32).toString("base64url");
const ids = {
  window: "10000000-0000-4000-8000-0000000006a1",
  project: "70000000-0000-4000-8000-000000000001",
  thread: "10000000-0000-4000-8000-000000000001",
  checkout: "20000000-0000-4000-8000-000000000001",
  challenge: "50000000-0000-4000-8000-000000000001",
  approval: "40000000-0000-4000-8000-000000000001",
};
const request = {
  effect: {
    kind: "change-thread-full-access",
    threadId: ids.thread,
    expectedVersion: 1,
    permissionPersistence: "current-session",
  },
};
const challenge = {
  challengeId: ids.challenge,
  effectDigest: "a".repeat(64),
  contextDigest: "b".repeat(64),
  projectId: ids.project,
  threadId: ids.thread,
  threadTitle: "Fix login",
  checkoutId: ids.checkout,
  repositoryId: `repo_${"c".repeat(64)}`,
  checkoutHead: { kind: "detached", oid: "d".repeat(40) },
  message: "Allow Full access?",
  detail: "Project: authoritative\nThread: Fix login",
};
const anchor = {
  kind: "thread",
  projectId: ids.project,
  threadId: ids.thread,
  bounds: { x: 80, y: 600, width: 640, height: 96 },
};

function harness(features: ReadonlyArray<string>) {
  const nativeMainToken = token();
  const bootstrap = decodeNightlyWindowBootstrap({
    kind: "registered",
    protocol: 1,
    windowId: ids.window,
    generation: 1,
    hostOrigin: "http://127.0.0.1:13773",
    hostInstance: "00000000-0000-4000-8000-000000000594",
    capability: token(),
    rendererIdentity: token(),
    leaseMs: 15_000,
    nativeMainToken,
    hostFeatures: features,
  });
  const nativeMain = createNativeMainAuthority();
  nativeMain.remember(7, bootstrap);
  const window = { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }) };
  const handlers = new Map<string, (event: unknown, ...values: unknown[]) => unknown>();
  const viewTokens: string[] = [];
  const view: CodeOperationApprovalViewPort = {
    webContents: {
      id: 41,
      loadURL: vi.fn(async () => undefined),
      send: vi.fn(),
      close: vi.fn(),
      isDestroyed: () => false,
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };
  const fetch = vi.fn(async (url: URL | string) =>
    String(url).endsWith("/code-operation-approval-challenges")
      ? Response.json(challenge)
      : String(url).endsWith("/code-operation-approval-confirmations")
        ? Response.json({ approvalId: ids.approval })
        : new Response(null, { status: 204 }),
  );
  installNightlyCodeApprovals({
    register: (channel, handler) => handlers.set(channel, handler as never),
    handleViewDecision: (channel, handler) => handlers.set(channel, handler as never),
    owns: (event) => {
      if ((event as { sender: { id: number } }).sender.id !== 7) throw new Error("not owned");
      return window;
    },
    bootstrap: (id) => (id === 7 ? bootstrap : undefined),
    nativeMain,
    views: {
      createView: (viewToken) => {
        viewTokens.push(viewToken);
        return view;
      },
      attach: vi.fn(),
      detach: vi.fn(),
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const from = (sender: number) => ({ sender: { id: sender } });
  const call = (channel: string, sender: number, ...values: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler(from(sender), ...values);
  };
  const routes = () => fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
  return { bootstrap, nativeMainToken, fetch, call, routes, viewTokens };
}

describe("Code operation approvals in a Nightly window", () => {
  it("confirms only from the native view's own decision, with the window's main-only token", async () => {
    const h = harness(["code-operation-approval"]);
    const approval = h.call(DESKTOP_IPC_CHANNELS.requestCodeOperationApproval, 7, request);
    await h.call(DESKTOP_IPC_CHANNELS.updateCodeOperationApprovalAnchor, 7, anchor);
    await vi.waitFor(() => expect(h.viewTokens).toHaveLength(1));
    await vi.waitFor(() =>
      expect(h.routes()).toContain("/api/desktop/code-operation-approval-challenges"),
    );
    const [, init] = h.fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-octant-window-capability": h.bootstrap.capability,
      "x-octant-native-main-authority": h.nativeMainToken,
    });
    const decision = {
      token: h.viewTokens[0],
      challengeId: ids.challenge,
      decision: "approve",
    };
    // The window's renderer holds no view token and is not the view: its
    // channels and a forged decision from its own web contents confirm nothing.
    await h.call(DESKTOP_IPC_CHANNELS.updateCodeOperationApprovalAnchor, 7, anchor);
    await expect(
      h.call(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.decision, 7, decision),
    ).resolves.toBeUndefined();
    expect(h.routes()).not.toContain("/api/desktop/code-operation-approval-confirmations");
    await h.call(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.decision, 41, decision);
    await expect(approval).resolves.toBe(ids.approval);
    expect(h.routes()).toContain("/api/desktop/code-operation-approval-confirmations");
  });

  it("says it needs a newer Octant when the host does not broker approvals, without asking it", async () => {
    const h = harness(["provider-credentials"]);
    await expect(
      h.call(DESKTOP_IPC_CHANNELS.requestCodeOperationApproval, 7, request),
    ).rejects.toThrow(NEEDS_NEWER_OCTANT);
    expect(h.viewTokens).toEqual([]);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses an approval request from a sender that is not a Nightly window", async () => {
    const h = harness(["code-operation-approval"]);
    await expect(
      h.call(DESKTOP_IPC_CHANNELS.requestCodeOperationApproval, 8, request),
    ).rejects.toThrow("not owned");
  });
});
