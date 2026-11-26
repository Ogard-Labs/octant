import { describe, expect, it } from "vitest";
import type { LinearWorkflowState, LinkedIssueRef } from "@octant/contracts";
import {
  chooseLinearIssueState,
  decideAgentIssueUpdate,
  decideGithubIssueMoment,
  parseLinkedIssueReference,
  withLinkedIssueReferences,
} from "./trackerIssueWritePolicy";

const state = (id: string, name: string, type: string, position: number): LinearWorkflowState => ({
  id,
  name,
  type,
  position,
});
const backlog = state("s-backlog", "Backlog", "backlog", 0);
const todo = state("s-todo", "Todo", "unstarted", 1);
const progress = state("s-progress", "In Progress", "started", 2);
const review = state("s-review", "In Review", "started", 3);
const done = state("s-done", "Done", "completed", 4);
const canceled = state("s-canceled", "Canceled", "canceled", 5);
const team = [backlog, todo, progress, review, done, canceled];

describe("chooseLinearIssueState", () => {
  it("moves an unstarted issue to In Progress, then In Review, then Done", () => {
    expect(chooseLinearIssueState({ moment: "in-progress", current: todo, states: team })).toEqual({
      kind: "set",
      state: progress,
    });
    expect(
      chooseLinearIssueState({ moment: "in-review", current: progress, states: team }),
    ).toEqual({ kind: "set", state: review });
    expect(chooseLinearIssueState({ moment: "done", current: review, states: team })).toEqual({
      kind: "set",
      state: done,
    });
  });

  it("never moves an issue backwards", () => {
    expect(
      chooseLinearIssueState({ moment: "in-progress", current: review, states: team }),
    ).toEqual({ kind: "skip", reason: "already-there" });
    expect(chooseLinearIssueState({ moment: "in-review", current: done, states: team })).toEqual({
      kind: "skip",
      reason: "already-there",
    });
    expect(chooseLinearIssueState({ moment: "done", current: canceled, states: team })).toEqual({
      kind: "skip",
      reason: "already-there",
    });
  });

  it("skips In Review on a team with no review state", () => {
    expect(
      chooseLinearIssueState({
        moment: "in-review",
        current: progress,
        states: [todo, progress, done],
      }),
    ).toEqual({ kind: "skip", reason: "no-matching-state" });
  });

  it("falls back to the first started and completed states by position", () => {
    const doing = state("s-doing", "Doing", "started", 7);
    const shipped = state("s-shipped", "Shipped", "completed", 9);
    expect(
      chooseLinearIssueState({ moment: "in-progress", current: todo, states: [todo, doing] }),
    ).toEqual({ kind: "set", state: doing });
    expect(
      chooseLinearIssueState({ moment: "done", current: doing, states: [doing, shipped] }),
    ).toEqual({ kind: "set", state: shipped });
  });
});

describe("decideGithubIssueMoment", () => {
  it("closes on done and skips the moments GitHub has no state for", () => {
    expect(decideGithubIssueMoment({ moment: "in-progress", open: true })).toEqual({
      kind: "skip",
      reason: "no-state-on-github",
    });
    expect(decideGithubIssueMoment({ moment: "in-review", open: true })).toEqual({
      kind: "skip",
      reason: "no-state-on-github",
    });
    expect(decideGithubIssueMoment({ moment: "done", open: true })).toEqual({ kind: "close" });
    expect(decideGithubIssueMoment({ moment: "done", open: false })).toEqual({
      kind: "already-closed",
    });
  });
});

describe("decideAgentIssueUpdate", () => {
  const linear: LinkedIssueRef = { forge: "linear", identifier: "ENG-1", issueId: "abc" };
  const base = {
    posture: "approval-gated" as const,
    issue: linear,
    linked: [linear],
    projectAllowsUpdates: false,
    readOutsideContent: false,
  };

  it("refuses in Plan and refuses an issue the thread is not linked to", () => {
    expect(decideAgentIssueUpdate({ ...base, posture: "plan" })).toEqual({
      decision: "refuse",
      reason: "plan",
    });
    expect(decideAgentIssueUpdate({ ...base, posture: "full-access", linked: [] })).toEqual({
      decision: "refuse",
      reason: "not-linked",
    });
  });

  it("does not ask at Full access, and asks below it unless the Project allows", () => {
    expect(decideAgentIssueUpdate({ ...base, posture: "full-access" })).toEqual({
      decision: "write",
    });
    expect(decideAgentIssueUpdate(base)).toEqual({ decision: "ask" });
    expect(decideAgentIssueUpdate({ ...base, projectAllowsUpdates: true })).toEqual({
      decision: "write-on-project-choice",
    });
    expect(
      decideAgentIssueUpdate({ ...base, projectAllowsUpdates: true, readOutsideContent: true }),
    ).toEqual({ decision: "ask" });
  });
});

describe("withLinkedIssueReferences", () => {
  const github: LinkedIssueRef = {
    forge: "github",
    owner: "acme",
    repository: "app",
    number: 12,
  };
  const other: LinkedIssueRef = {
    forge: "github",
    owner: "acme",
    repository: "docs",
    number: 3,
  };
  const linear: LinkedIssueRef = { forge: "linear", identifier: "ENG-7", issueId: "abc" };

  it("adds a closing reference for each linked issue the body does not name", () => {
    expect(
      withLinkedIssueReferences({
        body: "Adds the thing.",
        issues: [github, other, linear],
        baseRepository: "acme/app",
      }),
    ).toBe("Adds the thing.\n\nFixes #12\nFixes acme/docs#3\nFixes ENG-7");
  });

  it("leaves a body that already names the issue alone", () => {
    expect(
      withLinkedIssueReferences({
        body: "Closes #12 and ENG-7.",
        issues: [github, linear],
        baseRepository: "acme/app",
      }),
    ).toBe("Closes #12 and ENG-7.");
    expect(withLinkedIssueReferences({ body: "", issues: [linear], baseRepository: "a/b" })).toBe(
      "Fixes ENG-7",
    );
  });
});

describe("parseLinkedIssueReference", () => {
  it("reads a number in the delivery repository, a full GitHub reference, and a Linear identifier", () => {
    expect(parseLinkedIssueReference("#12", "acme/app")).toEqual({
      forge: "github",
      owner: "acme",
      repository: "app",
      number: 12,
    });
    expect(parseLinkedIssueReference("other/lib#4", undefined)).toEqual({
      forge: "github",
      owner: "other",
      repository: "lib",
      number: 4,
    });
    expect(parseLinkedIssueReference("eng-42", undefined)).toEqual({
      forge: "linear",
      identifier: "ENG-42",
    });
    expect(parseLinkedIssueReference("#12", undefined)).toBeUndefined();
    expect(parseLinkedIssueReference("not an issue", "acme/app")).toBeUndefined();
  });
});
