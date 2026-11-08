import {
  decodePendingRequest,
  decodeUtcTimestamp,
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

const workChildApproval = decodePendingRequest({
  mode: "work",
  kind: "child-approval",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000902",
  threadTitle: "Quarterly report",
  child: {
    runId: "00000000-0000-4000-8000-000000000a01",
    role: "research",
    task: "Collect the figures.",
  },
  text: "Run `bun install`.",
  requestedAt: "2026-10-06T08:04:00.000Z",
});
const codeChildQuestion = decodePendingRequest({
  mode: "code",
  kind: "child-question",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000904",
  threadTitle: "Fix the parser",
  child: {
    runId: "00000000-0000-4000-8000-000000000a02",
    role: "review",
    task: "Review the parser change.",
  },
  text: "Which fixture should I use?",
  requestedAt: "2026-10-06T08:00:10.000Z",
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

  it("lists a waiting subagent beside the requests it works under, without a way to answer it", async () => {
    const { route, sources } = fixture({ children: [workChildApproval, codeChildQuestion] });
    const body = await (await route(request()))?.json();
    expect(body.requests).toEqual([
      codeChildQuestion,
      codeApproval,
      workApproval,
      chatQuestion,
      workChildApproval,
    ]);
    expect(body.requests[0]).not.toHaveProperty("answer");
    expect(body.requests[0]).not.toHaveProperty("options");
    expect(sources.children).toHaveBeenCalledWith(windowId);
  });

  it("lists the agent's own approval beside the requests it works under, without a way to answer it, and not for a mode that is switched off", async () => {
    const leadApproval = decodePendingRequest({
      mode: "work",
      kind: "lead-approval",
      projectId,
      threadId: "00000000-0000-4000-8000-000000000902",
      threadTitle: "Quarterly report",
      text: "edit: summary.md",
      requestedAt: "2026-10-06T08:00:00.000Z",
    });
    const { route } = fixture({ children: [leadApproval] });
    const body = await (await route(request()))?.json();
    expect(body.requests[0]).toEqual(leadApproval);
    expect(body.requests[0]).not.toHaveProperty("answer");

    const off = fixture({
      settings: { ...defaultShellSettings(), workEnabled: false },
      children: [leadApproval],
    });
    const hidden = await (await off.route(request()))?.json();
    expect(hidden.requests.map((entry: { kind: string }) => entry.kind)).not.toContain(
      "lead-approval",
    );
  });

  it("lists no subagent row for a mode that is switched off", async () => {
    const { route } = fixture({
      settings: { ...defaultShellSettings(), workEnabled: false },
      children: [workChildApproval, codeChildQuestion],
    });
    const body = await (await route(request()))?.json();
    expect(body.requests.map((entry: { kind: string }) => entry.kind)).toEqual([
      "child-question",
      "approval",
      "question",
    ]);
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
        answer: { requestId: "00000000-0000-4000-8000-000000000903", expectedVersion: index + 1 },
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
    readonly deferrals?: PendingRequestSources["deferrals"];
    readonly settings?: ProductSurfaceSettings;
    readonly work?: ReadonlyArray<PendingRequest>;
    readonly code?: ReadonlyArray<PendingRequest> | (() => Promise<ReadonlyArray<PendingRequest>>);
    readonly chat?: ReadonlyArray<PendingRequest>;
    readonly children?: ReadonlyArray<PendingRequest>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const code = options.code;
  const sources = {
    ...(options.deferrals === undefined ? {} : { deferrals: options.deferrals }),
    readSettings: () => options.settings ?? defaultShellSettings(),
    work: vi.fn(async () => [...(options.work ?? [workApproval])]),
    code: vi.fn(typeof code === "function" ? code : async () => code ?? [codeApproval]),
    chat: vi.fn(() => options.chat ?? [chatQuestion]),
    children: vi.fn(async () => options.children ?? []),
  } satisfies PendingRequestSources;
  const route = createPendingRequestRouteHandler({
    service: new PendingRequestService(sources),
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { route, sources };
}

it("defers the exact question across windows and replay without answering it", async () => {
  const records: Array<{ key: string; until: string | null }> = [];
  const questions = [chatQuestion];
  const source = {
    readSettings: defaultShellSettings,
    work: async () => [workApproval],
    code: async () => [],
    children: async () => [],
    chat: () => questions,
    now: () => Date.parse("2026-10-06T09:00:00Z"),
    deferrals: {
      read: (key: string) => records.filter((r) => r.key === key).at(-1)?.until ?? undefined,
      record: (r: { key: string; until: string | null }) => {
        records.push(r);
      },
    },
  };
  const service = new PendingRequestService(source);
  const key =
    (await service.list(windowId)).requests.find((r) => r.kind === "question")?.deferralKey ??
    "missing";
  const change = { key, until: decodeUtcTimestamp("2026-10-06T10:00:00.000Z") };
  expect(await service.defer(windowId, change, () => true)).toBe(true);
  expect(questions).toEqual([chatQuestion]);
  expect(
    (
      await new PendingRequestService(source).list(
        decodeWindowId("00000000-0000-4000-8000-000000000802"),
      )
    ).requests.find((r) => r.kind === "question")?.deferredUntil,
  ).toBe(change.until);
  expect(await service.defer(windowId, { ...change, until: null }, () => true)).toBe(true);
  expect(
    (await service.list(windowId)).requests.find((r) => r.kind === "question")?.deferredUntil,
  ).toBeUndefined();
  expect(await service.defer(windowId, change, () => false)).toBe(false);
  questions.length = 0;
  expect(await service.defer(windowId, change, () => true)).toBe(false);
  expect((await service.list(windowId)).requests).toEqual([workApproval]);
});

it("authenticates question deferral, refuses approval keys and never calls an answer path", async () => {
  const record = vi.fn();
  const { route } = fixture({ deferrals: { read: () => undefined, record } });
  const list = await (await route(request()))?.json();
  const question = list.requests.find((r: PendingRequest) => r.kind === "question");
  const send = (body: unknown, token = capability) =>
    route(
      new Request("http://127.0.0.1/api/pending-requests/defer", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": token },
        body: JSON.stringify(body),
      }),
    );
  const change = { key: question.deferralKey, until: "2099-01-01T00:00:00.000Z" };
  expect((await send(change, "wrong"))?.status).toBe(401);
  expect((await send({ ...change, answer: "Yes" }))?.status).toBe(400);
  expect((await send({ ...change, key: "a".repeat(64) }))?.status).toBe(409);
  expect(record).not.toHaveBeenCalled();
  expect((await send(change))?.status).toBe(200);
  expect(record).toHaveBeenCalledExactlyOnceWith(change);
});

it("keeps deferral bound to the current choices and access in every answerable mode", async () => {
  const workQuestion = decodePendingRequest({
    ...workApproval,
    kind: "question",
    options: [{ label: "Yes" }],
  });
  const codeQuestion = decodePendingRequest({
    ...codeApproval,
    kind: "question",
    options: [{ label: "Yes" }],
    answer: {
      threadId: codeApproval.threadId,
      checkoutId: "00000000-0000-4000-8000-000000000905",
      requestId: "00000000-0000-4000-8000-000000000906",
    },
  });
  for (const question of [chatQuestion, workQuestion, codeQuestion]) {
    const record = vi.fn();
    let available = [question];
    const source = {
      readSettings: defaultShellSettings,
      work: async () => available.filter((r) => r.mode === "work"),
      code: async () => available.filter((r) => r.mode === "code"),
      chat: () => available.filter((r) => r.mode === "chat"),
      children: async () => [],
      deferrals: { read: () => undefined, record },
    };
    const service = new PendingRequestService(source);
    const key = (await service.list(windowId)).requests[0]?.deferralKey ?? "missing";
    const change = { key, until: decodeUtcTimestamp("2099-01-01T00:00:00.000Z") };
    expect(await service.defer(windowId, change, () => true)).toBe(true);
    available = [decodePendingRequest({ ...question, options: [{ label: "Changed" }] })];
    expect(await service.defer(windowId, change, () => true)).toBe(false);
    available = [];
    expect(await service.defer(windowId, change, () => true)).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
  }
});

it("defers a decision by the turn that asked it and brings it back with its deferral", async () => {
  const decision = decodePendingRequest({
    mode: "code",
    kind: "decision",
    projectId,
    threadId: "00000000-0000-4000-8000-000000000904",
    threadTitle: "Fix the parser",
    text: "Open the pull request now?",
    options: [{ label: "Open it", recommended: true }],
    requestedAt: "2026-10-06T08:05:00.000Z",
    answer: {
      threadId: "00000000-0000-4000-8000-000000000904",
      checkoutId: "00000000-0000-4000-8000-000000000905",
      operationId: "00000000-0000-4000-8000-000000000a02",
    },
  });
  const untilByKey = new Map<string, string>();
  const service = new PendingRequestService({
    readSettings: defaultShellSettings,
    work: async () => [],
    code: async () => [decision],
    children: async () => [],
    chat: () => [],
    deferrals: {
      read: (key: string) => untilByKey.get(key),
      record: (change: { key: string; until: string | null }) => {
        if (change.until === null) untilByKey.delete(change.key);
        else untilByKey.set(change.key, change.until);
      },
    },
  });
  const listed = (await service.list(windowId)).requests[0];
  const key = listed?.deferralKey ?? "missing";
  expect(listed?.deferredUntil).toBeUndefined();
  const until = decodeUtcTimestamp("2099-01-01T00:00:00.000Z");
  expect(await service.defer(windowId, { key, until }, () => true)).toBe(true);
  expect((await service.list(windowId)).requests[0]?.deferredUntil).toBe(until);
  expect(await service.defer(windowId, { key: "a".repeat(64), until }, () => true)).toBe(false);
});
