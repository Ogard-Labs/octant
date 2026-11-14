import { describe, expect, it } from "vitest";
import {
  checkDelegationParent,
  type DelegationParentFacts,
  type DelegationParentRules,
} from "./delegationParentCheck";

const WORK_PARENT: DelegationParentFacts = {
  parentMode: "work",
  parentAuthority: { subagents: true },
  liveAuthority: { subagents: true, executionPolicy: "approval-gated" },
};

function rules(sessionStatus: string | undefined): DelegationParentRules {
  return {
    creationPosture: () => "automatic",
    authorizeCreation: () => WORK_PARENT,
    externalContentIngested: () => false,
    runsAtFullAccess: () => false,
    standingAnswerCovers: () => false,
    sessionStatus: () => sessionStatus,
  };
}

/** A parent that read outside content, at `policy`, whose person may answer once. */
function markedParent(policy: "approval-gated" | "full-access" | "plan") {
  let answered = false;
  return {
    answer: () => {
      answered = true;
    },
    rules: {
      ...rules(undefined),
      authorizeCreation: () => ({
        ...WORK_PARENT,
        liveAuthority: { subagents: true, executionPolicy: policy },
      }),
      externalContentIngested: () => true,
      runsAtFullAccess: () => policy === "full-access",
      standingAnswerCovers: () => answered,
    } satisfies DelegationParentRules,
  };
}

const ASK = { mode: "work", threadId: "thread-1", windowId: "window-1" } as const;

describe("what a parent thread must satisfy before it starts a child on another host", () => {
  it.each(["paused-by-user", "paused-by-advisor", "recovery-required"])(
    "refuses a child while the parent session is %s",
    (status) => {
      expect(checkDelegationParent(rules(status), ASK)).toEqual({
        status: "refused",
        kind: "session-paused",
      });
    },
  );

  it.each([["running"], [undefined]])("delegates from a parent whose session is %s", (status) => {
    expect(checkDelegationParent(rules(status), ASK)).toEqual({
      status: "allowed",
      ceiling: "approval-gated",
    });
  });

  it("hands work to another spoke from a thread that read outside content once its person answered for the thread", () => {
    const parent = markedParent("approval-gated");
    expect(checkDelegationParent(parent.rules, ASK)).toEqual({
      status: "refused",
      kind: "parent-tainted",
    });
    parent.answer();
    expect(checkDelegationParent(parent.rules, ASK)).toEqual({
      status: "allowed",
      ceiling: "approval-gated",
    });
    expect(checkDelegationParent(parent.rules, ASK)).toEqual({
      status: "allowed",
      ceiling: "approval-gated",
    });
  });

  it("hands work to another spoke unasked from a Full access thread that read outside content", () => {
    expect(checkDelegationParent(markedParent("full-access").rules, ASK)).toEqual({
      status: "allowed",
      ceiling: "full-access",
    });
  });

  it("refuses a Plan thread that read outside content and holds no answer", () => {
    expect(checkDelegationParent(markedParent("plan").rules, ASK)).toEqual({
      status: "refused",
      kind: "parent-tainted",
    });
  });
});
