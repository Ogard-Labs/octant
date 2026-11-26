import { describe, expect, it } from "vitest";
import type { SideTaskOffer } from "@octant/contracts";
import {
  createThreadUnfinishedWork,
  type SideTaskChildStanding,
  type ThreadUnfinishedWorkPorts,
} from "./threadUnfinishedWork";

const parent = "parent";

function unfinished(input: {
  readonly children?: Readonly<Record<string, SideTaskChildStanding>>;
  readonly owing?: ReadonlyArray<string>;
  readonly held?: boolean;
  readonly run?: string;
}) {
  const children = input.children ?? {};
  return createThreadUnfinishedWork({
    sideTasks: {
      startedChildrenOf: (threadId) =>
        threadId === parent
          ? Object.keys(children).map((childThreadId) => ({
              childThreadId,
              offer: { title: `Task ${childThreadId}`, mode: "code" } as SideTaskOffer,
            }))
          : [],
    },
    reports: {
      undeliveredForParent: () =>
        (input.owing ?? []).map((childThreadId) => ({
          childThreadId,
        })) as unknown as ReturnType<ThreadUnfinishedWorkPorts["reports"]["undeliveredForParent"]>,
    },
    childStanding: ({ threadId }) => children[threadId] ?? "closed",
    reportsHeld: () => input.held === true,
    runningChildRun: () => input.run,
  })(parent);
}

describe("work that keeps a thread from being settled", () => {
  it("names the started side task that works, or that needs the person", () => {
    expect(unfinished({ children: { a: "quiet", b: "working" } })).toEqual({
      kind: "side-task-working",
      title: "Task b",
    });
    expect(unfinished({ children: { a: "attention" } })).toEqual({
      kind: "side-task-attention",
      title: "Task a",
    });
  });

  it("holds the thread while a quiet child's report is still owed to it, and lets go once it is not", () => {
    expect(unfinished({ children: { a: "quiet" }, owing: ["a"] })).toEqual({
      kind: "side-task-report",
      title: "Task a",
    });
    expect(unfinished({ children: { a: "quiet" } })).toBeUndefined();
  });

  it("lets go of a report the parent's own state keeps from being delivered, but not of a child still working", () => {
    expect(unfinished({ children: { a: "quiet" }, owing: ["a"], held: true })).toBeUndefined();
    expect(unfinished({ children: { a: "working" }, owing: ["a"], held: true })).toMatchObject({
      kind: "side-task-working",
    });
  });

  it("never holds a thread for a child that is archived, deleted or purged, even one that still owes a report", () => {
    expect(unfinished({ children: { a: "closed" }, owing: ["a"] })).toBeUndefined();
  });

  it("never holds a thread for an offer nobody started", () => {
    expect(unfinished({})).toBeUndefined();
  });

  it("names a running child run once the side tasks are done", () => {
    expect(unfinished({ children: { a: "quiet" }, run: "Compare the exports" })).toEqual({
      kind: "child-run",
      title: "Compare the exports",
    });
  });
});
