import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { sidebarThreadsWithWorkers, workerListingFor } from "./coordinatorWorkerListing";

const PROJECT = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";

const coordinator: ChatThreadNavigationItem = {
  threadId: "coordinator",
  title: "Backlog",
  projectId: PROJECT,
  coordinator: true,
};
const working: ChatThreadNavigationItem = {
  threadId: "w1",
  title: "Fix the flaky test",
  projectId: PROJECT,
  coordinatorThreadId: "coordinator",
  activity: "working",
};
const asking: ChatThreadNavigationItem = {
  threadId: "w2",
  title: "Bump the parser",
  projectId: PROJECT,
  coordinatorThreadId: "coordinator",
  activity: "attention",
};
const orphan: ChatThreadNavigationItem = {
  threadId: "w3",
  title: "Old worker",
  projectId: PROJECT,
  coordinatorThreadId: "gone",
};
const ordinary: ChatThreadNavigationItem = { threadId: "t", title: "Docs", projectId: PROJECT };
const threads = [ordinary, coordinator, working, asking, orphan];
const ids = (rows: ReadonlyArray<ChatThreadNavigationItem>) => rows.map((row) => row.threadId);

describe("where a coordinator's workers are listed", () => {
  it("lists no worker in the sidebar by default, and the coordinator row still counts every request", () => {
    const listed = sidebarThreadsWithWorkers(threads, undefined);
    expect(ids(listed)).toEqual(["t", "coordinator", "w3"]);
    expect(listed.find((row) => row.threadId === "coordinator")?.hiddenWorkers).toEqual({
      working: 1,
      attention: 1,
    });
  });

  it("lists workers, with no hidden counts, when Settings shows them in the sidebar", () => {
    const listed = sidebarThreadsWithWorkers(threads, {
      coordinatorWorkerListing: { sidebar: true, board: false },
    });
    expect(ids(listed)).toEqual(ids(threads));
    expect(listed.some((row) => row.hiddenWorkers !== undefined)).toBe(false);
  });

  it("lets a Project's own choice win over Settings, in either direction", () => {
    const hiddenHere = sidebarThreadsWithWorkers(threads, {
      coordinatorWorkerListing: { sidebar: true, board: true },
      coordinatorWorkerListingByProject: { [PROJECT]: { sidebar: false, board: true } } as never,
    });
    expect(ids(hiddenHere)).toEqual(["t", "coordinator", "w3"]);

    const shownHere = sidebarThreadsWithWorkers(threads, {
      coordinatorWorkerListingByProject: { [PROJECT]: { sidebar: true, board: false } } as never,
    });
    expect(ids(shownHere)).toEqual(ids(threads));

    expect(
      workerListingFor(
        {
          coordinatorWorkerListing: { sidebar: true, board: true },
          coordinatorWorkerListingByProject: { [OTHER]: { sidebar: false, board: false } } as never,
        },
        PROJECT,
      ),
    ).toEqual({ sidebar: true, board: true });
  });
});
