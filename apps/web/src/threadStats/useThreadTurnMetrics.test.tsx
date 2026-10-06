import type { TurnMetricsSummary } from "@octant/contracts";
import type { UsageQueryResponse } from "@octant/contracts/usage-rpc";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadTurnMetrics } from "./useThreadTurnMetrics";

function summary(turnCount: number): TurnMetricsSummary {
  return {
    turns: [],
    turnCount,
    metrics: {
      turns: turnCount,
      measuredTurns: 0,
      precision: "unavailable",
      decodeOutputTokens: 0,
      decodeMs: 0,
      toolMs: 0,
      timeToFirstTokenTotalMs: 0,
    },
  };
}

function answer(turnMetrics: TurnMetricsSummary | undefined): UsageQueryResponse {
  return { turnMetrics } as UsageQueryResponse;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useThreadTurnMetrics", () => {
  it("asks the host for the thread's own turns and keeps nothing for another thread", async () => {
    const query = vi.fn(async () => answer(summary(3)));
    const { result, rerender } = renderHook((props) => useThreadTurnMetrics(props), {
      initialProps: { client: { query }, threadId: "thread-a" as string | undefined },
    });

    await waitFor(() => expect(result.current?.turnCount).toBe(3));
    expect(query).toHaveBeenCalledWith({ filter: { subjectAggregateId: "thread-a" }, limit: 1 });

    query.mockImplementation(async () => answer(undefined));
    rerender({ client: { query }, threadId: "thread-b" });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();
  });

  it("does not ask while no thread is open", () => {
    const query = vi.fn(async () => answer(summary(1)));
    const { result } = renderHook(() =>
      useThreadTurnMetrics({ client: { query }, threadId: undefined }),
    );

    expect(query).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
  });

  it("keeps the last answer when a later read fails", async () => {
    const query = vi.fn(async () => answer(summary(2)));
    const { result, rerender } = renderHook((props) => useThreadTurnMetrics(props), {
      initialProps: { client: { query }, threadId: "thread-a" as string | undefined, revision: 1 },
    });
    await waitFor(() => expect(result.current?.turnCount).toBe(2));

    vi.useFakeTimers();
    query.mockImplementation(async () => {
      throw new Error("offline");
    });
    rerender({ client: { query }, threadId: "thread-a", revision: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.current?.turnCount).toBe(2);
  });

  it("reads once after a burst of movement rather than on every event", async () => {
    const query = vi.fn(async () => answer(summary(1)));
    const { rerender } = renderHook((props) => useThreadTurnMetrics(props), {
      initialProps: { client: { query }, threadId: "thread-a" as string | undefined, revision: 1 },
    });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    for (const revision of [2, 3, 4, 5]) {
      rerender({ client: { query }, threadId: "thread-a", revision });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(query).toHaveBeenCalledTimes(2);
  });
});
