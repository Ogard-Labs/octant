import { describe, expect, it } from "vitest";
import type { CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { CodeApprovalId } from "@octant/contracts";
import { collectThreadAttentionSignals } from "./collectThreadAttention";

describe("collecting thread attention", () => {
  it("reads a finished Chat turn as unread and a durable question as a follow-up", () => {
    expect(
      collectThreadAttentionSignals({
        chatThreads: [
          { threadId: "chat-a", title: "Unread thread", unread: true },
          { threadId: "chat-b", title: "Asked thread", followUp: true, unread: true },
          { threadId: "chat-c", title: "Quiet thread" },
        ],
        codeThreads: [],
      }),
    ).toEqual([
      { threadId: "chat-a", reason: "turn-finished", title: "Unread thread" },
      { threadId: "chat-b", reason: "question-asked", title: "Asked thread" },
    ]);
  });

  it("raises a live Code approval with the summary the workspace shows", () => {
    const threadId = "code-a" as CodeThreadId;
    expect(
      collectThreadAttentionSignals({
        activeCodeThreadId: "code-a",
        chatThreads: [],
        codeProviderRequests: [
          {
            kind: "approval",
            approvalId: "approval-1" as CodeApprovalId,
            summary: "Run bun run verify",
          },
          { kind: "input", requestId: "input-1", prompt: "Which branch?", options: [] },
        ],
        codeThreads: [
          {
            executionPolicy: "approval-gated",
            lifecycle: "active",
            providerInstanceId: "provider-one" as never,
            projectId: "project-1" as CodeThread["projectId"],
            threadId,
            title: "Diff pane",
          },
        ],
      }),
    ).toEqual([
      {
        threadId: "code-a",
        reason: "approval-required",
        title: "Diff pane",
        detail: "Run bun run verify",
      },
      {
        threadId: "code-a",
        reason: "question-asked",
        title: "Diff pane",
        detail: "Which branch?",
      },
    ]);
  });

  it("ignores provider requests when no Code thread is active", () => {
    expect(
      collectThreadAttentionSignals({
        chatThreads: [],
        codeProviderRequests: [
          {
            kind: "approval",
            approvalId: "approval-1" as CodeApprovalId,
            summary: "Run bun run verify",
          },
        ],
        codeThreads: [],
      }),
    ).toEqual([]);
  });
});
