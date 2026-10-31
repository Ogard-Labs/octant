import { describe, expect, it, vi } from "vitest";
import { GhPullRequestActionPort } from "./ghPullRequestActionPort";
import type { GhCommandOptions, GhCommandPort, GhCommandResult } from "./ghPullRequestPort";

const identity = { owner: "octant", name: "octant", number: 7 } as const;
const signal = new AbortController().signal;

function fixture(results: ReadonlyArray<GhCommandResult | Error>) {
  const queue = [...results];
  const run = vi.fn(
    async (_arguments: readonly string[], _options: GhCommandOptions, _signal: AbortSignal) => {
      const next = queue.shift() ?? { exitCode: 1, stdout: "" };
      if (next instanceof Error) throw next;
      return next;
    },
  );
  const command: GhCommandPort = { run };
  return {
    run,
    port: new GhPullRequestActionPort({
      command,
      inheritedEnvironment: { PATH: "/usr/bin", GH_TOKEN: "secret", GITHUB_TOKEN: "secret-too" },
    }),
  };
}

const threadOwner = (number: number, name = "octant") => ({
  exitCode: 0,
  stdout: JSON.stringify({
    data: { node: { pullRequest: { number, repository: { name, owner: { login: "octant" } } } } },
  }),
});

const view = (state: string) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    state,
    headRefName: "feature/a",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
  }),
});

describe("pull-request action context", () => {
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) });

  it("reads the pull request's labels, the repository's labels, and its review threads", async () => {
    const { port, run } = fixture([
      ok({ labels: [{ name: "bug" }] }),
      ok([{ name: "bug" }, { name: "p1" }]),
      ok({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_1",
                    isResolved: false,
                    isOutdated: true,
                    path: "src/a.ts",
                    comments: {
                      nodes: [{ author: { login: "reviewer" }, body: "Please rename." }],
                    },
                  },
                  { id: "bad id!", isResolved: false, comments: { nodes: [] } },
                ],
              },
            },
          },
        },
      }),
    ]);
    await expect(port.readContext(identity, signal)).resolves.toEqual({
      status: "read",
      labels: ["bug"],
      repositoryLabels: ["bug", "p1"],
      reviewThreads: [
        {
          id: "PRRT_1",
          resolved: false,
          outdated: true,
          path: "src/a.ts",
          author: "reviewer",
          excerpt: "Please rename.",
        },
      ],
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("reports a signed-out GitHub as unavailable and writes nothing", async () => {
    const { port, run } = fixture([
      { exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" },
      ok([]),
      ok({}),
    ]);
    await expect(port.readContext(identity, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "unauthenticated",
    });
    for (const call of run.mock.calls) {
      expect(call[0]).not.toContain("--add-label");
      expect(call[0]).not.toContain("mutation");
    }
  });
});

describe("pull-request action port", () => {
  it("adds and removes existing labels without a token in the environment", async () => {
    const { port, run } = fixture([{ exitCode: 0, stdout: "" }]);
    await expect(
      port.editLabels({ ...identity, add: ["bug", "p1"], remove: ["wip"] }, signal),
    ).resolves.toEqual({ status: "done" });
    expect(run.mock.calls[0]?.[0]).toEqual([
      "pr",
      "edit",
      "7",
      "--repo",
      "octant/octant",
      "--add-label",
      "bug,p1",
      "--remove-label",
      "wip",
    ]);
    const environment = run.mock.calls[0]?.[1].environment ?? {};
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
  });

  it("refuses to create a repository-wide label", async () => {
    const { port } = fixture([
      { exitCode: 1, stdout: "", stderr: "could not add label: 'new' not found" },
    ]);
    await expect(
      port.editLabels({ ...identity, add: ["new"], remove: [] }, signal),
    ).resolves.toEqual({ status: "refused", reason: "label-not-found" });
  });

  it("refuses malformed labels and too many labels before gh runs", async () => {
    const { port, run } = fixture([]);
    for (const labels of [
      ["a,b"],
      ["line\nbreak"],
      [""],
      Array.from({ length: 21 }, (_, i) => `l${i}`),
    ]) {
      await expect(
        port.editLabels({ ...identity, add: labels, remove: [] }, signal),
      ).resolves.toEqual({ status: "refused", reason: "invalid" });
    }
    await expect(port.editLabels({ ...identity, add: [], remove: [] }, signal)).resolves.toEqual({
      status: "refused",
      reason: "invalid",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("posts a comment and a review reply with the text on stdin, not in arguments", async () => {
    const { port, run } = fixture([
      { exitCode: 0, stdout: "" },
      threadOwner(7),
      { exitCode: 0, stdout: "{}" },
    ]);
    await expect(port.comment({ ...identity, body: "Looks good." }, signal)).resolves.toEqual({
      status: "done",
    });
    await expect(
      port.replyToReviewThread(
        { ...identity, threadNodeId: "PRRT_abc123", body: "Fixed." },
        signal,
      ),
    ).resolves.toEqual({ status: "done" });
    expect(run.mock.calls[0]?.[1].stdin).toBe("Looks good.");
    expect(run.mock.calls[0]?.[0]).not.toContain("Looks good.");
    expect(run.mock.calls[2]?.[1].stdin).toBe("Fixed.");
    expect(run.mock.calls[2]?.[0]).toContain("thread=PRRT_abc123");
  });

  it("refuses to reply in a review thread that belongs to another pull request", async () => {
    const { port, run } = fixture([threadOwner(8), threadOwner(7, "elsewhere")]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        port.replyToReviewThread(
          { ...identity, threadNodeId: "PRRT_other", body: "Fixed." },
          signal,
        ),
      ).resolves.toEqual({ status: "refused", reason: "invalid" });
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      run.mock.calls.every(([arguments_]) => !arguments_.join(" ").includes("addPullRequest")),
    ).toBe(true);
  });

  it("points a stacked pull request at another base without touching its branch", async () => {
    const { port, run } = fixture([{ exitCode: 0, stdout: "" }]);
    await expect(port.retarget({ ...identity, baseBranch: "main" }, signal)).resolves.toEqual({
      status: "done",
    });
    expect(run.mock.calls[0]?.[0]).toEqual([
      "pr",
      "edit",
      "7",
      "--repo",
      "octant/octant",
      "--base",
      "main",
    ]);
    await expect(port.retarget({ ...identity, baseBranch: "--delete" }, signal)).resolves.toEqual({
      status: "refused",
      reason: "invalid",
    });
  });

  it("refuses an empty comment, an oversized comment, and a malformed thread id", async () => {
    const { port, run } = fixture([]);
    await expect(port.comment({ ...identity, body: "  " }, signal)).resolves.toEqual({
      status: "refused",
      reason: "invalid",
    });
    await expect(port.comment({ ...identity, body: "x".repeat(70_000) }, signal)).resolves.toEqual({
      status: "refused",
      reason: "invalid",
    });
    await expect(
      port.replyToReviewThread({ ...identity, threadNodeId: "bad id; rm", body: "x" }, signal),
    ).resolves.toEqual({ status: "refused", reason: "invalid" });
    expect(run).not.toHaveBeenCalled();
  });

  it("closes an open pull request and reopens a closed one, never deleting the branch", async () => {
    const { port, run } = fixture([
      view("OPEN"),
      { exitCode: 0, stdout: "" },
      view("CLOSED"),
      { exitCode: 0, stdout: "" },
    ]);
    await expect(port.setState({ ...identity, state: "closed" }, signal)).resolves.toEqual({
      status: "done",
    });
    await expect(port.setState({ ...identity, state: "open" }, signal)).resolves.toEqual({
      status: "done",
    });
    expect(run.mock.calls[1]?.[0]).toEqual(["pr", "close", "7", "--repo", "octant/octant"]);
    expect(run.mock.calls[3]?.[0]).toEqual(["pr", "reopen", "7", "--repo", "octant/octant"]);
  });

  it("refuses to close what is not open and to reopen what merged", async () => {
    const { port, run } = fixture([view("CLOSED"), view("MERGED"), view("OPEN")]);
    await expect(port.setState({ ...identity, state: "closed" }, signal)).resolves.toEqual({
      status: "refused",
      reason: "not-open",
    });
    await expect(port.setState({ ...identity, state: "open" }, signal)).resolves.toEqual({
      status: "refused",
      reason: "merged",
    });
    await expect(port.setState({ ...identity, state: "open" }, signal)).resolves.toEqual({
      status: "refused",
      reason: "not-closed",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("reports a signed-out or unreachable gh as unavailable, not as a refusal", async () => {
    const { port } = fixture([
      { exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" },
      new Error("spawn failed"),
      { exitCode: 1, stdout: "", stderr: "dial tcp: Could not resolve host: api.github.com" },
    ]);
    await expect(port.comment({ ...identity, body: "x" }, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "unauthenticated",
    });
    await expect(port.comment({ ...identity, body: "x" }, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "disconnected",
    });
    await expect(port.comment({ ...identity, body: "x" }, signal)).resolves.toEqual({
      status: "unavailable",
      reason: "disconnected",
    });
  });

  it("reads required checks as passing, failing, pending, none, or unknown", async () => {
    const checks = (entries: unknown) => ({ exitCode: 0, stdout: JSON.stringify(entries) });
    const { port } = fixture([
      checks([{ name: "ci", bucket: "pass" }]),
      checks([
        { name: "ci", bucket: "pass" },
        { name: "e2e", bucket: "fail" },
      ]),
      checks([{ name: "ci", bucket: "pending" }]),
      checks([]),
      { exitCode: 1, stdout: "", stderr: "no required checks reported" },
      { exitCode: 1, stdout: "", stderr: "HTTP 502" },
      checks([{ name: "ci", bucket: "mystery" }]),
    ]);
    const states = [];
    for (let index = 0; index < 7; index += 1)
      states.push(await port.requiredChecks(identity, signal));
    expect(states).toEqual(["passing", "failing", "pending", "none", "none", "unknown", "unknown"]);
  });

  it("reads the head, base, and state of a pull request", async () => {
    const { port } = fixture([view("OPEN"), { exitCode: 0, stdout: "not json" }]);
    await expect(port.summary(identity, signal)).resolves.toEqual({
      status: "read",
      state: "open",
      headBranch: "feature/a",
      baseBranch: "main",
      headSha: "a".repeat(40),
    });
    await expect(port.summary(identity, signal)).resolves.toEqual({ status: "unavailable" });
  });
});
