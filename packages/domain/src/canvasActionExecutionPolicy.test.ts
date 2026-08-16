import { describe, expect, it } from "vitest";
import { decodeCanvasVersion, type CanvasVersion } from "@octant/contracts/canvas";
import {
  authorizeCanvasAction,
  CanvasActionPolicyRejected,
  evaluateCanvasActionApproval,
  planCanvasActionEffect,
  reportCanvasActionCapability,
  sameCanvasActionIdentity,
} from "./canvasActionExecutionPolicy";
import { classifyCanvasActionCommand } from "./canvasActionPolicy";
import { decodeCanvasActionCommand } from "@octant/contracts/canvas-actions";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  request: "44444444-4444-4444-8444-444444444444",
  source: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
  approval: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: "2026-08-01T21:00:00.000Z",
} as const;

const definition = {
  schemaVersion: 1,
  title: "Action fixture",
  provenance,
  sourceManifest: [],
  blocks: [{ blockId: "block-1", schemaVersion: 1, kind: "heading", level: 1, text: "Canvas" }],
} as const;

function version(overrides: Record<string, unknown> = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: 1,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition,
    createdBy: provenance.actor,
    createdAt: provenance.createdAt,
    ...overrides,
  });
}

const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

function actionRequest(
  command: unknown,
  approval: unknown = { kind: "not-required" },
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    kind: "canvas-action",
    requestId: ids.request,
    canvasId: ids.canvas,
    block: {
      blockId: "action-1",
      schemaVersion: 1,
      kind: "action",
      label: "Do a thing",
      command,
    },
    expectedSequence: 1,
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: ids.thread,
    actor: provenance.actor,
    providerInstanceId: ids.provider,
    modelId: "octant-test-model",
    requestedAuthority: authority,
    approval,
    ...overrides,
  };
}

const context = { mode: "chat", projectId: ids.project } as const;

function expectRejected(fn: () => unknown, denialCode: string): void {
  try {
    fn();
    throw new Error("expected CanvasActionPolicyRejected");
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasActionPolicyRejected);
    expect((error as CanvasActionPolicyRejected).denialCode).toBe(denialCode);
  }
}

describe("authorizeCanvasAction", () => {
  it("reauthorizes a well-formed read request against the Canvas provenance", () => {
    const request = authorizeCanvasAction({
      request: actionRequest({ command: "canvas.open-source", sourceId: ids.source }),
      current: version(),
      context,
    });
    expect(request.block.command.command).toBe("canvas.open-source");
    expect(reportCanvasActionCapability(request)).toEqual({
      command: "canvas.open-source",
      effect: "read",
      requiresApproval: false,
    });
  });

  it("rejects a malformed request before any authority check", () => {
    expectRejected(
      () => authorizeCanvasAction({ request: { not: "a request" }, current: version(), context }),
      "malformed-request",
    );
  });

  it("fails closed on a stale expected sequence", () => {
    expectRejected(
      () =>
        authorizeCanvasAction({
          request: actionRequest({ command: "canvas.request-refresh" }, undefined, {
            expectedSequence: 2,
          }),
          current: version(),
          context,
        }),
      "stale-version",
    );
  });

  it("rejects a mode mismatch against the Canvas and the active workspace", () => {
    expectRejected(
      () =>
        authorizeCanvasAction({
          request: actionRequest({ command: "canvas.request-refresh" }, undefined, {
            mode: "work",
          }),
          current: version(),
          context,
        }),
      "mode-mismatch",
    );
  });

  it("rejects a foreign origin thread", () => {
    expectRejected(
      () =>
        authorizeCanvasAction({
          request: actionRequest({ command: "canvas.request-refresh" }, undefined, {
            originThreadId: "00000000-0000-4000-8000-0000000000ff",
          }),
          current: version(),
          context,
        }),
      "origin-thread-mismatch",
    );
  });

  it("treats a revoked provider instance as unauthorized", () => {
    expectRejected(
      () =>
        authorizeCanvasAction({
          request: actionRequest({ command: "canvas.request-refresh" }, undefined, {
            providerInstanceId: "00000000-0000-4000-8000-0000000000aa",
          }),
          current: version(),
          context,
        }),
      "unauthorized",
    );
  });

  it("rejects a workspace that does not match the active server scope", () => {
    expectRejected(
      () =>
        authorizeCanvasAction({
          request: actionRequest({ command: "canvas.request-refresh" }),
          current: version(),
          context: {
            ...context,
            workspace: { kind: "chat-virtual", projectId: ids.project as never },
          },
        }),
      "scope-mismatch",
    );
  });
});

describe("evaluateCanvasActionApproval", () => {
  const proposeCapability = classifyCanvasActionCommand(
    decodeCanvasActionCommand({ command: "canvas.propose-thread" }),
  );
  const readCapability = classifyCanvasActionCommand(
    decodeCanvasActionCommand({ command: "canvas.open-source", sourceId: ids.source }),
  );

  it("requires approval for a thread-creating command", () => {
    expectRejected(
      () => evaluateCanvasActionApproval(proposeCapability, { kind: "not-required" }),
      "approval-required",
    );
    expectRejected(
      () => evaluateCanvasActionApproval(proposeCapability, { kind: "pending" }),
      "approval-required",
    );
  });

  it("fails closed when the user explicitly denied the action", () => {
    expectRejected(
      () => evaluateCanvasActionApproval(proposeCapability, { kind: "denied" }),
      "approval-denied",
    );
    expectRejected(
      () => evaluateCanvasActionApproval(readCapability, { kind: "denied" }),
      "approval-denied",
    );
  });

  it("proceeds for an approved mutation and a non-approval read", () => {
    expect(() =>
      evaluateCanvasActionApproval(proposeCapability, {
        kind: "approved",
        approvalId: ids.approval as never,
      }),
    ).not.toThrow();
    expect(() =>
      evaluateCanvasActionApproval(readCapability, { kind: "not-required" }),
    ).not.toThrow();
  });
});

describe("planCanvasActionEffect", () => {
  it("produces a completed navigation report for authorized reads", () => {
    const request = authorizeCanvasAction({
      request: actionRequest({ command: "canvas.open-thread", threadRef: "opaque:thread-1" }),
      current: version(),
      context,
    });
    expect(planCanvasActionEffect(request)).toEqual({
      outcome: "completed",
      report: { kind: "opened", reference: "opaque:thread-1" },
    });
  });

  it("hands off request-refresh honestly rather than faking success", () => {
    const request = authorizeCanvasAction({
      request: actionRequest({ command: "canvas.request-refresh" }),
      current: version(),
      context,
    });
    expect(planCanvasActionEffect(request)).toEqual({
      outcome: "requested",
      report: { kind: "refresh-requested", canvasId: ids.canvas },
    });
  });

  it("hands off an approved thread proposal with its approval identity", () => {
    const request = authorizeCanvasAction({
      request: actionRequest(
        { command: "canvas.propose-thread" },
        {
          kind: "approved",
          approvalId: ids.approval,
        },
      ),
      current: version(),
      context,
    });
    expect(planCanvasActionEffect(request)).toEqual({
      outcome: "requested",
      report: { kind: "thread-proposed", approvalId: ids.approval },
    });
  });
});

describe("sameCanvasActionIdentity", () => {
  it("matches only the same Canvas and action block", () => {
    expect(
      sameCanvasActionIdentity(
        { canvasId: ids.canvas, blockId: "action-1" },
        { canvasId: ids.canvas, blockId: "action-1" },
      ),
    ).toBe(true);
    expect(
      sameCanvasActionIdentity(
        { canvasId: ids.canvas, blockId: "action-1" },
        { canvasId: ids.canvas, blockId: "action-2" },
      ),
    ).toBe(false);
    expect(
      sameCanvasActionIdentity(
        { canvasId: ids.canvas, blockId: "action-1" },
        { canvasId: ids.project, blockId: "action-1" },
      ),
    ).toBe(false);
  });
});
