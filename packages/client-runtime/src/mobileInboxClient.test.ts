import { describe, expect, it, vi } from "vitest";
import {
  decodeChatBootstrap,
  decodeChatThread,
  decodeChatThreadView,
  decodeCodeBootstrap,
  decodeCodeBoardView,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
} from "@octant/contracts";
import {
  listMobileInbox,
  loadMobileChatThread,
  normalizeMobileInbox,
  changeMobileChatProvider,
  createMobileChatThread,
  createMobileChatWithFirstTurn,
  interruptMobileChatTurn,
  retryMobileChatTurn,
  sendMobileChatTurn,
  subscribeMobileChatEvents,
  uploadMobileChatAttachment,
  completeMobileChatWorkItem,
  cancelMobileChatWorkItem,
  completeMobileChatFollowUp,
  type MobileRemoteTransport,
} from "./mobileInboxClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-05T10:00:00.000Z";
const later = "2026-08-05T12:00:00.000Z";
const mid = "2026-08-05T11:00:00.000Z";

const chatThread = decodeChatThread({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Chat alpha",
  lifecycle: "active",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be calm.",
  version: 3,
  createdAt: now,
  updatedAt: now,
});

const workThread = decodeWorkThread({
  id: "00000000-0000-4000-8000-000000000101",
  projectId: "20000000-0000-4000-8000-000000000001",
  title: "Work brief",
  lifecycle: "active",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  version: 1,
  createdAt: now,
  updatedAt: later,
});

const codeThread = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  bindingRevisionId: "30000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "40000000-0000-4000-8000-000000000001",
  title: "Code slice",
  lifecycle: "active",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/mobile-a3",
    remoteName: "origin",
    proposedBaseRepository: "octocat/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: mid,
} as const;

const codeSettings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 1,
  updatedAt: now,
} as const;

const codeCheckout = {
  id: codeThread.checkoutId,
  repositoryId: codeThread.repositoryId,
  kind: "existing-worktree",
  availability: "available",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  observedAt: now,
} as const;

const codeBoard = decodeCodeBoardView({
  version: 1,
  query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
  cards: [
    {
      threadId: codeThread.id,
      projectId: codeThread.projectId,
      checkoutId: codeThread.checkoutId,
      checkoutKind: "existing-worktree",
      title: codeThread.title,
      status: "in-progress",
      statusReason: "executing",
      outcomeKind: codeThread.deliveryTarget.outcomeKind,
      deliverySatisfaction: "pending",
      providerInstanceId: codeThread.providerInstanceId,
      modelId: codeThread.modelId,
      executing: false,
      worktree: {
        kind: "available",
        checkoutId: codeThread.checkoutId,
        path: "/mock/octant",
        head: codeCheckout.head,
      },
      changedFiles: {
        kind: "observed",
        freshness: "fresh",
        changedPathCount: 1,
        stagedCount: 1,
        committedAhead: 0,
        workingTreeClean: false,
        insertions: 42,
        deletions: 12,
      },
      linkedPullRequest: { kind: "none", freshness: "fresh" },
      pullRequestSummaries: { items: [], hiddenCount: 0 },
      checks: { freshness: "fresh", state: "passing" },
      reviewState: { freshness: "fresh", state: "approved" },
      childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
      recovery: { kind: "ok" },
      githubFreshness: "fresh",
      followUp: false,
      lastMeaningfulActivityAt: now,
    },
  ],
  generatedAt: now,
});

const chatSettings = {
  defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
  defaultModelId: "model-a",
  defaultResearchEnabled: false,
  defaultResearchRouting: "automatic",
  defaultPersonalityInstructions: "Be calm.",
  version: 1,
  updatedAt: now,
} as const;

describe("mobileInboxClient", () => {
  it("normalizes host-qualified rows and sorts by freshness desc", () => {
    const rows = normalizeMobileInbox({
      hostId,
      chatThreads: [chatThread],
      workThreads: [workThread],
      codeThreads: [
        decodeCodeBootstrap({
          settings: codeSettings,
          threads: [codeThread],
          checkouts: [codeCheckout],
          activity: [],
        }).threads[0]!,
      ],
    });
    expect(rows.map((row) => ({ mode: row.mode, threadId: row.threadId }))).toEqual([
      { mode: "work", threadId: workThread.id },
      { mode: "code", threadId: codeThread.id },
      { mode: "chat", threadId: chatThread.id },
    ]);
    expect(rows[0]).toMatchObject({
      hostId,
      title: "Work brief",
      status: "active",
      freshness: later,
    });
  });

  it("attaches authoritative Code Board review state to inbox rows", () => {
    const decodedCodeThread = decodeCodeBootstrap({
      settings: codeSettings,
      threads: [codeThread],
      checkouts: [codeCheckout],
      activity: [],
    }).threads[0]!;
    const rows = normalizeMobileInbox({
      hostId,
      chatThreads: [],
      workThreads: [],
      codeThreads: [decodedCodeThread],
      codeReviewStates: new Map([[decodedCodeThread.id, "approved"]]),
    });
    expect(rows).toEqual([
      expect.objectContaining({
        mode: "code",
        threadId: decodedCodeThread.id,
        reviewState: "approved",
      }),
    ]);
  });

  it("lists inbox through authenticated transport fan-out", async () => {
    const fetch = vi.fn(async ({ path }: { path: string }) => {
      if (path === "/api/chat/bootstrap") {
        return Response.json(
          decodeChatBootstrap({ settings: chatSettings, threads: [chatThread] }),
        );
      }
      if (path === "/api/work/threads/bootstrap") {
        return Response.json(decodeWorkThreadBootstrap({ threads: [workThread] }));
      }
      if (path === "/api/code/bootstrap") {
        return Response.json(
          decodeCodeBootstrap({
            settings: codeSettings,
            threads: [codeThread],
            checkouts: [codeCheckout],
            activity: [],
          }),
        );
      }
      if (path === "/api/code/board") return Response.json(codeBoard);
      return new Response("missing", { status: 404 });
    });

    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    const rows = await listMobileInbox(transport);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.mode).toBe("work");
    expect(rows.find((row) => row.mode === "code")).toMatchObject({ reviewState: "approved" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("surfaces an unavailable authoritative Code Board instead of discarding it", async () => {
    const fetch = vi.fn(async ({ path }: { path: string }) => {
      if (path === "/api/chat/bootstrap") {
        return Response.json(decodeChatBootstrap({ settings: chatSettings, threads: [] }));
      }
      if (path === "/api/work/threads/bootstrap") {
        return Response.json(decodeWorkThreadBootstrap({ threads: [] }));
      }
      if (path === "/api/code/bootstrap") {
        return Response.json(
          decodeCodeBootstrap({
            settings: codeSettings,
            threads: [codeThread],
            checkouts: [codeCheckout],
            activity: [],
          }),
        );
      }
      if (path === "/api/code/board") return new Response("board unavailable", { status: 503 });
      return new Response("missing", { status: 404 });
    });

    await expect(
      listMobileInbox({
        hostId,
        authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      message: "Code Board state could not be loaded from the host.",
    });
  });

  it("loads a chat thread view and sends a follow-up", async () => {
    const view = decodeChatThreadView({
      thread: chatThread,
      turns: [],
      lastSequence: 0,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 1,
      followUpVersion: 1,
    });
    const fetch = vi.fn(async ({ method, path }: { method: string; path: string }) => {
      if (method === "GET" && path.includes("/api/chat/threads/")) {
        return Response.json(view);
      }
      if (method === "POST" && path === "/api/chat/commands") {
        return Response.json({ kind: "turn-created", turn: { id: "x" } });
      }
      return new Response("missing", { status: 404 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(loadMobileChatThread(transport, chatThread.id)).resolves.toMatchObject({
      thread: { id: chatThread.id },
    });
    await sendMobileChatTurn({
      transport,
      threadId: chatThread.id,
      expectedVersion: chatThread.version,
      prompt: "Ship the mobile inbox",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/chat/commands",
        body: expect.stringContaining("send-chat-turn"),
      }),
    );
  });

  it("interrupts and retries chat turns through host commands", async () => {
    const fetch = vi.fn(async ({ method, path }: { method: string; path: string }) => {
      if (method === "POST" && path === "/api/chat/commands") {
        return Response.json({ kind: "attempt-updated", attempt: { id: "x" } });
      }
      return new Response("missing", { status: 404 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const turnId = "00000000-0000-4000-8000-000000000011";
    const attemptId = "00000000-0000-4000-8000-000000000012";
    await interruptMobileChatTurn({
      transport,
      threadId: chatThread.id,
      expectedVersion: chatThread.version,
      turnId,
      attemptId,
    });
    await retryMobileChatTurn({
      transport,
      threadId: chatThread.id,
      expectedVersion: chatThread.version,
      turnId,
      attemptId,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ body: expect.stringContaining("interrupt-chat-turn") }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: expect.stringContaining("retry-chat-turn") }),
    );
  });

  it("uploads chat attachments with binary contentType", async () => {
    const attachment = {
      id: "00000000-0000-4000-8000-000000000021",
      threadId: chatThread.id,
      displayName: "shot.png",
      mediaType: "image/png",
      byteLength: 4,
      digest: "a".repeat(64),
      status: "finalized",
      createdAt: now,
    };
    const fetch = vi.fn(async () => Response.json(attachment));
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(
      uploadMobileChatAttachment({
        transport,
        threadId: chatThread.id,
        attachmentId: attachment.id,
        displayName: "shot.png",
        mediaType: "image/png",
        bytes,
      }),
    ).resolves.toMatchObject({ displayName: "shot.png" });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/chat/attachments",
        body: bytes,
        contentType: "image/png",
      }),
    );
  });

  it("subscribes to chat NDJSON events through authenticated transport", async () => {
    const threadId = chatThread.id;
    const frame = {
      threadId,
      sequence: 1,
      event: {
        kind: "attempt-updated",
        attempt: {
          id: "00000000-0000-4000-8000-000000000031",
          turnId: "00000000-0000-4000-8000-000000000032",
          threadId,
          providerInstanceId: chatThread.providerInstanceId,
          providerSessionId: "00000000-0000-4000-8000-000000000033",
          modelId: "model-a",
          contextManifestId: "00000000-0000-4000-8000-000000000034",
          outcome: "streaming",
          responseRefs: [],
          citationIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        controller.close();
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const controller = new AbortController();
    const frames = [];
    for await (const next of subscribeMobileChatEvents({
      transport,
      threadId,
      afterSequence: 0,
      signal: controller.signal,
    })) {
      frames.push(next);
    }
    expect(frames).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: `/api/chat/threads/${threadId}/events`,
        query: "?afterSequence=0",
        signal: controller.signal,
      }),
    );
  });

  it("completes and cancels chat work items on the host", async () => {
    const fetch = vi.fn(async () => Response.json({ kind: "work-updated", workItem: {} }));
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    await completeMobileChatWorkItem({
      transport,
      threadId: chatThread.id,
      expectedVersion: 2,
      itemId: "00000000-0000-4000-8000-000000000041",
    });
    await cancelMobileChatWorkItem({
      transport,
      threadId: chatThread.id,
      expectedVersion: 3,
      itemId: "00000000-0000-4000-8000-000000000041",
    });
    await completeMobileChatFollowUp({
      transport,
      threadId: chatThread.id,
      expectedVersion: 1,
      acknowledgedThroughSequence: 4,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ body: expect.stringContaining("complete-chat-work-item") }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: expect.stringContaining("cancel-chat-work-item") }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ body: expect.stringContaining("complete-chat-follow-up") }),
    );
  });

  it("rejects empty chat follow-ups before transport", async () => {
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: vi.fn(),
    };
    await expect(
      sendMobileChatTurn({
        transport,
        threadId: chatThread.id,
        expectedVersion: 1,
        prompt: "   ",
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(transport.authenticatedFetch).not.toHaveBeenCalled();
  });

  it("creates a host Chat thread and starts the first turn", async () => {
    const created = {
      kind: "thread-created",
      thread: { ...chatThread, title: "Ship mobile create", version: 1 },
    };
    const view = decodeChatThreadView({
      thread: { ...chatThread, title: "Ship mobile create", version: 2 },
      turns: [],
      lastSequence: 1,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 1,
      followUpVersion: 1,
    });
    const fetch = vi.fn(
      async ({ method, path, body }: { method: string; path: string; body?: string }) => {
        if (method === "POST" && path === "/api/chat/commands") {
          const payload = JSON.parse(body ?? "{}") as { kind?: string };
          if (payload.kind === "create-chat-thread") return Response.json(created);
          if (payload.kind === "send-chat-turn") {
            return new Response(null, { status: 200 });
          }
        }
        if (method === "GET" && path.includes("/api/chat/threads/")) {
          return Response.json(view);
        }
        return new Response("missing", { status: 404 });
      },
    );
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    const row = await createMobileChatWithFirstTurn({
      transport,
      prompt: "Ship mobile create",
    });
    expect(row).toMatchObject({
      hostId,
      mode: "chat",
      title: "Ship mobile create",
      threadId: chatThread.id,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("create-chat-thread"),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("send-chat-turn"),
      }),
    );

    await expect(createMobileChatThread({ transport, title: "   " })).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("applies change-chat-provider before the first turn when a model is selected", async () => {
    const created = {
      kind: "thread-created",
      thread: { ...chatThread, title: "Model pick", version: 1, modelId: "model-a" },
    };
    const updated = {
      kind: "thread-updated",
      thread: {
        ...chatThread,
        title: "Model pick",
        version: 2,
        modelId: "model-b",
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
      },
    };
    const view = decodeChatThreadView({
      thread: updated.thread,
      turns: [],
      lastSequence: 1,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 1,
      followUpVersion: 1,
    });
    const kinds: string[] = [];
    const fetch = vi.fn(
      async ({ method, path, body }: { method: string; path: string; body?: string }) => {
        if (method === "POST" && path === "/api/chat/commands") {
          const payload = JSON.parse(body ?? "{}") as {
            kind?: string;
            modelId?: string;
            expectedVersion?: number;
          };
          kinds.push(payload.kind ?? "");
          if (payload.kind === "create-chat-thread") return Response.json(created);
          if (payload.kind === "change-chat-provider") {
            expect(payload.modelId).toBe("model-b");
            expect(payload.expectedVersion).toBe(1);
            return Response.json(updated);
          }
          if (payload.kind === "send-chat-turn") {
            expect(payload.expectedVersion).toBe(2);
            return new Response(null, { status: 200 });
          }
        }
        if (method === "GET" && path.includes("/api/chat/threads/")) {
          return Response.json(view);
        }
        return new Response("missing", { status: 404 });
      },
    );
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await createMobileChatWithFirstTurn({
      transport,
      prompt: "Model pick",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-b",
    });
    expect(kinds).toEqual(["create-chat-thread", "change-chat-provider", "send-chat-turn"]);

    const changed = await changeMobileChatProvider({
      transport,
      threadId: chatThread.id,
      expectedVersion: 1,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-b",
    });
    expect(changed.modelId).toBe("model-b");
  });
});
