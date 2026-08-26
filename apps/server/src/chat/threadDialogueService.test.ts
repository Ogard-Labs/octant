import { describe, expect, it, vi } from "vitest";
import {
  decodeChatThreadId,
  decodeMentionableThreadId,
  type ChatThreadView,
  type WindowId,
} from "@octant/contracts";
import { ThreadDialogueService } from "./threadDialogueService";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const sourceThreadId = decodeChatThreadId("20000000-0000-4000-8000-000000000001");
const targetChatThreadId = decodeChatThreadId("30000000-0000-4000-8000-000000000001");
const targetThreadId = decodeMentionableThreadId(String(targetChatThreadId));
const targetTurnId = "40000000-0000-4000-8000-000000000001";

describe("ThreadDialogueService", () => {
  it("sends to an explicitly mentioned Chat and returns its completed reply", async () => {
    const executeChat = vi.fn(async () => ({ kind: "turn-created", turn: { id: targetTurnId } }));
    const service = new ThreadDialogueService({
      resolveChatTargets: async () => [{ threadId: targetThreadId, title: "Target Chat" }],
      readChatThread: () => targetView(),
      executeChat,
    });
    const tools = service.forThread({
      windowId,
      sourceThreadId,
      sourceTitle: "Source Chat",
      targetThreadIds: [targetThreadId],
    });

    const result = await tools?.execute({
      name: "octant_thread_message",
      inputJson: JSON.stringify({ targetThreadId, message: "Check the parser and report back." }),
    });

    expect(result?.result).toMatchObject({
      status: "completed",
      targetThreadId,
      targetTitle: "Target Chat",
      response: "The parser is using the old token.",
    });
    expect(executeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        threadId: targetThreadId,
        prompt: 'Message from Chat thread "Source Chat":\n\nCheck the parser and report back.',
      }),
      { windowId, coordinationDepth: 1 },
    );
  });

  it("refuses a target that was not explicitly mentioned", async () => {
    const executeChat = vi.fn(async () => ({ kind: "turn-created", turn: { id: targetTurnId } }));
    const service = new ThreadDialogueService({
      resolveChatTargets: async () => [],
      readChatThread: () => targetView(),
      executeChat,
    });
    const tools = service.forThread({
      windowId,
      sourceThreadId,
      sourceTitle: "Source Chat",
      targetThreadIds: [targetThreadId],
    });

    const result = await tools?.execute({
      name: "octant_thread_message",
      inputJson: JSON.stringify({ targetThreadId, message: "Do this." }),
    });

    expect(result?.isError).toBe(true);
    expect(result?.result).toMatchObject({ status: "refused" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("does not expose coordination tools to a target turn", () => {
    const service = new ThreadDialogueService({
      resolveChatTargets: async () => [],
      readChatThread: () => targetView(),
      executeChat: vi.fn(),
    });

    expect(
      service.forThread({
        windowId,
        sourceThreadId,
        sourceTitle: "Target Chat",
        targetThreadIds: [targetThreadId],
        coordinationDepth: 1,
      }),
    ).toBeUndefined();
  });

  it("returns waiting instead of interrupting an active target Chat", async () => {
    const executeChat = vi.fn(async () => {
      const error = Object.assign(new Error("A Chat response is already running."), {
        failure: { category: "waiting" },
      });
      throw error;
    });
    const service = new ThreadDialogueService({
      resolveChatTargets: async () => [{ threadId: targetThreadId, title: "Target Chat" }],
      readChatThread: () => targetView(),
      executeChat,
    });
    const tools = service.forThread({
      windowId,
      sourceThreadId,
      sourceTitle: "Source Chat",
      targetThreadIds: [targetThreadId],
    });

    const result = await tools?.execute({
      name: "octant_thread_message",
      inputJson: JSON.stringify({ targetThreadId, message: "Do this later." }),
    });

    expect(result?.result).toMatchObject({
      status: "waiting",
      targetThreadId,
      targetTitle: "Target Chat",
    });
    expect(result?.isError).toBe(true);
  });
});

function targetView(): ChatThreadView {
  return {
    thread: {
      id: targetChatThreadId,
      title: "Target Chat",
      lifecycle: "active",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "target-model",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be useful.",
      version: 3,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
    },
    lastSequence: 4,
    turns: [
      {
        id: targetTurnId,
        threadId: targetChatThreadId,
        sequence: 1,
        userMessageRef: {
          contentId: "60000000-0000-4000-8000-000000000001",
          digest: "a".repeat(64),
          byteLength: 10,
        },
        attachmentIds: [],
        attempts: [
          {
            id: "70000000-0000-4000-8000-000000000001",
            turnId: targetTurnId,
            threadId: targetChatThreadId,
            providerInstanceId: "50000000-0000-4000-8000-000000000001",
            providerSessionId: "80000000-0000-4000-8000-000000000001",
            modelId: "target-model",
            contextManifestId: "90000000-0000-4000-8000-000000000001",
            outcome: "completed",
            responseRefs: [
              {
                contentId: "60000000-0000-4000-8000-000000000002",
                digest: "b".repeat(64),
                byteLength: 40,
              },
            ],
            citationIds: [],
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
          },
        ],
        createdAt: "2026-08-24T10:00:00.000Z",
      },
    ],
    contents: [
      {
        contentId: "60000000-0000-4000-8000-000000000001",
        role: "user",
        body: "Check the parser and report back.",
        digest: "a".repeat(64),
        byteLength: 35,
      },
      {
        contentId: "60000000-0000-4000-8000-000000000002",
        role: "assistant",
        body: "The parser is using the old token.",
        digest: "b".repeat(64),
        byteLength: 35,
      },
    ],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  } as unknown as ChatThreadView;
}
