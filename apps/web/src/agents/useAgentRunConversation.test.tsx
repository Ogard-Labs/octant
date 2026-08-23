import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunConversationStreamFrame, AgentRunId } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunId } from "@octant/contracts/agent-run";
import { useAgentRunConversation } from "./useAgentRunConversation";

const firstRun = decodeAgentRunId("11111111-1111-4111-8111-111111111111");
const secondRun = decodeAgentRunId("22222222-2222-4222-8222-222222222222");
const parentThreadId = "33333333-3333-4333-8333-333333333333" as never;

interface PendingStream {
  readonly runId: AgentRunId;
  readonly afterSequence: number | undefined;
  readonly resolve: (frame: AgentRunConversationStreamFrame | undefined) => void;
}

function streamHarness() {
  const pending: PendingStream[] = [];
  const subscribe = vi.fn(
    (
      runId: AgentRunId,
      afterSequence: number | undefined,
    ): AsyncGenerator<AgentRunConversationStreamFrame> => {
      let resolveFrame: (frame: AgentRunConversationStreamFrame | undefined) => void = () => {};
      const frame = new Promise<AgentRunConversationStreamFrame | undefined>((resolve) => {
        resolveFrame = resolve;
      });
      pending.push({ runId, afterSequence, resolve: resolveFrame });
      return (async function* () {
        const next = await frame;
        if (next !== undefined) yield next;
      })();
    },
  );
  return {
    pending,
    client: { subscribeConversation: subscribe } as unknown as AgentRunClient,
  };
}

function frame(
  runId: AgentRunId,
  kind: "snapshot" | "delta",
  status: AgentRunConversationStreamFrame["status"],
  entries: ReadonlyArray<AgentRunConversationStreamFrame["entries"][number]>,
): AgentRunConversationStreamFrame {
  return {
    kind,
    runId,
    parentThreadId,
    executionKind: "octant-managed",
    modelId: "gpt-5.6-luna" as never,
    lifecycleStatus: status === "complete" ? "completed" : "running",
    status,
    entries,
    truncated: false,
    ...(entries.at(-1) === undefined ? {} : { nextCursor: String(entries.at(-1)?.sequence) }),
  };
}

function entry(sequence: number, text: string) {
  return {
    sequence,
    kind: "assistant" as const,
    text,
    occurredAt: "2026-08-23T00:00:00.000Z" as never,
  };
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useAgentRunConversation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with the last cursor and merges resumed deltas without duplicates", async () => {
    vi.useFakeTimers();
    const harness = streamHarness();
    const { result } = renderHook(() => useAgentRunConversation(harness.client, firstRun));

    harness.pending[0]?.resolve(frame(firstRun, "snapshot", "live", [entry(1, "one")]));
    await flushReact();
    expect(result.current.conversation?.entries.map((item) => item.text)).toEqual(["one"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(harness.pending).toHaveLength(2);
    expect(harness.pending[1]?.afterSequence).toBe(1);
    harness.pending[1]?.resolve(
      frame(firstRun, "delta", "live", [entry(1, "one"), entry(2, "two")]),
    );
    await flushReact();

    expect(result.current.conversation?.entries.map((item) => item.text)).toEqual(["one", "two"]);
    expect(result.current.reconnecting).toBe(true);
  });

  it("resets reconnect backoff after a frame and stops retrying after terminal state", async () => {
    vi.useFakeTimers();
    const harness = streamHarness();
    const { result } = renderHook(() => useAgentRunConversation(harness.client, firstRun));

    harness.pending[0]?.resolve(frame(firstRun, "snapshot", "live", [entry(1, "one")]));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    harness.pending[1]?.resolve(frame(firstRun, "delta", "live", [entry(2, "two")]));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(harness.pending).toHaveLength(3);

    harness.pending[2]?.resolve(frame(firstRun, "snapshot", "complete", [entry(3, "done")]));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(harness.pending).toHaveLength(3);
    expect(result.current.conversation?.status).toBe("complete");
    expect(result.current.reconnecting).toBe(false);
  });

  it.each(["stale", "unavailable"] as const)(
    "does not retry after a %s terminal stream frame",
    async (status) => {
      vi.useFakeTimers();
      const harness = streamHarness();
      const { result } = renderHook(() => useAgentRunConversation(harness.client, firstRun));
      harness.pending[0]?.resolve(frame(firstRun, "snapshot", status, []));
      await flushReact();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(harness.pending).toHaveLength(1);
      expect(result.current.conversation?.status).toBe(status);
      expect(result.current.reconnecting).toBe(false);
    },
  );

  it("ignores a late frame from a previous pane after selection changes", async () => {
    const harness = streamHarness();
    const { result, rerender } = renderHook(
      ({ runId }: { readonly runId: AgentRunId }) => useAgentRunConversation(harness.client, runId),
      { initialProps: { runId: firstRun } },
    );
    expect(harness.pending).toHaveLength(1);
    rerender({ runId: secondRun });
    expect(harness.pending).toHaveLength(2);

    harness.pending[0]?.resolve(frame(firstRun, "snapshot", "live", [entry(1, "old pane")]));
    harness.pending[1]?.resolve(frame(secondRun, "snapshot", "live", [entry(1, "new pane")]));
    await flushReact();

    expect(result.current.conversation?.runId).toBe(secondRun);
    expect(result.current.conversation?.entries.map((item) => item.text)).toEqual(["new pane"]);
  });
});
