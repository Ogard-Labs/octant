import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THREAD_ACTIVITY_RECOVERY_MS } from "./ThreadActivityRevisions";
import { useVisibleRefresh } from "./useVisibleRefresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setVisibility(visible: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visible ? "visible" : "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useVisibleRefresh", () => {
  afterEach(() => {
    setVisibility(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads once on mount, then once at the recovery cadence, and not in between", async () => {
    vi.useFakeTimers();
    const reads: Array<AbortSignal> = [];
    const refresh = vi.fn(async (signal: AbortSignal) => {
      reads.push(signal);
    });
    renderHook(
      ({ revision }) => useVisibleRefresh(refresh, revision, THREAD_ACTIVITY_RECOVERY_MS),
      {
        initialProps: { revision: 1 },
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_RECOVERY_MS - 1);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("earns exactly one trailing read when a notice lands during a read", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const calls: Array<() => void> = [];
    let call = 0;
    const refresh = vi.fn((_signal: AbortSignal) => {
      call += 1;
      calls.push(call === 1 ? () => first.resolve() : () => undefined);
      return call === 1 ? first.promise : Promise.resolve();
    });
    const { rerender } = renderHook(
      ({ revision }) => useVisibleRefresh(refresh, revision, THREAD_ACTIVITY_RECOVERY_MS),
      { initialProps: { revision: 1 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ revision: 2 });
    rerender({ revision: 3 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The first read is still in flight, so the notices queue as one.
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("makes no reads while hidden and reads once when the window shows again", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (_signal: AbortSignal) => undefined);
    const { rerender } = renderHook(
      ({ revision }) => useVisibleRefresh(refresh, revision, THREAD_ACTIVITY_RECOVERY_MS),
      { initialProps: { revision: 1 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility(false);
    rerender({ revision: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_RECOVERY_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reads again when the browser comes back online", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (_signal: AbortSignal) => undefined);
    renderHook(
      ({ revision }) => useVisibleRefresh(refresh, revision, THREAD_ACTIVITY_RECOVERY_MS),
      {
        initialProps: { revision: 1 },
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores a read that finishes after unmount and leaves nothing scheduled", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const signals: Array<AbortSignal> = [];
    const refresh = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return first.promise;
    });
    const { unmount } = renderHook(() =>
      useVisibleRefresh(refresh, 1, THREAD_ACTIVITY_RECOVERY_MS),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      first.resolve();
      await vi.advanceTimersByTimeAsync(THREAD_ACTIVITY_RECOVERY_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the predecessor and makes one new read when the refresh changes", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const signalsA: Array<AbortSignal> = [];
    const refreshA = vi.fn((signal: AbortSignal) => {
      signalsA.push(signal);
      return first.promise;
    });
    const refreshB = vi.fn(async (_signal: AbortSignal) => undefined);
    const { rerender } = renderHook(
      ({ refresh }) => useVisibleRefresh(refresh, 1, THREAD_ACTIVITY_RECOVERY_MS),
      { initialProps: { refresh: refreshA } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshA).toHaveBeenCalledTimes(1);
    rerender({ refresh: refreshB });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(signalsA[0]?.aborted).toBe(true);
    expect(refreshB).toHaveBeenCalledTimes(1);
  });
});
