import { describe, expect, it } from "vitest";
import type {
  AgentRunParentContextSelection,
  AgentRunParentContextUnavailableReason,
} from "./agentRunParentContext";
import {
  branchHandoffRecord,
  conversationHandoffRefusalMessage,
  providerSwitchHandoffRecord,
  selectionBelongsToThread,
  type ConversationHandoffRefusal,
} from "./conversationHandoff";

const omissions = {
  earlierMessages: 3,
  unfinishedReplies: 1,
  missingBodies: 2,
  oversizedBodies: 0,
  emptyBodies: 0,
  attachments: 1,
  truncatedMessages: 0,
  truncatedCharacters: 0,
  sourceTruncatedMessages: 0,
};
const selection = (
  source: Partial<
    Omit<Extract<AgentRunParentContextSelection, { status: "available" }>["source"], "projectId">
  > & { readonly projectId?: string | null } = {},
): Extract<AgentRunParentContextSelection, { status: "available" }> => {
  const { projectId, ...rest } = source;
  return {
    status: "available",
    blocks: [
      { kind: "conversation-summary", text: "summary" },
      { kind: "user-message", text: "question" },
      { kind: "assistant-message", text: "answer" },
    ],
    omissions,
    source: {
      mode: "chat",
      threadId: "thread-1",
      // `null` is a Chat outside any Project, whose source carries none.
      ...(projectId === null ? {} : { projectId: projectId ?? "project-1" }),
      threadVersion: 2,
      externalContentIngested: true,
      point: {},
      ...rest,
    },
  };
};

describe("conversation handoff records", () => {
  it("counts the messages carried, not the summary, and states nothing native moved", () => {
    expect(
      providerSwitchHandoffRecord(selection(), {
        providerInstanceId: "00000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
      }),
    ).toEqual({
      reason: "provider-switch",
      previousProviderInstanceId: "00000000-0000-4000-8000-000000000001",
      previousModelId: "model-a",
      messages: 2,
      omissions,
      externalContentIngested: true,
      nativeSessionTransferred: false,
      hiddenReasoningTransferred: false,
    });
    expect(branchHandoffRecord(selection())).toEqual({
      reason: "branch",
      messages: 2,
      omissions,
      externalContentIngested: true,
      nativeSessionTransferred: false,
      hiddenReasoningTransferred: false,
    });
  });
});

describe("selectionBelongsToThread", () => {
  const thread = { mode: "chat", id: "thread-1", projectId: "project-1" } as const;

  it("accepts the thread's own conversation in its own Project", () => {
    expect(selectionBelongsToThread(selection(), thread)).toBe("ok");
  });

  it("refuses another thread's conversation, whatever else matches", () => {
    expect(selectionBelongsToThread(selection({ threadId: "thread-2" }), thread)).toBe(
      "foreign-thread",
    );
    expect(selectionBelongsToThread(selection({ mode: "work" }), thread)).toBe("foreign-thread");
  });

  it("refuses a conversation read from another Project, including a Chat with none", () => {
    expect(selectionBelongsToThread(selection({ projectId: "project-2" }), thread)).toBe(
      "foreign-project",
    );
    expect(
      selectionBelongsToThread(selection({ projectId: null }), {
        ...thread,
        projectId: undefined,
      }),
    ).toBe("ok");
    expect(
      selectionBelongsToThread(selection({ projectId: "project-1" }), {
        ...thread,
        projectId: undefined,
      }),
    ).toBe("foreign-project");
  });
});

describe("conversationHandoffRefusalMessage", () => {
  const reasons: ReadonlyArray<ConversationHandoffRefusal> = [
    "unsupported",
    "nothing-to-hand-over",
    "thread-unavailable",
    "foreign-thread",
    "foreign-project",
    "source-point-unavailable",
    "source-unavailable",
    "source-changed",
    "source-empty",
    "invalid-page",
    "history-window-exceeded",
  ];

  it("names a distinct cause for every reason, for a switch and for a branch", () => {
    // Keeps the list above whole: a reason the selector can return must be here.
    const unavailable: ReadonlyArray<AgentRunParentContextUnavailableReason> = [
      "thread-unavailable",
      "foreign-thread",
      "foreign-project",
      "source-point-unavailable",
      "source-unavailable",
      "source-changed",
      "source-empty",
      "invalid-page",
      "history-window-exceeded",
    ];
    for (const reason of unavailable) expect(reasons).toContain(reason);
    for (const cause of ["switch", "branch"] as const) {
      const messages = reasons
        .filter((reason) => reason !== "invalid-page")
        .map((reason) => conversationHandoffRefusalMessage(reason, { thread: "Chat", cause }));
      expect(new Set(messages).size).toBe(messages.length);
    }
  });

  it("tells the person how to recover from a refused switch and from a refused branch", () => {
    expect(
      conversationHandoffRefusalMessage("source-empty", { thread: "Chat", cause: "switch" }),
    ).toContain("Switch back to the previous provider or start a new Chat.");
    expect(
      conversationHandoffRefusalMessage("source-empty", { thread: "Chat", cause: "branch" }),
    ).toContain("Send the message from the original conversation instead.");
  });

  it("speaks of the Work task for Work", () => {
    expect(
      conversationHandoffRefusalMessage("source-empty", { thread: "Work task", cause: "switch" }),
    ).toContain("This Work task has no readable messages");
  });
});
