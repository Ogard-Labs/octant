import { describe, expect, it, vi } from "vitest";
import type { GhCommandPort, GhCommandResult } from "./ghPullRequestPort";
import { GhPullRequestSwitchPort } from "./ghPullRequestSwitchPort";

const signal = new AbortController().signal;
const request = { owner: "octant", name: "octant", number: 12 };

function port(answer: (arguments_: readonly string[]) => GhCommandResult) {
  const run = vi.fn<GhCommandPort["run"]>(async (arguments_) => answer(arguments_));
  return { run, port: new GhPullRequestSwitchPort({ command: { run }, inheritedEnvironment: {} }) };
}

describe("forge switch port", () => {
  it("asks the forge for auto-merge pinned to the seen head, never a direct merge", async () => {
    const { run, port: forge } = port(() => ({ exitCode: 0, stdout: "" }));
    const result = await forge.enableAutoMerge(
      { ...request, method: "squash", headSha: "a1" },
      signal,
    );
    expect(result).toEqual({ status: "enabled" });
    expect(run.mock.calls[0]?.[0]).toEqual([
      "pr",
      "merge",
      "12",
      "--repo",
      "octant/octant",
      "--auto",
      "--squash",
      "--match-head-commit",
      "a1",
    ]);
  });

  it("reports a repository that refuses auto-merge as unsupported", async () => {
    const { port: forge } = port(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)",
    }));
    expect(
      await forge.enableAutoMerge({ ...request, method: "merge", headSha: "a1" }, signal),
    ).toEqual({ status: "unsupported", reason: "auto-merge-not-allowed" });
  });

  it("reads the repository's auto-merge and merge-method settings", async () => {
    const { port: forge } = port(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        allow_auto_merge: false,
        allow_merge_commit: true,
        allow_squash_merge: false,
        allow_rebase_merge: true,
      }),
    }));
    expect(await forge.readAutoMergeSettings(request, signal)).toEqual({
      status: "read",
      allowAutoMerge: false,
      methods: { merge: true, squash: false, rebase: true },
    });
  });

  it("observes failed required checks with a log tail, open review threads, and a conflict", async () => {
    const { port: forge } = port((arguments_) => {
      if (arguments_[0] === "pr" && arguments_[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: "a1",
            headRefName: "feature/x",
            baseRefName: "main",
            mergeable: "CONFLICTING",
            autoMergeRequest: null,
            reviewDecision: "APPROVED",
          }),
        };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "checks") {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              name: "lint",
              bucket: "fail",
              link: "https://github.com/octant/octant/actions/runs/5/job/77",
            },
            { name: "test", bucket: "pass", link: "" },
          ]),
        };
      }
      if (arguments_[0] === "run") return { exitCode: 0, stdout: "x".repeat(10_000) + "boom" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "RT_1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/a.ts",
                      line: 3,
                      comments: { nodes: [{ author: { login: "rev" }, body: "Rename this" }] },
                    },
                    { id: "RT_2", isResolved: true, isOutdated: false, comments: { nodes: [] } },
                  ],
                },
              },
            },
          },
        }),
      };
    });
    const observation = await forge.observe(request, signal);
    expect(observation).toMatchObject({
      status: "observed",
      state: "open",
      headSha: "a1",
      autoMergeEnabled: false,
      waitingOn: ["checks", "reviews", "conflicts"],
    });
    if (observation.status !== "observed") throw new Error("expected an observation");
    expect(observation.failures.map((entry) => entry.failure)).toEqual([
      { kind: "check", key: "lint" },
      { kind: "review-thread", key: "RT_1" },
      { kind: "conflict", key: "base" },
    ]);
    expect(observation.failures[0]?.detail.endsWith("boom")).toBe(true);
    expect(observation.failures[0]?.detail.length).toBeLessThan(4_200);
    expect(observation.failures[1]?.detail).toContain("src/a.ts:3");
    expect(observation.failures[1]?.detail).toContain("rev: Rename this");
  });
});
