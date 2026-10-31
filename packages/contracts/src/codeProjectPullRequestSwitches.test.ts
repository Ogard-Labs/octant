import { describe, expect, it } from "vitest";
import {
  decodeCodeProjectPullRequestAutoFixCommand,
  decodeCodeProjectPullRequestAutoFixRecorded,
  decodeCodeProjectPullRequestMergeWhenReadyCommand,
  decodeCodeProjectPullRequestSwitchOutcome,
} from "./codeProjectPullRequestSwitches";

const target = {
  projectId: "10000000-0000-4000-8000-000000000001",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
};
const threadId = "20000000-0000-4000-8000-000000000001";

describe("pull-request switch contracts", () => {
  it("requires the seen head to turn Merge when ready on, and refuses a renderer-supplied identity", () => {
    expect(
      decodeCodeProjectPullRequestMergeWhenReadyCommand({ kind: "enable", target, headSha: "a1" }),
    ).toEqual({ kind: "enable", target, headSha: "a1" });
    expect(() =>
      decodeCodeProjectPullRequestMergeWhenReadyCommand({ kind: "enable", target }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestMergeWhenReadyCommand({
        kind: "disable",
        target,
        windowId: "00000000-0000-4000-8000-000000000901",
      }),
    ).toThrow();
  });

  it("names the thread an Auto-fix switch wakes", () => {
    expect(
      decodeCodeProjectPullRequestAutoFixCommand({ kind: "enable", target, threadId }),
    ).toEqual({ kind: "enable", target, threadId });
    expect(() => decodeCodeProjectPullRequestAutoFixCommand({ kind: "enable", target })).toThrow();
  });

  it("journals a wake by failure identity and attempt, within the attempt limit", () => {
    const wake = {
      target,
      threadId,
      change: {
        kind: "woke",
        headSha: "a1",
        failures: [{ kind: "check", key: "lint" }],
        attempt: 3,
        result: "started",
      },
    };
    expect(decodeCodeProjectPullRequestAutoFixRecorded(wake)).toEqual(wake);
    expect(() =>
      decodeCodeProjectPullRequestAutoFixRecorded({
        ...wake,
        change: { ...wake.change, attempt: 4 },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestAutoFixRecorded({
        ...wake,
        change: { ...wake.change, failures: [] },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeProjectPullRequestAutoFixRecorded({
        ...wake,
        change: { ...wake.change, log: "error text" },
      }),
    ).toThrow();
  });

  it("answers an unsupported forge as a value, not an error", () => {
    expect(
      decodeCodeProjectPullRequestSwitchOutcome({
        status: "unsupported",
        reason: "auto-merge-not-allowed",
      }),
    ).toEqual({ status: "unsupported", reason: "auto-merge-not-allowed" });
  });
});
