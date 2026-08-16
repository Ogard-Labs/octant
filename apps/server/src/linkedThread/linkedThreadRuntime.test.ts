import { describe, expect, it, vi } from "vitest";
import type { ChatThread, WindowId } from "@octant/contracts";
import { LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY } from "@octant/domain";
import { createLinkedThreadRuntime } from "./linkedThreadRuntime";

const now = "2026-08-03T00:00:00.000Z";
const sourceThread = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "77777777-7777-4777-8777-777777777777",
  title: "Source review",
  lifecycle: "active",
  providerInstanceId: "88888888-8888-4888-8888-888888888888",
  modelId: "review-model",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Review carefully.",
  version: 2,
  createdAt: now,
  updatedAt: now,
} as ChatThread;

describe("createLinkedThreadRuntime", () => {
  it("creates real Chat peers with the source route and starts each review turn", async () => {
    const execute = vi.fn(async (command: Record<string, unknown>) => {
      if (command.kind === "create-chat-thread") {
        return {
          kind: "thread-created",
          thread: {
            ...sourceThread,
            id: command.threadId,
            title: command.title,
            version: 1,
          },
        };
      }
      if (command.kind === "send-chat-turn") return { kind: "turn-created" };
      throw new Error("unexpected command");
    });
    const service = createLinkedThreadRuntime({
      actor: {
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000001" as never,
      },
      chat: { execute } as never,
      readChatThreadView: () => ({ thread: sourceThread }),
    });
    const windowId = "00000000-0000-4000-8000-000000000099" as WindowId;
    const scope = {
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: sourceThread.projectId },
    } as const;

    const proposed = await service.execute(windowId, {
      kind: "linked-thread-prompt-preview",
      requestId: "33333333-3333-4333-8333-333333333333" as never,
      requestFingerprint: "a".repeat(64) as never,
      prompt: "/review 2 threads Review the migration plan.",
      sourceThreadId: sourceThread.id as never,
      sourceScope: scope as never,
      sourceVersion: sourceThread.version,
      contextSnapshotId: "44444444-4444-4444-8444-444444444444" as never,
      targetScope: scope as never,
      requestedAuthority: LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
      nestingDepth: 1,
    });
    if (proposed.kind !== "linked-thread-preview-proposed") throw new Error("expected preview");

    const confirmed = await service.execute(windowId, {
      kind: "confirm-linked-thread-preview",
      previewId: proposed.preview.previewId,
      expectedVersion: proposed.preview.version,
      confirmed: true,
    });

    expect(confirmed).toMatchObject({
      kind: "linked-thread-preview-confirmed",
      aggregate: { status: "created" },
      receipt: { status: "accepted" },
    });
    expect(
      execute.mock.calls.filter(([command]) => command.kind === "create-chat-thread"),
    ).toHaveLength(2);
    expect(
      execute.mock.calls.filter(([command]) => command.kind === "send-chat-turn"),
    ).toHaveLength(2);
    for (const [command] of execute.mock.calls.filter(
      ([candidate]) => candidate.kind === "send-chat-turn",
    )) {
      expect(command).toMatchObject({ prompt: "Review the migration plan." });
    }
  });

  it("fails closed instead of inventing a provider route for a stale source", async () => {
    const service = createLinkedThreadRuntime({
      actor: {
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000001" as never,
      },
      chat: { execute: vi.fn() } as never,
      readChatThreadView: () => undefined,
    });
    const outcome = await service.execute("00000000-0000-4000-8000-000000000099" as WindowId, {
      kind: "linked-thread-prompt-preview",
      requestId: "33333333-3333-4333-8333-333333333333" as never,
      requestFingerprint: "a".repeat(64) as never,
      prompt: "/review 1 threads Review it.",
      sourceThreadId: sourceThread.id as never,
      sourceScope: {
        hostId: "local",
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: sourceThread.projectId },
      } as never,
      sourceVersion: sourceThread.version,
      contextSnapshotId: "44444444-4444-4444-8444-444444444444" as never,
      targetScope: {
        hostId: "local",
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: sourceThread.projectId },
      } as never,
      requestedAuthority: LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
      nestingDepth: 1,
    });

    expect(outcome).toMatchObject({ code: "unavailable" });
  });

  it("reports a created peer even when its first review turn fails", async () => {
    let sendCount = 0;
    const execute = vi.fn(async (command: Record<string, unknown>) => {
      if (command.kind === "create-chat-thread") {
        return {
          kind: "thread-created",
          thread: {
            ...sourceThread,
            id: command.threadId,
            title: command.title,
            version: 1,
          },
        };
      }
      if (command.kind === "send-chat-turn") {
        sendCount += 1;
        if (sendCount === 2) throw new Error("provider unavailable");
        return { kind: "turn-created" };
      }
      throw new Error("unexpected command");
    });
    const service = createLinkedThreadRuntime({
      actor: {
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000001" as never,
      },
      chat: { execute } as never,
      readChatThreadView: () => ({ thread: sourceThread }),
    });
    const windowId = "00000000-0000-4000-8000-000000000099" as WindowId;
    const scope = {
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: sourceThread.projectId },
    } as const;
    const proposed = await service.execute(windowId, {
      kind: "linked-thread-prompt-preview",
      requestId: "33333333-3333-4333-8333-333333333333" as never,
      requestFingerprint: "a".repeat(64) as never,
      prompt: "/review 2 threads Review the migration plan.",
      sourceThreadId: sourceThread.id as never,
      sourceScope: scope as never,
      sourceVersion: sourceThread.version,
      contextSnapshotId: "44444444-4444-4444-8444-444444444444" as never,
      targetScope: scope as never,
      requestedAuthority: LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
      nestingDepth: 1,
    });
    if (proposed.kind !== "linked-thread-preview-proposed") throw new Error("expected preview");

    const confirmed = await service.execute(windowId, {
      kind: "confirm-linked-thread-preview",
      previewId: proposed.preview.previewId,
      expectedVersion: proposed.preview.version,
      confirmed: true,
    });

    expect(confirmed).toMatchObject({
      kind: "linked-thread-preview-confirmed",
      aggregate: {
        status: "partial",
        results: [
          { status: "created", threadId: expect.any(String) },
          { status: "failed", threadId: expect.any(String) },
        ],
      },
      receipt: { status: "accepted", createdThreadIds: [expect.any(String), expect.any(String)] },
    });
  });
});
