import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TurnSettlement } from "./queuedSend";
import { useQueuedSend } from "./useQueuedSend";

describe("useQueuedSend", () => {
  it("sends the parked follow-up once the running turn completes", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = renderHook(
      (props: { settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({ threadKey: "thread-a", settlement: props.settlement, send }),
      { initialProps: { settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    expect(result.current.state).toEqual({ status: "queued", threadKey: "thread-a" });
    expect(send).not.toHaveBeenCalled();

    rerender({ settlement: "completed" });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
  });

  it("holds the follow-up when the turn is cancelled and does not send it", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = renderHook(
      (props: { settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({ threadKey: "thread-a", settlement: props.settlement, send }),
      { initialProps: { settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    rerender({ settlement: "cancelled" });
    await waitFor(() => expect(result.current.state.status).toBe("held"));
    expect(send).not.toHaveBeenCalled();
    expect(result.current.statusMessage).toMatch(/cancelled/i);
  });

  it("lets the user discard a parked follow-up before it fires", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = renderHook(
      (props: { settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({ threadKey: "thread-a", settlement: props.settlement, send }),
      { initialProps: { settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    act(() => {
      result.current.discard();
    });
    rerender({ settlement: "completed" });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send after the user leaves the thread", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = renderHook(
      (props: { threadKey: string; settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({
          threadKey: props.threadKey,
          settlement: props.settlement,
          send,
        }),
      { initialProps: { threadKey: "thread-a", settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    rerender({ threadKey: "thread-b", settlement: "running" });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    rerender({ threadKey: "thread-a", settlement: "completed" });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("holds the follow-up when the ordinary send path is refused", async () => {
    const send = vi.fn(async () => false);
    const { rerender, result } = renderHook(
      (props: { settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({ threadKey: "thread-a", settlement: props.settlement, send }),
      { initialProps: { settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    rerender({ settlement: "completed" });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state.status).toBe("held"));
    expect(result.current.statusMessage).toMatch(/not sent/i);
  });

  it("waits until the composer is ready before firing a completed turn", async () => {
    const send = vi.fn(async () => true);
    const { rerender, result } = renderHook(
      (props: { ready: boolean; settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({
          threadKey: "thread-a",
          settlement: props.settlement,
          ready: props.ready,
          send,
        }),
      { initialProps: { ready: false, settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    rerender({ ready: false, settlement: "completed" });
    await waitFor(() => expect(result.current.state.status).toBe("queued"));
    expect(send).not.toHaveBeenCalled();

    rerender({ ready: true, settlement: "completed" });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
  });

  it("fires a later thread's queued send after an earlier send settles", async () => {
    let resolveFirst: ((value: boolean) => void) | undefined;
    const send = vi.fn();
    send.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    send.mockImplementation(async () => true);
    const { rerender, result } = renderHook(
      (props: { threadKey: string; settlement: TurnSettlement | "idle" }) =>
        useQueuedSend({
          threadKey: props.threadKey,
          settlement: props.settlement,
          send,
        }),
      { initialProps: { threadKey: "thread-a", settlement: "running" } },
    );

    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    rerender({ threadKey: "thread-a", settlement: "completed" });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());

    rerender({ threadKey: "thread-b", settlement: "running" });
    act(() => {
      expect(result.current.enqueue()).toBe(true);
    });
    expect(result.current.state).toEqual({ status: "queued", threadKey: "thread-b" });
    expect(resolveFirst).toBeDefined();
    await act(async () => {
      resolveFirst?.(true);
    });

    rerender({ threadKey: "thread-b", settlement: "completed" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
  });
});
