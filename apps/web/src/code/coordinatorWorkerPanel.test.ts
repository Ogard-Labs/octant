import { describe, expect, it } from "vitest";
import {
  coordinatorWorkerRows,
  coordinatorWorkerSections,
  coordinatorWorkerState,
  type CoordinatorWorkerSource,
} from "./coordinatorWorkerPanel";

function worker(overrides: Partial<CoordinatorWorkerSource> & { readonly id: string }) {
  const { id, ...rest } = overrides;
  return {
    threadId: id,
    title: `Worker ${id}`,
    projectId: "p",
    providerInstanceId: "i",
    lifecycle: "active",
    coordinatorThreadId: "c",
    modelId: "m",
    ...rest,
  } as unknown as CoordinatorWorkerSource;
}

const pullRequest = (state: string) =>
  ({
    items: [{ identity: { number: 7 }, state, checks: "passing" }],
    hiddenCount: 0,
  }) as never;

describe("the Workers panel's rows", () => {
  it("reads a worker's state from host facts, with a request outranking every other word", () => {
    expect(coordinatorWorkerState(worker({ id: "a", awaitingInput: true, executing: true }))).toBe(
      "needs-you",
    );
    expect(coordinatorWorkerState(worker({ id: "b", executing: true }))).toBe("working");
    expect(coordinatorWorkerState(worker({ id: "c" }))).toBe("idle");
    expect(
      coordinatorWorkerState(worker({ id: "d", pullRequestSummaries: pullRequest("open") })),
    ).toBe("in-review");
    expect(
      coordinatorWorkerState(worker({ id: "e", pullRequestSummaries: pullRequest("merged") })),
    ).toBe("done");
    expect(coordinatorWorkerState(worker({ id: "f", markedDone: true }))).toBe("done");
  });

  it("lists only this coordinator's workers, newest change first, and files them in the four sections", () => {
    const rows = coordinatorWorkerRows(
      [
        worker({
          id: "old",
          completedAt: "2026-11-15T09:00:00.000Z" as never,
          updatedAt: "1" as never,
        }),
        worker({ id: "ask", awaitingInput: true, updatedAt: "2" as never }),
        worker({ id: "run", executing: true, updatedAt: "3" as never }),
        worker({ id: "pr", pullRequestSummaries: pullRequest("open"), updatedAt: "4" as never }),
        worker({ id: "other", coordinatorThreadId: "elsewhere" as never }),
      ],
      "c",
      () => "Sonnet 5.5",
    );
    expect(rows.map((row) => row.threadId)).toEqual(["pr", "run", "ask", "old"]);
    expect(rows[0]?.modelLabel).toBe("Sonnet 5.5");
    const sections = coordinatorWorkerSections(rows);
    expect(sections.needsYou.map((row) => row.threadId)).toEqual(["ask"]);
    expect(sections.working.map((row) => row.threadId)).toEqual(["run"]);
    expect(sections.inReview.map((row) => row.threadId)).toEqual(["pr"]);
    expect(sections.done.map((row) => row.threadId)).toEqual(["old"]);
  });
});
