import {
  composerTextWasTyped,
  forgetTypedComposerText,
  threadDraftScope,
} from "@octant/client-runtime/typed-composer-text";
import { CodeClientFailure, type CodeClient } from "@octant/client-runtime/code-client";
import type { CodeBootstrap, CodeThreadId, CodeThreadView } from "@octant/contracts/code";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CodeThreadControllerSlots,
  createCodeThreadControllers,
  useCodeThreadController,
  useOpenCodeThreadProviderRequests,
} from "./codeThreadControllers";
import CodeWorkspaceTab from "./CodeWorkspaceTab";
import { createCodeReadCursorStore } from "./useCodeController";

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

/** A host that holds each thread's answers back until the test lets them through. */
function conversingHost(replies: Map<string, string>, host: "windowed" | "whole" = "windowed") {
  const codeClient = client();
  const gate = { held: false, release: () => undefined as void };
  let open = Promise.resolve();
  const hold = () => {
    gate.held = true;
    open = new Promise<void>((resolve) => {
      gate.release = () => {
        gate.held = false;
        resolve();
      };
    });
  };
  const read = codeClient.thread;
  const turnOf = (threadId: CodeThreadId) => {
    const evidence = (part: string) => ({
      contentId: String(threadId).replace(/^1/, part),
      digest: "a".repeat(64),
      byteLength: 10,
    });
    return {
      operationId: String(threadId).replace(/^1/, "7"),
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      sessionId: String(threadId).replace(/^1/, "8"),
      prompt: evidence("5"),
      assistant: [evidence("6")],
      status: "completed" as const,
      startedAt: now,
      updatedAt: now,
    };
  };
  Object.assign(codeClient, {
    thread: vi.fn(async (threadId: CodeThreadId) => {
      await open;
      return read(threadId);
    }),
    conversation: vi.fn(async (threadId: CodeThreadId) => {
      await open;
      return {
        version: 3 as const,
        threadId,
        turns: [turnOf(threadId)],
        nextCursor: 1,
        hasMore: false,
      };
    }),
    ...(host === "whole"
      ? {}
      : {
          conversationWindow: vi.fn(async (threadId: CodeThreadId) => {
            await open;
            return { version: 1 as const, threadId, turns: [turnOf(threadId)], hasEarlier: false };
          }),
        }),
    operationContent: vi.fn(async (threadId: CodeThreadId, _operation: unknown, id: unknown) =>
      new TextEncoder().encode(
        String(id).startsWith("5") ? "What is here?" : (replies.get(String(threadId)) ?? ""),
      ),
    ),
    listTests: vi.fn(async () => ({ definitions: [] })),
    inspectTerminal: vi.fn(async () => ({ sessions: [] })),
  });
  return { client: codeClient, hold, release: () => gate.release() };
}

interface DrawnFrame {
  readonly threadId: CodeThreadId;
  readonly text: string;
  readonly turnStatus: string | undefined;
  readonly requests: number | undefined;
}

/** One pane, as a workspace draws it: the thread in front, under its own controller. */
function ThreadPane(props: {
  readonly controllers: ReturnType<typeof createCodeThreadControllers>;
  readonly threadId: CodeThreadId;
  readonly onFrame?: (frame: DrawnFrame) => void;
}) {
  const controller = useCodeThreadController(props.controllers, props.threadId);
  // What each commit draws, before any effect or answer.
  const pane = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    props.onFrame?.({
      threadId: props.threadId,
      text: pane.current?.textContent ?? "",
      turnStatus: controller?.turnStatus,
      requests: controller?.providerRequests.length,
    });
  });
  return (
    <main ref={pane} data-thread={String(props.threadId)} key={String(props.threadId)}>
      {controller === undefined ? (
        "Preparing this Code thread"
      ) : (
        <CodeWorkspaceTab
          controller={controller}
          tab={
            {
              id: `tab-${String(props.threadId)}`,
              kind: "code-overview",
              mode: "code",
              threadId: props.threadId,
              title: "Thread",
            } as never
          }
        />
      )}
    </main>
  );
}

function ThreadWindow(props: {
  readonly client: CodeClient;
  readonly registry: ReturnType<typeof createCodeThreadControllers>;
  readonly readCursorStore: ReturnType<typeof createCodeReadCursorStore>;
  readonly navigationBootstrap: CodeBootstrap;
  readonly threadId: CodeThreadId;
  readonly onFrame?: (frame: DrawnFrame) => void;
}) {
  const { threadId } = props;
  return (
    <>
      <ThreadPane
        controllers={props.registry}
        threadId={threadId}
        {...(props.onFrame === undefined ? {} : { onFrame: props.onFrame })}
      />
      <CodeThreadControllerSlots
        client={props.client}
        navigationBootstrap={props.navigationBootstrap}
        readCursorStore={props.readCursorStore}
        registry={props.registry}
        threadIds={useMemo(() => [threadId], [threadId])}
      />
    </>
  );
}

describe("switching between Code threads the window has loaded", () => {
  // The workspace's own lazy chunk belongs to a thread's first open, not to a switch.
  beforeAll(async () => {
    await import("./CodeWorkspace");
  }, 60_000);

  async function openBoth(kind: "windowed" | "whole" = "windowed") {
    const replies = new Map([
      [String(threadA), "Reply from the first thread"],
      [String(threadB), "Reply from the second thread"],
    ]);
    const host = conversingHost(replies, kind);
    const registry = createCodeThreadControllers();
    const readCursorStore = createCodeReadCursorStore();
    const frames: DrawnFrame[] = [];
    const props = {
      client: host.client,
      navigationBootstrap: bootstrap(),
      onFrame: (frame: DrawnFrame) => void frames.push(frame),
      readCursorStore,
      registry,
    };
    const view = render(<ThreadWindow {...props} threadId={threadA} />);
    const show = (threadId: CodeThreadId, change: Partial<typeof props> = {}) =>
      view.rerender(<ThreadWindow {...props} {...change} threadId={threadId} />);
    await screen.findByText("Reply from the first thread");
    show(threadB);
    await screen.findByText("Reply from the second thread");
    frames.length = 0;
    return { frames, host, readCursorStore, registry, replies, show };
  }

  it("loads again, as at a first open, on a host that can only read a thread whole", async () => {
    const opened = await openBoth("whole");
    expect(opened.registry.shown(threadA)).toBeUndefined();
    opened.show(threadA);
    expect(screen.queryByText("Reply from the second thread")).toBeNull();
    expect(await screen.findByText("Reply from the first thread")).toBeInTheDocument();
  });

  it.each(["windowed"] as const)(
    "draws the incoming conversation in the first frame while a %s host is still answering",
    async (kind) => {
      const opened = await openBoth(kind);
      opened.host.hold();
      opened.show(threadA);

      expect(opened.frames.length).toBeGreaterThan(0);
      for (const frame of opened.frames) {
        expect(frame.text).not.toContain("Reply from the second thread");
        expect(frame.text).not.toMatch(/Loading conversation|Preparing this Code thread/);
      }

      // The transcript measures itself within the same commit, before anything is painted.
      expect(screen.getByText("Reply from the first thread")).toBeInTheDocument();

      // The journal still has the last word on what the thread holds.
      opened.replies.set(String(threadA), "Reply the thread got meanwhile");
      opened.host.release();
      expect(await screen.findByText("Reply the thread got meanwhile")).toBeInTheDocument();
      expect(screen.queryByText("Reply from the first thread")).toBeNull();
      expect(opened.registry.get(threadA)?.conversationHistory).toBe("loaded");
    },
  );

  it("still draws a thread at once after a quick switch there and back", async () => {
    const opened = await openBoth();
    opened.host.hold();
    for (const id of [threadA, threadB, threadA, threadB]) {
      opened.frames.length = 0;
      opened.show(id);
      for (const frame of opened.frames) {
        expect(frame.text).not.toMatch(/Loading conversation|Preparing this Code thread/);
      }
      expect(
        screen.getByText(
          id === threadA ? "Reply from the first thread" : "Reply from the second thread",
        ),
      ).toBeInTheDocument();
    }
    opened.host.release();
    await waitFor(() => expect(opened.registry.get(threadB)?.conversationHistory).toBe("loaded"));
  });

  it("does not call a kept transcript loaded before the host has answered again", async () => {
    const opened = await openBoth();
    opened.host.hold();
    opened.show(threadA);
    expect(opened.registry.get(threadA)?.conversationHistory).toBe("loading");
    opened.host.release();
    await waitFor(() => expect(opened.registry.get(threadA)?.conversationHistory).toBe("loaded"));
  });

  it("runs nothing for a thread that left every pane, not even after a command it left waiting", async () => {
    const opened = await openBoth();
    let answer: (result: unknown) => void = () => undefined;
    vi.mocked(opened.host.client.execute).mockImplementation(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    act(() => void opened.registry.get(threadB)?.renameThread(threadB, "Renamed"));
    await waitFor(() => expect(opened.host.client.execute).toHaveBeenCalled());
    const marked = vi.spyOn(opened.readCursorStore, "mark");
    const markedDeferred = vi.spyOn(opened.readCursorStore, "markDeferred");
    opened.show(threadA);
    await waitFor(() => expect(opened.registry.get(threadA)?.conversationHistory).toBe("loaded"));

    expect(opened.registry.get(threadB)).toBeUndefined();
    const streams = vi
      .mocked(opened.host.client.subscribe)
      .mock.calls.filter(([id]) => String(id) === String(threadB));
    expect(streams.every(([, , signal]) => signal?.aborted)).toBe(true);
    await act(async () => {
      answer({ kind: "thread-updated", thread: thread(threadB, checkoutB, "Renamed") });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      vi
        .mocked(opened.host.client.subscribe)
        .mock.calls.filter(([id]) => String(id) === String(threadB)),
    ).toHaveLength(streams.length);
    for (const spy of [marked, markedDeferred]) {
      expect(spy.mock.calls.filter(([id]) => String(id) === String(threadB))).toEqual([]);
    }
  });

  it("offers nothing to answer, stop or retry on what a left thread last showed", async () => {
    const opened = await openBoth();
    const left = opened.registry.shown(threadA);
    expect(left?.conversation).toHaveLength(2);
    expect(left).toMatchObject({
      conversationHistory: "loading",
      providerRequests: [],
      turnStatus: "idle",
      turnError: undefined,
    });
    opened.host.hold();
    opened.show(threadA);
    for (const frame of opened.frames) {
      expect(frame).toMatchObject({ requests: 0, turnStatus: "idle" });
    }
    opened.host.release();
    await waitFor(() => expect(opened.registry.get(threadA)?.conversationHistory).toBe("loaded"));
  });

  it("delivers a prompt queued while a thread was away, even once its text was let go", async () => {
    const opened = await openBoth();
    opened.registry.restoreDraft(threadA, "Bounced prompt");
    opened.registry.keepOnly(opened.host.client, []);
    expect(opened.registry.shown(threadA)).toBeUndefined();
    opened.show(threadA);
    await waitFor(() => expect(opened.registry.get(threadA)?.pendingDraft).toBe("Bounced prompt"));
    act(() => opened.registry.get(threadA)?.setPendingDraft(""));
  });

  it("keeps the draft typed in each thread across a switch", async () => {
    const opened = await openBoth();
    act(() => opened.registry.get(threadB)?.setPendingDraft("Half a thought"));
    opened.show(threadA);
    expect(screen.queryByText("Half a thought")).toBeNull();
    opened.show(threadB);
    expect(opened.registry.get(threadB)?.pendingDraft).toBe("Half a thought");
    act(() => opened.registry.get(threadB)?.setPendingDraft(""));
  });

  it("keeps only the threads left most recently", () => {
    const registry = createCodeThreadControllers();
    const ids = Array.from(
      { length: 12 },
      (_, index) => `10000000-0000-4000-8000-0000000001${String(index + 10)}` as CodeThreadId,
    );
    for (const id of ids) {
      registry.publish(id, {
        keepThread: () => ({ view: { thread: { id } }, conversation: [] }),
      } as never);
      registry.release(id);
    }
    expect(ids.filter((id) => registry.shown(id) !== undefined)).toEqual(ids.slice(-8));
  });

  it.each([
    [
      "the host no longer lists it",
      (): { navigationBootstrap: CodeBootstrap } => ({
        navigationBootstrap: { ...bootstrap(), threads: bootstrap().threads.slice(1) },
      }),
    ],
    ["the window moves to another host", () => ({ client: conversingHost(new Map()).client })],
  ])("lets go of what a left thread showed when %s", async (_, change) => {
    const opened = await openBoth();
    expect(opened.registry.shown(threadA)).toBeDefined();
    opened.show(threadB, change());
    await waitFor(() => expect(opened.registry.shown(threadA)).toBeUndefined());
  });
});
