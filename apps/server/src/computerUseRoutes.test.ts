import {
  decodeComputerUseSessionView,
  decodeWindowId,
  type ComputerUseApprovalDecisionRequest,
  type ComputerUseSessionScope,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseRuntimeError } from "./computerUse/computerUseRuntime";
import { createComputerUseRouteHandler } from "./computerUseRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "30000000-0000-4000-8000-000000000001",
  rootId: "40000000-0000-4000-8000-000000000001",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as const;
const scope = {
  sessionId: "60000000-0000-4000-8000-000000000001",
  threadId: "70000000-0000-4000-8000-000000000001",
  authority,
} as ComputerUseSessionScope;
const view = decodeComputerUseSessionView({
  ...scope,
  requestedBy: {
    kind: "local-user",
    actorId: "80000000-0000-4000-8000-000000000001",
  },
  state: "waiting-for-approval",
  sequence: 1,
  pendingApproval: {
    approvalId: "90000000-0000-4000-8000-000000000001",
    actionId: "a0000000-0000-4000-8000-000000000001",
    expiresAt: "2026-07-27T21:01:00.000Z",
    summary: "click in Preview",
  },
  events: [
    {
      sequence: 1,
      kind: "approval-requested",
      occurredAt: "2026-07-27T21:00:00.000Z",
      detail: "One-time approval is required.",
    },
  ],
});

function fixture() {
  const authorityStore = new WindowAuthorityStore();
  authorityStore.register({ windowId, capability, now: 1_000 });
  const { pendingApproval: _pendingApproval, ...terminalView } = view;
  const runtime = {
    inspect: vi.fn(() => view),
    list: vi.fn(() => [view]),
    decide: vi.fn(async () => ({ ...terminalView, state: "completed" as const })),
    stop: vi.fn(async () => ({ ...terminalView, state: "stopped" as const })),
    listForHostPerson: vi.fn(() => [view]),
    inspectForHostPerson: vi.fn(() => view),
    stopForHostPerson: vi.fn(async () => ({ ...terminalView, state: "stopped" as const })),
  };
  return {
    runtime,
    handle: createComputerUseRouteHandler({
      runtime,
      windowAuthorityStore: authorityStore,
      now: () => 1_001,
    }),
  };
}

function request(path: string, body: unknown, token = capability): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": token,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(body),
  });
}

const deviceId = "b0000000-0000-4000-8000-000000000001";

/** A request the remote dispatch forwarded, with the device session it authenticated. */
function deviceRequest(
  path: string,
  body: unknown,
  admittedBy: "host-person" | "hub-roster" | undefined,
): Request {
  const forwarded = new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(forwarded, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "c0000000-0000-4000-8000-0000000000aa",
      ...(admittedBy === undefined ? {} : { admittedBy }),
    } as never,
    scopeId: deviceId as never,
  });
  return forwarded;
}

describe("computer-use lifecycle routes", () => {
  it("lets a device the host's own person paired see and stop computer use a window's turn started", async () => {
    const { handle, runtime } = fixture();
    const sessions = await handle(deviceRequest("/api/computer-use/sessions", {}, "host-person"));
    expect(sessions?.status).toBe(200);
    await expect(sessions?.json()).resolves.toEqual([view]);
    expect(
      (await handle(deviceRequest("/api/computer-use/inspect", scope, "host-person")))?.status,
    ).toBe(200);
    const stopped = await handle(deviceRequest("/api/computer-use/stop", scope, "host-person"));
    expect(stopped?.status).toBe(200);
    await expect(stopped?.json()).resolves.toMatchObject({ state: "stopped" });
    expect(runtime.stopForHostPerson).toHaveBeenCalledWith(scope);
    // The window-scoped lookups are never used for the person's device.
    expect(runtime.list).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("refuses to stop computer use for a device the hub's roster introduced, an unproved pairing, or a caller with no session", async () => {
    const { handle, runtime } = fixture();
    for (const admittedBy of ["hub-roster", undefined] as const) {
      expect(
        (await handle(deviceRequest("/api/computer-use/stop", scope, admittedBy)))?.status,
      ).toBe(403);
      expect(
        (await handle(deviceRequest("/api/computer-use/sessions", {}, admittedBy)))?.status,
      ).toBe(403);
    }
    const anonymous = new Request("http://127.0.0.1/api/computer-use/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scope),
    });
    expect((await handle(anonymous))?.status).toBe(401);
    expect(runtime.stopForHostPerson).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.listForHostPerson).not.toHaveBeenCalled();
  });

  it("returns a replayable view only through the authenticated owner window", async () => {
    const { handle, runtime } = fixture();
    const response = await handle(request("/api/computer-use/inspect", scope));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual(view);
    expect(runtime.inspect).toHaveBeenCalledWith({ ownerWindowId: windowId, ...scope });

    const sessions = await handle(request("/api/computer-use/sessions", {}));
    expect(sessions?.status).toBe(200);
    await expect(sessions?.json()).resolves.toEqual([view]);
    expect(runtime.list).toHaveBeenCalledWith(windowId);

    const unauthorized = await handle(
      request("/api/computer-use/inspect", scope, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"),
    );
    expect(unauthorized?.status).toBe(401);
    expect(runtime.inspect).toHaveBeenCalledOnce();
  });

  it("forwards exact one-time approval and immediate stop commands", async () => {
    const { handle, runtime } = fixture();
    const decision = {
      ...scope,
      actionId: view.pendingApproval!.actionId,
      approvalId: view.pendingApproval!.approvalId,
      decision: "approved",
    } satisfies ComputerUseApprovalDecisionRequest;

    expect((await handle(request("/api/computer-use/approvals", decision)))?.status).toBe(200);
    expect(runtime.decide).toHaveBeenCalledWith({ ownerWindowId: windowId, ...decision });
    expect((await handle(request("/api/computer-use/stop", scope)))?.status).toBe(200);
    expect(runtime.stop).toHaveBeenCalledWith({ ownerWindowId: windowId, ...scope });
  });

  it("fails closed for invalid origin/body/method and runtime scope denial", async () => {
    const { handle, runtime } = fixture();
    const badOrigin = request("/api/computer-use/inspect", scope);
    badOrigin.headers.set("origin", "https://attacker.example");
    expect((await handle(badOrigin))?.status).toBe(400);
    expect((await handle(new Request("http://127.0.0.1/api/computer-use/inspect")))?.status).toBe(
      405,
    );
    expect(
      (await handle(request("/api/computer-use/inspect", { ...scope, extra: true })))?.status,
    ).toBe(400);

    runtime.decide.mockRejectedValueOnce(
      new ComputerUseRuntimeError("approval-denied", "Approval is stale."),
    );
    const denied = await handle(
      request("/api/computer-use/approvals", {
        ...scope,
        actionId: view.pendingApproval!.actionId,
        approvalId: view.pendingApproval!.approvalId,
        decision: "approved",
      }),
    );
    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toMatchObject({ category: "approval-denied" });
  });

  it("refuses an approval that arrives over the network instead of from a window on this Mac", async () => {
    const { handle, runtime } = fixture();
    const decision = {
      ...scope,
      actionId: view.pendingApproval?.actionId,
      approvalId: view.pendingApproval?.approvalId,
      decision: "approved",
    };
    const remote = new Request("http://octant-mac.tailnet.example/api/computer-use/approvals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": capability,
        origin: "http://octant-mac.tailnet.example",
      },
      body: JSON.stringify(decision),
    });
    expect((await handle(remote))?.status).toBe(400);
    // A window this host never registered, such as a paired device's, has no
    // capability to present.
    const unregistered = await handle(
      request("/api/computer-use/approvals", decision, "B".repeat(43)),
    );
    expect(unregistered?.status).toBe(401);
    expect(runtime.decide).not.toHaveBeenCalled();
  });
});
