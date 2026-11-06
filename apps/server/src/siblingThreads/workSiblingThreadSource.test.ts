import {
  decodeSiblingThreadId,
  decodeWorkThreadId,
  type WindowId,
  type WorkThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkBoardRuntimeActivity } from "../work/workThreadBoardService";
import { workSiblingThreadSource, type WorkSiblingThreadEvidence } from "./workSiblingThreadSource";

const created = "2026-11-01T06:00:00.000Z";
const projectA = "a2000000-0000-4000-8000-000000000001";
const projectB = "b2000000-0000-4000-8000-000000000001";
const windowId = "a2000000-0000-4000-8000-0000000000ff" as WindowId;

function workThread(id: string, overrides: Partial<Record<keyof WorkThread, unknown>> = {}) {
  return {
    id: decodeWorkThreadId(id),
    projectId: projectA,
    title: `Thread ${id.slice(-1)}`,
    lifecycle: "active",
    createdAt: created,
    ...overrides,
  } as never as WorkThread;
}

const idle: WorkBoardRuntimeActivity = {
  executing: false,
  awaitingInput: false,
  interrupted: false,
};

function evidenceFor(
  threads: ReadonlyArray<WorkThread>,
  activity: Readonly<Record<string, Partial<WorkBoardRuntimeActivity>>> = {},
  turns: Readonly<Record<string, ReadonlyArray<string>>> = {},
): WorkSiblingThreadEvidence {
  return {
    threads: () => threads,
    thread: (threadId) => threads.find((thread) => String(thread.id) === String(threadId)),
    activity: (threadId) => ({ ...idle, ...activity[String(threadId)] }),
    turnUpdates: (threadId) => (turns[String(threadId)] ?? []).map((updatedAt) => ({ updatedAt })),
    mentions: { readTranscript: vi.fn(async () => []) },
  };
}

describe("Work sibling-thread source", () => {
  it("files a Work thread's state by the activity the Work board reads", () => {
    const running = workThread("a2000000-0000-4000-8000-000000000011");
    const asking = workThread("a2000000-0000-4000-8000-000000000012");
    const interrupted = workThread("a2000000-0000-4000-8000-000000000013");
    const decided = workThread("a2000000-0000-4000-8000-000000000014");
    const fresh = workThread("a2000000-0000-4000-8000-000000000015");
    const source = workSiblingThreadSource(
      evidenceFor(
        [running, asking, interrupted, decided, fresh],
        {
          [String(running.id)]: { executing: true },
          [String(asking.id)]: { awaitingInput: true },
          [String(interrupted.id)]: { interrupted: true },
          [String(decided.id)]: { decisionPending: true },
        },
        { [String(running.id)]: ["2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"] },
      ),
      windowId,
    );
    const at = (thread: WorkThread) => source.thread(decodeSiblingThreadId(String(thread.id)));

    expect(at(running)).toMatchObject({
      mode: "work",
      state: "working",
      stateChangedAt: "2026-11-01T08:00:00.000Z",
    });
    expect(at(asking)?.state).toBe("waiting-for-person");
    expect(at(interrupted)?.state).toBe("waiting-for-person");
    expect(at(decided)?.state).toBe("waiting-for-person");
    expect(at(fresh)).toMatchObject({ state: "idle", stateChangedAt: created });
  });

  it("lists the asked Project's Work threads and marks Done, archived, and deleting ones closed", () => {
    const open = workThread("a2000000-0000-4000-8000-000000000021");
    const done = workThread("a2000000-0000-4000-8000-000000000022", { completionConfirmed: true });
    const completed = workThread("a2000000-0000-4000-8000-000000000023", { completedAt: created });
    const archived = workThread("a2000000-0000-4000-8000-000000000024", { lifecycle: "archived" });
    const deleting = workThread("a2000000-0000-4000-8000-000000000025", { lifecycle: "deleting" });
    const elsewhere = workThread("a2000000-0000-4000-8000-000000000026", { projectId: projectB });
    const source = workSiblingThreadSource(
      evidenceFor([open, done, completed, archived, deleting, elsewhere]),
      windowId,
    );

    expect(
      source
        .projectThreads(projectA as never)
        .map((entry) => [String(entry.threadId), entry.closed]),
    ).toEqual([
      [String(open.id), false],
      [String(done.id), true],
      [String(completed.id), true],
      [String(archived.id), true],
      [String(deleting.id), true],
    ]);
  });

  it("reads a transcript through the Work mention read for the turn's window", async () => {
    const target = workThread("a2000000-0000-4000-8000-000000000031");
    const evidence = evidenceFor([target]);
    const source = workSiblingThreadSource(evidence, windowId);

    await source.readTranscript(decodeSiblingThreadId(String(target.id)));

    expect(evidence.mentions.readTranscript).toHaveBeenCalledExactlyOnceWith(
      windowId,
      String(target.id),
    );
  });
});
