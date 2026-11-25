import { afterEach, expect, it, vi } from "vitest";
import { createNightlyClientRecovery } from "./nightlyClientRecovery";

afterEach(() => vi.useRealTimers());

it("reports failed cleanup when the initial acquisition refuses and startup quits", async () => {
  const exhausted = vi.fn();
  const client = createNightlyClientRecovery({
    open: async () => ({ kind: "refused", reason: "native-unavailable", cleanupFailed: true }),
    exhausted,
  });
  expect((await client.start()).kind).toBe("refused");
  expect(await client.stop()).toEqual({ kind: "failed" });
  expect(exhausted).not.toHaveBeenCalled();
});

it("preserves failed cleanup of a refused late acquisition after cancellation", async () => {
  vi.useFakeTimers();
  let lost = () => {};
  let finish: (() => void) | undefined;
  let attempts = 0;
  const client = createNightlyClientRecovery({
    open: async (_signal, notify) => {
      lost = notify;
      if (++attempts === 1) return { kind: "opened", close: async () => ({ kind: "closed" }) };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { kind: "refused", reason: "native-unavailable", cleanupFailed: true };
    },
    exhausted: vi.fn(),
  });
  await client.start();
  lost();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = client.stop();
  finish?.();
  expect(await stopping).toEqual({ kind: "failed" });
});

it("preserves failed cleanup of a lost lease after a successful replacement closes", async () => {
  vi.useFakeTimers();
  let lost = () => {};
  let attempts = 0;
  const client = createNightlyClientRecovery({
    open: async (_signal, notify) => {
      lost = notify;
      const kind = ++attempts === 1 ? ("failed" as const) : ("closed" as const);
      return { kind: "opened", close: async () => ({ kind }) };
    },
    exhausted: vi.fn(),
  });
  await client.start();
  lost();
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toBe(2);
  expect(await client.stop()).toEqual({ kind: "failed" });
});

it("replaces a lost lease with fresh registration and prevents concurrent recovery", async () => {
  vi.useFakeTimers();
  let lost = () => {};
  const close = vi.fn(async () => ({ kind: "closed" as const }));
  const open = vi.fn(async (_signal: AbortSignal, notify: () => void) => {
    lost = notify;
    return { kind: "opened" as const, close };
  });
  const exhausted = vi.fn();
  const client = createNightlyClientRecovery({ open, exhausted });
  await client.start();
  lost();
  lost();
  expect(client.recovering()).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
  expect(client.recovering()).toBe(false);
  expect(exhausted).not.toHaveBeenCalled();
  await client.stop();
});

it("bounds repeated refused registrations and explains exhaustion once", async () => {
  vi.useFakeTimers();
  let lost = () => {};
  let attempts = 0;
  const exhausted = vi.fn();
  const client = createNightlyClientRecovery({
    open: async (_signal, notify) => {
      lost = notify;
      attempts++;
      return attempts === 1
        ? { kind: "opened", close: async () => ({ kind: "closed" }) }
        : { kind: "refused", reason: "not-running" };
    },
    exhausted,
  });
  await client.start();
  lost();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(exhausted).toHaveBeenCalledOnce();
  const final = attempts;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toBe(final);
  expect(final).toBeGreaterThan(2);
  expect(final).toBeLessThan(25);
  await client.stop();
});

it("cancels a pending fresh acquisition and closes its late result without retry or explanation", async () => {
  vi.useFakeTimers();
  let lost = () => {};
  let finish: (() => void) | undefined;
  const close = vi.fn(async () => ({ kind: "closed" as const }));
  const exhausted = vi.fn();
  let attempts = 0;
  const client = createNightlyClientRecovery({
    open: async (_signal, notify) => {
      lost = notify;
      if (++attempts > 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { kind: "opened", close };
    },
    exhausted,
  });
  await client.start();
  lost();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = client.stop();
  finish?.();
  await stopping;
  expect(close).toHaveBeenCalledTimes(2);
  expect(exhausted).not.toHaveBeenCalled();
  expect(attempts).toBe(2);
});

it("keeps asking for its first window while Octant answers too slowly or is still starting", async () => {
  vi.useFakeTimers();
  const reasons = ["deadline-exceeded", "unavailable"];
  const open = vi.fn(async () => {
    const reason = reasons.shift();
    return reason === undefined
      ? { kind: "opened" as const, close: async () => ({ kind: "closed" as const }) }
      : { kind: "refused" as const, reason, retryable: true as const };
  });
  const exhausted = vi.fn();
  const client = createNightlyClientRecovery({ open, exhausted });
  const started = client.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await started).kind).toBe("opened");
  expect(open).toHaveBeenCalledTimes(3);
  expect(exhausted).not.toHaveBeenCalled();
  expect(await client.stop()).toEqual({ kind: "closed" });
});

it("stops asking for its first window after a bounded time and reports the last refusal", async () => {
  vi.useFakeTimers();
  const open = vi.fn(async () => ({
    kind: "refused" as const,
    reason: "deadline-exceeded",
    retryable: true as const,
  }));
  const client = createNightlyClientRecovery({ open, exhausted: vi.fn() });
  const started = client.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await started).toMatchObject({ kind: "refused", reason: "deadline-exceeded" });
  const attempts = open.mock.calls.length;
  expect(attempts).toBeGreaterThan(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(open).toHaveBeenCalledTimes(attempts);
});

it.each([
  // No answer a later attempt could change, or a window that already existed.
  { reason: "invalid-peer" },
  { reason: "deadline-exceeded" },
])("asks once when its first window is refused for good: $reason", async (refusal) => {
  vi.useFakeTimers();
  const open = vi.fn(async () => ({ kind: "refused" as const, ...refusal }));
  const client = createNightlyClientRecovery({ open, exhausted: vi.fn() });
  const started = client.start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await started).kind).toBe("refused");
  expect(open).toHaveBeenCalledOnce();
});

it("stops asking for its first window when the person quits", async () => {
  vi.useFakeTimers();
  const open = vi.fn(async () => ({
    kind: "refused" as const,
    reason: "unavailable",
    retryable: true as const,
  }));
  const client = createNightlyClientRecovery({ open, exhausted: vi.fn() });
  const started = client.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(await client.stop()).toEqual({ kind: "closed" });
  expect((await started).kind).toBe("refused");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(open).toHaveBeenCalledOnce();
});

it("starts no attempt when its wait for the first window ends after the deadline", async () => {
  vi.useFakeTimers();
  const open = vi.fn(async () => ({
    kind: "refused" as const,
    reason: "unavailable",
    retryable: true as const,
  }));
  const client = createNightlyClientRecovery({ open, exhausted: vi.fn() });
  const started = client.start();
  await vi.advanceTimersByTimeAsync(0);
  // A busy main process can run the backoff timer after the deadline has passed.
  const late = vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect((await started).kind).toBe("refused");
    expect(open).toHaveBeenCalledOnce();
  } finally {
    late.mockRestore();
  }
});
