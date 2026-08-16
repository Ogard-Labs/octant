import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AggregateVersion,
  decodeWorkRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type WorkRequestFrame,
  type WorkRequestId,
} from "@octant/contracts";

const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
import { EventActor } from "@octant/contracts/events";
import { WorkRequestProjection } from "./workRequestProjection";
import { WorkRequestService, type WorkRequestProjectPort } from "./workRequestService";

const ids = {
  request: decodeWorkRequestId("11111111-1111-4111-8111-111111111111"),
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  thread: decodeWorkThreadId("33333333-3333-4333-8333-333333333333"),
  provider: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
  session: decodeProviderSessionId("77777777-7777-4777-8777-777777777777"),
  otherProvider: decodeProviderInstanceId("88888888-8888-4888-8888-888888888888"),
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const systemActor = Schema.decodeUnknownSync(EventActor)({ kind: "system", actorId: ids.actor });
const clockNow = "2026-08-10T08:00:00.000Z";
const clockLater = "2026-08-10T08:05:00.000Z";

const approvalDetail = {
  kind: "approval",
  action: "run-terminal-command",
  description: "Run `bun install`.",
} as const;

interface TestHarness {
  service: WorkRequestService;
  projection: WorkRequestProjection;
  clock: { ticks: number; now: () => string };
}

function createService(
  options: {
    projects?: WorkRequestProjectPort;
    actorOverride?: typeof EventActor.Type;
    providerSessions?: Partial<{
      answerApproval: (input: {
        readonly sessionId: string;
        readonly requestId: string;
        readonly approved: boolean;
      }) => Promise<void>;
      answerUserInput: (input: {
        readonly sessionId: string;
        readonly requestId: string;
        readonly answer: string;
      }) => Promise<void>;
      cancel: (input: {
        readonly sessionId: string;
        readonly requestId: string;
        readonly kind: "approval" | "user-input";
      }) => Promise<void>;
    }>;
    eventStore?: {
      append(input: {
        readonly requestId: WorkRequestId;
        readonly expectedVersion: number;
        readonly frame: WorkRequestFrame;
        readonly occurredAt: string;
        readonly actor: typeof EventActor.Type;
      }): WorkRequestFrame;
      replayAll(): { readonly status: "ok"; readonly frames: ReadonlyArray<WorkRequestFrame> };
    };
  } = {},
): TestHarness {
  const projection = new WorkRequestProjection();
  const clock = { ticks: 0, now: () => (clock.ticks++ === 0 ? clockNow : clockLater) };
  const projects: WorkRequestProjectPort = options.projects ?? {
    projectType: (id) => (id === ids.project ? "work" : "unknown"),
    isActiveWorkProject: (id) => id === ids.project,
    workCanonicalRoot: () => "/work",
    threadProjectId: () => ids.project,
    threadProviderInstanceId: () => ids.provider,
  };
  let sequence = 0;
  const frames = new Map<WorkRequestId, Array<WorkRequestFrame>>();
  const defaultEventStore = {
    append(input: {
      requestId: WorkRequestId;
      expectedVersion: number;
      frame: WorkRequestFrame;
      occurredAt: string;
    }) {
      const existing = frames.get(input.requestId) ?? [];
      if (existing.length !== input.expectedVersion) {
        throw new Error("optimistic concurrency conflict");
      }
      sequence += 1;
      frames.set(input.requestId, [...existing, input.frame]);
      return input.frame;
    },
    replayAll() {
      return {
        status: "ok" as const,
        frames: [...frames.values()].flat(),
      };
    },
  };
  const eventStore = options.eventStore ?? defaultEventStore;
  void sequence;
  const service = new WorkRequestService({
    projects,
    projection,
    eventStore,
    actor: options.actorOverride ?? actor,
    clock: clock.now,
    ...(options.providerSessions === undefined
      ? {}
      : { providerSessions: options.providerSessions }),
  } as never);
  return { service, projection, clock };
}

describe("WorkRequestService.record", () => {
  it("records a new pending approval request", () => {
    const { service } = createService();
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.request.status).toBe("pending");
    expect(result.request.version).toBe(1);
  });

  it("keeps a credential-bearing provider callback private while delivering it exactly", async () => {
    const delivered: Array<string> = [];
    const { service, projection } = createService({
      providerSessions: {
        answerApproval: async (input) => {
          delivered.push(input.requestId);
        },
      },
    });
    const providerCallbackId = "postgres://alice:secret@host/request";
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId,
      detail: approvalDetail,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.request.providerRequestId).toBe(String(ids.request));
    expect(JSON.stringify(result.request)).not.toContain(providerCallbackId);
    expect(projection.lookup(result.request.requestId)?.providerCallbackId).toBe(
      providerCallbackId,
    );

    await service.resolve({
      kind: "resolve-work-request",
      requestId: result.request.requestId,
      expectedVersion: result.request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(delivered).toEqual([providerCallbackId]);
  });

  it("is idempotent for a redelivered providerRequestId on the same thread", () => {
    const { service } = createService();
    const first = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    const second = service.record({
      requestId: decodeWorkRequestId("66666666-6666-4666-8666-666666666666"),
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  it("does not collapse a reused provider request id from a new provider session", () => {
    const { service } = createService();
    const first = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    const second = service.record({
      requestId: decodeWorkRequestId("66666666-6666-4666-8666-666666666666"),
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: decodeProviderSessionId("77777777-7777-4777-8777-777777777778"),
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.request.requestId).not.toBe(first.request.requestId);
  });

  it("fails closed for a non-Work Project", () => {
    const { service } = createService({
      projects: {
        projectType: () => "chat",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("not-found");
  });

  it("rejects provider requests for an archived Work Project", () => {
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => false,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
    });

    expect(
      service.record({
        requestId: ids.request,
        projectId: ids.project,
        threadId: ids.thread,
        providerInstanceId: ids.provider,
        providerSessionId: ids.session,
        providerCallbackId: "provider-req-1",
        detail: approvalDetail,
      }),
    ).toMatchObject({ status: "failure", failure: { code: "unauthorized" } });
  });

  it("fails closed when the Work canonical root is unavailable (confinement)", () => {
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => undefined,
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("fails closed when the recording provider does not match the thread's current provider", () => {
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.otherProvider,
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("rejects a request whose thread belongs to a different Project", () => {
    const otherProject = decodeProjectId("99999999-9999-4999-8999-999999999999");
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProviderInstanceId: () => ids.provider,
        threadProjectId: () => otherProject,
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("rejects a request for an unknown thread", () => {
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProviderInstanceId: () => ids.provider,
        threadProjectId: () => undefined,
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("not-found");
  });
});

describe("WorkRequestService.resolve", () => {
  function recordOne(service: WorkRequestService) {
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    if (result.status !== "ok") throw new Error("setup failed");
    return result.request;
  }

  it("resolves a pending approval request", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.request.status).toBe("resolved");
  });

  it("journals provider-driven and user-driven transitions with their service-clock times", async () => {
    const actors: Array<(typeof EventActor.Type)["kind"]> = [];
    const occurredAt: Array<string> = [];
    const { service } = createService({
      eventStore: {
        append(input) {
          actors.push(input.actor.kind);
          occurredAt.push(input.occurredAt);
          return input.frame;
        },
        replayAll: () => ({ status: "ok", frames: [] }),
      },
    });
    const request = recordOne(service);

    await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });

    expect(actors).toEqual(["system", "local-user", "local-user", "local-user"]);
    expect(occurredAt).toEqual([clockNow, clockLater, clockLater, clockLater]);
  });

  it("answers the originating approval session before journaling resolution", async () => {
    const calls: Array<string> = [];
    const { service } = createService({
      providerSessions: {
        answerApproval: async (input) => {
          calls.push(`answer:${input.sessionId}:${input.requestId}:${input.approved}`);
        },
        answerUserInput: async () => undefined,
      },
    });
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("ok");
    expect(calls).toEqual([`answer:${ids.session}:provider-req-1:true`]);
  });

  it("answers the originating user-input session before journaling resolution", async () => {
    const calls: Array<string> = [];
    const { service } = createService({
      providerSessions: {
        answerApproval: async () => undefined,
        answerUserInput: async (input) => {
          calls.push(`answer:${input.sessionId}:${input.requestId}:${input.answer}`);
        },
      },
    });
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-input-1",
      detail: { kind: "user-input", prompt: "Choose", options: [] },
    });
    if (result.status !== "ok") throw new Error("setup failed");
    const resolved = await service.resolve({
      kind: "resolve-work-request",
      requestId: result.request.requestId,
      expectedVersion: result.request.version,
      resolution: { kind: "user-input", answer: "PDF" },
    });
    expect(resolved.status).toBe("ok");
    expect(calls).toEqual([`answer:${ids.session}:provider-input-1:PDF`]);
  });

  it("keeps the request pending when the provider rejects the answer", async () => {
    const { service, projection } = createService({
      providerSessions: {
        answerApproval: async () => {
          throw new Error("provider disconnected");
        },
        answerUserInput: async () => undefined,
      },
    });
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result).toMatchObject({ status: "failure", failure: { code: "unavailable" } });
    expect(projection.lookup(request.requestId)?.request).toMatchObject({
      status: "pending",
      version: 3,
    });
  });

  it("does not settle an identical resolve while its provider delivery is in flight", async () => {
    let releaseProvider: (() => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const { service, projection } = createService({
      providerSessions: {
        answerApproval: async () =>
          new Promise<void>((resolve) => {
            releaseProvider = resolve;
            providerStarted?.();
          }),
      },
    });
    const request = recordOne(service);
    const command = {
      kind: "resolve-work-request" as const,
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval" as const, approved: true },
    };
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });

    const first = service.resolve(command);
    await started;
    // A provider terminal event can race this acknowledgement; it must not
    // convert the delivery intent into an interruption before it settles.
    expect(service.interruptSession(ids.session)).toEqual([]);
    const duplicate = await service.resolve(command);

    expect(duplicate).toMatchObject({ status: "failure", failure: { code: "conflict" } });
    expect(projection.lookup(request.requestId)?.request).toMatchObject({
      status: "pending",
      delivery: { kind: "resolve" },
      version: 2,
    });
    releaseProvider?.();
    expect(await first).toMatchObject({ status: "ok", request: { status: "resolved" } });
  });

  it("reconciles a provider-accepted answer after its terminal journal append fails", async () => {
    const projection = new WorkRequestProjection();
    const frames = new Map<WorkRequestId, Array<WorkRequestFrame>>();
    let failTerminalAppend = true;
    const eventStore = {
      append(input: {
        requestId: WorkRequestId;
        expectedVersion: number;
        frame: WorkRequestFrame;
      }) {
        if (input.frame.kind === "resolved" && failTerminalAppend) {
          failTerminalAppend = false;
          throw new Error("journal unavailable");
        }
        const existing = frames.get(input.requestId) ?? [];
        if (existing.length !== input.expectedVersion) throw new Error("stale");
        frames.set(input.requestId, [...existing, input.frame]);
        return input.frame;
      },
      replayAll: () => ({ status: "ok" as const, frames: [...frames.values()].flat() }),
    };
    const answers: Array<string> = [];
    const service = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
      projection,
      eventStore,
      actor,
      clock: () => clockNow,
      providerSessions: {
        answerApproval: async (input) => {
          answers.push(`${input.sessionId}:${input.requestId}:${input.approved}`);
        },
      },
    });
    const recorded = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    if (recorded.status !== "ok") throw new Error("setup failed");
    const command = {
      kind: "resolve-work-request" as const,
      requestId: recorded.request.requestId,
      expectedVersion: recorded.request.version,
      resolution: { kind: "approval" as const, approved: true },
    };

    expect(await service.resolve(command)).toMatchObject({
      status: "failure",
      failure: { code: "unavailable" },
    });
    expect(projection.lookup(ids.request)?.request).toMatchObject({
      status: "pending",
      delivery: {
        kind: "resolve",
        resolution: { kind: "approval", approved: true },
        confirmed: true,
      },
      version: 3,
    });

    expect(service.interruptSession(ids.session)).toMatchObject([
      { status: "ok", request: { status: "resolved", version: 4 } },
    ]);
    // A terminal provider event completes the durable, provider-confirmed
    // user intent; it must not overwrite it as an interruption.
    expect(projection.lookup(ids.request)?.request.status).toBe("resolved");
    expect(answers).toEqual([`${ids.session}:provider-req-1:true`]);
  });

  it("returns not-found for an unknown request", async () => {
    const { service } = createService();
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: ids.request,
      expectedVersion: decodeAggregateVersion(1),
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("not-found");
  });

  it("returns stale when expectedVersion does not match the current head", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: decodeAggregateVersion(request.version + 1),
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("stale");
  });

  it("returns invalid when the resolution kind does not match the request's detail kind", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "user-input", answer: "PDF" },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("invalid");
  });

  it("settles a duplicate resolve with the same resolution idempotently", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const command = {
      kind: "resolve-work-request" as const,
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval" as const, approved: true },
    };
    const first = await service.resolve(command);
    const second = await service.resolve(command);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.request.version).toBe(first.request.version);
  });

  it("returns conflict when a duplicate resolve carries a different resolution", async () => {
    const { service } = createService();
    const request = recordOne(service);
    await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: false },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
  });

  it("rejects a resolve issued by a system actor", async () => {
    const { service } = createService({ actorOverride: systemActor });
    const request = recordOne(service);
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("fails closed when the thread's provider changed since the request was recorded", async () => {
    let currentProvider = ids.provider;
    const { service } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => currentProvider,
      },
    });
    const request = recordOne(service);
    currentProvider = ids.otherProvider;
    const result = await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });
});

describe("WorkRequestService.cancel", () => {
  function recordOne(service: WorkRequestService) {
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    if (result.status !== "ok") throw new Error("setup failed");
    return result.request;
  }

  it("cancels a pending request", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = await service.cancel({
      kind: "cancel-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.request.status).toBe("cancelled");
  });

  it("settles a duplicate cancel idempotently", async () => {
    const { service } = createService();
    const request = recordOne(service);
    const command = {
      kind: "cancel-work-request" as const,
      requestId: request.requestId,
      expectedVersion: request.version,
    };
    const first = await service.cancel(command);
    const second = await service.cancel(command);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
  });

  it("delivers cancellation to the originating provider before settling", async () => {
    const calls: Array<string> = [];
    const { service } = createService({
      providerSessions: {
        answerApproval: async () => undefined,
        answerUserInput: async () => undefined,
        cancel: async (input) => {
          calls.push(`${input.sessionId}:${input.requestId}:${input.kind}`);
        },
      },
    });
    const request = recordOne(service);
    const result = await service.cancel({
      kind: "cancel-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
    });
    expect(result.status).toBe("ok");
    expect(calls).toEqual([`${ids.session}:provider-req-1:approval`]);
  });

  it("keeps the request pending when cancellation delivery fails", async () => {
    const { service, projection } = createService({
      providerSessions: {
        answerApproval: async () => undefined,
        answerUserInput: async () => undefined,
        cancel: async () => {
          throw new Error("provider disconnected");
        },
      },
    });
    const request = recordOne(service);
    const result = await service.cancel({
      kind: "cancel-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
    });
    expect(result).toMatchObject({ status: "failure", failure: { code: "unavailable" } });
    expect(projection.lookup(request.requestId)?.request).toMatchObject({
      status: "pending",
      version: 3,
    });
  });

  it("returns conflict when cancelling an already-resolved request", async () => {
    const { service } = createService();
    const request = recordOne(service);
    await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    const result = await service.cancel({
      kind: "cancel-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
  });
});

describe("WorkRequestService interruption and expiry", () => {
  function recordOne(service: WorkRequestService) {
    const result = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    if (result.status !== "ok") throw new Error("setup failed");
    return result.request;
  }

  it("interrupts a pending request", () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = service.interrupt(request.requestId);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.request.status).toBe("interrupted");
  });

  it("settles a duplicate interrupt idempotently", () => {
    const { service } = createService();
    const request = recordOne(service);
    const first = service.interrupt(request.requestId);
    const second = service.interrupt(request.requestId);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
  });

  it("does not overwrite an already-resolved request with interrupted", async () => {
    const { service } = createService();
    const request = recordOne(service);
    await service.resolve({
      kind: "resolve-work-request",
      requestId: request.requestId,
      expectedVersion: request.version,
      resolution: { kind: "approval", approved: true },
    });
    const result = service.interrupt(request.requestId);
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
  });

  it("expires a pending request", () => {
    const { service } = createService();
    const request = recordOne(service);
    const result = service.expire(request.requestId);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.request.status).toBe("expired");
  });

  it("settles a duplicate expire idempotently", () => {
    const { service } = createService();
    const request = recordOne(service);
    const first = service.expire(request.requestId);
    const second = service.expire(request.requestId);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
  });
});

describe("WorkRequestService hydration and listing", () => {
  it("hydrates a fresh projection from the authoritative journal after restart", () => {
    const projects: WorkRequestProjectPort = {
      projectType: (id) => (id === ids.project ? "work" : "unknown"),
      isActiveWorkProject: (id) => id === ids.project,
      workCanonicalRoot: () => "/work",
      threadProjectId: () => ids.project,
      threadProviderInstanceId: () => ids.provider,
    };
    const frames = new Map<WorkRequestId, Array<WorkRequestFrame>>();
    const eventStore = {
      append(input: {
        requestId: WorkRequestId;
        expectedVersion: number;
        frame: WorkRequestFrame;
      }) {
        const existing = frames.get(input.requestId) ?? [];
        if (existing.length !== input.expectedVersion) {
          throw new Error("optimistic concurrency conflict");
        }
        frames.set(input.requestId, [...existing, input.frame]);
        return input.frame;
      },
      replayAll: () => ({ status: "ok" as const, frames: [...frames.values()].flat() }),
    };
    const firstProjection = new WorkRequestProjection();
    const firstService = new WorkRequestService({
      projects,
      projection: firstProjection,
      eventStore,
      actor,
      clock: () => clockNow,
    });
    firstService.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });

    // Simulate a server restart: a fresh projection and service instance
    // share only the authoritative event store.
    const rehydratedProjection = new WorkRequestProjection();
    const restartedService = new WorkRequestService({
      projects,
      projection: rehydratedProjection,
      eventStore,
      actor,
      clock: () => clockNow,
    });
    expect(rehydratedProjection.lookup(ids.request)).toBeUndefined();
    restartedService.hydrate();
    expect(rehydratedProjection.lookup(ids.request)?.request.status).toBe("pending");

    // Hydrating again (e.g. a duplicate reconnect hydration) is idempotent.
    restartedService.hydrate();
    expect(rehydratedProjection.lookup(ids.request)?.request.version).toBe(1);
  });

  it("lists pending requests for a Project", () => {
    const { service } = createService();
    service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(service.listPending(ids.project)).toHaveLength(1);
  });

  it("lists requests for a Project-scoped thread", () => {
    const { service } = createService();
    service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(service.listForThread(ids.project, ids.thread)).toHaveLength(1);
  });

  it("excludes and reconciles pending requests whose provider or Project became unavailable", () => {
    let active = true;
    let currentProvider = ids.provider;
    const { service, projection } = createService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => active,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => currentProvider,
      },
    });
    const recorded = service.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    expect(recorded.status).toBe("ok");

    currentProvider = ids.otherProvider;
    expect(service.listPending(ids.project)).toEqual([]);
    expect(service.listForThread(ids.project, ids.thread)).toEqual([]);
    expect(service.reconcileUnavailableRequests()).toMatchObject([
      { status: "ok", request: { status: "interrupted" } },
    ]);

    active = false;
    expect(service.listPending(ids.project)).toEqual([]);
    expect(service.interruptProject(ids.project)).toEqual([]);
    expect(projection.lookup(ids.request)?.request.status).toBe("interrupted");
  });

  it("interrupts an unconfirmed delivery intent restored after restart", async () => {
    const frames = new Map<WorkRequestId, Array<WorkRequestFrame>>();
    const eventStore = {
      append(input: {
        requestId: WorkRequestId;
        expectedVersion: number;
        frame: WorkRequestFrame;
      }) {
        const existing = frames.get(input.requestId) ?? [];
        if (existing.length !== input.expectedVersion) throw new Error("stale");
        frames.set(input.requestId, [...existing, input.frame]);
        return input.frame;
      },
      replayAll: () => ({ status: "ok" as const, frames: [...frames.values()].flat() }),
    };
    let releaseProvider: (() => void) | undefined;
    let providerDeliveryStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      providerDeliveryStarted = resolve;
    });
    const first = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
      projection: new WorkRequestProjection(),
      eventStore,
      actor,
      clock: () => clockNow,
      providerSessions: {
        answerApproval: async () => {
          providerDeliveryStarted?.();
          await new Promise<void>((resolve) => {
            releaseProvider = resolve;
          });
        },
      },
    });
    const recorded = first.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: approvalDetail,
    });
    if (recorded.status !== "ok") throw new Error("setup failed");
    const resolving = first.resolve({
      kind: "resolve-work-request",
      requestId: ids.request,
      expectedVersion: recorded.request.version,
      resolution: { kind: "approval", approved: true },
    });
    await providerStarted;
    // The live delivery owns this request until its provider callback returns;
    // a terminal event during that window must not race it to interrupted.
    expect(first.interruptSession(ids.session)).toEqual([]);

    const projection = new WorkRequestProjection();
    const restarted = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
      projection,
      eventStore,
      actor,
      clock: () => clockLater,
    });
    restarted.hydrate();

    expect(restarted.interruptSession(ids.session)).toMatchObject([
      { status: "ok", request: { status: "interrupted" } },
    ]);
    expect(projection.lookup(ids.request)?.request.delivery).toBeUndefined();
    releaseProvider?.();
    await expect(resolving).resolves.toMatchObject({ status: "failure" });
  });

  it("restores private provider option values before resolving a rehydrated request", async () => {
    const frames = new Map<WorkRequestId, Array<WorkRequestFrame>>();
    const eventStore = {
      append(input: {
        requestId: WorkRequestId;
        expectedVersion: number;
        frame: WorkRequestFrame;
      }) {
        const existing = frames.get(input.requestId) ?? [];
        if (existing.length !== input.expectedVersion) throw new Error("stale");
        frames.set(input.requestId, [...existing, input.frame]);
        return input.frame;
      },
      replayAll: () => ({ status: "ok" as const, frames: [...frames.values()].flat() }),
    };
    const first = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
      projection: new WorkRequestProjection(),
      eventStore,
      actor,
      clock: () => clockNow,
    });
    const recorded = first.record({
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.session,
      providerCallbackId: "provider-req-1",
      detail: {
        kind: "user-input",
        prompt: "Pick a source",
        options: ["Option 1: [redacted reference]"],
      },
      providerOptionValues: ["file:///private/source"],
    } as never);
    if (recorded.status !== "ok") throw new Error("setup failed");

    const answers: string[] = [];
    const restarted = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: () => true,
        workCanonicalRoot: () => "/work",
        threadProjectId: () => ids.project,
        threadProviderInstanceId: () => ids.provider,
      },
      projection: new WorkRequestProjection(),
      eventStore,
      actor,
      clock: () => clockLater,
      providerSessions: {
        answerUserInput: async (input) => {
          answers.push(input.answer);
        },
      },
    });
    restarted.hydrate();

    expect(
      await restarted.resolve({
        kind: "resolve-work-request",
        requestId: ids.request,
        expectedVersion: recorded.request.version,
        resolution: { kind: "user-input", answer: "Option 1: [redacted reference]" },
      }),
    ).toMatchObject({ status: "ok", request: { status: "resolved" } });
    expect(answers).toEqual(["file:///private/source"]);
  });
});
