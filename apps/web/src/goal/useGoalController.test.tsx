import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadGoal } from "@octant/contracts";
import { GoalClientFailure, type GoalClient } from "@octant/client-runtime/goal-client";
import { useGoalController } from "./useGoalController";

const threadId = "00000000-0000-4000-8000-000000000208";
const otherThreadId = "00000000-0000-4000-8000-000000000209";
const goalId = "00000000-0000-4000-8000-000000000206";
const revisionId = "00000000-0000-4000-8000-000000000207";
const mintedId = "00000000-0000-4000-8000-0000000002ff";

function goalWith(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    id: goalId,
    threadId,
    revisionId,
    objective: "Ship the Goal surface",
    status: "active",
    budget: {},
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
    evidence: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as unknown as ThreadGoal;
}

function controllerOptions(client: GoalClient, thread = threadId) {
  return { client, enabled: true, threadId: thread, newId: () => mintedId };
}

describe("useGoalController", () => {
  it("reads the host projection for the thread", async () => {
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
      execute: vi.fn(),
    };

    const { result } = renderHook(() => useGoalController(controllerOptions(client)));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.goal?.objective).toBe("Ship the Goal surface");
    expect(client.read).toHaveBeenCalledWith(threadId, expect.anything());
  });

  it("sends the version it last read and adopts the host reply", async () => {
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
      execute: vi.fn().mockResolvedValue({
        goal: goalWith({ status: "paused", version: 2 as ThreadGoal["version"] }),
        history: [],
      }),
    };

    const { result } = renderHook(() => useGoalController(controllerOptions(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.pause();
    });

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pause-thread-goal", expectedVersion: 1, goalId }),
    );
    expect(result.current.goal?.status).toBe("paused");
  });

  it("creates a Goal from the injected id source when the thread has none", async () => {
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: null, history: [] }),
      execute: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
    };

    const { result } = renderHook(() => useGoalController(controllerOptions(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.create("  Ship the Goal surface  ".trim());
    });

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-thread-goal",
        expectedVersion: 0,
        goalId: mintedId,
        revisionId: mintedId,
      }),
    );
  });

  it("re-reads instead of retrying when the host reports a stale version", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ goal: goalWith(), history: [] })
      .mockResolvedValue({
        goal: goalWith({ status: "paused", version: 3 as ThreadGoal["version"] }),
        history: [],
      });
    const client: GoalClient = {
      read,
      execute: vi
        .fn()
        .mockRejectedValue(
          new GoalClientFailure("Goal version conflict; reload and retry.", 409, "stale"),
        ),
    };

    const { result } = renderHook(() => useGoalController(controllerOptions(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.complete();
    });

    expect(result.current.commandMessage).toBe("Goal version conflict; reload and retry.");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.goal?.version).toBe(3));
  });

  it("classifies an unauthorized read without showing a Goal", async () => {
    const client: GoalClient = {
      read: vi.fn().mockRejectedValue(new GoalClientFailure("Goal request is unauthorized.", 401)),
      execute: vi.fn(),
    };

    const { result } = renderHook(() => useGoalController(controllerOptions(client)));

    await waitFor(() => expect(result.current.status).toBe("unauthorized"));
    expect(result.current.goal).toBeNull();
  });

  it("discards a superseded load so a previous thread cannot repaint the Goal", async () => {
    let releaseFirst: (() => void) | undefined;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ goal: goalWith({ objective: "Stale thread" }), history: [] });
          }),
      )
      .mockResolvedValue({
        goal: goalWith({ threadId: otherThreadId, objective: "Current thread" }),
        history: [],
      });
    const client: GoalClient = { read, execute: vi.fn() };

    const { rerender, result } = renderHook(
      (thread: string) => useGoalController(controllerOptions(client, thread)),
      { initialProps: threadId },
    );
    rerender(otherThreadId);
    await waitFor(() => expect(result.current.goal?.objective).toBe("Current thread"));
    await act(async () => {
      releaseFirst?.();
    });

    expect(result.current.goal?.objective).toBe("Current thread");
  });

  it("stays idle without a client so the surface never implies a Goal exists", async () => {
    const { result } = renderHook(() =>
      useGoalController({ client: undefined, enabled: false, threadId }),
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await result.current.pause()).toBe(false);
  });
});
