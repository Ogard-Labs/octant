import {
  decodePendingRequest,
  decodeWindowId,
  MAX_PENDING_REQUESTS,
  type PendingRequest,
  type ProductSurfaceSettings,
} from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { defaultShellSettings } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { createPendingRequestRouteHandler } from "./pendingRequestRoutes";
import { PendingRequestService, type PendingRequestSources } from "./pendingRequestService";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = "00000000-0000-4000-8000-000000000901";

const workApproval = decodePendingRequest({
  mode: "work",
  kind: "approval",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000902",
  threadTitle: "Quarterly report",
  text: "Run `bun install`.",
  requestedAt: "2026-10-06T08:02:00.000Z",
  answer: { requestId: "00000000-0000-4000-8000-000000000903", expectedVersion: 1 },
});
const codeApproval = decodePendingRequest({
  mode: "code",
  kind: "approval",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000904",
  threadTitle: "Fix the parser",
  text: "Allow `bun test`?",
  requestedAt: "2026-10-06T08:01:00.000Z",
  answer: {
    threadId: "00000000-0000-4000-8000-000000000904",
    checkoutId: "00000000-0000-4000-8000-000000000905",
    approvalId: "00000000-0000-4000-8000-000000000906",
  },
});
const chatQuestion = decodePendingRequest({
  mode: "chat",
  kind: "question",
  threadId: "00000000-0000-4000-8000-000000000907",
  threadTitle: "Trip plan",
  text: "How should I proceed?",
  options: [{ label: "Yes" }, { label: "No" }],
  requestedAt: "2026-10-06T08:03:00.000Z",
  answer: {
    threadId: "00000000-0000-4000-8000-000000000907",
    expectedVersion: 3,
    turnId: "00000000-0000-4000-8000-000000000908",
    attemptId: "00000000-0000-4000-8000-000000000909",
    requestId: "q-first",
  },
});

const codeDecision = decodePendingRequest({
  mode: "code",
  kind: "decision",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000910",
  threadTitle: "Ship the parser",
  text: "Open the pull request now?",
  options: [
    { label: "Open it", recommended: true },
    { label: "Wait", recommended: false },
  ],
  requestedAt: "2026-10-06T08:00:30.000Z",
  answer: {
    threadId: "00000000-0000-4000-8000-000000000910",
    checkoutId: "00000000-0000-4000-8000-000000000911",
    operationId: "00000000-0000-4000-8000-000000000912",
  },
});

describe("pending request route", () => {
  it("lists a finished turn's decision for a local window, oldest first among requests", async () => {
    const { route } = fixture({ code: [codeApproval, codeDecision] });
    const response = await route(request());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      requests: [codeDecision, codeApproval, workApproval, chatQuestion],
      truncated: false,
    });
  });

  it("gives a paired device no decision", async () => {
    const { route, sources } = fixture({ code: [codeDecision] });
    const remote = new Request("http://127.0.0.1/api/pending-requests");
    bindPrincipalRouteContext(remote, {
      principal: createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
        deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      }),
      scopeId: decodeWindowId("22222222-2222-4222-8222-222222222222"),
    });
    const response = await route(remote);
    expect(response?.status).toBe(403);
    expect(JSON.stringify(await response?.json())).not.toContain("Open the pull request");
    expect(sources.code).not.toHaveBeenCalled();
  });

  it("lists the window's Work, Code, and Chat requests, oldest waiting first", async () => {
    const { route, sources } = fixture();
    const response = await route(request());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      requests: [codeApproval, workApproval, chatQuestion],
      truncated: false,
    });
    expect(sources.work).toHaveBeenCalledWith(windowId);
    expect(sources.code).toHaveBeenCalledWith(windowId);
  });

  it("asks a disabled mode for nothing and lists nothing from it", async () => {
    const { route, sources } = fixture({
      settings: { ...defaultShellSettings(), chatEnabled: false, workEnabled: false },
    });
    const response = await route(request());
    expect(await response?.json()).toEqual({ requests: [codeApproval], truncated: false });
    expect(sources.work).not.toHaveBeenCalled();
    expect(sources.chat).not.toHaveBeenCalled();
  });

  it("keeps the oldest requests and says so when more are waiting than one read carries", async () => {
    const many = Array.from({ length: MAX_PENDING_REQUESTS + 2 }, (_, index) =>
      decodePendingRequest({
        ...workApproval,
        requestedAt: new Date(Date.UTC(2026, 9, 6, 8, 0, index)).toISOString(),
        answer: { ...workApproval.answer, expectedVersion: index + 1 },
      }),
    ).reverse();
    const { route } = fixture({ work: many, code: [], chat: [] });
    const body = await (await route(request()))?.json();
    expect(body.truncated).toBe(true);
    expect(body.requests).toHaveLength(MAX_PENDING_REQUESTS);
    expect(body.requests[0].requestedAt).toBe("2026-10-06T08:00:00.000Z");
  });

  it("refuses a read without the window capability", async () => {
    const { route, sources } = fixture();
    const response = await route(new Request("http://127.0.0.1/api/pending-requests"));
    expect(response?.status).toBe(401);
    expect(sources.code).not.toHaveBeenCalled();
  });

  it("refuses a read that is not on loopback", async () => {
    const { route } = fixture();
    const response = await route(
      new Request("http://192.168.1.20/api/pending-requests", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("refuses a paired device even when its request reaches the route", async () => {
    const { route, sources } = fixture();
    const remote = new Request("http://127.0.0.1/api/pending-requests");
    bindPrincipalRouteContext(remote, {
      principal: createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
        deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      }),
      scopeId: decodeWindowId("22222222-2222-4222-8222-222222222222"),
    });
    const response = await route(remote);
    expect(response?.status).toBe(403);
    expect(sources.work).not.toHaveBeenCalled();
    expect(sources.code).not.toHaveBeenCalled();
    expect(sources.chat).not.toHaveBeenCalled();
  });

  it("refuses a caller that names a window or any other parameter", async () => {
    const { route } = fixture();
    const response = await route(request(`?windowId=${String(windowId)}`));
    expect(response?.status).toBe(400);
  });

  it("drops a request from the next read once its mode no longer lists it", async () => {
    const work = [workApproval];
    const { route } = fixture({ work, code: [], chat: [] });
    expect(await (await route(request()))?.json()).toMatchObject({ requests: [workApproval] });
    work.length = 0;
    expect(await (await route(request()))?.json()).toMatchObject({ requests: [] });
  });

  it("fails the read rather than leave out a mode it could not read", async () => {
    const { route } = fixture({
      code: async () => {
        throw new Error("checkout authority unavailable");
      },
    });
    const response = await route(request());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      code: "unavailable",
      message: "Pending requests are unavailable.",
    });
  });
});

function request(search = ""): Request {
  return new Request(`http://127.0.0.1/api/pending-requests${search}`, {
    headers: { "x-octant-window-capability": capability },
  });
}

function fixture(
  options: {
    readonly settings?: ProductSurfaceSettings;
    readonly work?: ReadonlyArray<PendingRequest>;
    readonly code?: ReadonlyArray<PendingRequest> | (() => Promise<ReadonlyArray<PendingRequest>>);
    readonly chat?: ReadonlyArray<PendingRequest>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const code = options.code;
  const sources = {
    readSettings: () => options.settings ?? defaultShellSettings(),
    work: vi.fn(async () => [...(options.work ?? [workApproval])]),
    code: vi.fn(typeof code === "function" ? code : async () => code ?? [codeApproval]),
    chat: vi.fn(() => options.chat ?? [chatQuestion]),
  } satisfies PendingRequestSources;
  const route = createPendingRequestRouteHandler({
    service: new PendingRequestService(sources),
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { route, sources };
}
