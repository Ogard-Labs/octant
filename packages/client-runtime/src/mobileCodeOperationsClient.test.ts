import { describe, expect, it, vi } from "vitest";
import { MAX_CODE_EVIDENCE_BATCH_ITEMS } from "@octant/contracts";
import {
  loadMobileCodeConversation,
  observeMobilePullRequest,
  sendMobileCodeTurn,
} from "./mobileCodeOperationsClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "84000000-0000-4000-8000-000000000001";
const checkoutId = "85000000-0000-4000-8000-000000000001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mobileCodeOperationsClient", () => {
  it("observes a pull request over authenticated remote transport", async () => {
    const fetch = vi.fn(async ({ body }: { body?: string }) => {
      const command = JSON.parse(body ?? "{}") as { operationId: string; kind: string };
      expect(command.kind).toBe("observe-pull-request");
      return jsonResponse({
        kind: "pull-request-review",
        operationId: command.operationId,
        state: "none",
        freshness: "fresh",
      });
    });

    const transport = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(
      observeMobilePullRequest({ transport, threadId, checkoutId }),
    ).resolves.toMatchObject({ kind: "pull-request-review", state: "none" });
  });
});

describe("mobile Code follow-through", () => {
  const now = "2026-08-05T20:00:00.000Z";
  const operationId = "86000000-0000-4000-8000-000000000001";
  const providerInstanceId = "10000000-0000-4000-8000-000000000001";
  const promptContentId = "87000000-0000-4000-8000-000000000001";
  const replyContentId = "87000000-0000-4000-8000-000000000002";
  const reference = (contentId: string, byteLength: number) => ({
    contentId,
    digest: "a".repeat(64),
    byteLength,
  });
  const thread = {
    id: threadId,
    projectId: "20000000-0000-4000-8000-000000000001",
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"c".repeat(64)}`,
    checkoutId,
    title: "Fix the flaky test",
    lifecycle: "active",
    providerInstanceId,
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "octant/mobile-fix",
      remoteName: "origin",
      proposedBaseRepository: "acme/app",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  function transport(requests: Array<{ method: string; path: string; body?: string }>) {
    const fetch = vi.fn(
      async (input: { method: string; path: string; query?: string; body?: string }) => {
        requests.push(input);
        const { method, path, body } = input;
        if (method === "GET" && path === "/api/code/bootstrap") {
          return jsonResponse({
            settings: {
              defaultExecutionPolicy: "approval-gated",
              defaultPermissionPersistence: "current-session",
              version: 1,
              updatedAt: now,
            },
            threads: [thread],
            checkouts: [],
            activity: [],
          });
        }
        if (method === "GET" && path === `/api/code/threads/${threadId}/conversation`) {
          return jsonResponse({
            version: 3,
            threadId,
            turns: [
              {
                operationId,
                providerInstanceId,
                modelId: "model-a",
                sessionId: "89000000-0000-4000-8000-000000000001",
                prompt: reference(promptContentId, 12),
                assistant: [reference(replyContentId, 20)],
                status: "completed",
                startedAt: now,
                updatedAt: now,
              },
            ],
            nextCursor: 1,
            hasMore: false,
          });
        }
        if (method === "POST" && path === "/api/code/evidence/batch") {
          return jsonResponse({
            threadId,
            items: [
              { operationId, contentId: promptContentId, text: "Fix the test" },
              { operationId, contentId: replyContentId, text: "Done: the test now passes." },
            ],
          });
        }
        if (method === "PUT" && path === "/api/code/evidence") {
          return jsonResponse(
            reference("87000000-0000-4000-8000-000000000003", (body ?? "").length),
          );
        }
        if (method === "POST" && path === "/api/code/commands") {
          const command = JSON.parse(body ?? "{}") as { kind: string; operationId: string };
          expect(command.kind).toBe("start-provider-turn");
          return jsonResponse({
            kind: "provider-turn-state",
            operationId: command.operationId,
            state: "running",
          });
        }
        return jsonResponse({ category: "unavailable" }, 404);
      },
    );
    return {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
  }

  it("reads a Code thread's conversation with the text behind each prompt and reply", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const conversation = await loadMobileCodeConversation(transport(requests), threadId);
    expect(conversation).toEqual([
      {
        operationId,
        status: "completed",
        prompt: "Fix the test",
        assistant: ["Done: the test now passes."],
        updatedAt: now,
      },
    ]);
  });

  it("refuses a Code conversation whose threadId does not match the request", async () => {
    const otherThreadId = "84000000-0000-4000-8000-000000000099";
    const fetch = vi.fn(async ({ path }: { path: string }) => {
      if (path === `/api/code/threads/${threadId}/conversation`) {
        return jsonResponse({
          version: 3,
          threadId: otherThreadId,
          turns: [],
          nextCursor: 0,
          hasMore: false,
        });
      }
      return jsonResponse({ category: "unavailable" }, 404);
    });
    const port = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    await expect(loadMobileCodeConversation(port, threadId)).rejects.toMatchObject({
      category: "unavailable",
      message: "Code conversation identity mismatch.",
    });
  });

  it("refuses a Code evidence batch whose threadId does not match the request", async () => {
    const otherThreadId = "84000000-0000-4000-8000-000000000099";
    const fetch = vi.fn(async ({ method, path }: { method: string; path: string }) => {
      if (method === "GET" && path === `/api/code/threads/${threadId}/conversation`) {
        return jsonResponse({
          version: 3,
          threadId,
          turns: [
            {
              operationId,
              providerInstanceId,
              modelId: "model-a",
              sessionId: "89000000-0000-4000-8000-000000000001",
              prompt: reference(promptContentId, 12),
              assistant: [],
              status: "completed",
              startedAt: now,
              updatedAt: now,
            },
          ],
          nextCursor: 1,
          hasMore: false,
        });
      }
      if (method === "POST" && path === "/api/code/evidence/batch") {
        return jsonResponse({ threadId: otherThreadId, items: [] });
      }
      return jsonResponse({ category: "unavailable" }, 404);
    });
    const port = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    await expect(loadMobileCodeConversation(port, threadId)).rejects.toMatchObject({
      category: "unavailable",
      message: "Code evidence identity mismatch.",
    });
  });

  it("keeps the earliest evidence references when a conversation exceeds one batch", async () => {
    const assistant = Array.from({ length: MAX_CODE_EVIDENCE_BATCH_ITEMS }, (_, index) => {
      const contentId = `87000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      return { contentId, text: `part-${index}` };
    });
    const requested: Array<{ operationId: string; contentId: string }> = [];
    const fetch = vi.fn(
      async ({ method, path, body }: { method: string; path: string; body?: string }) => {
        if (method === "GET" && path === `/api/code/threads/${threadId}/conversation`) {
          return jsonResponse({
            version: 3,
            threadId,
            turns: [
              {
                operationId,
                providerInstanceId,
                modelId: "model-a",
                sessionId: "89000000-0000-4000-8000-000000000001",
                prompt: reference(promptContentId, 12),
                assistant: assistant.map((part) => reference(part.contentId, part.text.length)),
                status: "completed",
                startedAt: now,
                updatedAt: now,
              },
            ],
            nextCursor: 1,
            hasMore: false,
          });
        }
        if (method === "POST" && path === "/api/code/evidence/batch") {
          const payload = JSON.parse(body ?? "{}") as {
            items: Array<{ operationId: string; contentId: string }>;
          };
          requested.push(...payload.items);
          const texts = new Map<string, string>([
            [promptContentId, "Fix the test"],
            ...assistant.map((part) => [part.contentId, part.text] as const),
          ]);
          return jsonResponse({
            threadId,
            items: payload.items.map((item) => ({
              ...item,
              text: texts.get(item.contentId) ?? "",
            })),
          });
        }
        return jsonResponse({ category: "unavailable" }, 404);
      },
    );
    const port = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const conversation = await loadMobileCodeConversation(port, threadId);
    expect(requested).toHaveLength(MAX_CODE_EVIDENCE_BATCH_ITEMS);
    expect(requested[0]).toEqual({ operationId, contentId: promptContentId });
    expect(requested.at(-1)?.contentId).toBe(
      assistant[MAX_CODE_EVIDENCE_BATCH_ITEMS - 2]?.contentId,
    );
    expect(conversation).toEqual([
      {
        operationId,
        status: "completed",
        prompt: "Fix the test",
        assistant: assistant.slice(0, MAX_CODE_EVIDENCE_BATCH_ITEMS - 1).map((part) => part.text),
        updatedAt: now,
      },
    ]);
  });

  it("stages a follow-up prompt as evidence and starts a provider turn on the thread's checkout", async () => {
    const requests: Array<{ method: string; path: string; body?: string }> = [];
    const port = transport(requests);
    const started = await sendMobileCodeTurn({
      transport: port,
      threadId,
      prompt: "  Also lint  ",
    });
    expect(started.state).toBe("running");
    const evidence = requests.find((request) => request.path === "/api/code/evidence");
    expect(evidence?.method).toBe("PUT");
    expect(evidence?.body).toBe("Also lint");
    const command = requests.find((request) => request.path === "/api/code/commands");
    expect(JSON.parse(command?.body ?? "{}")).toMatchObject({
      kind: "start-provider-turn",
      threadId,
      checkoutId,
    });
    await expect(
      sendMobileCodeTurn({ transport: port, threadId, prompt: " " }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });
});
