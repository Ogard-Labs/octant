import { describe, expect, it } from "vitest";
import {
  decodeWorkRequestFrame,
  decodeWorkRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  type WorkRequestFrame,
} from "@octant/contracts";
import { WorkRequestProjection } from "./workRequestProjection";

const ids = {
  request: decodeWorkRequestId("11111111-1111-4111-8111-111111111111"),
  otherRequest: decodeWorkRequestId("99999999-9999-4999-8999-999999999999"),
  project: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  otherProject: decodeProjectId("66666666-6666-4666-8666-666666666666"),
  thread: decodeWorkThreadId("33333333-3333-4333-8333-333333333333"),
  otherThread: decodeWorkThreadId("77777777-7777-4777-8777-777777777777"),
  provider: "44444444-4444-4444-8444-444444444444",
} as const;

const requestedAt = "2026-08-10T08:00:00.000Z";
const settledAt = "2026-08-10T08:05:00.000Z";

function requestedFrame(
  overrides: Partial<{
    requestId: string;
    projectId: string;
    threadId: string;
    version: number;
  }> = {},
): WorkRequestFrame {
  return decodeWorkRequestFrame({
    kind: "requested",
    request: {
      requestId: overrides.requestId ?? ids.request,
      projectId: overrides.projectId ?? ids.project,
      threadId: overrides.threadId ?? ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.provider,
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "run-terminal-command",
        description: "Run `bun install`.",
      },
      status: "pending",
      requestedAt,
      version: overrides.version ?? 1,
    },
  });
}

function resolvedFrame(version = 2): WorkRequestFrame {
  return decodeWorkRequestFrame({
    kind: "resolved",
    request: {
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.provider,
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "run-terminal-command",
        description: "Run `bun install`.",
      },
      status: "resolved",
      resolution: { kind: "approval", approved: true },
      requestedAt,
      settledAt,
      version,
    },
  });
}

describe("WorkRequestProjection", () => {
  it("applies a requested frame and makes the request lookupable", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    const entry = projection.lookup(ids.request);
    expect(entry?.request.status).toBe("pending");
  });

  it("applies a resolved frame over a requested frame", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(resolvedFrame());
    const entry = projection.lookup(ids.request);
    expect(entry?.request.status).toBe("resolved");
  });

  it("ignores a stale frame whose version is not newer than the current head", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(resolvedFrame());
    projection.apply(requestedFrame());
    const entry = projection.lookup(ids.request);
    expect(entry?.request.status).toBe("resolved");
  });

  it("lists pending requests scoped to a Project", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(
      requestedFrame({ requestId: ids.otherRequest, projectId: ids.otherProject, version: 1 }),
    );
    const pending = projection.listPending(ids.project);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe(ids.request);
  });

  it("lists requests scoped to a Project and thread", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(
      requestedFrame({ requestId: ids.otherRequest, threadId: ids.otherThread, version: 1 }),
    );
    const forThread = projection.listForThread(ids.project, ids.thread);
    expect(forThread).toHaveLength(1);
    expect(forThread[0]?.requestId).toBe(ids.request);
  });

  it("excludes resolved requests from listPending", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(resolvedFrame());
    expect(projection.listPending(ids.project)).toHaveLength(0);
  });

  it("snapshot returns every tracked entry", () => {
    const projection = new WorkRequestProjection();
    projection.apply(requestedFrame());
    projection.apply(
      requestedFrame({ requestId: ids.otherRequest, projectId: ids.otherProject, version: 1 }),
    );
    expect(projection.snapshot().size).toBe(2);
  });
});
