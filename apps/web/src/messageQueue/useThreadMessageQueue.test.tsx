import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeMentionableThreadId, type ThreadMessageQueueResult } from "@octant/contracts";
import { useThreadMessageQueue } from "./useThreadMessageQueue";
import { createComposerThreadDraftStore } from "../composer/composerThreadDraftStore";
import { readQueueReceipts } from "./threadMessageQueueReceipts";
import { queueTestHost } from "./queueTestHost.test-fixture";

const threadId = "11111111-1111-4111-8111-111111111111";
describe("host-owned follow-up queues", () => {
  it.each(["chat", "work", "code"] as const)(
    "reads the %s queue after reconnect and never dispatches on unmount",
    async (mode) => {
      const host = queueTestHost();
      const first = renderHook(() => useThreadMessageQueue({ mode, threadId, client: host }));
      const second = renderHook(() => useThreadMessageQueue({ mode, threadId, client: host }));
      await waitFor(() =>
        expect(first.result.current.available && second.result.current.available).toBe(true),
      );
      await act(async () => {
        expect(await first.result.current.enqueue({ mode, prompt: "First" })).toBe("accepted");
      });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      await waitFor(() => expect(second.result.current.snapshot?.items).toHaveLength(1));
      await act(async () => {
        expect(await second.result.current.enqueue({ mode, prompt: "Second" })).toBe("accepted");
      });
      first.unmount();
      second.unmount();
      expect(host.execute).toHaveBeenCalledTimes(2);
      const reopened = renderHook(() => useThreadMessageQueue({ mode, threadId, client: host }));
      await waitFor(() =>
        expect(reopened.result.current.snapshot?.items.map((item) => item.payload?.prompt)).toEqual(
          ["First", "Second"],
        ),
      );
      expect(host.execute).toHaveBeenCalledTimes(2);
    },
  );

  it("refreshes on a version conflict without acknowledging the caller's draft", async () => {
    const host = queueTestHost();
    const first = renderHook(() => useThreadMessageQueue({ mode: "chat", threadId, client: host }));
    const second = renderHook(() =>
      useThreadMessageQueue({ mode: "chat", threadId, client: host }),
    );
    await waitFor(() =>
      expect(first.result.current.available && second.result.current.available).toBe(true),
    );
    await act(async () => {
      await first.result.current.enqueue({ mode: "chat", prompt: "First" });
    });
    const accepted = vi.fn();
    await act(async () => {
      expect(
        await second.result.current.enqueue({ mode: "chat", prompt: "Second" }, accepted),
      ).toBe("refused");
    });
    expect(accepted).not.toHaveBeenCalled();
    expect(second.result.current.snapshot?.items).toHaveLength(1);
    expect(second.result.current.message).toContain("another window");
  });

  it("checks an uncertain acknowledgment with the same identity and transfers ownership only once", async () => {
    const host = queueTestHost();
    host.execute.mockImplementationOnce(async (command) => {
      host.apply(command);
      throw new Error("connection lost");
    });
    const { result } = renderHook(() =>
      useThreadMessageQueue({ mode: "code", threadId, client: host }),
    );
    await waitFor(() => expect(result.current.available).toBe(true));
    const accepted = vi.fn();
    await act(async () => {
      expect(await result.current.enqueue({ mode: "code", prompt: "Keep it" }, accepted)).toBe(
        "unknown",
      );
    });
    expect(accepted).not.toHaveBeenCalled();
    expect(result.current.uncertain).toBe(true);
    await act(async () => {
      expect(await result.current.enqueue({ mode: "code", prompt: "Another" })).toBe("refused");
      await result.current.retry();
    });
    expect(host.execute.mock.calls[1]?.[0]).toEqual(host.execute.mock.calls[0]?.[0]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(result.current.snapshot?.items).toHaveLength(1);
  });

  it("transfers accepted attachment ownership after unmount without dispatching a turn", async () => {
    const host = queueTestHost();
    const response = Promise.withResolvers<ThreadMessageQueueResult>();
    host.execute.mockImplementationOnce(() => response.promise);
    const { result, unmount } = renderHook(() =>
      useThreadMessageQueue({ mode: "work", threadId, client: host }),
    );
    await waitFor(() => expect(result.current.available).toBe(true));
    const accepted = vi.fn();
    let submit = Promise.resolve<unknown>(undefined);
    act(() => {
      submit = result.current.enqueue({ mode: "work", prompt: "Attachment ownership" }, accepted);
    });
    const command = host.execute.mock.calls[0]?.[0];
    if (command === undefined) throw new Error("Expected queue submission");
    unmount();
    response.resolve(host.apply(command));
    await submit;
    expect(accepted).toHaveBeenCalledOnce();
    expect(host.execute).toHaveBeenCalledOnce();
  });

  it.each(["refused", "conflict"] as const)(
    "recovers an uncertain request once after a retried %s even when unmounted",
    async (status) => {
      const host = queueTestHost();
      host.execute.mockRejectedValueOnce(new Error("offline"));
      const response = Promise.withResolvers<ThreadMessageQueueResult>();
      const { result, unmount } = renderHook(() =>
        useThreadMessageQueue({ mode: "chat", threadId, client: host }),
      );
      await waitFor(() => expect(result.current.available).toBe(true));
      const accepted = vi.fn();
      const onRefused = vi.fn();
      await act(async () => {
        expect(
          await result.current.enqueue({ mode: "chat", prompt: "Keep" }, accepted, onRefused),
        ).toBe("unknown");
      });
      expect(onRefused).not.toHaveBeenCalled();
      host.execute.mockImplementationOnce(() => response.promise);
      let retry = Promise.resolve();
      act(() => {
        retry = result.current.retry();
      });
      const command = host.execute.mock.calls[0]?.[0];
      if (command === undefined) throw new Error("Expected enqueue");
      expect(host.execute.mock.calls[1]?.[0]).toEqual(command);
      unmount();
      response.resolve(
        status === "refused"
          ? { status, requestId: command.requestId, reason: "queue-full" }
          : { status, requestId: command.requestId, snapshot: host.snapshot(command.scope) },
      );
      await retry;
      expect(accepted).not.toHaveBeenCalled();
      expect(onRefused).toHaveBeenCalledOnce();
    },
  );

  it("reopens an uncertain submission with its exact receipt even after the host completed it", async () => {
    const host = queueTestHost();
    host.execute.mockImplementationOnce(async (command) => {
      host.apply(command);
      host.publish({ ...host.snapshot(command.scope), items: [] });
      throw new Error("lost response");
    });
    const first = renderHook(() => useThreadMessageQueue({ mode: "code", threadId, client: host }));
    await waitFor(() => expect(first.result.current.available).toBe(true));
    await act(async () => {
      await first.result.current.enqueue({ mode: "code", prompt: "Original" });
    });
    first.unmount();
    const reopened = renderHook(() =>
      useThreadMessageQueue({ mode: "code", threadId, client: host }),
    );
    await waitFor(() => expect(reopened.result.current.available).toBe(true));
    expect(reopened.result.current.uncertain).toBe(true);
    await act(async () => {
      expect(await reopened.result.current.enqueue({ mode: "code", prompt: "New" })).toBe(
        "refused",
      );
      await reopened.result.current.retry();
    });
    expect(host.execute).toHaveBeenCalledTimes(2);
    expect(host.execute.mock.calls[1]?.[0]).toEqual(host.execute.mock.calls[0]?.[0]);
    expect(reopened.result.current.uncertain).toBe(false);
  });

  it("refuses to send if an exact receipt cannot be persisted", async () => {
    const host = queueTestHost();
    const { result } = renderHook(() =>
      useThreadMessageQueue({ mode: "code", threadId, client: host }),
    );
    await waitFor(() => expect(result.current.available).toBe(true));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const refused = vi.fn();
    try {
      await act(async () => {
        expect(
          await result.current.enqueue({ mode: "code", prompt: "Keep" }, undefined, refused),
        ).toBe("refused");
      });
      expect(host.execute).not.toHaveBeenCalled();
      expect(refused).toHaveBeenCalledOnce();
    } finally {
      storage.mockRestore();
    }
  });

  it.each([
    "unauthorized",
    "authority-revoked",
    "thread-unavailable",
    "not-found",
    "storage-unavailable",
  ] as const)(
    "keeps an uncertain receipt after a retried %s without releasing its attachments",
    async (reason) => {
      const host = queueTestHost();
      host.execute.mockImplementationOnce(async (command) => {
        host.apply(command);
        throw new Error("lost response");
      });
      host.execute.mockImplementationOnce(async (command) => ({
        status: "refused",
        requestId: command.requestId,
        reason,
      }));
      const { result } = renderHook(() =>
        useThreadMessageQueue({ mode: "chat", threadId, client: host }),
      );
      await waitFor(() => expect(result.current.available).toBe(true));
      const accepted = vi.fn();
      const refused = vi.fn();
      await act(async () => {
        await result.current.enqueue({ mode: "chat", prompt: "Original" }, accepted, refused);
      });
      await act(async () => {
        await result.current.retry();
      });
      expect(result.current.uncertain).toBe(true);
      expect(refused).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      await act(async () => {
        expect(await result.current.enqueue({ mode: "chat", prompt: "Another" })).toBe("refused");
        await result.current.retry();
      });
      expect(host.execute.mock.calls[1]?.[0]).toEqual(host.execute.mock.calls[0]?.[0]);
      expect(host.execute.mock.calls[2]?.[0]).toEqual(host.execute.mock.calls[0]?.[0]);
      expect(accepted).toHaveBeenCalledOnce();
      expect(refused).not.toHaveBeenCalled();
    },
  );

  it.each(["unchanged", "newer", "edited back"] as const)(
    "reconciles a recovered acceptance while preserving a %s draft identity",
    async (scenario) => {
      const host = queueTestHost();
      host.execute.mockImplementationOnce(async (command) => {
        host.apply(command);
        throw new Error("lost response");
      });
      const store = createComposerThreadDraftStore(localStorage);
      const write = (text: string) =>
        store.write("code", threadId, { text, caretIndex: text.length, stagedDropped: false });
      write("Original");
      const draft = { text: "Original", revision: store.revision("code", threadId) };
      const first = renderHook(() =>
        useThreadMessageQueue({
          mode: "code",
          threadId,
          client: host,
          draft: { ...draft, clear: () => store.clear("code", threadId) },
        }),
      );
      await waitFor(() => expect(first.result.current.available).toBe(true));
      await act(async () => {
        await first.result.current.enqueue(
          { mode: "code", prompt: "Original" },
          undefined,
          undefined,
          draft,
        );
      });
      first.unmount();
      if (scenario !== "unchanged") write("Newer");
      if (scenario === "edited back") write("Original");
      const text = store.read("code", threadId)?.text ?? "";
      const clear = vi.fn(() => {
        store.clear("code", threadId);
      });
      const reopened = renderHook(() =>
        useThreadMessageQueue({
          mode: "code",
          threadId,
          client: host,
          draft: { text, revision: store.revision("code", threadId), clear },
        }),
      );
      await waitFor(() => expect(reopened.result.current.available).toBe(true));
      await act(async () => {
        await reopened.result.current.retry();
      });
      if (scenario === "unchanged") expect(clear).toHaveBeenCalledOnce();
      else {
        expect(clear).not.toHaveBeenCalled();
        expect(store.read("code", threadId)?.text).toBe(text);
      }
      expect(
        readQueueReceipts("local", { mode: "code", threadId: decodeMentionableThreadId(threadId) }),
      ).toEqual({ status: "ready", receipts: [] });
    },
  );

  it("reconciles an acceptance received after unmount without posting again", async () => {
    const host = queueTestHost();
    const response = Promise.withResolvers<ThreadMessageQueueResult>();
    host.execute.mockImplementationOnce(() => response.promise);
    const clear = vi.fn();
    const draft = { text: "Original", revision: 0, clear };
    const first = renderHook(() =>
      useThreadMessageQueue({ mode: "code", threadId, client: host, draft }),
    );
    await waitFor(() => expect(first.result.current.available).toBe(true));
    let submission = Promise.resolve<unknown>(undefined);
    act(() => {
      submission = first.result.current.enqueue(
        { mode: "code", prompt: "Original" },
        undefined,
        undefined,
        draft,
      );
    });
    await waitFor(() => expect(host.execute).toHaveBeenCalledOnce());
    const command = host.execute.mock.calls[0]?.[0];
    if (command === undefined) throw new Error("Expected enqueue");
    first.unmount();
    response.resolve(host.apply(command));
    await submission;
    const reopened = renderHook(() =>
      useThreadMessageQueue({ mode: "code", threadId, client: host, draft }),
    );
    await waitFor(() => expect(reopened.result.current.uncertain).toBe(true));
    await act(async () => {
      await reopened.result.current.retry();
    });
    expect(host.execute).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not repeat a definitive refusal or its cleanup when receipt removal initially fails", async () => {
    const host = queueTestHost();
    host.execute.mockImplementationOnce(async (command) => ({
      status: "refused",
      requestId: command.requestId,
      reason: "queue-full",
    }));
    const { result } = renderHook(() =>
      useThreadMessageQueue({ mode: "chat", threadId, client: host }),
    );
    await waitFor(() => expect(result.current.available).toBe(true));
    const refused = vi.fn();
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      await act(async () => {
        await result.current.enqueue({ mode: "chat", prompt: "Original" }, undefined, refused);
      });
      expect(result.current.uncertain).toBe(true);
    } finally {
      remove.mockRestore();
    }
    await act(async () => {
      await result.current.retry();
    });
    expect(refused).toHaveBeenCalledOnce();
    expect(host.execute).toHaveBeenCalledOnce();
    expect(result.current.uncertain).toBe(false);
  });

  it("reports an unavailable host and retains the last authoritative snapshot", async () => {
    const host = queueTestHost();
    const { result } = renderHook(() =>
      useThreadMessageQueue({ mode: "chat", threadId, client: host }),
    );
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.enqueue({ mode: "chat", prompt: "Keep" });
    });
    host.read.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.available).toBe(false);
    expect(result.current.snapshot).toEqual(
      host.snapshot({ mode: "chat", threadId: decodeMentionableThreadId(threadId) }),
    );
    await act(async () => {
      expect(await result.current.enqueue({ mode: "chat", prompt: "No local fallback" })).toBe(
        "refused",
      );
    });
    expect(host.execute).toHaveBeenCalledOnce();
  });
});
