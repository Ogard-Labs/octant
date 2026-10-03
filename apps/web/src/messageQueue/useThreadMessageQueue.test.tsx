import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeMentionableThreadId, type ThreadMessageQueueResult } from "@octant/contracts";
import { useThreadMessageQueue } from "./useThreadMessageQueue";
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
