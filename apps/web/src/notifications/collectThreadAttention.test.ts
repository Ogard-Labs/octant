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
      { threadId: "chat-a", reason: "turn-finished", title: "Unread thread", source: "chat" },
      { threadId: "chat-b", reason: "question-asked", title: "Asked thread", source: "chat" },
    ]);
  });

  it("raises a live Code approval with the summary the workspace shows", () => {
    const threadId = "code-a" as CodeThreadId;
    expect(
      collectThreadAttentionSignals({
        chatThreads: [],
        codeProviderRequestsByThreadId: {
          "code-a": [
            {
              kind: "approval",
              approvalId: "approval-1" as CodeApprovalId,
              summary: "Run bun run verify",
            },
            { kind: "input", requestId: "input-1", prompt: "Which branch?", options: [] },
          ],
        },
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
        source: "code",
        projectId: "project-1",
      },
      {
        threadId: "code-a",
        reason: "question-asked",
        title: "Diff pane",
        detail: "Which branch?",
        source: "code",
        projectId: "project-1",
      },
    ]);
  });

  it("raises provider requests from a background Code thread that is not active", () => {
    const activeThreadId = "code-active" as CodeThreadId;
    const backgroundThreadId = "code-background" as CodeThreadId;
    expect(
      collectThreadAttentionSignals({
        chatThreads: [],
        codeProviderRequestsByThreadId: {
          "code-background": [
            {
              kind: "approval",
              approvalId: "approval-bg" as CodeApprovalId,
              summary: "Delete node_modules",
            },
          ],
        },
        codeThreads: [
          {
            executionPolicy: "approval-gated",
            lifecycle: "active",
            providerInstanceId: "provider-one" as never,
            projectId: "project-1" as CodeThread["projectId"],
            threadId: activeThreadId,
            title: "Active thread",
          },
          {
            executionPolicy: "approval-gated",
            lifecycle: "active",
            providerInstanceId: "provider-one" as never,
            projectId: "project-2" as CodeThread["projectId"],
            threadId: backgroundThreadId,
            title: "Background thread",
          },
        ],
      }),
    ).toEqual([
      {
        threadId: "code-background",
        reason: "approval-required",
        title: "Background thread",
        detail: "Delete node_modules",
        source: "code",
        projectId: "project-2",
      },
    ]);
  });

  it("ignores empty provider-request entries", () => {
    expect(
      collectThreadAttentionSignals({
        chatThreads: [],
        codeProviderRequestsByThreadId: {
          "code-a": [],
        },
        codeThreads: [],
      }),
    ).toEqual([]);
  });
});
