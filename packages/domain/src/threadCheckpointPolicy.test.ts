import { decodeChatThreadId, decodeChatTurnId } from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeCodeOperationId } from "@octant/contracts/code-operations";
import { describe, expect, it } from "vitest";
import {
  planThreadCheckpointMark,
  planThreadCheckpointRestore,
  type CheckpointCodeThreadFacts,
  type CheckpointChatThreadFacts,
} from "./threadCheckpointPolicy";

const ids = {
  checkpoint: "11111111-1111-4111-8111-111111111111",
  chatThread: decodeChatThreadId("22222222-2222-4222-8222-222222222222"),
  chatTurn: decodeChatTurnId("33333333-3333-4333-8333-333333333333"),
  codeThread: decodeCodeThreadId("44444444-4444-4444-8444-444444444444"),
  operation: decodeCodeOperationId("55555555-5555-4555-8555-555555555555"),
  project: "66666666-6666-4666-8666-666666666666",
};

const revision = "a".repeat(40);

const chatFacts: CheckpointChatThreadFacts = {
  mode: "chat",
  threadId: ids.chatThread,
  lifecycle: "active",
  carriesAnchor: true,
  projectId: ids.project,
  projectAvailable: true,
};

const codeFacts: CheckpointCodeThreadFacts = {
  mode: "code",
  threadId: ids.codeThread,
  lifecycle: "active",
  carriesAnchor: true,
  revision,
  projectId: ids.project,
  projectAvailable: true,
};

const chatCheckpoint = {
  id: ids.checkpoint,
  anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
  lifecycle: "marked",
} as const;

const codeCheckpoint = {
  id: ids.checkpoint,
  anchor: {
    mode: "code",
    threadId: ids.codeThread,
    operationId: ids.operation,
    revision,
  },
  lifecycle: "marked",
} as const;

describe("marking a checkpoint", () => {
  it("records the revision the marked Code turn ran on", () => {
    const decision = planThreadCheckpointMark({
      anchor: { mode: "code", threadId: ids.codeThread, operationId: ids.operation },
      thread: codeFacts,
    });
    expect(decision).toEqual({
      status: "marks",
      anchor: {
        mode: "code",
        threadId: ids.codeThread,
        operationId: ids.operation,
        revision,
      },
      projectId: ids.project,
    });
  });

  it("refuses a Code turn whose revision the host never caught", () => {
    const { revision: _absent, ...withoutRevision } = codeFacts;
    const decision = planThreadCheckpointMark({
      anchor: { mode: "code", threadId: ids.codeThread, operationId: ids.operation },
      thread: withoutRevision,
    });
    expect(decision).toEqual({ status: "refuses", reason: "revision-unavailable" });
  });

  it("refuses a turn that is no longer part of the conversation", () => {
    const decision = planThreadCheckpointMark({
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
      thread: { ...chatFacts, carriesAnchor: false },
    });
    expect(decision).toEqual({ status: "refuses", reason: "anchor-unavailable" });
  });

  it("refuses a thread the host no longer holds", () => {
    const decision = planThreadCheckpointMark({
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
      thread: undefined,
    });
    expect(decision).toEqual({ status: "refuses", reason: "thread-unavailable" });
  });

  it("refuses a checkpoint on a thread that is being deleted", () => {
    const decision = planThreadCheckpointMark({
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
      thread: { ...chatFacts, lifecycle: "deleting" },
    });
    expect(decision).toEqual({ status: "refuses", reason: "thread-unavailable" });
  });

  it("refuses an anchor pointing at a thread in the other mode", () => {
    const decision = planThreadCheckpointMark({
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
      thread: codeFacts,
    });
    expect(decision).toEqual({ status: "refuses", reason: "thread-unavailable" });
  });

  it("marks an unfiled Chat thread without inventing a Project", () => {
    const { projectId: _unfiled, ...unfiled } = chatFacts;
    const decision = planThreadCheckpointMark({
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
      thread: unfiled,
    });
    expect(decision).toEqual({
      status: "marks",
      anchor: { mode: "chat", threadId: ids.chatThread, turnId: ids.chatTurn },
    });
  });
});

describe("restoring from a checkpoint", () => {
  it("branches the conversation through the marked Chat turn", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: chatCheckpoint,
      thread: chatFacts,
    });
    expect(decision).toEqual({
      status: "branches-chat",
      threadId: ids.chatThread,
      turnId: ids.chatTurn,
    });
  });

  it("starts a Code thread on its own worktree at the marked revision", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: codeCheckpoint,
      thread: codeFacts,
    });
    expect(decision).toEqual({
      status: "creates-code-thread",
      sourceThreadId: ids.codeThread,
      operationId: ids.operation,
      revision,
      projectId: ids.project,
    });
  });

  it("refuses a checkpoint the user has forgotten", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: { ...chatCheckpoint, lifecycle: "forgotten" },
      thread: chatFacts,
    });
    expect(decision).toEqual({ status: "refuses", reason: "checkpoint-forgotten" });
  });

  it("refuses when a later revision of the conversation dropped the marked turn", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: chatCheckpoint,
      thread: { ...chatFacts, carriesAnchor: false },
    });
    expect(decision).toEqual({ status: "refuses", reason: "anchor-unavailable" });
  });

  it("refuses when the Project the thread is filed under is unavailable", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: codeCheckpoint,
      thread: { ...codeFacts, projectAvailable: false },
    });
    expect(decision).toEqual({ status: "refuses", reason: "project-unavailable" });
  });

  it("refuses when the source thread is gone", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: codeCheckpoint,
      thread: undefined,
    });
    expect(decision).toEqual({ status: "refuses", reason: "thread-unavailable" });
  });

  it("refuses an archived thread, which the user unarchives before taking it up again", () => {
    const decision = planThreadCheckpointRestore({
      checkpoint: chatCheckpoint,
      thread: { ...chatFacts, lifecycle: "archived" },
    });
    expect(decision).toEqual({ status: "refuses", reason: "thread-unavailable" });
  });
});
