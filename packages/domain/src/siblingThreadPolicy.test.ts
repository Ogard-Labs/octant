import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIBLING_THREAD_WAIT_MS,
  MAX_SIBLING_THREAD_LIST_ROWS,
  MAX_SIBLING_THREAD_READS_PER_TURN,
  MAX_SIBLING_THREAD_WAITS_PER_TURN,
  MAX_SIBLING_THREAD_WAIT_MS,
} from "@octant/contracts";
import {
  SIBLING_THREAD_UNREACHABLE,
  decideSiblingThreadCall,
  decideSiblingThreadTarget,
  listSiblingThreads,
  parseSiblingThreadReference,
  siblingThreadActionIngestsContent,
  siblingThreadReference,
  siblingThreadWaitMs,
  type SiblingThreadCaller,
  type SiblingThreadFacts,
} from "./siblingThreadPolicy";

const projectA = "a0000000-0000-4000-8000-000000000001";
const projectB = "b0000000-0000-4000-8000-000000000001";
const threadId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const caller: SiblingThreadCaller = { threadId: threadId(1), projectId: projectA, mode: "code" };

const sibling = (
  n: number,
  overrides: Partial<SiblingThreadFacts & { stateChangedAt: string }> = {},
) => ({
  threadId: threadId(n),
  projectId: projectA,
  mode: "code" as const,
  closed: false,
  stateChangedAt: `2026-10-13T07:00:${String(n % 60).padStart(2, "0")}.000Z`,
  ...overrides,
});

const unreachable = {
  status: "refused",
  reason: "unauthorized",
  message: SIBLING_THREAD_UNREACHABLE,
};

describe("sibling thread policy", () => {
  it("lists only the other open Code threads of the caller's Project, newest change first", () => {
    const listed = listSiblingThreads(caller, [
      sibling(1),
      sibling(2, { stateChangedAt: "2026-10-13T07:00:00.000Z" }),
      sibling(3, { stateChangedAt: "2026-10-13T08:00:00.000Z" }),
      sibling(4, { closed: true }),
      sibling(5, { projectId: projectB }),
      sibling(6, { mode: "work" }),
      sibling(7, { projectId: undefined }),
    ]);

    expect(listed.threads.map((thread) => thread.threadId)).toEqual([threadId(3), threadId(2)]);
    expect(listed.truncated).toBe(false);
  });

  it("lists nothing for a caller outside a Project or outside Code", () => {
    const candidates = [sibling(2), sibling(3)];

    expect(listSiblingThreads({ ...caller, projectId: undefined }, candidates).threads).toEqual([]);
    expect(listSiblingThreads({ ...caller, mode: "work" }, candidates).threads).toEqual([]);
  });

  it("caps the list and says when readable threads were left out", () => {
    const candidates = Array.from({ length: MAX_SIBLING_THREAD_LIST_ROWS + 1 }, (_, index) =>
      sibling(index + 2),
    );

    const listed = listSiblingThreads(caller, candidates);

    expect(listed.threads).toHaveLength(MAX_SIBLING_THREAD_LIST_ROWS);
    expect(listed.truncated).toBe(true);
    expect(listSiblingThreads(caller, candidates.slice(1)).truncated).toBe(false);
  });

  it("admits a reference to a thread that is still readable", () => {
    const target = sibling(2);
    const reference = siblingThreadReference({ threadId: target.threadId, projectId: projectA });

    expect(parseSiblingThreadReference(reference)).toEqual({
      threadId: target.threadId,
      projectId: projectA,
    });
    expect(decideSiblingThreadTarget({ caller, reference, target })).toEqual({
      status: "admitted",
      target,
    });
  });

  it("refuses every reference outside the readable set in the same words as an unknown one", () => {
    const referenceTo = (target: SiblingThreadFacts) =>
      siblingThreadReference({
        threadId: target.threadId,
        projectId: target.projectId ?? projectA,
      });
    const otherProject = sibling(3, { projectId: projectB });
    const work = sibling(4, { mode: "work" });

    const refusals = [
      decideSiblingThreadTarget({ caller, reference: "not a reference", target: undefined }),
      decideSiblingThreadTarget({ caller, reference: threadId(2), target: sibling(2) }),
      decideSiblingThreadTarget({ caller, reference: referenceTo(sibling(2)), target: undefined }),
      decideSiblingThreadTarget({
        caller,
        reference: referenceTo(otherProject),
        target: otherProject,
      }),
      decideSiblingThreadTarget({ caller, reference: referenceTo(work), target: work }),
      decideSiblingThreadTarget({ caller, reference: referenceTo(sibling(1)), target: sibling(1) }),
    ];

    for (const refusal of refusals) expect(refusal).toEqual(unreachable);
  });

  it("refuses a reference to a thread completed or archived after it was listed", () => {
    const reference = siblingThreadReference({ threadId: threadId(2), projectId: projectA });

    expect(
      decideSiblingThreadTarget({ caller, reference, target: sibling(2, { closed: true }) }),
    ).toEqual(unreachable);
  });

  it("refuses a reference whose thread has moved to another Project, even back into the caller's", () => {
    const listedInB = siblingThreadReference({ threadId: threadId(2), projectId: projectB });

    expect(decideSiblingThreadTarget({ caller, reference: listedInB, target: sibling(2) })).toEqual(
      unreachable,
    );
    expect(
      decideSiblingThreadTarget({
        caller,
        reference: siblingThreadReference({ threadId: threadId(2), projectId: projectA }),
        target: sibling(2, { projectId: projectB }),
      }),
    ).toEqual(unreachable);
  });

  it("never resolves a reference to a different thread than the one it names", () => {
    const reference = siblingThreadReference({ threadId: threadId(2), projectId: projectA });

    expect(decideSiblingThreadTarget({ caller, reference, target: sibling(3) })).toEqual(
      unreachable,
    );
  });

  it("refuses the read and the wait past the per-turn bound, and never counts list", () => {
    expect(
      decideSiblingThreadCall({
        action: "read",
        readsThisTurn: MAX_SIBLING_THREAD_READS_PER_TURN - 1,
        waitsThisTurn: 0,
      }),
    ).toEqual({ status: "admitted" });
    expect(
      decideSiblingThreadCall({
        action: "read",
        readsThisTurn: MAX_SIBLING_THREAD_READS_PER_TURN,
        waitsThisTurn: 0,
      }),
    ).toMatchObject({ status: "refused", reason: "rate-limited" });
    expect(
      decideSiblingThreadCall({
        action: "wait",
        readsThisTurn: MAX_SIBLING_THREAD_READS_PER_TURN,
        waitsThisTurn: MAX_SIBLING_THREAD_WAITS_PER_TURN - 1,
      }),
    ).toEqual({ status: "admitted" });
    expect(
      decideSiblingThreadCall({
        action: "wait",
        readsThisTurn: 0,
        waitsThisTurn: MAX_SIBLING_THREAD_WAITS_PER_TURN,
      }),
    ).toMatchObject({ status: "refused", reason: "rate-limited" });
    expect(
      decideSiblingThreadCall({
        action: "list",
        readsThisTurn: MAX_SIBLING_THREAD_READS_PER_TURN,
        waitsThisTurn: MAX_SIBLING_THREAD_WAITS_PER_TURN,
      }),
    ).toEqual({ status: "admitted" });
  });

  it("blocks a wait for the default when no timeout is named and never past the child-run bound", () => {
    expect(siblingThreadWaitMs(undefined)).toBe(DEFAULT_SIBLING_THREAD_WAIT_MS);
    expect(siblingThreadWaitMs(5_000)).toBe(5_000);
    expect(siblingThreadWaitMs(-1)).toBe(0);
    expect(siblingThreadWaitMs(MAX_SIBLING_THREAD_WAIT_MS * 10)).toBe(MAX_SIBLING_THREAD_WAIT_MS);
    expect(MAX_SIBLING_THREAD_WAIT_MS).toBe(120_000);
  });

  it("marks the caller as having read outside content on list and read, but not on wait", () => {
    expect(siblingThreadActionIngestsContent("list")).toBe(true);
    expect(siblingThreadActionIngestsContent("read")).toBe(true);
    expect(siblingThreadActionIngestsContent("wait")).toBe(false);
  });
});
