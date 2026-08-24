import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import {
  decodeChatBootstrap,
  decodeChatNavigation,
  decodeChatCommandResult,
  decodeChatEventFrame,
  decodeChatThreadId,
  decodeChatThreadView,
} from "@octant/contracts/chat";
import type { ChatEventFrame, ChatThreadId, ChatThreadView } from "@octant/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptChatEventFrame,
  createChatReadCursorStore,
  useChatController,
} from "./useChatController";
import { createComposerThreadDraftStore } from "../composer/composerThreadDraftStore";

const capability = "A".repeat(43);
const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000802");
const otherThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000803");
const now = "2026-07-19T12:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

const bootstrap = () =>
  decodeChatBootstrap({
    settings: {
      defaultProviderInstanceId: "10000000-0000-4000-8000-000000000001",
      defaultModelId: "model-a",
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Be calm.",
      version: 1,
      updatedAt: now,
    },
    threads: [
      {
        id: threadId,
        title: "Planning",
        lifecycle: "active",
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherThreadId,
        title: "Research",
        lifecycle: "active",
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

function threadView(sequence: number, followUpOpen = false): ChatThreadView {
  return decodeChatThreadView({
    thread: bootstrap().threads[0]!,
    turns: [],
    lastSequence: sequence,
    contents: [],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: followUpOpen ? 1 : 0,
    ...(followUpOpen
      ? {
          followUp: {
            threadId,
            state: "open",
            origin: "manual",
            reason: "Review the plan.",
            triggerSequence: 1,
            acknowledgedThroughSequence: 0,
            createdAt: now,
          },
        }
      : {}),
  });
}

function frame(sequence: number, thread = threadId): ChatEventFrame {
  return decodeChatEventFrame({
    threadId: thread,
    sequence,
    event: {
      kind: "thread-updated",
      thread: { ...bootstrap().threads[0]!, version: sequence, updatedAt: now },
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("useChatController", () => {
  it("shares read cursors without sharing active views across controllers", async () => {
    const readCursorStore = createChatReadCursorStore();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      navigation: vi.fn(async () =>
        decodeChatNavigation({
          threads: bootstrap().threads.map((thread, index) => ({
            id: thread.id,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            updatedAt: thread.updatedAt,
            lastSequence: index === 0 ? 5 : 7,
            followUpOpen: true,
          })),
        }),
      ),
      thread: vi.fn(async (requestedThreadId) =>
        decodeChatThreadView({
          ...threadView(String(requestedThreadId) === String(threadId) ? 5 : 7, true),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      ),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() => ({
      sidebar: useChatController({ client, readCursorStore }),
      firstTab: useChatController({ activeThreadId: threadId, client, readCursorStore }),
      secondTab: useChatController({ activeThreadId: otherThreadId, client, readCursorStore }),
    }));

    await waitFor(() => expect(result.current.firstTab.activeView?.thread.id).toBe(threadId));
    await waitFor(() => expect(result.current.secondTab.activeView?.thread.id).toBe(otherThreadId));
    await waitFor(() =>
      expect(result.current.sidebar.navigation).toEqual([
        {
          followUp: true,
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          threadId: String(threadId),
          title: "Planning",
          unread: false,
          updatedAt: now,
        },
        {
          followUp: true,
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          threadId: String(otherThreadId),
          title: "Research",
          unread: false,
          updatedAt: now,
        },
      ]),
    );
    expect(result.current.firstTab.activeView?.thread.id).toBe(threadId);
    expect(result.current.secondTab.activeView?.thread.id).toBe(otherThreadId);
  });

  it("bootstraps once and exposes unread separately from durable follow-up", async () => {
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      navigation: vi.fn(async () =>
        decodeChatNavigation({
          threads: bootstrap().threads.map((thread, index) => ({
            id: thread.id,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            updatedAt: thread.updatedAt,
            lastSequence: index === 0 ? 2 : 3,
            followUpOpen: index === 0,
          })),
        }),
      ),
      thread: vi.fn(async (requestedThreadId) =>
        String(requestedThreadId) === String(threadId)
          ? threadView(2, true)
          : decodeChatThreadView({
              ...threadView(3),
              thread: bootstrap().threads[1]!,
            }),
      ),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(client.bootstrap).toHaveBeenCalledTimes(1);
    expect(result.current.navigation).toEqual([
      {
        followUp: true,
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        threadId: String(threadId),
        title: "Planning",
        unread: false,
        updatedAt: now,
      },
      {
        followUp: false,
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        threadId: String(otherThreadId),
        title: "Research",
        unread: true,
        updatedAt: now,
      },
    ]);
  });

  it("uses the authoritative thread view timestamp after later activity", async () => {
    const later = "2026-08-14T16:00:00.000Z";
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      navigation: vi.fn(async () =>
        decodeChatNavigation({
          threads: bootstrap().threads.map((thread, index) => ({
            id: thread.id,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            updatedAt: index === 0 ? later : thread.updatedAt,
            lastSequence: index === 0 ? 4 : 3,
            followUpOpen: index === 0,
          })),
        }),
      ),
      thread: vi.fn(async (requestedThreadId) =>
        String(requestedThreadId) === String(threadId)
          ? decodeChatThreadView({
              ...threadView(4, true),
              thread: { ...bootstrap().threads[0]!, updatedAt: later, version: 2 },
            })
          : decodeChatThreadView({
              ...threadView(3),
              thread: bootstrap().threads[1]!,
            }),
      ),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      result.current.navigation.find((item) => item.threadId === String(threadId)),
    ).toMatchObject({
      updatedAt: later,
    });
    expect(
      result.current.navigation.find((item) => item.threadId === String(otherThreadId)),
    ).toMatchObject({
      updatedAt: now,
    });
  });

  it("refreshes inactive thread summaries without marking them read", async () => {
    let otherSequence = 0;
    let otherFollowUp = false;
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      navigation: vi.fn(async () =>
        decodeChatNavigation({
          threads: bootstrap().threads.map((thread, index) => ({
            id: thread.id,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            updatedAt: thread.updatedAt,
            lastSequence: index === 0 ? 0 : otherSequence,
            followUpOpen: index === 0 ? false : otherFollowUp,
          })),
        }),
      ),
      thread: vi.fn(async (requestedThreadId) =>
        String(requestedThreadId) === String(threadId)
          ? threadView(0)
          : decodeChatThreadView({
              ...threadView(otherSequence, otherFollowUp),
              thread: bootstrap().threads[1]!,
            }),
      ),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() =>
      useChatController({
        client,
        navigationRefreshMs: 10,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(result.current.navigation[1]?.unread).toBe(false));
    expect(client.thread).not.toHaveBeenCalled();

    otherSequence = 3;
    otherFollowUp = true;

    await waitFor(() =>
      expect(result.current.navigation[1]).toMatchObject({ followUp: true, unread: true }),
    );
    expect(client.thread).not.toHaveBeenCalled();
  });

  it("pauses inactive-thread polling while the document is hidden", async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    try {
      const threadRead = vi.fn(async (requestedThreadId: ChatThreadId) =>
        decodeChatThreadView({
          ...threadView(1),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      );
      const client = createMockClient({
        bootstrap: vi.fn(async () => bootstrap()),
        navigation: vi.fn(async () =>
          decodeChatNavigation({
            threads: bootstrap().threads.map((thread) => ({
              id: thread.id,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              updatedAt: thread.updatedAt,
              lastSequence: 1,
              followUpOpen: false,
            })),
          }),
        ),
        thread: threadRead,
        subscribe: vi.fn(async function* () {}),
      });
      const { unmount } = renderHook(() =>
        useChatController({
          client,
          navigationRefreshMs: 10,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      );

      await waitFor(() => expect(client.bootstrap).toHaveBeenCalledOnce());
      expect(threadRead).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(client.navigation).toHaveBeenCalled());
      unmount();
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: originalVisibility,
      });
    }
  });

  it("keeps the last authoritative navigation facts when a refresh fails", async () => {
    const navigation = vi
      .fn()
      .mockResolvedValueOnce(
        decodeChatNavigation({
          threads: [
            {
              id: threadId,
              title: "Planning",
              providerInstanceId: "10000000-0000-4000-8000-000000000001",
              updatedAt: now,
              lastSequence: 2,
              followUpOpen: true,
            },
          ],
        }),
      )
      .mockRejectedValue(new Error("navigation unavailable"));
    const client = createMockClient({
      bootstrap: vi.fn(async () =>
        decodeChatBootstrap({ ...bootstrap(), threads: [bootstrap().threads[0]!] }),
      ),
      navigation,
      thread: vi.fn(async () => threadView(0)),
      subscribe: vi.fn(async function* () {}),
    });
    const { result, unmount } = renderHook(() =>
      useChatController({
        client,
        navigationRefreshMs: 10,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.navigation[0]).toMatchObject({ followUp: true }));
    await waitFor(() => expect(navigation.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.navigation[0]).toMatchObject({ followUp: true, unread: true });
    unmount();
  });

  it("holds a thread the user marked unread until they explicitly read it again", async () => {
    // With no sequence advanced this sitting, dropping the cursor alone leaves
    // the comparison at zero-over-zero and the click does visibly nothing.
    const readCursorStore = createChatReadCursorStore();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      navigation: vi.fn(async () =>
        decodeChatNavigation({
          threads: bootstrap().threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            updatedAt: thread.updatedAt,
            lastSequence: 0,
            followUpOpen: false,
          })),
        }),
      ),
      thread: vi.fn(async () => threadView(0)),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() => useChatController({ client, readCursorStore }));
    await waitFor(() => expect(result.current.navigation[0]?.unread).toBe(false));

    act(() => readCursorStore.unmark(threadId));
    await waitFor(() => expect(result.current.navigation[0]?.unread).toBe(true));

    act(() => result.current.markThreadRead(threadId));
    await waitFor(() => expect(result.current.navigation[0]?.unread).toBe(false));
  });

  it("cancels inactive-thread refresh scheduling on unmount", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<ChatThreadView>();
      const client = createMockClient({
        bootstrap: vi.fn(async () =>
          decodeChatBootstrap({ ...bootstrap(), threads: [bootstrap().threads[0]!] }),
        ),
        navigation: vi.fn(async () =>
          decodeChatNavigation({
            threads: [
              {
                id: threadId,
                title: "Planning",
                providerInstanceId: "10000000-0000-4000-8000-000000000001",
                updatedAt: now,
                lastSequence: 0,
                followUpOpen: false,
              },
            ],
          }),
        ),
        thread: vi.fn(() => pending.promise),
        subscribe: vi.fn(async function* () {}),
      });
      const { unmount } = renderHook(() =>
        useChatController({
          client,
          navigationRefreshMs: 10,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      );
      await act(async () => Promise.resolve());
      expect(client.navigation).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(client.navigation).toHaveBeenCalledTimes(1);
      pending.resolve(threadView(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes after the authoritative snapshot cursor and refetches on stream gaps", async () => {
    let snapshotSequence = 1;
    const subscribe = vi
      .fn()
      .mockImplementationOnce(async function* () {
        snapshotSequence = 3;
        yield frame(3);
      })
      .mockImplementation(async function* () {});
    const thread = vi.fn(async () => threadView(snapshotSequence));
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread,
      subscribe,
      execute: vi.fn(),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.activeView?.lastSequence).toBe(3));
    expect(subscribe).toHaveBeenCalledWith(threadId, 1, expect.any(AbortSignal));
    expect(thread.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.activeView?.turns).toEqual([]);
  });

  it("reconnects after a finite clean replay so later frames are observed", async () => {
    let snapshotSequence = 1;
    const subscribe = vi
      .fn()
      .mockImplementationOnce(async function* () {})
      .mockImplementationOnce(async function* (_threadId, _cursor, signal: AbortSignal) {
        snapshotSequence = 2;
        yield frame(2);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      });
    const thread = vi.fn(async () => threadView(snapshotSequence));
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread,
      subscribe,
    });
    const { result, unmount } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        reconnectDelayMs: 0,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.activeView?.lastSequence).toBe(2));
    expect(subscribe).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps catching up after a failed snapshot instead of freezing the thread", async () => {
    const subscribe = vi
      .fn()
      .mockImplementationOnce(async function* () {
        throw new Error("Event stream dropped.");
      })
      .mockImplementation(async function* (_threadId, _cursor, signal: AbortSignal) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      });
    const thread = vi
      .fn()
      .mockResolvedValueOnce(threadView(1))
      .mockRejectedValueOnce(new Error("Octant Chat service is unavailable."))
      .mockResolvedValue(threadView(5));
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread,
      subscribe,
    });
    const { result, unmount } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        reconnectDelayMs: 0,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.activeView?.lastSequence).toBe(5));
    expect(result.current.status).toBe("ready");
    expect(thread.mock.calls.length).toBeGreaterThanOrEqual(3);
    unmount();
  });

  it("does not refetch an unchanged thread after a finite empty replay", async () => {
    const client = createMockClient({
      bootstrap: vi.fn(async () => decodeChatBootstrap({ ...bootstrap(), threads: [] })),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
    });
    const { result, unmount } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(client.thread).toHaveBeenCalledOnce();
    unmount();
  });

  it("aborts the previous stream when the active thread changes", async () => {
    const subscribe = vi.fn(async function* (_threadId, _afterSequence, signal: AbortSignal) {
      if (signal.aborted) return;
      yield* [];
    });
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe,
    });
    const { rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    const firstSignal = subscribe.mock.calls[0]![2] as AbortSignal;
    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
  });

  it("clears the previous view while a newly selected thread is loading", async () => {
    const pendingOther = deferred<ChatThreadView>();
    const client = createMockClient({
      bootstrap: vi.fn(async () =>
        decodeChatBootstrap({ ...bootstrap(), threads: [bootstrap().threads[0]!] }),
      ),
      thread: vi.fn(async (requestedThreadId) =>
        String(requestedThreadId) === String(threadId) ? threadView(1) : pendingOther.promise,
      ),
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));

    rerender({ activeThreadId: otherThreadId });
    expect(result.current.activeView).toBeUndefined();
    expect(await result.current.sendTurn("must not reach the old thread")).toBe(false);
    pendingOther.resolve(
      decodeChatThreadView({ ...threadView(1), thread: bootstrap().threads[1]! }),
    );
  });

  it("does not reactivate an old thread or erase a newer draft when a send resolves late", async () => {
    const pendingExecute = deferred<Awaited<ReturnType<ChatClient["execute"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async (requestedThreadId) =>
        decodeChatThreadView({
          ...threadView(1),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      ),
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
      execute: vi.fn(() => pendingExecute.promise),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));

    let send!: Promise<boolean>;
    act(() => {
      send = result.current.sendTurn("original draft");
    });
    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(otherThreadId));
    act(() => result.current.setPendingDraft("newer draft"));
    pendingExecute.resolve(
      decodeChatCommandResult({
        kind: "turn-created",
        turn: {
          id: "00000000-0000-4000-8000-000000000901",
          threadId,
          sequence: 1,
          userMessageRef: {
            contentId: "00000000-0000-4000-8000-000000000902",
            digest: "a".repeat(64),
            byteLength: 1,
          },
          attachmentIds: [],
          attempts: [],
          createdAt: now,
        },
      }),
    );
    await act(async () => expect(await send).toBe(true));

    expect(result.current.activeView?.thread.id).toBe(otherThreadId);
    expect(result.current.pendingDraft).toBe("newer draft");
  });

  it("does not reactivate an old thread when its attachment upload resolves late", async () => {
    const pendingUpload = deferred<Awaited<ReturnType<ChatClient["upload"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async (requestedThreadId) =>
        decodeChatThreadView({
          ...threadView(1),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      ),
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
      upload: vi.fn(() => pendingUpload.promise),
      discard: vi.fn(),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));

    let upload!: Promise<Awaited<ReturnType<ChatClient["upload"]>>>;
    act(() => {
      upload = result.current.upload({
        threadId,
        attachmentId: "00000000-0000-4000-8000-000000000904" as never,
        displayName: "diagram.png",
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      });
    });
    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(otherThreadId));
    pendingUpload.resolve({
      id: "00000000-0000-4000-8000-000000000904" as never,
      threadId,
      displayName: "diagram.png",
      mediaType: "image/png",
      byteLength: 1,
      digest: "a".repeat(64) as never,
      status: "finalized",
      createdAt: now as never,
    });
    await act(async () => void (await upload));

    expect(result.current.activeView?.thread.id).toBe(otherThreadId);
  });

  it("awaits the active-thread refresh before resolving an attachment upload", async () => {
    const refreshed = deferred<ChatThreadView>();
    const threadRead = vi.fn<ChatClient["thread"]>().mockResolvedValue(threadView(1));
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: threadRead,
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
      upload: vi.fn(async (input) => ({
        id: input.attachmentId,
        threadId: input.threadId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64) as never,
        status: "finalized" as const,
        createdAt: now as never,
      })),
      discard: vi.fn(),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));
    threadRead.mockClear();
    threadRead.mockImplementationOnce(() => refreshed.promise).mockResolvedValue(threadView(2));

    let settled = false;
    const upload = result.current
      .upload({
        threadId,
        attachmentId: "00000000-0000-4000-8000-000000000906" as never,
        displayName: "diagram.png",
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      })
      .finally(() => {
        settled = true;
      });
    await waitFor(() => expect(threadRead.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(settled).toBe(false);
    refreshed.resolve(
      decodeChatThreadView({
        ...threadView(2),
        thread: { ...threadView(2).thread, version: 2 },
      }),
    );
    await act(async () => void (await upload));
    expect(result.current.activeView?.thread.version).toBe(2);
  });

  it("does not surface a late old-thread send failure on the newly active thread", async () => {
    const pendingExecute = deferred<Awaited<ReturnType<ChatClient["execute"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async (requestedThreadId) =>
        decodeChatThreadView({
          ...threadView(1),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      ),
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
      execute: vi.fn(() => pendingExecute.promise),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));

    let send!: Promise<boolean>;
    act(() => {
      send = result.current.sendTurn("old thread request");
    });
    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(otherThreadId));
    pendingExecute.reject(new Error("old thread failed"));
    await act(async () => expect(await send).toBe(false));

    expect(result.current.errorMessage).toBeUndefined();
    expect(result.current.activeView?.thread.id).toBe(otherThreadId);
  });

  it("does not surface a late old-thread upload failure on the newly active thread", async () => {
    const pendingUpload = deferred<Awaited<ReturnType<ChatClient["upload"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async (requestedThreadId) =>
        decodeChatThreadView({
          ...threadView(1),
          thread:
            String(requestedThreadId) === String(threadId)
              ? bootstrap().threads[0]!
              : bootstrap().threads[1]!,
        }),
      ),
      subscribe: vi.fn(async function* (_threadId, _cursor, signal: AbortSignal) {
        yield* [];
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }),
      upload: vi.fn(() => pendingUpload.promise),
      discard: vi.fn(),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));

    let upload!: Promise<Awaited<ReturnType<ChatClient["upload"]>>>;
    act(() => {
      upload = result.current.upload({
        threadId,
        attachmentId: "00000000-0000-4000-8000-000000000905" as never,
        displayName: "diagram.png",
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      });
    });
    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(otherThreadId));
    pendingUpload.reject(new Error("old upload failed"));
    await act(async () => expect(upload).rejects.toThrow("old upload failed"));

    expect(result.current.errorMessage).toBeUndefined();
    expect(result.current.activeView?.thread.id).toBe(otherThreadId);
  });

  it("clears the composer as soon as send starts and restores the text if send fails", async () => {
    const pendingExecute = deferred<Awaited<ReturnType<ChatClient["execute"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(() => pendingExecute.promise),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.setPendingDraft("hva er klokken?");
    });
    let send!: Promise<boolean>;
    act(() => {
      send = result.current.sendTurn("hva er klokken?");
    });
    expect(result.current.pendingDraft).toBe("");

    pendingExecute.reject(new Error("transport failed"));
    await act(async () => expect(await send).toBe(false));
    expect(result.current.pendingDraft).toBe("hva er klokken?");
  });

  it("keeps an explicit clear while a send is still pending", async () => {
    const pendingExecute = deferred<Awaited<ReturnType<ChatClient["execute"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(() => pendingExecute.promise),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.setPendingDraft("hva er klokken?");
    });
    let send!: Promise<boolean>;
    act(() => {
      send = result.current.sendTurn("hva er klokken?");
    });
    act(() => {
      result.current.setPendingDraft("replacement");
      result.current.setPendingDraft("");
    });

    pendingExecute.reject(new Error("transport failed"));
    await act(async () => expect(await send).toBe(false));
    expect(result.current.pendingDraft).toBe("");
  });

  it("keeps the dropped-context warning when a failed send restores the draft", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    const pendingExecute = deferred<Awaited<ReturnType<ChatClient["execute"]>>>();
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(() => pendingExecute.promise),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.setPendingDraft("retry with attachments");
      result.current.markDraftStagedDropped();
    });
    expect(result.current.draftStagedDropped).toBe(true);
    let send!: Promise<boolean>;
    act(() => {
      send = result.current.sendTurn("retry with attachments");
    });

    pendingExecute.reject(new Error("transport failed"));
    await act(async () => expect(await send).toBe(false));
    expect(result.current.pendingDraft).toBe("retry with attachments");
    expect(result.current.draftStagedDropped).toBe(true);
  });

  it("keeps composer draft text on failed sends and clears it after success", async () => {
    const attachmentId = "00000000-0000-4000-8000-000000000906" as never;
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce({
        kind: "turn-created",
        turn: {
          id: "00000000-0000-4000-8000-000000000901",
          threadId,
          sequence: 1,
          userMessageRef: {
            contentId: "00000000-0000-4000-8000-000000000902",
            digest: "a".repeat(64),
            byteLength: 1,
          },
          attachmentIds: [],
          attempts: [],
          createdAt: now,
        },
      });
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute,
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.sendTurn("draft stays");
    });
    expect(result.current.pendingDraft).toBe("draft stays");
    await act(async () => {
      await result.current.sendTurn(
        "draft stays",
        [attachmentId],
        [],
        [],
        [
          {
            kind: "plugin",
            extensionId: "30000000-0000-4000-8000-000000000001" as never,
            packageId: "31000000-0000-4000-8000-000000000001" as never,
            componentId: "instructions" as never,
            packageVersion: "1.2.3" as never,
            packageDigest: `sha256:${"a".repeat(64)}` as never,
            catalogEpoch: `sha256:${"c".repeat(64)}` as never,
            origin: { kind: "draft", reference: "draft-1" },
          },
        ],
      );
    });
    expect(result.current.pendingDraft).toBe("");
    expect(execute).toHaveBeenLastCalledWith({
      kind: "send-chat-turn",
      threadId,
      expectedVersion: threadView(1).thread.version,
      prompt: "draft stays",
      attachmentIds: [attachmentId],
      extensionSelections: [
        {
          kind: "plugin",
          extensionId: "30000000-0000-4000-8000-000000000001",
          packageId: "31000000-0000-4000-8000-000000000001",
          componentId: "instructions",
          packageVersion: "1.2.3",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"c".repeat(64)}`,
          origin: { kind: "draft", reference: "draft-1" },
        },
      ],
    });
  });

  it("returns the authoritative command result for exact new-thread navigation", async () => {
    const created = { kind: "thread-created" as const, thread: bootstrap().threads[1]! };
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => created),
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    let commandResult;
    await act(async () => {
      commandResult = await result.current.execute({
        kind: "create-chat-thread",
        title: "New chat",
        hostId: "local" as never,
      });
    });
    expect(commandResult).toEqual(created);
  });

  it("reloads the thread list when branching the active thread mints a new one", async () => {
    const branch = { kind: "thread-created" as const, thread: bootstrap().threads[1]! };
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => branch),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(client.bootstrap).toHaveBeenCalledTimes(1);
    let commandResult;
    await act(async () => {
      commandResult = await result.current.execute({
        kind: "branch-chat-thread",
        threadId,
        expectedVersion: 1 as never,
        turnId: "00000000-0000-4000-8000-000000000899" as never,
        title: "Planning (branch)",
      });
    });

    expect(commandResult).toEqual(branch);
    // The branch is not the command's target thread, so reactivating the
    // target alone cannot surface it; the thread list must reload too.
    await waitFor(() => expect(client.bootstrap).toHaveBeenCalledTimes(2));
  });

  it("updates Chat defaults only through the authoritative settings command result", async () => {
    const current = bootstrap();
    const updated = decodeChatBootstrap({
      ...current,
      settings: {
        ...current.settings,
        defaultResearchEnabled: true,
        defaultResearchRouting: "searxng",
        version: 2,
      },
    });
    const client = createMockClient({
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockRejectedValue(new Error("reload failed")),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => ({
        kind: "settings-updated" as const,
        settings: updated.settings,
      })),
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );
    await waitFor(() => expect(result.current.bootstrap).toEqual(current));

    const command = {
      kind: "update-chat-settings" as const,
      expectedVersion: current.settings.version,
      defaultProviderInstanceId: current.settings.defaultProviderInstanceId,
      defaultModelId: current.settings.defaultModelId,
      defaultResearchEnabled: true,
      defaultResearchRouting: "searxng" as const,
      defaultPersonalityInstructions: current.settings.defaultPersonalityInstructions,
    };
    await act(async () => expect(await result.current.updateSettings(command)).toBe(true));

    expect(client.execute).toHaveBeenCalledWith(command);
    await waitFor(() => expect(result.current.bootstrap?.settings).toEqual(updated.settings));
    expect(client.bootstrap).toHaveBeenCalledOnce();
  });

  it("does not let a second immediate defaults change race the first", async () => {
    const current = bootstrap();
    let version = current.settings.version as unknown as number;
    const seen: Array<{ modelId: string; expectedVersion: number }> = [];
    const client = createMockClient({
      bootstrap: vi.fn(async () => current),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async (command) => {
        if (command.kind !== "update-chat-settings") throw new Error("unexpected command");
        const expected = command.expectedVersion as unknown as number;
        seen.push({ modelId: String(command.defaultModelId), expectedVersion: expected });
        if (expected !== version) throw new Error(`conflict: expected ${String(version)}`);
        version += 1;
        return {
          kind: "settings-updated" as const,
          settings: decodeChatBootstrap({
            ...current,
            settings: { ...current.settings, defaultModelId: command.defaultModelId, version },
          }).settings,
        };
      }),
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );
    await waitFor(() => expect(result.current.bootstrap).toEqual(current));

    const command = (modelId: string) => ({
      kind: "update-chat-settings" as const,
      expectedVersion: current.settings.version,
      defaultProviderInstanceId: current.settings.defaultProviderInstanceId,
      defaultModelId: modelId as never,
      defaultResearchEnabled: current.settings.defaultResearchEnabled,
      defaultResearchRouting: current.settings.defaultResearchRouting,
      defaultPersonalityInstructions: current.settings.defaultPersonalityInstructions,
    });

    // Two picks before the first returns. Both are built from the same render,
    // so without a queue they claim the same version and the server rejects the
    // second — leaving whichever arrived first, not the model chosen last.
    await act(async () => {
      const first = result.current.updateSettings(command("model-b"));
      const second = result.current.updateSettings(command("model-c"));
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });

    expect(seen).toEqual([
      { modelId: "model-b", expectedVersion: 1 },
      { modelId: "model-c", expectedVersion: 2 },
    ]);
    await waitFor(() => expect(result.current.bootstrap?.settings.defaultModelId).toBe("model-c"));
  });

  it("stands down a queued defaults write once another window has won", async () => {
    const current = bootstrap();
    const elsewhere = decodeChatBootstrap({
      ...current,
      settings: {
        ...current.settings,
        defaultPersonalityInstructions: "Be blunt.",
        version: 2,
      },
    });
    const execute = vi.fn(async () => {
      throw new ChatClientFailure({ category: "stale", message: "Settings changed." });
    });
    const client = createMockClient({
      bootstrap: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(elsewhere),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute,
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );
    await waitFor(() => expect(result.current.bootstrap).toEqual(current));

    const command = (modelId: string) => ({
      kind: "update-chat-settings" as const,
      expectedVersion: current.settings.version,
      defaultProviderInstanceId: current.settings.defaultProviderInstanceId,
      defaultModelId: modelId as never,
      defaultResearchEnabled: current.settings.defaultResearchEnabled,
      defaultResearchRouting: current.settings.defaultResearchRouting,
      defaultPersonalityInstructions: current.settings.defaultPersonalityInstructions,
    });

    await act(async () => {
      const first = result.current.updateSettings(command("model-b"));
      const second = result.current.updateSettings(command("model-c"));
      expect(await first).toBe(false);
      expect(await second).toBe(false);
    });

    // The command carries the whole settings record. Re-stamping the second one
    // with the reloaded version would get it accepted, putting this window's
    // pre-conflict personality back over the one the other window just wrote.
    expect(execute).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(result.current.bootstrap?.settings.defaultPersonalityInstructions).toBe("Be blunt."),
    );
  });

  it("surfaces a stale Chat defaults conflict after loading authoritative values", async () => {
    const current = bootstrap();
    const updated = decodeChatBootstrap({
      ...current,
      settings: { ...current.settings, version: 2, defaultResearchEnabled: true },
    });
    const client = createMockClient({
      bootstrap: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(updated),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => {
        throw new ChatClientFailure({ category: "stale", message: "Settings changed." });
      }),
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );
    await waitFor(() => expect(result.current.bootstrap).toEqual(current));

    await act(async () =>
      expect(
        await result.current.updateSettings({
          kind: "update-chat-settings",
          expectedVersion: current.settings.version,
          defaultProviderInstanceId: current.settings.defaultProviderInstanceId,
          defaultModelId: current.settings.defaultModelId,
          defaultResearchEnabled: true,
          defaultResearchRouting: current.settings.defaultResearchRouting,
          defaultPersonalityInstructions: current.settings.defaultPersonalityInstructions,
        }),
      ).toBe(false),
    );

    await waitFor(() => expect(result.current.bootstrap?.settings).toEqual(updated.settings));
    expect(result.current.settingsMessage).toMatch(
      /changed elsewhere.*review them and save again/i,
    );
  });

  it("requires reconnect when stale Chat defaults cannot be reloaded", async () => {
    const current = bootstrap();
    const client = createMockClient({
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockRejectedValueOnce(new Error("reload unavailable")),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => {
        throw new ChatClientFailure({ category: "stale", message: "Settings changed." });
      }),
    });
    const { result } = renderHook(() =>
      useChatController({ client, serverUrl: "http://127.0.0.1", windowCapability: capability }),
    );
    await waitFor(() => expect(result.current.bootstrap).toEqual(current));

    await act(async () =>
      expect(
        await result.current.updateSettings({
          kind: "update-chat-settings",
          expectedVersion: current.settings.version,
          defaultProviderInstanceId: current.settings.defaultProviderInstanceId,
          defaultModelId: current.settings.defaultModelId,
          defaultResearchEnabled: true,
          defaultResearchRouting: current.settings.defaultResearchRouting,
          defaultPersonalityInstructions: current.settings.defaultPersonalityInstructions,
        }),
      ).toBe(false),
    );

    expect(result.current.bootstrap).toEqual(current);
    expect(result.current.status).toBe("disconnected");
    expect(result.current.settingsMessage).toMatch(/could not be reloaded.*reconnect/i);
    expect(result.current.settingsMessage).not.toMatch(/values were loaded/i);
  });

  it("rejects regressed and cross-thread frames without shadowing durable state", () => {
    expect(acceptChatEventFrame(frame(2), threadId, 1)).toBe(true);
    expect(acceptChatEventFrame(frame(1), threadId, 1)).toBe(false);
    expect(acceptChatEventFrame(frame(3), threadId, 1)).toBe(true);
    expect(acceptChatEventFrame(frame(1), threadId, 2)).toBe(false);
    expect(
      acceptChatEventFrame(
        { ...frame(2), sequence: Number.POSITIVE_INFINITY as never },
        threadId,
        1,
      ),
    ).toBe(false);
    expect(acceptChatEventFrame(frame(2, otherThreadId), threadId, 1)).toBe(false);
  });

  it("restores Chat text and caret after leaving the thread", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async (requested) =>
        String(requested) === String(threadId)
          ? threadView(1)
          : decodeChatThreadView({
              ...threadView(1),
              thread: bootstrap().threads[1]!,
            }),
      ),
      subscribe: vi.fn(async function* () {}),
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useChatController({
          activeThreadId,
          client,
          draftStore: store,
          reconnectDelayMs: 60_000,
          serverUrl: "http://127.0.0.1",
          windowCapability: capability,
        }),
      { initialProps: { activeThreadId: threadId } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(threadId));
    act(() => result.current.setPendingDraft("half-written plan", 4));

    rerender({ activeThreadId: otherThreadId });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(otherThreadId));
    expect(result.current.pendingDraft).toBe("");

    rerender({ activeThreadId: threadId });
    await waitFor(() => expect(result.current.pendingDraft).toBe("half-written plan"));
    expect(result.current.pendingDraftCaret).toBe(4);
  });

  it("restores a Chat draft after the controller remounts", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
    });
    const first = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => first.result.current.setPendingDraft("survives restart", 3));
    first.unmount();

    const second = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(second.result.current.pendingDraft).toBe("survives restart"));
    expect(second.result.current.pendingDraftCaret).toBe(3);
    second.unmount();
  });

  it("does not restore a Chat draft after a successful send", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => ({
        kind: "turn-created" as const,
        turn: {
          id: "00000000-0000-4000-8000-000000000901",
          threadId,
          sequence: 1,
          userMessageRef: {
            contentId: "00000000-0000-4000-8000-000000000902",
            digest: "a".repeat(64),
            byteLength: 1,
          },
          attachmentIds: [],
          attempts: [],
          createdAt: now,
        },
      })) as never,
    });
    const { result, unmount } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.setPendingDraft("send this"));
    await act(async () => {
      await result.current.sendTurn("send this");
    });
    expect(result.current.pendingDraft).toBe("");
    unmount();

    const remounted = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    expect(remounted.result.current.pendingDraft).toBe("");
    remounted.unmount();
  });

  it("removes a Chat draft when the thread is deleted", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    const client = createMockClient({
      bootstrap: vi.fn(async () => bootstrap()),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
      execute: vi.fn(async () => ({
        kind: "deleted" as const,
        threadId,
        deletedAt: now,
      })) as never,
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.setPendingDraft("do not keep"));
    await act(async () => {
      await result.current.execute({
        kind: "delete-chat-thread",
        threadId,
        expectedVersion: threadView(1).thread.version,
      });
    });
    expect(result.current.pendingDraft).toBe("");
    expect(store.read("chat", String(threadId))).toBeUndefined();
  });

  it("purges a Chat draft when bootstrap no longer lists the thread", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("chat", String(threadId), {
      text: "do not keep",
      caretIndex: 0,
      stagedDropped: false,
    });
    const empty = { ...bootstrap(), threads: [] };
    const client = createMockClient({
      bootstrap: vi.fn(async () => empty),
      thread: vi.fn(async () => threadView(1)),
      subscribe: vi.fn(async function* () {}),
    });
    const { result } = renderHook(() =>
      useChatController({
        activeThreadId: threadId,
        client,
        draftStore: store,
        reconnectDelayMs: 60_000,
        serverUrl: "http://127.0.0.1",
        windowCapability: capability,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(store.read("chat", String(threadId))).toBeUndefined();
  });
});

function memoryDraftStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function createMockClient(
  overrides: Partial<ChatClient> & Pick<ChatClient, "bootstrap" | "thread" | "subscribe">,
): ChatClient {
  return {
    search: vi.fn(async () => []),
    navigation: vi.fn(async () => ({ threads: [] })),
    execute: vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: bootstrap().threads[0]!,
    })),
    upload: vi.fn(),
    discard: vi.fn(),
    ...overrides,
  };
}
