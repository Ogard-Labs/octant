import { decodeThreadCheckpoint, type ThreadCheckpoint } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadCheckpointError,
  ThreadCheckpointService,
  type ThreadCheckpointChatPort,
  type ThreadCheckpointCodePort,
} from "./threadCheckpointService";

const ids = {
  checkpoint: "11111111-1111-4111-8111-111111111111",
  chatThread: "22222222-2222-4222-8222-222222222222",
  chatTurn: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  operation: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  branch: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  window: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  fresh: "99999999-9999-4999-8999-999999999999",
};

const revision = "a".repeat(40);
const windowId = ids.window as never;
const now = "2026-08-18T09:00:00.000Z";

function harness(
  options: {
    readonly checkpoints?: ReadonlyArray<ThreadCheckpoint>;
    readonly chatCarriesTurn?: boolean;
    readonly codeRevision?: string | undefined;
    readonly codeProjectAvailable?: boolean;
    readonly withCode?: boolean;
    readonly canAccess?: boolean;
  } = {},
) {
  const stored = new Map<string, ThreadCheckpoint>(
    (options.checkpoints ?? []).map((checkpoint) => [String(checkpoint.id), checkpoint]),
  );
  const journal = { append: vi.fn() };
  const chat: ThreadCheckpointChatPort = {
    facts: vi.fn(() => ({
      mode: "chat" as const,
      threadId: ids.chatThread,
      lifecycle: "active" as const,
      carriesAnchor: options.chatCarriesTurn ?? true,
      projectId: ids.project,
      projectAvailable: true,
    })),
    branch: vi.fn(async () => ({ status: "created" as const, threadId: ids.branch as never })),
  };
  const code: ThreadCheckpointCodePort = {
    facts: vi.fn(() => ({
      mode: "code" as const,
      threadId: ids.codeThread,
      lifecycle: "active" as const,
      carriesAnchor: true,
      ...(options.codeRevision === undefined ? {} : { revision: options.codeRevision }),
      projectId: ids.project,
      projectAvailable: options.codeProjectAvailable ?? true,
    })),
    restore: vi.fn(async () => ({ status: "created" as const, threadId: ids.fresh as never })),
  };
  const service = new ThreadCheckpointService({
    journal,
    readCheckpoint: (checkpointId) => stored.get(String(checkpointId)),
    readCheckpoints: (threadId) =>
      [...stored.values()].filter(
        (checkpoint) => String(checkpoint.anchor.threadId) === String(threadId),
      ),
    canAccess: async () => options.canAccess ?? true,
    chat,
    ...(options.withCode === false ? {} : { code }),
    uuid: () => ids.checkpoint,
    clock: () => now,
    actor: { kind: "local-user", actorId: ids.actor as never },
  });
  return { service, journal, chat, code, stored };
}

const markChat = {
  kind: "mark-thread-checkpoint",
  anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
  label: "Before the rewrite",
} as const;

const markCode = {
  kind: "mark-thread-checkpoint",
  anchor: { mode: "code", threadId: ids.codeThread, operationId: ids.operation },
  label: "Green tests",
} as const;

const storedChatCheckpoint = decodeThreadCheckpoint({
  id: ids.checkpoint,
  anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
  label: "Before the rewrite",
  projectId: ids.project,
  lifecycle: "marked",
  restoreCount: 0,
  markedAt: now,
  version: 1,
  updatedAt: now,
});

const storedCodeCheckpoint = decodeThreadCheckpoint({
  ...storedChatCheckpoint,
  anchor: { mode: "code", threadId: ids.codeThread, operationId: ids.operation, revision },
});

describe("marking a point in a thread", () => {
  it("journals the marked point against its own aggregate", async () => {
    const { service, journal } = harness();

    const result = await service.execute(windowId, markChat);

    expect(result).toMatchObject({ kind: "checkpoint-marked" });
    const append = journal.append.mock.calls[0]?.[0] as {
      aggregate: { aggregateType: string; aggregateId: string };
      expectedVersion: number;
      events: ReadonlyArray<{ eventName: string }>;
    };
    expect(append.aggregate).toEqual({
      aggregateType: "thread-checkpoint",
      aggregateId: ids.checkpoint,
    });
    expect(append.expectedVersion).toBe(0);
    expect(append.events.map((event) => event.eventName)).toEqual(["checkpoint.marked@1"]);
  });

  it("records the revision a Code restore would start from", async () => {
    const { service } = harness({ codeRevision: revision });

    const result = await service.execute(windowId, markCode);

    expect(result).toMatchObject({
      kind: "checkpoint-marked",
      checkpoint: { anchor: { mode: "code", revision } },
    });
  });

  it("refuses, and journals nothing, when the Code turn recorded no revision", async () => {
    const { service, journal } = harness({ codeRevision: undefined });

    const result = await service.execute(windowId, markCode);

    expect(result).toEqual({ kind: "checkpoint-refused", reason: "revision-unavailable" });
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("refuses a Code point on a host assembled without Code", async () => {
    const { service } = harness({ withCode: false });

    expect(await service.execute(windowId, markCode)).toEqual({
      kind: "checkpoint-refused",
      reason: "thread-unavailable",
    });
  });

  it("refuses a turn a later revision of the conversation dropped", async () => {
    const { service } = harness({ chatCarriesTurn: false });

    expect(await service.execute(windowId, markChat)).toEqual({
      kind: "checkpoint-refused",
      reason: "anchor-unavailable",
    });
  });

  it("refuses a window that may not see the Project the thread is filed under", async () => {
    const { service, journal } = harness({ canAccess: false });

    await expect(service.execute(windowId, markChat)).rejects.toBeInstanceOf(ThreadCheckpointError);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("refuses a checkpoint ID another checkpoint already holds", async () => {
    const { service } = harness({ checkpoints: [storedChatCheckpoint] });

    await expect(service.execute(windowId, markChat)).rejects.toBeInstanceOf(ThreadCheckpointError);
  });
});

describe("taking a thread up again from a point", () => {
  it("branches the Chat conversation and never touches the thread it came from", async () => {
    const { service, journal, chat } = harness({ checkpoints: [storedChatCheckpoint] });

    const result = await service.execute(windowId, {
      kind: "restore-from-thread-checkpoint",
      checkpointId: ids.checkpoint,
      expectedVersion: 1,
      title: "Second direction",
    });

    expect(chat.branch).toHaveBeenCalledWith({
      authenticatedWindowId: windowId,
      threadId: ids.chatThread,
      turnId: ids.chatTurn,
      title: "Second direction",
    });
    expect(result).toMatchObject({
      kind: "checkpoint-restored",
      restore: { mode: "chat", threadId: ids.branch },
      checkpoint: { restoreCount: 1, lastRestoredAt: now, version: 2 },
    });
    // Every journal write this produced belongs to the marker. The source
    // thread's own history is appended to by Chat, never rewritten here.
    const aggregates = journal.append.mock.calls.map(
      (call) => (call[0] as { aggregate: { aggregateType: string } }).aggregate.aggregateType,
    );
    expect(aggregates).toEqual(["thread-checkpoint"]);
  });

  it("starts the Code thread at the recorded revision", async () => {
    const { service, code } = harness({
      checkpoints: [storedCodeCheckpoint],
      codeRevision: revision,
    });

    const result = await service.execute(windowId, {
      kind: "restore-from-thread-checkpoint",
      checkpointId: ids.checkpoint,
      expectedVersion: 1,
      title: "From the green build",
    });

    expect(code.restore).toHaveBeenCalledWith({
      authenticatedWindowId: windowId,
      sourceThreadId: ids.codeThread,
      operationId: ids.operation,
      revision,
      title: "From the green build",
    });
    expect(result).toMatchObject({ restore: { mode: "code", threadId: ids.fresh } });
  });

  it("reports the mode's own refusal rather than inventing a thread", async () => {
    const { service, code, journal } = harness({
      checkpoints: [storedCodeCheckpoint],
      codeRevision: revision,
    });
    (code.restore as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "refused",
      reason: "restore-refused",
    });

    const result = await service.execute(windowId, {
      kind: "restore-from-thread-checkpoint",
      checkpointId: ids.checkpoint,
      expectedVersion: 1,
      title: "From the green build",
    });

    expect(result).toEqual({ kind: "checkpoint-refused", reason: "restore-refused" });
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("refuses when the Project the Code thread is filed under is unavailable", async () => {
    const { service } = harness({
      checkpoints: [storedCodeCheckpoint],
      codeRevision: revision,
      codeProjectAvailable: false,
    });

    expect(
      await service.execute(windowId, {
        kind: "restore-from-thread-checkpoint",
        checkpointId: ids.checkpoint,
        expectedVersion: 1,
        title: "From the green build",
      }),
    ).toEqual({ kind: "checkpoint-refused", reason: "project-unavailable" });
  });

  it("refuses a point the user has put away", async () => {
    const forgotten = decodeThreadCheckpoint({
      ...storedChatCheckpoint,
      lifecycle: "forgotten",
      version: 2,
    });
    const { service } = harness({ checkpoints: [forgotten] });

    expect(
      await service.execute(windowId, {
        kind: "restore-from-thread-checkpoint",
        checkpointId: ids.checkpoint,
        expectedVersion: 2,
        title: "Second direction",
      }),
    ).toEqual({ kind: "checkpoint-refused", reason: "checkpoint-forgotten" });
  });

  it("refuses a restore computed against a stale view of the checkpoint", async () => {
    const { service } = harness({ checkpoints: [storedChatCheckpoint] });

    await expect(
      service.execute(windowId, {
        kind: "restore-from-thread-checkpoint",
        checkpointId: ids.checkpoint,
        expectedVersion: 7,
        title: "Second direction",
      }),
    ).rejects.toMatchObject({ category: "conflict" });
  });
});

describe("putting a point away", () => {
  it("keeps the marker readable as forgotten instead of deleting it", async () => {
    const { service, journal } = harness({ checkpoints: [storedChatCheckpoint] });

    const result = await service.execute(windowId, {
      kind: "forget-thread-checkpoint",
      checkpointId: ids.checkpoint,
      expectedVersion: 1,
    });

    expect(result).toMatchObject({
      kind: "checkpoint-forgotten",
      checkpoint: { lifecycle: "forgotten", version: 2 },
    });
    expect(
      (journal.append.mock.calls[0]?.[0] as { events: ReadonlyArray<{ eventName: string }> })
        .events[0]?.eventName,
    ).toBe("checkpoint.forgotten@1");
  });
});

describe("listing the points a thread carries", () => {
  it("answers with the thread's own checkpoints", async () => {
    const otherThreadCheckpoint = decodeThreadCheckpoint({
      ...storedCodeCheckpoint,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const { service } = harness({ checkpoints: [storedChatCheckpoint, otherThreadCheckpoint] });

    const listed = await service.list(windowId, ids.chatThread);
    expect(listed.map((checkpoint) => checkpoint.anchor.mode)).toEqual(["chat"]);
  });

  it("shows none of them to a window that may not see the Project", async () => {
    const { service } = harness({ checkpoints: [storedChatCheckpoint], canAccess: false });

    expect(await service.list(windowId, ids.chatThread)).toEqual([]);
  });
});
