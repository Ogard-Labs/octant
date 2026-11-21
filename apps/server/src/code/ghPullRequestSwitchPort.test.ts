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

  it("reads only merge state and optional required checks for a coordinator done-when condition", async () => {
    const { port: forge, run } = port((args) =>
      args[1] === "checks"
        ? {
            exitCode: 0,
            stdout: JSON.stringify([{ name: "test", bucket: "pass", link: "" }]),
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "MERGED",
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
            }),
          },
    );

    const stateOnly = await forge.observePullRequestCondition(
      request,
      { requiredChecks: false },
      signal,
    );
    expect(stateOnly).toEqual({ status: "observed", state: "merged" });
    expect(run).toHaveBeenCalledTimes(1);

    const withChecks = await forge.observePullRequestCondition(
      request,
      { requiredChecks: true },
      signal,
    );
    expect(withChecks).toEqual({
      status: "observed",
      state: "merged",
      requiredChecks: "green",
    });
    expect(run).toHaveBeenCalledTimes(3);

    const rollupResponse = (
      headNodes: ReadonlyArray<unknown>,
      mergeNodes?: ReadonlyArray<unknown>,
    ) => ({
      exitCode: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: "1".repeat(40),
                      statusCheckRollup: {
                        contexts: {
                          nodes: headNodes,
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                ],
              },
              potentialMergeCommit:
                mergeNodes === undefined
                  ? null
                  : {
                      oid: "2".repeat(40),
                      statusCheckRollup: {
                        contexts: {
                          nodes: mergeNodes,
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
            },
          },
        },
      }),
    });

    // Unreported required checks stay pending when the base branch requires checks.
    const unreported = port((args) => {
      if (args[1] === "checks") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "no required checks reported on the 'feature/x' branch",
        };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return rollupResponse([]);
      }
      if (args[0] === "api" && args.some((arg) => arg.includes("/rules/branches/main"))) {
        return { exitCode: 0, stdout: JSON.stringify([[]]) };
      }
      if (args[0] === "api" && args[1]?.includes("/branches/main")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            protected: true,
            protection: {
              enabled: true,
              required_status_checks: { contexts: ["test"], checks: [{ context: "test" }] },
            },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
        }),
      };
    }).port;
    expect(
      await unreported.observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });

    // Partially reported required checks stay pending until every required context has passed.
    const partialChecks = (
      reported: ReadonlyArray<{ readonly name: string; readonly bucket: string }>,
    ) =>
      port((args) => {
        if (args[1] === "checks") {
          return { exitCode: 0, stdout: JSON.stringify(reported) };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse(
            reported.map((entry) => ({
              __typename: "CheckRun",
              name: entry.name,
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { app: { databaseId: 15368 } },
            })),
          );
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [{ context: "lint" }, { context: "test" }],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    expect(
      await partialChecks([{ name: "lint", bucket: "pass" }]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await partialChecks([
        { name: "lint", bucket: "pass" },
        { name: "test", bucket: "pass" },
      ]).observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // A review-blocked PR whose required checks all pass on the test merge commit reports green,
    // while passing checks split across head and test-merge commits are never mixed.
    const testMergePort = (headNodes: ReadonlyArray<unknown>, mergeNodes: ReadonlyArray<unknown>) =>
      port((args) => {
        if (args[1] === "checks") {
          return { exitCode: 0, stdout: JSON.stringify([{ name: "lint", bucket: "pass" }]) };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse(headNodes, mergeNodes);
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [{ context: "lint" }, { context: "integration" }],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    const passRun = (name: string, appId = 15368) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      checkSuite: { app: { databaseId: appId } },
    });
    const failRun = (name: string, appId = 15368) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion: "FAILURE",
      checkSuite: { app: { databaseId: appId } },
    });
    expect(
      await testMergePort(
        [passRun("lint")],
        [passRun("lint"), passRun("integration")],
      ).observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });
    expect(
      await testMergePort([passRun("lint")], [passRun("integration")]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await testMergePort(
        [passRun("lint")],
        [passRun("lint"), failRun("integration")],
      ).observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "failing" });

    // Same-name required checks from distinct GitHub Apps must each pass under their pinned app.
    const multiAppPort = (headNodes: ReadonlyArray<unknown>) =>
      port((args) => {
        if (args[1] === "checks") {
          return { exitCode: 0, stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]) };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse(headNodes);
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [
                      { context: "ci", integration_id: 100 },
                      { context: "ci", integration_id: 200 },
                    ],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    expect(
      await multiAppPort([passRun("ci", 100)]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await multiAppPort([passRun("ci", 100), passRun("ci", 200)]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // An app-pinned StatusContext passes only when GitHub marks it isRequired on the PR.
    const statusContextPort = (isRequired: boolean) =>
      port((args) => {
        if (args[1] === "checks") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ name: "deploy-check", bucket: "pass" }]),
          };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse([
            {
              __typename: "StatusContext",
              context: "deploy-check",
              state: "SUCCESS",
              createdAt: "2026-11-21T10:00:00Z",
              isRequired,
            },
          ]);
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [{ context: "deploy-check", integration_id: 300 }],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    expect(
      await statusContextPort(true).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });
    expect(
      await statusContextPort(false).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });

    // A newer passing rerun supersedes an older failed CheckRun of the same check identity.
    const rerunPort = (headNodes: ReadonlyArray<unknown>) =>
      port((args) => {
        if (args[1] === "checks") {
          return { exitCode: 0, stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]) };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse(headNodes);
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [{ context: "ci", integration_id: 15368 }],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    const oldFail = {
      __typename: "CheckRun",
      databaseId: 101,
      name: "ci",
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-11-21T10:00:00Z",
      completedAt: "2026-11-21T10:01:00Z",
      checkSuite: {
        id: "CS_1",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_ci" } },
      },
    };
    const newPass = {
      __typename: "CheckRun",
      databaseId: 102,
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-11-21T10:05:00Z",
      completedAt: "2026-11-21T10:06:00Z",
      checkSuite: {
        id: "CS_2",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_ci" } },
      },
    };
    expect(
      await rerunPort([oldFail, newPass]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });
    expect(
      await rerunPort([newPass, oldFail]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // A queued rerun without startedAt/completedAt stays pending over an earlier passing run.
    const queuedRerun = {
      __typename: "CheckRun",
      databaseId: 103,
      name: "ci",
      status: "QUEUED",
      conclusion: null,
      startedAt: null,
      completedAt: null,
      checkSuite: {
        id: "CS_3",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_ci" } },
      },
    };
    expect(
      await rerunPort([newPass, queuedRerun]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await rerunPort([queuedRerun, newPass]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    const undatedPass = {
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-11-21T10:05:00Z",
      completedAt: "2026-11-21T10:06:00Z",
      checkSuite: {
        id: "CS_4",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_ci" } },
      },
    };
    const undatedQueued = {
      __typename: "CheckRun",
      name: "ci",
      status: "QUEUED",
      conclusion: null,
      startedAt: null,
      completedAt: null,
      checkSuite: {
        id: "CS_5",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_ci" } },
      },
    };
    expect(
      await rerunPort([undatedPass, undatedQueued]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await rerunPort([undatedQueued, undatedPass]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });

    // Distinct workflows with different workflow ids never hide each other's failures.
    const workflowAFail = {
      __typename: "CheckRun",
      databaseId: 201,
      name: "ci",
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-11-21T10:00:00Z",
      completedAt: "2026-11-21T10:01:00Z",
      checkSuite: {
        id: "CS_a",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_1" } },
      },
    };
    const workflowBPass = {
      __typename: "CheckRun",
      databaseId: 202,
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-11-21T10:05:00Z",
      completedAt: "2026-11-21T10:06:00Z",
      checkSuite: {
        id: "CS_b",
        app: { databaseId: 15368 },
        workflowRun: { workflow: { id: "W_2" } },
      },
    };
    expect(
      await rerunPort([workflowAFail, workflowBPass]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "failing" });

    // When a context has both an any-source rule and an app-pinned rule, an isRequired
    // StatusContext satisfies only the any-source rule and leaves the app pin pending.
    const overlappingRulesPort = (headNodes: ReadonlyArray<unknown>) =>
      port((args) => {
        if (args[1] === "checks") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ name: "deploy-check", bucket: "pass" }]),
          };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return rollupResponse(headNodes);
        }
        if (
          args[0] === "api" &&
          args.includes("--paginate") &&
          args.includes("--slurp") &&
          args.some((arg) => arg.includes("/rules/branches/main"))
        ) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: [
                      { context: "deploy-check" },
                      { context: "deploy-check", integration_id: 300 },
                    ],
                  },
                },
              ],
            ]),
          };
        }
        if (args[0] === "api" && args[1]?.includes("/branches/main")) {
          return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            baseRefName: "main",
            mergeStateStatus: "BLOCKED",
          }),
        };
      }).port;
    const statusOnly = {
      __typename: "StatusContext",
      context: "deploy-check",
      state: "SUCCESS",
      createdAt: "2026-11-21T10:00:00Z",
      isRequired: true,
    };
    expect(
      await overlappingRulesPort([statusOnly]).observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });
    expect(
      await overlappingRulesPort([
        statusOnly,
        passRun("deploy-check", 300),
      ]).observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // Multi-page commit rollups paginate through pullRequest(number:) so fork head commits work.
    const paginatedQueries: string[] = [];
    const paginatedPort = port((args) => {
      if (args[1] === "checks") {
        return { exitCode: 0, stdout: JSON.stringify([{ name: "lint", bucket: "pass" }]) };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const queryArg = args.find((arg) => arg.startsWith("query=")) ?? "";
        paginatedQueries.push(queryArg);
        const isPageTwo = args.includes("cursor=cursor-1");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: "1".repeat(40),
                          statusCheckRollup: {
                            contexts: {
                              nodes: [isPageTwo ? passRun("integration") : passRun("lint")],
                              pageInfo: isPageTwo
                                ? { hasNextPage: false, endCursor: null }
                                : { hasNextPage: true, endCursor: "cursor-1" },
                            },
                          },
                        },
                      },
                    ],
                  },
                  potentialMergeCommit: null,
                },
              },
            },
          }),
        };
      }
      if (
        args[0] === "api" &&
        args.includes("--paginate") &&
        args.includes("--slurp") &&
        args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            [
              {
                type: "required_status_checks",
                parameters: {
                  required_status_checks: [{ context: "lint" }, { context: "integration" }],
                },
              },
            ],
          ]),
        };
      }
      if (args[0] === "api" && args[1]?.includes("/branches/main")) {
        return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
        }),
      };
    }).port;
    expect(
      await paginatedPort.observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });
    expect(paginatedQueries).toHaveLength(2);
    expect(paginatedQueries[1]).not.toContain("object(oid:");
    expect(paginatedQueries[1]).toContain("pullRequest(number:");

    // A branch requiring only review approval (BLOCKED) with zero required checks reports green.
    const reviewOnlyBlocked = port((args) => {
      if (args[1] === "checks") {
        return { exitCode: 0, stdout: "[]" };
      }
      if (
        args[0] === "api" &&
        args.includes("--paginate") &&
        args.includes("--slurp") &&
        args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
          ]),
        };
      }
      if (args[0] === "api" && args[1]?.includes("/branches/main")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            protected: true,
            protection: {
              enabled: true,
              required_status_checks: { contexts: [], checks: [] },
            },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
        }),
      };
    }).port;
    expect(
      await reviewOnlyBlocked.observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // Ruleset-required check on a later rules page still keeps unreported checks pending.
    const rulesetUnreported = port((args) => {
      if (args[1] === "checks") return { exitCode: 0, stdout: "[]" };
      if (args[0] === "api" && args[1] === "graphql") return rollupResponse([]);
      if (
        args[0] === "api" &&
        args.includes("--paginate") &&
        args.includes("--slurp") &&
        args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
            [
              {
                type: "required_status_checks",
                parameters: { required_status_checks: [{ context: "ci" }] },
              },
            ],
          ]),
        };
      }
      if (args[0] === "api" && args[1]?.includes("/branches/main")) {
        return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
        }),
      };
    }).port;
    expect(
      await rulesetUnreported.observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "pending" });

    // A malformed rules page fails closed as unavailable rather than reporting green.
    const malformedRulesPage = port((args) => {
      if (args[1] === "checks") return { exitCode: 0, stdout: "[]" };
      if (
        args[0] === "api" &&
        args.includes("--paginate") &&
        args.includes("--slurp") &&
        args.some((arg) => arg.includes("/rules/branches/main"))
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
            { unexpected: true },
          ]),
        };
      }
      if (args[0] === "api" && args[1]?.includes("/branches/main")) {
        return { exitCode: 0, stdout: JSON.stringify({ protected: false }) };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
        }),
      };
    }).port;
    expect(
      await malformedRulesPage.observePullRequestCondition(
        request,
        { requiredChecks: true },
        signal,
      ),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "unavailable" });

    // Empty check array with CLEAN merge state confirms no required checks are missing.
    const noRequiredClean = port((args) =>
      args[1] === "checks"
        ? { exitCode: 0, stdout: "[]" }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
            }),
          },
    ).port;
    expect(
      await noRequiredClean.observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "green" });

    // Unknown check bucket fails closed as unavailable.
    const unknownBucket = port((args) =>
      args[1] === "checks"
        ? { exitCode: 0, stdout: JSON.stringify([{ name: "ci", bucket: "mystery" }]) }
        : { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeStateStatus: "UNSTABLE" }) },
    ).port;
    expect(
      await unknownBucket.observePullRequestCondition(request, { requiredChecks: true }, signal),
    ).toEqual({ status: "observed", state: "open", requiredChecks: "unavailable" });
  });
});
