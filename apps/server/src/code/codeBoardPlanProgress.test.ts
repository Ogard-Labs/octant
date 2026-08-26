import { decodeCodeThreadId, decodeThreadPlan, type ThreadPlan } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createCodeBoardPlanProgressSource } from "./codeBoardPlanProgress";

const now = "2026-08-25T10:00:00.000Z";
const threadId = decodeCodeThreadId("3f200000-0000-4000-8000-000000000002");

function plan(steps: ReadonlyArray<"pending" | "in-progress" | "done" | "dropped">): ThreadPlan {
  return decodeThreadPlan({
    id: "3f200000-0000-4000-8000-000000000001",
    threadId: String(threadId),
    revisionId: "3f200000-0000-4000-8000-000000000003",
    title: "Plan",
    status: "approved",
    steps: steps.map((status, index) => ({
      stepId: `3f200000-0000-4000-8000-00000000001${index}`,
      position: index,
      title: `Step ${index}`,
      status,
    })),
    proposedAt: now,
    updatedAt: now,
    version: 1,
  });
}

describe("createCodeBoardPlanProgressSource", () => {
  it("reports absent for a thread with no live plan", () => {
    const source = createCodeBoardPlanProgressSource({
      read: () => ({ plan: null, history: [] }),
    });
    expect(source.read(threadId)).toEqual({ kind: "none" });
  });

  it("counts done steps out of steps that were not dropped", () => {
    const source = createCodeBoardPlanProgressSource({
      read: () => ({ plan: plan(["done", "done", "in-progress", "dropped"]), history: [] }),
    });
    expect(source.read(threadId)).toEqual({ kind: "present", done: 2, total: 3 });
  });

  it("reads the plan store keyed by the exact thread id requested", () => {
    const reads: string[] = [];
    const source = createCodeBoardPlanProgressSource({
      read: (id) => {
        reads.push(id);
        return { plan: null, history: [] };
      },
    });
    source.read(threadId);
    expect(reads).toEqual([String(threadId)]);
  });
});
