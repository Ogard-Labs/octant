import {
  composerTextWasTyped,
  forgetTypedComposerText,
  threadDraftScope,
} from "@octant/client-runtime/typed-composer-text";
import { CodeClientFailure, type CodeClient } from "@octant/client-runtime/code-client";
import type { CodeBootstrap, CodeThreadId, CodeThreadView } from "@octant/contracts/code";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CodeThreadControllerSlots,
  createCodeThreadControllers,
  useOpenCodeThreadProviderRequests,
} from "./codeThreadControllers";
import { createCodeReadCursorStore } from "./useCodeController";
import { ThreadActivityRevisionsContext } from "../polling/ThreadActivityRevisions";

function ProviderRequestReader(props: {
  readonly controllers: ReturnType<typeof createCodeThreadControllers>;
  readonly threadIds: ReadonlyArray<CodeThreadId>;
  readonly onRead: (snapshot: unknown) => void;
}) {
  const snapshot = useOpenCodeThreadProviderRequests(props.controllers, props.threadIds);
  props.onRead(snapshot);
  return null;
}

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
    queryProjectPullRequests: vi.fn(),
    refreshProjectPullRequests: vi.fn(),
    queryProjectPullRequestDetail: vi.fn(),
    refreshProjectPullRequestDetail: vi.fn(),
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
  it("delivers a queued first-turn refresh when the new thread controller is published", () => {
    const registry = createCodeThreadControllers();
    const refreshConversation = vi.fn(() => true);

    registry.refreshConversation(threadA);
    registry.publish(threadA, { refreshConversation } as never);
    registry.publish(threadA, { refreshConversation } as never);

    expect(refreshConversation).toHaveBeenCalledOnce();
  });

  it("hands a new thread its first prompt even when the prompt is announced before the controller exists", () => {
    const registry = createCodeThreadControllers();
    const announceFirstPrompt = vi.fn();

    registry.announceFirstPrompt(threadA, "Fix the failing test");
    registry.publish(threadA, { announceFirstPrompt } as never);
    registry.publish(threadA, { announceFirstPrompt } as never);

    expect(announceFirstPrompt).toHaveBeenCalledOnce();
    expect(announceFirstPrompt).toHaveBeenCalledWith("Fix the failing test");
  });

  it("restores a failed first prompt once the task controller is ready", () => {
    const registry = createCodeThreadControllers();
    const setPendingDraft = vi.fn();
    registry.restoreDraft(threadA, "Retry this prompt");
    registry.publish(threadA, { status: "loading", setPendingDraft } as never);
    expect(setPendingDraft).not.toHaveBeenCalled();
    registry.publish(threadA, { status: "ready", setPendingDraft } as never);
    registry.publish(threadA, { status: "ready", setPendingDraft } as never);
    expect(setPendingDraft).toHaveBeenCalledExactlyOnceWith("Retry this prompt");
  });

  it("moves the claim of a typed first prompt to the thread that gets it back, and only for that prompt", () => {
    forgetTypedComposerText();
    const registry = createCodeThreadControllers();
    registry.restoreDraft(threadA, "I prefer tabs", undefined, true);
    registry.restoreDraft(threadB, "A button wrote this");

    expect(composerTextWasTyped(threadDraftScope("code", String(threadA)), "I prefer tabs")).toBe(
      true,
    );
    expect(
      composerTextWasTyped(threadDraftScope("code", String(threadB)), "A button wrote this"),
    ).toBe(false);
    expect(composerTextWasTyped(threadDraftScope("code", String(threadB)), "I prefer tabs")).toBe(
      false,
    );
  });

  it("keeps the first-turn refusal until the task finishes loading", () => {
    const registry = createCodeThreadControllers();
    const setPendingDraft = vi.fn();
    const showTurnRefusal = vi.fn();
    registry.restoreDraft(threadA, "Retry this prompt", "Provider unavailable");
    registry.publish(threadA, { status: "loading", setPendingDraft, showTurnRefusal } as never);
    expect(showTurnRefusal).not.toHaveBeenCalled();
    registry.publish(threadA, { status: "ready", setPendingDraft, showTurnRefusal } as never);
    registry.publish(threadA, { status: "ready", setPendingDraft, showTurnRefusal } as never);
    expect(setPendingDraft).toHaveBeenCalledExactlyOnceWith("Retry this prompt");
    expect(showTurnRefusal).toHaveBeenCalledExactlyOnceWith("Provider unavailable");
  });

  it("discards a queued prompt restoration when its task tab is released", () => {
    const registry = createCodeThreadControllers();
    const setPendingDraft = vi.fn();
    registry.restoreDraft(threadA, "Closed task prompt");
    registry.release(threadA);
    registry.publish(threadA, { status: "ready", setPendingDraft } as never);
    expect(setPendingDraft).not.toHaveBeenCalled();
  });

  it("does not deliver a first prompt that was withdrawn before the controller existed", () => {
    const registry = createCodeThreadControllers();
    const announceFirstPrompt = vi.fn();

    registry.announceFirstPrompt(threadA, "Fix the failing test");
    registry.announceFirstPrompt(threadA, undefined);
    registry.publish(threadA, { announceFirstPrompt } as never);

    expect(announceFirstPrompt).not.toHaveBeenCalled();
  });

  it("sets the notice immediately when the thread's controller is published", () => {
    const registry = createCodeThreadControllers();
    const setAccessNotice = vi.fn();
    const notice = "Full access was not confirmed.";

    registry.publish(threadA, { setAccessNotice } as never);
    registry.holdAccessNotice(threadA, notice);

    expect(setAccessNotice).toHaveBeenCalledExactlyOnceWith(notice);
  });

  it("delivers an access notice held for a released thread when that thread's controller publishes again", () => {
    const registry = createCodeThreadControllers();
    const firstSetAccessNotice = vi.fn();
    const secondSetAccessNotice = vi.fn();
    const notice = "Full access confirmation was cancelled when you left this thread.";

    registry.publish(threadA, { setAccessNotice: firstSetAccessNotice } as never);
    registry.release(threadA);
    registry.holdAccessNotice(threadA, notice);

    expect(firstSetAccessNotice).not.toHaveBeenCalled();

    registry.publish(threadA, { setAccessNotice: secondSetAccessNotice } as never);
    expect(secondSetAccessNotice).toHaveBeenCalledExactlyOnceWith(notice);

    registry.publish(threadA, { setAccessNotice: vi.fn() } as never);
    expect(secondSetAccessNotice).toHaveBeenCalledOnce();
  });

  it("shares the window bootstrap and reads follow-ups only for each tab's own thread", async () => {
    const registry = createCodeThreadControllers();
    const api = client();
    render(
      <CodeThreadControllerSlots
        client={api}
        navigationBootstrap={bootstrap()}
        readCursorStore={createCodeReadCursorStore()}
        registry={registry}
        threadIds={[threadA, threadB]}
      />,
    );
    await waitFor(() => {
      expect(registry.get(threadA)?.conversationHistory).toBe("loaded");
      expect(registry.get(threadB)?.conversationHistory).toBe("loaded");
    });
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(api.readFollowUp).toHaveBeenCalledTimes(2);
    expect(api.readFollowUp).toHaveBeenCalledWith(threadA);
    expect(api.readFollowUp).toHaveBeenCalledWith(threadB);
  });

  it("waits for window metadata without starting another bootstrap", async () => {
    const registry = createCodeThreadControllers();
    const api = client();
    const props = {
      client: api,
      readCursorStore: createCodeReadCursorStore(),
      registry,
      threadIds: [threadA],
    };
    const view = render(<CodeThreadControllerSlots {...props} navigationBootstrap={undefined} />);
    await waitFor(() => expect(registry.get(threadA)?.conversationHistory).toBe("loaded"));
    expect(api.bootstrap).not.toHaveBeenCalled();
    view.rerender(<CodeThreadControllerSlots {...props} navigationBootstrap={bootstrap()} />);
    await waitFor(() => expect(registry.get(threadA)?.status).toBe("ready"));
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(api.readFollowUp).toHaveBeenCalledTimes(1);
  });

  it.each(["late", "updated"] as const)(
    "keeps a failed thread load retryable when %s window metadata arrives",
    async (timing) => {
      const registry = createCodeThreadControllers();
      const api = client();
      vi.mocked(api.thread).mockRejectedValueOnce(
        new CodeClientFailure({ category: "unavailable", message: "Thread load unavailable" }),
      );
      const props = {
        client: api,
        readCursorStore: createCodeReadCursorStore(),
        registry,
        threadIds: [threadA],
      };
      const view = render(
        <CodeThreadControllerSlots
          {...props}
          navigationBootstrap={timing === "late" ? undefined : bootstrap()}
        />,
      );
      await waitFor(() =>
        expect(registry.get(threadA)?.errorMessage).toBe("Thread load unavailable"),
      );
      const failedStatus = registry.get(threadA)?.status;
      view.rerender(<CodeThreadControllerSlots {...props} navigationBootstrap={bootstrap()} />);
      expect(registry.get(threadA)?.errorMessage).toBe("Thread load unavailable");
      expect(registry.get(threadA)?.status).toBe(failedStatus);
      expect(api.thread).toHaveBeenCalledTimes(1);
      await act(async () => {
        await registry.get(threadA)?.retry();
      });
      await waitFor(() => expect(registry.get(threadA)?.activeView?.thread.id).toBe(threadA));
      expect(registry.get(threadA)?.errorMessage).toBeUndefined();
    },
  );

  it("reads what the person sent into an open thread's running turn when the window hears a queue change", async () => {
    const registry = createCodeThreadControllers();
    const steeredMessages = [{ messageId: "m1", body: "Skip the backfill.", steeredAt: now }];
    const turn = {
      operationId: "70000000-0000-4000-8000-000000000001",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      prompt: { contentId: "p", digest: "a".repeat(64), byteLength: 1 },
      assistant: [],
      status: "incomplete",
      startedAt: now,
      updatedAt: now,
    };
    let held: object = turn;
    const conversationWindow = vi.fn(async (threadId: unknown) => ({
      version: 1,
      threadId,
      turns: String(threadId) === String(threadA) ? [held] : [],
      hasEarlier: false,
      hasLater: false,
    }));
    const api = {
      ...client(),
      conversationWindow,
      operationContent: vi.fn(async () => new TextEncoder().encode("Add the index")),
      subscribeOperation: vi.fn((_t: unknown, _o: unknown, _c: unknown, signal: AbortSignal) =>
        idleStream(signal),
      ),
    } as unknown as CodeClient;
    const readCursorStore = createCodeReadCursorStore();
    const tree = (threadMessageQueue: number) => (
      <ThreadActivityRevisionsContext.Provider
        value={{ browserCaptures: 0, toolApprovals: 0, threadFollowUps: 0, threadMessageQueue }}
      >
        <CodeThreadControllerSlots
          client={api}
          navigationBootstrap={bootstrap()}
          readCursorStore={readCursorStore}
          registry={registry}
          threadIds={[threadA, threadB]}
        />
      </ThreadActivityRevisionsContext.Provider>
    );
    const view = render(tree(1));
    await waitFor(() => {
      expect(registry.get(threadA)?.turnStatus).toBe("running");
      expect(registry.get(threadB)?.conversationHistory).toBe("loaded");
    });
    const readsOf = (threadId: CodeThreadId) =>
      conversationWindow.mock.calls.filter(([id]) => String(id) === String(threadId)).length;
    const idleReads = readsOf(threadB);

    held = { ...turn, steeredMessages };
    view.rerender(tree(2));

    await waitFor(() =>
      expect(registry.get(threadA)?.conversation.at(-1)).toMatchObject({ steeredMessages }),
    );
    // A thread with no running turn has nothing to take in.
    expect(readsOf(threadB)).toBe(idleReads);
  });

  it("follows a turn another window started in a thread this window opened idle, with what the person sent into it", async () => {
    const registry = createCodeThreadControllers();
    const steeredMessages = [{ messageId: "m1", body: "Skip the backfill.", steeredAt: now }];
    const turn = {
      operationId: "70000000-0000-4000-8000-000000000002",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      prompt: { contentId: "p", digest: "a".repeat(64), byteLength: 1 },
      assistant: [],
      status: "incomplete",
      steeredMessages,
      startedAt: now,
      updatedAt: now,
    };
    let turnsOfA: ReadonlyArray<object> = [];
    const conversationWindow = vi.fn(async (threadId: unknown) => ({
      version: 1,
      threadId,
      turns: String(threadId) === String(threadA) ? turnsOfA : [],
      hasEarlier: false,
      hasLater: false,
    }));
    const subscribeOperation = vi.fn((_t: unknown, _o: unknown, _c: unknown, signal: AbortSignal) =>
      idleStream(signal),
    );
    const api = {
      ...client(),
      conversationWindow,
      operationContent: vi.fn(async () => new TextEncoder().encode("Add the index")),
      subscribeOperation,
    } as unknown as CodeClient;
    const readCursorStore = createCodeReadCursorStore();
    const idle = bootstrap();
    const tree = (navigationBootstrap: CodeBootstrap) => (
      <CodeThreadControllerSlots
        client={api}
        navigationBootstrap={navigationBootstrap}
        readCursorStore={readCursorStore}
        registry={registry}
        threadIds={[threadA, threadB]}
      />
    );
    const view = render(tree(idle));
    await waitFor(() => {
      expect(registry.get(threadA)?.conversationHistory).toBe("loaded");
      expect(registry.get(threadB)?.conversationHistory).toBe("loaded");
    });
    expect(registry.get(threadA)?.turnStatus).toBe("idle");
    const readsOf = (threadId: CodeThreadId) =>
      conversationWindow.mock.calls.filter(([id]) => String(id) === String(threadId)).length;
    const idleReadsOfB = readsOf(threadB);
    const idleReadsOfA = readsOf(threadA);

    // Another window started a turn and the runtime took a message into it.
    // The window's thread list is all this one hears of it.
    turnsOfA = [turn];
    const working = (sequence: number): CodeBootstrap => ({
      ...idle,
      activity: [{ threadId: threadA, lastSequence: sequence }] as never,
      runtime: [{ threadId: threadA, executing: true }] as never,
    });
    view.rerender(tree(working(5)));

    await waitFor(() => {
      expect(registry.get(threadA)?.turnStatus).toBe("running");
      expect(registry.get(threadA)?.conversation.at(-1)).toMatchObject({
        role: "assistant",
        steeredMessages,
      });
    });
    await waitFor(() => expect(subscribeOperation).toHaveBeenCalledOnce());
    const followedReads = readsOf(threadA);
    expect(followedReads).toBeGreaterThan(idleReadsOfA);

    // More activity on a turn already followed reads nothing again and opens
    // no second stream.
    view.rerender(tree(working(9)));
    await act(async () => undefined);
    expect(subscribeOperation).toHaveBeenCalledOnce();
    expect(readsOf(threadB)).toBe(idleReadsOfB);
  });

  describe("a turn started elsewhere", () => {
    const providerTurn = (operationId: string, status: string, extra: object = {}) => ({
      operationId,
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      prompt: { contentId: "p", digest: "a".repeat(64), byteLength: 1 },
      assistant: [],
      status,
      startedAt: now,
      updatedAt: now,
      ...extra,
    });
    const asked = "70000000-0000-4000-8000-000000000003";
    const next = "70000000-0000-4000-8000-000000000004";

    function host(
      initial: ReadonlyArray<object>,
      stream?: (operationId: string, signal: AbortSignal) => AsyncGenerator | undefined,
    ) {
      const held = { turnsOfA: initial };
      const conversationWindow = vi.fn(
        async (threadId: unknown, _options?: { readonly limit?: number }) => ({
          version: 1,
          threadId,
          turns: String(threadId) === String(threadA) ? held.turnsOfA : [],
          hasEarlier: false,
          hasLater: false,
        }),
      );
      const subscribeOperation = vi.fn(
        (_t: unknown, operationId: unknown, _c: unknown, signal: AbortSignal) =>
          stream?.(String(operationId), signal) ??
          (String(operationId) === asked
            ? (async function* () {
                // The host replays a turn that waits on the person and ends it.
                yield {
                  threadId: threadA,
                  operationId: asked,
                  cursor: 1,
                  occurredAt: now,
                  event: { kind: "operation-state", state: "waiting" },
                };
              })()
            : idleStream(signal)),
      );
      const api = {
        ...client(),
        conversationWindow,
        operationContent: vi.fn(async () => new TextEncoder().encode("Add the index")),
        subscribeOperation,
      } as unknown as CodeClient;
      return { api, conversationWindow, held, subscribeOperation };
    }

    const working = (sequence: number): CodeBootstrap => ({
      ...bootstrap(),
      activity: [{ threadId: threadA, lastSequence: sequence }] as never,
      runtime: [{ threadId: threadA, executing: true }] as never,
    });

    function open(api: CodeClient, navigationBootstrap: CodeBootstrap) {
      const registry = createCodeThreadControllers();
      const readCursorStore = createCodeReadCursorStore();
      const tree = (current: CodeBootstrap) => (
        <CodeThreadControllerSlots
          client={api}
          navigationBootstrap={current}
          readCursorStore={readCursorStore}
          registry={registry}
          threadIds={[threadA]}
        />
      );
      const view = render(tree(navigationBootstrap));
      return { registry, rerender: (current: CodeBootstrap) => view.rerender(tree(current)) };
    }

    it("follows the next turn in a thread whose last turn waits on the person", async () => {
      const { api, held, subscribeOperation } = host([providerTurn(asked, "waiting")]);
      const { registry, rerender } = open(api, bootstrap());
      await waitFor(() => expect(registry.get(threadA)?.turnStatus).toBe("waiting"));

      const steeredMessages = [{ messageId: "m2", body: "Use staging.", steeredAt: now }];
      held.turnsOfA = [
        providerTurn(asked, "completed"),
        providerTurn(next, "incomplete", { steeredMessages }),
      ];
      rerender(working(7));

      await waitFor(() => {
        expect(registry.get(threadA)?.turnStatus).toBe("running");
        expect(registry.get(threadA)?.conversation.at(-1)).toMatchObject({ steeredMessages });
      });
      await waitFor(() =>
        expect(subscribeOperation).toHaveBeenLastCalledWith(
          threadA,
          next,
          expect.anything(),
          expect.anything(),
        ),
      );
    });

    it("shows a turn that started and finished elsewhere between two reads of the list", async () => {
      const { api, conversationWindow, held } = host([providerTurn(asked, "completed")]);
      const settled = (sequence: number): CodeBootstrap => ({
        ...bootstrap(),
        activity: [{ threadId: threadA, lastSequence: sequence }] as never,
      });
      const { registry, rerender } = open(api, settled(2));
      await waitFor(() => expect(registry.get(threadA)?.conversationHistory).toBe("loaded"));
      const steeredMessages = [{ messageId: "m3", body: "Keep the old name.", steeredAt: now }];
      held.turnsOfA = [
        providerTurn(asked, "completed"),
        providerTurn(next, "completed", { steeredMessages }),
      ];
      // The list never said the thread was working; only its activity moved.
      rerender(settled(9));
      await waitFor(() =>
        expect(registry.get(threadA)?.conversation.at(-1)).toMatchObject({
          operationId: next,
          steeredMessages,
        }),
      );
      // Activity on a turn already shown takes one look at the newest turn and
      // reads nothing whole again.
      const wholeReads = () =>
        conversationWindow.mock.calls.filter(([, options]) => (options?.limit ?? 0) > 2).length;
      const before = wholeReads();
      rerender(settled(11));
      await waitFor(() =>
        expect(conversationWindow).toHaveBeenLastCalledWith(
          threadA,
          { limit: 1 },
          expect.anything(),
        ),
      );
      expect(wholeReads()).toBe(before);
    });

    it("looks again on its own when its look at a settled thread failed", async () => {
      const { api, conversationWindow, held } = host([providerTurn(asked, "completed")]);
      const settled = (sequence: number): CodeBootstrap => ({
        ...bootstrap(),
        activity: [{ threadId: threadA, lastSequence: sequence }] as never,
      });
      const { registry, rerender } = open(api, settled(2));
      await waitFor(() => expect(registry.get(threadA)?.conversationHistory).toBe("loaded"));
      held.turnsOfA = [providerTurn(asked, "completed"), providerTurn(next, "completed")];
      conversationWindow.mockRejectedValueOnce(new Error("offline"));
      // The list moves once and then says the same thing on every refresh.
      rerender(settled(9));
      await waitFor(
        () =>
          expect(registry.get(threadA)?.conversation.at(-1)).toMatchObject({ operationId: next }),
        { timeout: 8_000 },
      );
    }, 12_000);

    it("streams the queued turn that follows the one this view followed", async () => {
      let finishFirst = () => {};
      const firstEnds = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const { api, held, subscribeOperation } = host(
        [providerTurn(asked, "incomplete")],
        (operationId) =>
          operationId === asked
            ? (async function* () {
                await firstEnds;
                yield {
                  threadId: threadA,
                  operationId: asked,
                  cursor: 1,
                  occurredAt: now,
                  event: { kind: "operation-state", state: "completed" },
                };
              })()
            : undefined,
      );
      const { registry } = open(api, bootstrap());
      await waitFor(() => expect(registry.get(threadA)?.turnStatus).toBe("running"));

      // The next queued message became a turn before this view saw the first end.
      held.turnsOfA = [providerTurn(asked, "completed"), providerTurn(next, "incomplete")];
      finishFirst();

      await waitFor(() =>
        expect(subscribeOperation).toHaveBeenLastCalledWith(
          threadA,
          next,
          expect.anything(),
          expect.anything(),
        ),
      );
      expect(registry.get(threadA)?.turnStatus).toBe("running");
      await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
      expect(
        subscribeOperation.mock.calls.filter(([, operationId]) => String(operationId) === next),
      ).toHaveLength(1);
    }, 10_000);

    it("reads nothing more for a thread the list already says is working when it opens", async () => {
      const { api, conversationWindow, subscribeOperation } = host([
        providerTurn(next, "incomplete"),
      ]);
      const { registry, rerender } = open(api, working(3));
      await waitFor(() => expect(registry.get(threadA)?.turnStatus).toBe("running"));
      rerender(working(4));
      await act(async () => undefined);
      // Only the open's own read takes the whole window; the turn's poll
      // looks at one turn.
      const wholeReads = conversationWindow.mock.calls.filter(
        ([, options]) => (options?.limit ?? 0) > 2,
      );
      expect(wholeReads).toHaveLength(1);
      expect(subscribeOperation).toHaveBeenCalledOnce();
    });
  });

  it("gives every open Code thread its own view instead of one shared with the front tab", async () => {
    const registry = createCodeThreadControllers();
    render(
      <CodeThreadControllerSlots
        navigationBootstrap={bootstrap()}
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
    const navigationBootstrap = bootstrap();
    const readCursorStore = createCodeReadCursorStore();
    const { rerender } = render(
      <CodeThreadControllerSlots
        navigationBootstrap={navigationBootstrap}
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
        navigationBootstrap={navigationBootstrap}
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
        navigationBootstrap={bootstrap()}
        client={client()}
        readCursorStore={createCodeReadCursorStore()}
        registry={registry}
        threadIds={[threadA]}
      />,
    );

    await waitFor(() => expect(registry.get(threadA)?.activeView).toBeDefined());
    expect(announced).toHaveBeenCalled();
  });

  it("wakes a thread's readers only when that thread's controller moves", async () => {
    const registry = createCodeThreadControllers();
    const readsA = vi.fn();
    const readsB = vi.fn();
    registry.subscribeThread(threadA, readsA);
    registry.subscribeThread(threadB, readsB);

    render(
      <CodeThreadControllerSlots
        navigationBootstrap={bootstrap()}
        client={client()}
        readCursorStore={createCodeReadCursorStore()}
        registry={registry}
        threadIds={[threadA]}
      />,
    );

    await waitFor(() => expect(registry.get(threadA)?.activeView).toBeDefined());
    expect(readsA).toHaveBeenCalled();
    expect(readsB).not.toHaveBeenCalled();
  });

  it("returns the same provider-request snapshot when nothing changed", () => {
    const registry = createCodeThreadControllers();
    const snapshots: unknown[] = [];

    render(
      <ProviderRequestReader
        controllers={registry}
        onRead={(snapshot) => snapshots.push(snapshot)}
        threadIds={[threadA]}
      />,
    );

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toBe(snapshots[0]);
  });
});
