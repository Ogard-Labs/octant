import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIBLING_THREAD_WAIT_MS,
  MAX_SIBLING_THREAD_LIST_ROWS,
  MAX_SIBLING_THREAD_READS_PER_TURN,
  MAX_SIBLING_THREAD_WAITS_PER_TURN,
  MAX_SIBLING_THREAD_WAIT_MS,
  decodeProjectId,
  decodeSiblingThreadId,
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
  threadsToolOperations,
  type SiblingThreadCaller,
  type SiblingThreadFacts,
} from "./siblingThreadPolicy";

const projectA = decodeProjectId("a0000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("b0000000-0000-4000-8000-000000000001");
const threadId = (n: number) =>
  decodeSiblingThreadId(`c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

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

  it("lists nothing for a caller outside a Project, in Chat, or of another mode than its siblings", () => {
    const candidates = [sibling(2), sibling(3)];

    expect(listSiblingThreads({ ...caller, projectId: undefined }, candidates).threads).toEqual([]);
    expect(listSiblingThreads({ ...caller, mode: "work" }, candidates).threads).toEqual([]);
    expect(
      listSiblingThreads({ ...caller, mode: "chat" }, [
        sibling(2, { mode: "chat" }),
        sibling(3, { mode: "chat" }),
      ]).threads,
    ).toEqual([]);
  });

  it("lists the other open Work threads of a Work caller's Project", () => {
    const workCaller: SiblingThreadCaller = { ...caller, mode: "work" };
    const listed = listSiblingThreads(workCaller, [
      sibling(1, { mode: "work" }),
      sibling(2, { mode: "work" }),
      sibling(3, { mode: "work", closed: true }),
      sibling(4, { mode: "work", projectId: projectB }),
      sibling(5),
    ]);

    expect(listed.threads.map((thread) => thread.threadId)).toEqual([threadId(2)]);
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

  describe("the operations a turn is offered", () => {
    const code = {
      mode: "code" as const,
      posture: "approval-gated",
      profileAllowsRead: true,
      profileAllowsSend: true,
      profileAllowsBoard: true,
      messagingCarried: true,
      plannerThread: false,
    };

    it("offers a Code turn reading and messaging, and its planner the board too", () => {
      expect(threadsToolOperations(code)).toEqual([
        "help",
        "list",
        "read",
        "wait",
        "send",
        "acknowledge",
        "receipts",
      ]);
      expect(threadsToolOperations({ ...code, plannerThread: true })).toContain("board");
    });

    it("keeps messaging out of Plan and out of a profile that names only the read operations", () => {
      expect(threadsToolOperations({ ...code, posture: "plan" })).toEqual([
        "help",
        "list",
        "read",
        "wait",
      ]);
      expect(threadsToolOperations({ ...code, profileAllowsSend: false })).not.toContain("send");
    });

    it("offers a Work turn messaging where the host carries messages into Work turns, and never board or start", () => {
      const work = { ...code, mode: "work", posture: undefined, plannerThread: true } as const;
      expect(
        threadsToolOperations({
          ...work,
          coordinatorLevel: "full-access",
          profileAllowsStart: true,
        }),
      ).toEqual(["help", "list", "read", "wait", "send", "acknowledge", "receipts"]);
      expect(threadsToolOperations({ ...work, messagingCarried: false })).toEqual([
        "help",
        "list",
        "read",
        "wait",
      ]);
      expect(threadsToolOperations({ ...work, profileAllowsSend: false })).not.toContain("send");
    });

    it("offers board only to the designated planner whose profile names it", () => {
      expect(threadsToolOperations(code)).not.toContain("board");
      expect(
        threadsToolOperations({ ...code, plannerThread: true, profileAllowsBoard: false }),
      ).not.toContain("board");
    });

    it("offers no operation, not even help, to Chat or to a profile that names none", () => {
      expect(threadsToolOperations({ ...code, mode: "chat" })).toEqual([]);
      expect(
        threadsToolOperations({
          ...code,
          profileAllowsRead: false,
          profileAllowsSend: false,
          profileAllowsBoard: false,
        }),
      ).toEqual([]);
    });
  });
});
