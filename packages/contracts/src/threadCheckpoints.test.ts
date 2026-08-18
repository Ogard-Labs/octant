import { describe, expect, it } from "vitest";
import {
  MAX_THREAD_CHECKPOINT_LABEL_LENGTH,
  THREAD_CHECKPOINT_EVENT_NAMES,
  decodeThreadCheckpoint,
  decodeThreadCheckpointCommand,
  decodeThreadCheckpointCommandResult,
} from "./threadCheckpoints";

const ids = {
  checkpoint: "11111111-1111-4111-8111-111111111111",
  chatThread: "22222222-2222-4222-8222-222222222222",
  chatTurn: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  operation: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
};

const revision = "a".repeat(40);

const chatCheckpoint = {
  id: ids.checkpoint,
  anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
  label: "Before the rewrite",
  projectId: ids.project,
  lifecycle: "marked",
  restoreCount: 0,
  markedAt: "2026-08-18T09:00:00.000Z",
  version: 1,
  updatedAt: "2026-08-18T09:00:00.000Z",
};

const codeCheckpoint = {
  ...chatCheckpoint,
  anchor: {
    mode: "code",
    threadId: ids.codeThread,
    operationId: ids.operation,
    revision,
  },
};

describe("thread checkpoints", () => {
  it("carries the revision a Code restore would start from", () => {
    const checkpoint = decodeThreadCheckpoint(codeCheckpoint);
    expect(checkpoint.anchor.mode === "code" && checkpoint.anchor.revision).toBe(revision);
  });

  it("refuses a Code checkpoint that names no revision", () => {
    const { revision: _omitted, ...anchor } = codeCheckpoint.anchor;
    expect(() => decodeThreadCheckpoint({ ...codeCheckpoint, anchor })).toThrow();
  });

  it("refuses a Chat checkpoint that carries a revision", () => {
    expect(() =>
      decodeThreadCheckpoint({
        ...chatCheckpoint,
        anchor: { ...chatCheckpoint.anchor, revision },
      }),
    ).toThrow();
  });

  it("refuses a checkpoint that claims restores without a time it last happened", () => {
    expect(() => decodeThreadCheckpoint({ ...chatCheckpoint, restoreCount: 2 })).toThrow();
  });

  it("refuses a checkpoint that reports a restore time but no restore", () => {
    expect(() =>
      decodeThreadCheckpoint({ ...chatCheckpoint, lastRestoredAt: "2026-08-18T10:00:00.000Z" }),
    ).toThrow();
  });

  it("accepts a checkpoint that has been taken up again", () => {
    const checkpoint = decodeThreadCheckpoint({
      ...chatCheckpoint,
      restoreCount: 2,
      lastRestoredAt: "2026-08-18T10:00:00.000Z",
    });
    expect(checkpoint.restoreCount).toBe(2);
  });

  it("refuses a label longer than a name", () => {
    expect(() =>
      decodeThreadCheckpoint({
        ...chatCheckpoint,
        label: "n".repeat(MAX_THREAD_CHECKPOINT_LABEL_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("takes a mark request that names identity only", () => {
    const command = decodeThreadCheckpointCommand({
      kind: "mark-thread-checkpoint",
      anchor: { mode: "code", threadId: ids.codeThread, operationId: ids.operation },
      label: "Green tests",
    });
    expect(command.kind).toBe("mark-thread-checkpoint");
  });

  it("refuses a mark request that supplies its own revision", () => {
    expect(() =>
      decodeThreadCheckpointCommand({
        kind: "mark-thread-checkpoint",
        anchor: {
          mode: "code",
          threadId: ids.codeThread,
          operationId: ids.operation,
          revision,
        },
        label: "Green tests",
      }),
    ).toThrow();
  });

  it("reports a refusal as a result rather than an absence", () => {
    const result = decodeThreadCheckpointCommandResult({
      kind: "checkpoint-refused",
      reason: "revision-unavailable",
    });
    expect(result.kind).toBe("checkpoint-refused");
  });

  it("names the thread a restore produced", () => {
    const result = decodeThreadCheckpointCommandResult({
      kind: "checkpoint-restored",
      checkpoint: {
        ...codeCheckpoint,
        restoreCount: 1,
        lastRestoredAt: "2026-08-18T10:00:00.000Z",
        version: 2,
        updatedAt: "2026-08-18T10:00:00.000Z",
      },
      restore: { mode: "code", threadId: ids.chatThread },
    });
    expect(result.kind === "checkpoint-restored" && result.restore.threadId).toBe(ids.chatThread);
  });

  it("names every checkpoint event it journals", () => {
    expect([...THREAD_CHECKPOINT_EVENT_NAMES]).toEqual([
      "checkpoint.marked@1",
      "checkpoint.forgotten@1",
      "checkpoint.restored@1",
    ]);
  });
});
