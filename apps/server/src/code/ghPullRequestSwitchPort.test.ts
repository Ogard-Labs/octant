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

  it("finds an unresolved review thread that sits past the first page", async () => {
    const pageOf = (nodes: unknown[], endCursor: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: endCursor !== null, endCursor },
                nodes,
              },
            },
          },
        },
      });
    const resolved = Array.from({ length: 50 }, (_, index) => ({
      id: `RT_done_${String(index)}`,
      isResolved: true,
      isOutdated: false,
      comments: { nodes: [] },
    }));
    const { run, port: forge } = port((arguments_) => {
      if (arguments_[0] === "pr" && arguments_[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: "a1",
            headRefName: "feature/x",
            baseRefName: "main",
            mergeable: "MERGEABLE",
            autoMergeRequest: null,
            reviewDecision: "REVIEW_REQUIRED",
          }),
        };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "checks")
        return { exitCode: 0, stdout: "[]" };
      return arguments_.includes("after=CURSOR_1")
        ? {
            exitCode: 0,
            stdout: pageOf(
              [
                {
                  id: "RT_late",
                  isResolved: false,
                  isOutdated: false,
                  path: "src/b.ts",
                  line: 9,
                  comments: { nodes: [{ author: { login: "rev" }, body: "Late comment" }] },
                },
              ],
              null,
            ),
          }
        : { exitCode: 0, stdout: pageOf(resolved, "CURSOR_1") };
    });
    const observation = await forge.observe(request, signal);
    if (observation.status !== "observed") throw new Error("expected an observation");
    expect(observation.failures.map((entry) => entry.failure)).toEqual([
      { kind: "review-thread", key: "RT_late" },
    ]);
    expect(run.mock.calls.filter(([arguments_]) => arguments_[0] === "api")).toHaveLength(2);
  });

  it("reads a watch's activity from one view and one bounded discussion read, without the Auto-fix reads", async () => {
    const { run, port: forge } = port((arguments_) =>
      arguments_[0] === "api"
        ? {
            exitCode: 0,
            // What the `--jq` filter prints: the newest reviews and comments,
            // bodies already cut inside `gh`.
            stdout: JSON.stringify({
              reviews: [
                {
                  id: "PRR_1",
                  author: { login: "rev" },
                  state: "CHANGES_REQUESTED",
                  submittedAt: "2026-11-01T10:30:00Z",
                  body: "Please rename.",
                },
                { id: "PRR_draft", author: { login: "rev" }, state: "PENDING", body: "unsent" },
              ],
              comments: [
                {
                  id: "IC_1",
                  author: { login: "teammate" },
                  createdAt: "2026-11-01T10:40:00Z",
                  body: "Looks close.",
                  viewerDidAuthor: false,
                },
                {
                  id: "IC_mine",
                  author: { login: "me" },
                  createdAt: "2026-11-01T10:45:00Z",
                  body: "Posted under the person's name.",
                  viewerDidAuthor: true,
                },
              ],
            }),
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              headRefOid: "a1",
              headRefName: "feature/x",
              baseRefName: "main",
              mergeable: "MERGEABLE",
              autoMergeRequest: null,
              reviewDecision: "CHANGES_REQUESTED",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                },
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
                { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
              ],
            }),
          },
    );
    const observation = await forge.observe(request, signal, { failures: false, activity: true });
    expect(run).toHaveBeenCalledTimes(2);
    const view = run.mock.calls[0]?.[0] ?? [];
    expect(view.slice(0, 2)).toEqual(["pr", "view"]);
    expect(view.at(-1)).toContain("statusCheckRollup");
    // `gh pr view --json reviews,comments` pages through the whole history and
    // can outgrow the command's output cap on a long discussion.
    expect(view.at(-1)).not.toMatch(/reviews|comments/);
    const discussion = run.mock.calls[1]?.[0] ?? [];
    expect(discussion.slice(0, 2)).toEqual(["api", "graphql"]);
    const query = discussion.find((argument) => argument.startsWith("query=")) ?? "";
    expect(query).toContain("reviews(last:50)");
    expect(query).toContain("comments(last:50)");
    expect(query).not.toContain("octant");
    expect(discussion).toEqual(
      expect.arrayContaining(["-F", "owner=octant", "-F", "name=octant", "-F", "number=12"]),
    );
    const filter = discussion[discussion.indexOf("--jq") + 1] ?? "";
    expect(filter).toContain('.body // "")[0:2049]');
    expect(filter).toContain("tojson");
    if (observation.status !== "observed") throw new Error("expected an observation");
    expect(observation.failures).toEqual([]);
    expect(observation.activity).toEqual({
      checks: "failed",
      failedChecks: ["lint"],
      reviewDecision: "changes-requested",
      conflicting: false,
      reviews: [
        {
          id: "PRR_1",
          author: "rev",
          state: "changes requested",
          at: "2026-11-01T10:30:00Z",
          body: "Please rename.",
        },
      ],
      comments: [
        { id: "IC_1", author: "teammate", at: "2026-11-01T10:40:00Z", body: "Looks close." },
      ],
    });
  });

  it("calls checks settled only once none on the head is still running", async () => {
    const rollup = (entries: unknown[]) =>
      port(() => ({
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          headRefOid: "a1",
          mergeable: "CONFLICTING",
          reviewDecision: "",
          statusCheckRollup: entries,
          reviews: [],
          comments: [],
        }),
      })).port;
    const checksOf = async (entries: unknown[]) => {
      const observation = await rollup(entries).observe(request, signal, {
        failures: false,
        activity: true,
      });
      return observation.status === "observed" ? observation.activity : undefined;
    };
    expect(await checksOf([])).toMatchObject({ checks: "none", conflicting: true });
    expect(
      await checksOf([
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" },
      ]),
    ).toMatchObject({ checks: "pending" });
    expect(
      await checksOf([
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", context: "ci", state: "PENDING" },
      ]),
    ).toMatchObject({ checks: "pending" });
    const passed = await checksOf([
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
      { __typename: "StatusContext", context: "ci", state: "SUCCESS" },
    ]);
    expect(passed).toMatchObject({ checks: "passed", failedChecks: [] });
    expect(passed?.reviewDecision).toBeUndefined();
  });
});
