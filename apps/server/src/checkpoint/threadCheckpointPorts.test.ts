import type { CodeThread, EventEnvelope, Project } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCheckpointChatPort, createCheckpointCodePort } from "./threadCheckpointPorts";

const ids = {
  chatThread: "22222222-2222-4222-8222-222222222222",
  chatTurn: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  operation: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  branch: "77777777-7777-4777-8777-777777777777",
  fresh: "99999999-9999-4999-8999-999999999999",
  window: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const revision = "a".repeat(40);
const now = "2026-08-18T09:00:00.000Z";
const activeProject = { id: ids.project, lifecycle: "active" } as unknown as Project;

const codeThread = {
  id: ids.codeThread,
  projectId: ids.project,
  bindingRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  title: "Original work",
  lifecycle: "active",
  providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  modelId: "model-a",
  executionPolicy: "full-access",
  permissionPersistence: "project-default",
  deliveryTarget: {
    branchIntent: "octant/original",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
    proposedOutcome: { outcomeKind: "merged-pr", proposedAt: now },
  },
  version: 3,
  createdAt: now,
  updatedAt: now,
} as unknown as CodeThread;

function turnStartedEnvelope(options: { readonly head?: string } = {}): EventEnvelope {
  return {
    payload: {
      threadId: ids.codeThread,
      operationId: ids.operation,
      cursor: 1,
      occurredAt: now,
      event: {
        kind: "conversation-turn-started",
        providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        modelId: "model-a",
        sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        prompt: { contentId: ids.branch, digest: "b".repeat(64), byteLength: 12 },
        ...(options.head === undefined
          ? {}
          : {
              checkpoint: {
                worktree: "c".repeat(40),
                index: "d".repeat(40),
                head: options.head,
              },
            }),
      },
    },
  } as unknown as EventEnvelope;
}

describe("Chat's side of a checkpoint", () => {
  it("branches at the marked turn against the thread version the host holds", async () => {
    const execute = vi.fn(async () => ({
      kind: "thread-created",
      thread: { id: ids.branch },
    }));
    const port = createCheckpointChatPort({
      readChatThread: () => ({ id: ids.chatThread, version: 9 }) as never,
      readChatThreadView: () => undefined,
      readProject: () => activeProject,
      execute,
    });

    const outcome = await port.branch({
      authenticatedWindowId: ids.window as never,
      threadId: ids.chatThread as never,
      turnId: ids.chatTurn as never,
      title: "Second direction",
    });

    expect(execute).toHaveBeenCalledWith({
      kind: "branch-chat-thread",
      threadId: ids.chatThread,
      expectedVersion: 9,
      turnId: ids.chatTurn,
      title: "Second direction",
    });
    expect(outcome).toEqual({ status: "created", threadId: ids.branch });
  });

  it("reports a refusal from Chat rather than a thread that was never created", async () => {
    const port = createCheckpointChatPort({
      readChatThread: () => ({ id: ids.chatThread, version: 9 }) as never,
      readChatThreadView: () => undefined,
      readProject: () => activeProject,
      execute: async () => {
        throw new Error("refused");
      },
    });

    expect(
      await port.branch({
        authenticatedWindowId: ids.window as never,
        threadId: ids.chatThread as never,
        turnId: ids.chatTurn as never,
        title: "Second direction",
      }),
    ).toEqual({ status: "refused", reason: "restore-refused" });
  });
});

describe("Code's side of a checkpoint", () => {
  function port(options: { readonly envelope?: EventEnvelope; readonly execute?: unknown } = {}) {
    const execute =
      (options.execute as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => ({ kind: "managed-thread-created" }));
    return {
      execute,
      port: createCheckpointCodePort({
        readCodeThread: () => codeThread,
        readProject: () => activeProject,
        readOperationStart: () => options.envelope,
        execute: execute as never,
        uuid: () => ids.fresh,
        clock: () => now,
      }),
    };
  }

  it("reads the revision the checkout was on before the marked turn ran", () => {
    const { port: subject } = port({ envelope: turnStartedEnvelope({ head: revision }) });

    expect(subject.facts(ids.codeThread as never, ids.operation as never)).toMatchObject({
      carriesAnchor: true,
      revision,
    });
  });

  it("reports no revision for a turn the host never caught a checkout for", () => {
    const { port: subject } = port({ envelope: turnStartedEnvelope() });

    expect(subject.facts(ids.codeThread as never, ids.operation as never)).toMatchObject({
      carriesAnchor: true,
    });
    expect(
      subject.facts(ids.codeThread as never, ids.operation as never)?.mode === "code" &&
        subject.facts(ids.codeThread as never, ids.operation as never)?.revision,
    ).toBeUndefined();
  });

  it("starts the restored thread approval-gated, on its own branch, at the revision", async () => {
    const { port: subject, execute } = port({
      envelope: turnStartedEnvelope({ head: revision }),
    });

    const outcome = await subject.restore({
      authenticatedWindowId: ids.window as never,
      sourceThreadId: ids.codeThread as never,
      operationId: ids.operation as never,
      revision,
      title: "From the green build",
    });

    expect(outcome).toEqual({ status: "created", threadId: ids.fresh });
    const command = execute.mock.calls[0]?.[1] as {
      executionPolicy: string;
      permissionPersistence: string;
      sourceRevision: string;
      startFromOrigin: boolean;
      deliveryTarget: Record<string, unknown>;
      forkedFrom: Record<string, unknown>;
    };
    // A new thread carries no approval receipt of its own, so it never inherits
    // the source thread's Full access.
    expect(command.executionPolicy).toBe("approval-gated");
    expect(command.permissionPersistence).toBe("current-session");
    expect(command.sourceRevision).toBe(revision);
    expect(command.startFromOrigin).toBe(false);
    // A fresh delivery branch: returning to a point must not compete for the
    // branch the original thread is still delivering on.
    expect(command.deliveryTarget.branchIntent).not.toBe("octant/original");
    expect(command.deliveryTarget.outcomeKind).toBe("opened-pr");
    // The proposal raised on the source thread stays there.
    expect(command.deliveryTarget.proposedOutcome).toBeUndefined();
    expect(command.forkedFrom).toEqual({
      threadId: ids.codeThread,
      throughOperationId: ids.operation,
    });
  });
});
