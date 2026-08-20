import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeBootstrap, CodeThreadId, CodeThreadView } from "@octant/contracts/code";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeThreadControllerSlots, createCodeThreadControllers } from "./codeThreadControllers";
import { createCodeReadCursorStore } from "./useCodeController";

const now = "2026-08-16T09:00:00.000Z";
const repositoryId = `repo_${"a".repeat(64)}`;
const threadA = "10000000-0000-4000-8000-000000000001" as CodeThreadId;
const threadB = "10000000-0000-4000-8000-000000000002" as CodeThreadId;
const checkoutA = "40000000-0000-4000-8000-000000000001";
const checkoutB = "40000000-0000-4000-8000-000000000002";

function checkout(id: string): CodeThreadView["checkout"] {
  return {
    id: id as never,
    repositoryId: repositoryId as never,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "development" as never, oid: "a".repeat(40) as never },
    observedAt: now as never,
  };
}

function thread(id: CodeThreadId, checkoutId: string, title: string): CodeThreadView["thread"] {
  return {
    id,
    projectId: "20000000-0000-4000-8000-000000000001" as never,
    bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
    repositoryId: repositoryId as never,
    checkoutId: checkoutId as never,
    title,
    lifecycle: "active",
    providerInstanceId: "50000000-0000-4000-8000-000000000001" as never,
    modelId: "model-a" as never,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: { branchIntent: "feature/a", remoteName: "origin", outcomeKind: "opened-pr" },
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
  } as never;
}

function bootstrap(): CodeBootstrap {
  return {
    checkouts: [checkout(checkoutA), checkout(checkoutB)],
    settings: {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      updatedAt: now as never,
      version: 1 as never,
    },
    threads: [thread(threadA, checkoutA, "First"), thread(threadB, checkoutB, "Second")],
    activity: [],
  } as never;
}

async function* idleStream(signal: AbortSignal) {
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  yield* [];
}

function client(): CodeClient {
  return {
    bootstrap: vi.fn(async () => bootstrap()),
    queryBoard: vi.fn(),
    conversation: vi.fn(async (threadId: unknown) => ({
      version: 3 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(),
    operationContent: vi.fn(),
    putAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    attachment: vi.fn(),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
    putEvidence: vi.fn(),
    save: vi.fn(),
    openFile: vi.fn(),
    listTests: vi.fn(),
    subscribe: vi.fn((_threadId: unknown, _cursor: unknown, signal: AbortSignal) =>
      idleStream(signal),
    ),
    subscribeOperation: vi.fn(),
    thread: vi.fn(async (threadId: unknown) =>
      String(threadId) === String(threadA)
        ? {
            checkout: checkout(checkoutA),
            lastSequence: 1,
            thread: thread(threadA, checkoutA, "First"),
          }
        : {
            checkout: checkout(checkoutB),
            lastSequence: 1,
            thread: thread(threadB, checkoutB, "Second"),
          },
    ),
    readFollowUp: vi.fn(async (threadId: unknown) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(),
  } as unknown as CodeClient;
}

describe("CodeThreadControllerSlots", () => {
  it("gives every open Code thread its own view instead of one shared with the front tab", async () => {
    const registry = createCodeThreadControllers();
    render(
      <CodeThreadControllerSlots
        client={client()}
        readCursorStore={createCodeReadCursorStore()}
        registry={registry}
        threadIds={[threadA, threadB]}
      />,
    );

    await waitFor(() => {
      expect(registry.get(threadA)?.activeView?.thread.title).toBe("First");
      expect(registry.get(threadB)?.activeView?.thread.title).toBe("Second");
    });
    expect(registry.get(threadA)?.activeView?.checkout.id).toBe(checkoutA);
    expect(registry.get(threadB)?.activeView?.checkout.id).toBe(checkoutB);
  });

  it("lets go of a thread that was closed while the others keep running", async () => {
    const registry = createCodeThreadControllers();
    const codeClient = client();
    const readCursorStore = createCodeReadCursorStore();
    const { rerender } = render(
      <CodeThreadControllerSlots
        client={codeClient}
        readCursorStore={readCursorStore}
        registry={registry}
        threadIds={[threadA, threadB]}
      />,
    );
    await waitFor(() => expect(registry.get(threadB)?.activeView).toBeDefined());
    const running = registry.get(threadA);

    rerender(
      <CodeThreadControllerSlots
        client={codeClient}
        readCursorStore={readCursorStore}
        registry={registry}
        threadIds={[threadA]}
      />,
    );

    await waitFor(() => expect(registry.get(threadB)).toBeUndefined());
    expect(registry.get(threadA)).toBe(running);
  });

  it("tells a subscriber when a thread's own state moves", async () => {
    const registry = createCodeThreadControllers();
    const announced = vi.fn();
    registry.subscribe(announced);

    render(
      <CodeThreadControllerSlots
        client={client()}
        readCursorStore={createCodeReadCursorStore()}
        registry={registry}
        threadIds={[threadA]}
      />,
    );

    await waitFor(() => expect(registry.get(threadA)?.activeView).toBeDefined());
    expect(announced).toHaveBeenCalled();
  });
});
