import { describe, expect, it } from "vitest";
import {
  CANVAS_ACTION_MAX_FILTERS,
  CANVAS_ACTION_MAX_SELECTION_REFS,
  CANVAS_COMMAND_IDS,
  decodeCanvasActionBlock,
  decodeCanvasActionCancelRequest,
  decodeCanvasActionCommand,
  decodeCanvasActionReceipt,
  decodeCanvasActionRequest,
  decodeCanvasActionResult,
  decodeCanvasCommandId,
} from "./canvasActions";

const ids = {
  source: "11111111-1111-4111-8111-111111111111",
  otherSource: "22222222-2222-4222-8222-222222222222",
} as const;

const actionBlock = (command: unknown) =>
  ({
    blockId: "open-source",
    schemaVersion: 1,
    kind: "action",
    label: "Open source",
    command,
  }) as const;

describe("Canvas action command allowlist", () => {
  it("exposes exactly the registered Octant command identifiers", () => {
    expect(CANVAS_COMMAND_IDS).toEqual([
      "canvas.open-source",
      "canvas.filter-data",
      "canvas.attach-selection",
      "canvas.open-thread",
      "canvas.open-pull-request",
      "canvas.request-refresh",
      "canvas.propose-thread",
    ]);
    for (const commandId of CANVAS_COMMAND_IDS) {
      expect(decodeCanvasCommandId(commandId)).toBe(commandId);
    }
  });

  it("fails closed on an unknown command identifier", () => {
    expect(() => decodeCanvasCommandId("canvas.delete-everything")).toThrow();
    expect(() => decodeCanvasCommandId("shell.exec")).toThrow();
    expect(() => decodeCanvasCommandId("canvas.open-source ")).toThrow();
  });
});

describe("Canvas action command contracts", () => {
  it("round-trips each allowlisted command reference", () => {
    const commands = [
      { command: "canvas.open-source", sourceId: ids.source },
      {
        command: "canvas.filter-data",
        target: "table-1",
        filters: [{ column: "status", operator: "eq", value: "open" }],
      },
      {
        command: "canvas.attach-selection",
        selection: [
          { kind: "canvas" },
          { kind: "block", blockId: "table-1" },
          { kind: "source", sourceId: ids.source },
        ],
      },
      { command: "canvas.open-thread", threadRef: "opaque:thread-abc" },
      { command: "canvas.open-pull-request", pullRequestRef: "ref:pr-42" },
      { command: "canvas.request-refresh" },
      { command: "canvas.propose-thread", prompt: "Draft a follow-up plan." },
      { command: "canvas.propose-thread" },
    ] as const;
    for (const command of commands) {
      expect(decodeCanvasActionCommand(command)).toEqual(command);
    }
  });

  it("rejects unknown commands and excess fields (fail closed)", () => {
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.run-script", script: "rm -rf /" }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.open-source", sourceId: ids.source, extra: 1 }),
    ).toThrow();
    // A command with an executable-looking payload has no schema slot for it.
    expect(() =>
      decodeCanvasActionCommand({
        command: "canvas.request-refresh",
        handler: "() => fetch('http://evil')",
      }),
    ).toThrow();
  });

  it("rejects non-opaque, path, and credential-bearing references", () => {
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.open-thread", threadRef: "file:///etc/passwd" }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.open-thread", threadRef: "../secret" }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({
        command: "canvas.open-pull-request",
        pullRequestRef: "https://user:pass@host/pr",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.open-thread", threadRef: "plain-token" }),
    ).toThrow();
  });

  it("bounds filter and selection collections", () => {
    expect(() =>
      decodeCanvasActionCommand({
        command: "canvas.filter-data",
        target: "table-1",
        filters: Array.from({ length: CANVAS_ACTION_MAX_FILTERS + 1 }, () => ({
          column: "status",
          operator: "eq",
          value: "open",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.filter-data", target: "table-1", filters: [] }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({
        command: "canvas.attach-selection",
        selection: Array.from({ length: CANVAS_ACTION_MAX_SELECTION_REFS + 1 }, () => ({
          kind: "canvas",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasActionCommand({ command: "canvas.attach-selection", selection: [] }),
    ).toThrow();
  });
});

describe("Canvas action block contract", () => {
  it("round-trips a declarative action block", () => {
    const block = actionBlock({ command: "canvas.open-source", sourceId: ids.source });
    expect(decodeCanvasActionBlock(block)).toEqual(block);
  });

  it("accepts an optional bounded description but no executable fields", () => {
    const block = {
      ...actionBlock({ command: "canvas.request-refresh" }),
      description: "Reauthorize and refresh the bound sources.",
    };
    expect(decodeCanvasActionBlock(block)).toEqual(block);
    expect(() => decodeCanvasActionBlock({ ...block, onClick: "alert(1)" })).toThrow();
    expect(() =>
      decodeCanvasActionBlock({
        ...actionBlock({ command: "canvas.request-refresh" }),
        kind: "html",
      }),
    ).toThrow();
  });

  it("rejects a future block schema version", () => {
    expect(() =>
      decodeCanvasActionBlock({
        ...actionBlock({ command: "canvas.request-refresh" }),
        schemaVersion: 2,
      }),
    ).toThrow();
  });
});

const executionIds = {
  request: "44444444-4444-4444-8444-444444444444",
  canvas: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
  approval: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

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

const actionRequest = (
  command: unknown,
  approval: unknown = { kind: "not-required" },
  overrides: Record<string, unknown> = {},
) =>
  ({
    schemaVersion: 1,
    kind: "canvas-action",
    requestId: executionIds.request,
    canvasId: executionIds.canvas,
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
    originThreadId: executionIds.thread,
    actor: { kind: "local-user", actorId: executionIds.actor },
    providerInstanceId: executionIds.provider,
    modelId: "octant-test-model",
    requestedAuthority: authority,
    approval,
    ...overrides,
  }) as const;

describe("Canvas action execution request contract", () => {
  it("round-trips an authorized read request with an admitted block", () => {
    const request = actionRequest({ command: "canvas.open-thread", threadRef: "opaque:thread-1" });
    expect(decodeCanvasActionRequest(request)).toEqual(request);
  });

  it("carries every approval decision the host can forward", () => {
    for (const approval of [
      { kind: "not-required" },
      { kind: "pending" },
      { kind: "approved", approvalId: executionIds.approval },
      { kind: "denied" },
    ]) {
      const request = actionRequest({ command: "canvas.propose-thread" }, approval);
      expect(decodeCanvasActionRequest(request).approval).toEqual(approval);
    }
  });

  it("fails closed on excess fields and forged approval identity", () => {
    expect(() =>
      decodeCanvasActionRequest(
        actionRequest(
          { command: "canvas.request-refresh" },
          { kind: "not-required" },
          {
            onClick: "alert(1)",
          },
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeCanvasActionRequest(
        actionRequest({ command: "canvas.propose-thread" }, { kind: "approved" }),
      ),
    ).toThrow();
    expect(() =>
      decodeCanvasActionRequest(
        actionRequest(
          { command: "canvas.propose-thread" },
          {
            kind: "approved",
            approvalId: "not-a-uuid",
          },
        ),
      ),
    ).toThrow();
  });

  it("rejects a stale-shaped non-positive expected sequence", () => {
    expect(() =>
      decodeCanvasActionRequest(
        actionRequest(
          { command: "canvas.request-refresh" },
          { kind: "not-required" },
          {
            expectedSequence: 0,
          },
        ),
      ),
    ).toThrow();
  });
});

describe("Canvas action cancellation contract", () => {
  it("round-trips a cancellation correlated by request, canvas, and block", () => {
    const cancel = {
      schemaVersion: 1,
      kind: "canvas-action-cancel",
      requestId: executionIds.request,
      canvasId: executionIds.canvas,
      blockId: "action-1",
    } as const;
    expect(decodeCanvasActionCancelRequest(cancel)).toEqual(cancel);
  });

  it("rejects excess cancellation fields", () => {
    expect(() =>
      decodeCanvasActionCancelRequest({
        schemaVersion: 1,
        kind: "canvas-action-cancel",
        requestId: executionIds.request,
        canvasId: executionIds.canvas,
        blockId: "action-1",
        recipeId: executionIds.canvas,
      }),
    ).toThrow();
  });
});

describe("Canvas action receipt and result contracts", () => {
  const receipt = (overrides: Record<string, unknown> = {}) =>
    ({
      schemaVersion: 1,
      kind: "canvas-action-receipt",
      requestId: executionIds.request,
      canvasId: executionIds.canvas,
      blockId: "action-1",
      capability: { command: "canvas.open-thread", effect: "read", requiresApproval: false },
      outcome: "completed",
      report: { kind: "opened", reference: "opaque:thread-1" },
      completedAt: "2026-08-01T21:00:00.000Z",
      ...overrides,
    }) as const;

  it("round-trips an auditable read receipt with a typed report", () => {
    expect(decodeCanvasActionReceipt(receipt())).toEqual(receipt());
  });

  it("records an honest hand-off report for request-refresh", () => {
    const handoff = receipt({
      capability: { command: "canvas.request-refresh", effect: "mutate", requiresApproval: false },
      outcome: "requested",
      report: { kind: "refresh-requested", canvasId: executionIds.canvas },
    });
    expect(decodeCanvasActionReceipt(handoff).outcome).toBe("requested");
  });

  it("wraps accepted and denied execution results", () => {
    expect(decodeCanvasActionResult({ kind: "accepted", receipt: receipt() }).kind).toBe(
      "accepted",
    );
    const denied = decodeCanvasActionResult({
      kind: "denied",
      denialCode: "approval-required",
      message: "This action creates a new thread and needs approval.",
    });
    expect(denied).toMatchObject({ kind: "denied", denialCode: "approval-required" });
    expect(() =>
      decodeCanvasActionResult({
        kind: "denied",
        denialCode: "not-a-real-code",
        message: "nope",
      }),
    ).toThrow();
  });
});
