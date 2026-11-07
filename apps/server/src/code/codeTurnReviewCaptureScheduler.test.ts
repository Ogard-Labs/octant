import { afterEach, expect, it, vi } from "vitest";
import { CodeTurnReviewCaptureScheduler } from "./codeTurnReviewCaptureScheduler";

afterEach(() => vi.useRealTimers());

it("coalesces edit bursts, keeps one capture in flight and flushes the final version", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<void>();
  const capture = vi.fn(async (final: boolean) => {
    if (!final && capture.mock.calls.length === 1) await held.promise;
  });
  const unavailable = vi.fn();
  const owner = new CodeTurnReviewCaptureScheduler({ capture, unavailable, now: Date.now });
  try {
    for (let i = 0; i < 20; i++) owner.request();
    await vi.advanceTimersByTimeAsync(499);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) owner.request();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(capture).toHaveBeenCalledOnce();
    held.resolve();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
    owner.request();
    await owner.flush(true);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls[2]?.[0]).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    owner.close();
  }
});

it("settles a hung capture at its finite deadline and cancels only its owned work", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const unavailable = vi.fn();
  const owner = new CodeTurnReviewCaptureScheduler({
    capture: async (_final, signal) => {
      signals.push(signal);
      await held.promise;
    },
    unavailable,
    now: Date.now,
  });
  try {
    const waiting = owner.flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await waiting;
    expect(signals[0]?.aborted).toBe(true);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith("deadline", expect.any(Function));
    owner.request();
    owner.close();
    held.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals).toHaveLength(1);
    expect(unavailable).toHaveBeenCalledOnce();
  } finally {
    held.resolve();
    owner.close();
  }
});
