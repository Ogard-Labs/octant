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
    sessionStatus: () => sessionStatus,
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
});
