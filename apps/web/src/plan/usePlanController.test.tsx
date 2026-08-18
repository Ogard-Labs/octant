import type { PlanClient } from "@octant/client-runtime/plan-client";
import { PlanClientFailure } from "@octant/client-runtime/plan-client";
import type { ThreadPlan } from "@octant/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePlanController } from "./usePlanController";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  plan: "20000000-0000-4000-8000-000000000001",
  revision: "30000000-0000-4000-8000-000000000001",
  step: "40000000-0000-4000-8000-000000000001",
} as const;

function plan(overrides: Partial<ThreadPlan> = {}): ThreadPlan {
  return {
    id: ids.plan,
    threadId: ids.thread,
    revisionId: ids.revision,
    title: "Land the replay fix",
    status: "proposed",
    steps: [{ stepId: ids.step, position: 0, title: "Reproduce the gap", status: "pending" }],
    proposedAt: "2026-08-18T09:00:00.000Z",
    updatedAt: "2026-08-18T09:00:00.000Z",
    version: 3,
    ...overrides,
  } as ThreadPlan;
}

function client(overrides: Partial<PlanClient> = {}): PlanClient {
  return {
    read: vi.fn(async () => ({ plan: plan(), history: [] })),
    execute: vi.fn(async () => ({
      plan: plan({ status: "approved", version: 4 as never }),
      history: [],
    })),
    ...overrides,
  } as unknown as PlanClient;
}

function ids2(): () => string {
  let index = 1;
  return () => `50000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
}

describe("the plan controller", () => {
  it("approves the exact revision and version this window is showing", async () => {
    const execute = vi.fn(async () => ({
      plan: plan({ status: "approved", version: 4 as never }),
      history: [],
    }));
    const planClient = client({ execute });
    const newId = ids2();
    const { result } = renderHook(() =>
      usePlanController({ client: planClient, enabled: true, threadId: ids.thread, newId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.approve();
    });

    expect(execute).toHaveBeenCalledWith({
      kind: "approve-thread-plan",
      threadId: ids.thread,
      expectedVersion: 3,
      planId: ids.plan,
      revisionId: ids.revision,
    });
    expect(result.current.plan?.status).toBe("approved");
  });

  it("re-reads instead of resending when the host says the window is behind", async () => {
    const read = vi.fn(async () => ({ plan: plan(), history: [] }));
    const execute = vi.fn(async () => {
      throw new PlanClientFailure("The plan moved under this command.", 409, "stale");
    });
    const planClient = client({ read, execute });
    const newId = ids2();
    const { result } = renderHook(() =>
      usePlanController({ client: planClient, enabled: true, threadId: ids.thread, newId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.approve();
    });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.commandMessage).toBe("The plan moved under this command.");
  });

  it("sends only the steps that were actually written", async () => {
    const execute = vi.fn(async () => ({ plan: plan(), history: [] }));
    const planClient = client({
      read: vi.fn(async () => ({ plan: null, history: [] })),
      execute,
    });
    const newId = ids2();
    const { result } = renderHook(() =>
      usePlanController({ client: planClient, enabled: true, threadId: ids.thread, newId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.propose("Land the fix", [
        { title: "  Reproduce  ", rationale: " the report is vague " },
        { title: "   " },
      ]);
    });

    const command = (execute.mock.calls as ReadonlyArray<ReadonlyArray<unknown>>)[0]?.[0] as {
      readonly steps: ReadonlyArray<{ readonly title: string; readonly rationale?: string }>;
      readonly expectedVersion: number;
    };
    expect(command.steps.map((step) => step.title)).toEqual(["Reproduce"]);
    expect(command.steps[0]?.rationale).toBe("the report is vague");
    expect(command.expectedVersion).toBe(0);
  });

  it("reports a window that may not read the plan without inventing one", async () => {
    const planClient = client({
      read: vi.fn(async () => {
        throw new PlanClientFailure("Not authorized.", 401);
      }),
    });
    const newId = ids2();
    const { result } = renderHook(() =>
      usePlanController({ client: planClient, enabled: true, threadId: ids.thread, newId }),
    );

    await waitFor(() => expect(result.current.status).toBe("unauthorized"));
    expect(result.current.plan).toBeNull();
  });
});
