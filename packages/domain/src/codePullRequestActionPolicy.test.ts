import { describe, expect, it } from "vitest";
import {
  decidePushBranch,
  decideRemotePullRequestMerge,
  decideStackMerge,
  pullRequestChangeNeedsPerActApproval,
} from "./codePullRequestActionPolicy";

const branches = { ownBranch: "feature/a", baseBranch: "main" } as const;

describe("push branch policy", () => {
  it("lets a thread push its own branch without a per-act approval", () => {
    expect(
      decidePushBranch({ ...branches, remoteBranch: "feature/a", approvedForThisAct: false }),
    ).toEqual({ decision: "allow" });
  });

  it("lets a force-with-lease replace only the expected head of its own branch", () => {
    const force = { mode: "with-lease", expectedRemoteOid: "a".repeat(40) } as const;
    expect(
      decidePushBranch({
        ...branches,
        remoteBranch: "feature/a",
        force,
        approvedForThisAct: false,
      }),
    ).toEqual({ decision: "allow" });
    expect(
      decidePushBranch({
        ...branches,
        remoteBranch: "feature/a",
        force: { mode: "with-lease" },
        approvedForThisAct: true,
      }),
    ).toEqual({ decision: "refuse", reason: "lease-missing" });
  });

  it("refuses any push to a branch the thread does not own, however it was approved", () => {
    for (const force of [
      undefined,
      { mode: "with-lease", expectedRemoteOid: "b".repeat(40) } as const,
      { mode: "plain" } as const,
    ]) {
      expect(
        decidePushBranch({
          ...branches,
          remoteBranch: "feature/other",
          ...(force === undefined ? {} : { force }),
          approvedForThisAct: true,
        }),
      ).toEqual({ decision: "refuse", reason: "not-own-branch" });
    }
  });

  it("opens a plain force-push and the default branch only for this one act", () => {
    expect(
      decidePushBranch({
        ...branches,
        remoteBranch: "feature/a",
        force: { mode: "plain" },
        approvedForThisAct: false,
      }),
    ).toEqual({ decision: "refuse", reason: "needs-the-persons-request" });
    expect(
      decidePushBranch({ ...branches, remoteBranch: "main", approvedForThisAct: false }),
    ).toEqual({ decision: "refuse", reason: "needs-the-persons-request" });
    expect(
      decidePushBranch({
        ...branches,
        remoteBranch: "main",
        force: { mode: "plain" },
        approvedForThisAct: true,
      }),
    ).toEqual({ decision: "allow" });
  });
});

describe("pull-request merge policy", () => {
  it("merges only on the person's confirmation with required checks passing", () => {
    const base = { caller: "remote-device", confirmed: true } as const;
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "passing" }).decision).toBe(
      "allow",
    );
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "none" }).decision).toBe(
      "allow",
    );
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "failing" })).toEqual({
      decision: "refuse",
      reason: "checks-not-passing",
    });
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "pending" })).toEqual({
      decision: "refuse",
      reason: "checks-not-passing",
    });
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "unknown" })).toEqual({
      decision: "refuse",
      reason: "checks-unknown",
    });
    expect(
      decideRemotePullRequestMerge({ ...base, confirmed: false, requiredChecks: "passing" }),
    ).toEqual({ decision: "refuse", reason: "not-confirmed" });
  });

  it("holds an agent on a stored choice to the same checks as one on request", () => {
    const base = { caller: "agent-on-standing-permission", confirmed: true } as const;
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "passing" })).toEqual({
      decision: "allow",
    });
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "pending" })).toEqual({
      decision: "refuse",
      reason: "checks-not-passing",
    });
    expect(decideRemotePullRequestMerge({ ...base, requiredChecks: "unknown" })).toEqual({
      decision: "refuse",
      reason: "checks-unknown",
    });
  });

  it("refuses an agent merging on its own initiative", () => {
    expect(
      decideRemotePullRequestMerge({
        caller: "agent-on-its-own",
        confirmed: true,
        requiredChecks: "passing",
      }),
    ).toEqual({ decision: "refuse", reason: "not-authorized" });
  });

  it("asks for the person at every level for a merge and a comment, not for a label", () => {
    expect(pullRequestChangeNeedsPerActApproval("merge")).toBe(true);
    expect(pullRequestChangeNeedsPerActApproval("comment")).toBe(true);
    expect(pullRequestChangeNeedsPerActApproval("labels")).toBe(false);
    expect(pullRequestChangeNeedsPerActApproval("close")).toBe(false);
  });
});

describe("stack merge policy", () => {
  const pr = (number: number, headBranch: string, baseBranch: string) => ({
    number,
    headBranch,
    baseBranch,
  });

  it("accepts a chain from the bottom", () => {
    expect(decideStackMerge([pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b")])).toEqual({
      decision: "allow",
    });
  });

  it("refuses an empty, repeated, over-long, or broken chain whole", () => {
    expect(decideStackMerge([])).toEqual({ decision: "refuse", reason: "empty" });
    expect(decideStackMerge([pr(1, "a", "main"), pr(1, "a", "main")])).toEqual({
      decision: "refuse",
      reason: "duplicate",
    });
    expect(decideStackMerge([pr(1, "a", "main"), pr(2, "b", "main")])).toEqual({
      decision: "refuse",
      reason: "not-a-chain",
    });
    const long = Array.from({ length: 11 }, (_, i) =>
      pr(i + 1, `b${i}`, i === 0 ? "main" : `b${i - 1}`),
    );
    expect(decideStackMerge(long)).toEqual({ decision: "refuse", reason: "too-long" });
  });
});
