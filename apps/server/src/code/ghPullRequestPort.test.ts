import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId } from "@octant/contracts";
import {
  GhPullRequestPort,
  createGhCommandPort,
  type GhCommandPort,
  type GhCommandResult,
} from "./ghPullRequestPort";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const request = {
  threadId: decodeCodeThreadId("84000000-0000-4000-8000-000000000001"),
  title: "Delivery notes",
  body: "Verified implementation.",
} as const;
const target = {
  authorization: "confirmed-delivery-target",
  baseRepository: "octant/octant",
  baseBranch: "development",
  head: "octocat:feature/phase-7",
} as const;

const pullRequest = {
  number: 175,
  url: "https://github.com/octant/octant/pull/175",
  state: "OPEN",
  baseRefName: "development",
  headRefName: "feature/phase-7",
  headRepositoryOwner: { login: "octocat" },
};

function fixture(
  results: readonly GhCommandResult[],
  resolvedTarget: typeof target | undefined | null = target,
) {
  const queue = [...results];
  const command: GhCommandPort = {
    run: vi.fn(async () => queue.shift() ?? { exitCode: 1, stdout: "" }),
  };
  return {
    command,
    port: new GhPullRequestPort({
      command,
      resolveTarget: vi.fn(async () => resolvedTarget ?? undefined),
      inheritedEnvironment: {
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret-too",
        GH_ENTERPRISE_TOKEN: "secret-three",
      },
    }),
  };
}

function listResult(values: readonly unknown[], exitCode = 0): GhCommandResult {
  return { exitCode, stdout: JSON.stringify(values) };
}

describe("GhPullRequestPort", () => {
  it("returns one exact existing PR without creating or exposing ambient tokens", async () => {
    const { command, port } = fixture([listResult([pullRequest])]);

    await expect(port.ensure(request, new AbortController().signal)).resolves.toEqual({
      status: "existing",
      pullRequest: {
        number: 175,
        url: pullRequest.url,
        state: "open",
        baseRepository: target.baseRepository,
        baseBranch: target.baseBranch,
        headOwner: "octocat",
        headBranch: "feature/phase-7",
      },
    });

    expect(command.run).toHaveBeenCalledOnce();
    expect(command.run).toHaveBeenCalledWith(
      [
        "pr",
        "list",
        "--repo",
        target.baseRepository,
        "--base",
        target.baseBranch,
        "--head",
        target.head,
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        "number,url,state,baseRefName,headRefName,headRepositoryOwner",
      ],
      expect.objectContaining({
        environment: expect.objectContaining({
          PATH: "/usr/bin",
          GIT_TERMINAL_PROMPT: "0",
          GH_PROMPT_DISABLED: "1",
        }),
        stdin: undefined,
      }),
      expect.any(AbortSignal),
    );
    const environment = vi.mocked(command.run).mock.calls[0]![1].environment;
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("GH_ENTERPRISE_TOKEN");
  });

  it("creates once and then re-observes the exact PR for retry-safe identity", async () => {
    const { command, port } = fixture([
      listResult([]),
      { exitCode: 0, stdout: `${pullRequest.url}\n` },
      listResult([pullRequest]),
      listResult([pullRequest]),
    ]);
    const signal = new AbortController().signal;

    await expect(port.ensure(request, signal)).resolves.toMatchObject({
      status: "created",
      pullRequest: { number: 175, url: pullRequest.url },
    });
    await expect(port.ensure(request, signal)).resolves.toMatchObject({
      status: "existing",
      pullRequest: { number: 175 },
    });

    expect(command.run).toHaveBeenNthCalledWith(
      2,
      [
        "pr",
        "create",
        "--repo",
        target.baseRepository,
        "--base",
        target.baseBranch,
        "--head",
        target.head,
        "--title",
        request.title,
        "--body-file",
        "-",
      ],
      expect.objectContaining({ stdin: request.body }),
      signal,
    );
    expect(
      vi
        .mocked(command.run)
        .mock.calls.filter(([arguments_]) => arguments_[0] === "pr" && arguments_[1] === "create"),
    ).toHaveLength(1);
  });

  it("re-observes after an uncertain create failure instead of duplicating the PR", async () => {
    const { port } = fixture([
      listResult([]),
      { exitCode: 1, stdout: "private failure" },
      listResult([pullRequest]),
    ]);

    await expect(port.ensure(request, new AbortController().signal)).resolves.toMatchObject({
      status: "existing",
      pullRequest: { number: 175 },
    });
  });

  it.each([
    ["blank title", { ...request, title: " " }],
    ["NUL title", { ...request, title: "unsafe\0title" }],
  ])("rejects %s before invoking gh", async (_label, invalid) => {
    const { command, port } = fixture([]);

    await expect(port.ensure(invalid, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      code: "invalid-target",
    });
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["invalid repository", { ...target, baseRepository: "not-a-repository" }],
    ["unsafe base", { ...target, baseBranch: "--force" }],
    ["implicit head owner", { ...target, head: "feature/phase-7" }],
    ["unsafe head", { ...target, head: "owner:feature..oops" }],
  ])("rejects a %s authoritative delivery target before invoking gh", async (_label, invalid) => {
    const { command, port } = fixture([], invalid as never);

    await expect(port.ensure(request, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      code: "invalid-target",
    });
    expect(command.run).not.toHaveBeenCalled();
  });

  it("fails closed when the gh command port rejects", async () => {
    const command: GhCommandPort = {
      run: vi.fn(async () => {
        throw new Error("private spawn failure");
      }),
    };
    const port = new GhPullRequestPort({
      command,
      resolveTarget: vi.fn(async () => target),
    });

    await expect(port.ensure(request, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      code: "pr-observation-unavailable",
    });
  });

  it("terminates a hung gh process at the configured deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-gh-timeout-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "gh");
    writeFileSync(executable, "#!/bin/sh\nsleep 60\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const port = new GhPullRequestPort({
      command: createGhCommandPort({ ghPath: executable, timeoutMs: 20 }),
      resolveTarget: async () => target,
    });

    await expect(port.ensure(request, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      code: "pr-observation-unavailable",
    });
  });

  it.each([
    ["ambiguous", listResult([pullRequest, { ...pullRequest, number: 176 }])],
    ["malformed", { exitCode: 0, stdout: "not-json" }],
    ["unavailable", { exitCode: 1, stdout: "private failure" }],
  ])("fails closed for %s PR observation", async (_label, observed) => {
    const { port } = fixture([observed]);

    await expect(port.ensure(request, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      code: "pr-observation-unavailable",
    });
  });
});

const reviewRequest = { threadId: request.threadId, maxDiffBytes: 1_048_576 } as const;
const headSha = "a".repeat(40);
const detailJson = JSON.stringify({
  number: 175,
  title: "Delivery notes",
  state: "OPEN",
  isDraft: false,
  body: "Verified implementation.",
  author: { login: "octocat" },
  baseRefName: "development",
  headRefName: "feature/phase-7",
  headRefOid: headSha,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  url: pullRequest.url,
  commits: [{ oid: headSha, messageHeadline: "feat: phase 7", authors: [{ login: "octocat" }] }],
  files: [{ path: "apps/web/src/code/x.ts", additions: 5, deletions: 1 }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "web tests", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "ci/build", state: "PENDING" },
  ],
  reviews: [{ author: { login: "reviewer" }, state: "APPROVED", body: "LGTM" }],
  comments: [{ author: { login: "octocat" }, body: "Ready." }],
});
const repoMethodsJson = JSON.stringify({
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: false,
});
const diffText = "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n";

describe("GhPullRequestPort.observeReview", () => {
  it("observes every read-only section of the linked PR without mutating GitHub", async () => {
    const { command, port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: detailJson },
      { exitCode: 0, stdout: diffText },
      { exitCode: 0, stdout: repoMethodsJson },
    ]);

    await expect(port.observeReview(reviewRequest, new AbortController().signal)).resolves.toEqual({
      status: "observed",
      freshness: "fresh",
      ambiguous: false,
      staleSections: [],
      pullRequest: {
        number: 175,
        url: pullRequest.url,
        title: "Delivery notes",
        state: "open",
        baseRepository: target.baseRepository,
        baseBranch: target.baseBranch,
        headRepository: "octocat",
        headBranch: "feature/phase-7",
        author: "octocat",
        matchesDeliveryBranch: true,
      },
      description: "Verified implementation.",
      diff: diffText,
      diffTruncated: false,
      commits: [{ oid: headSha, messageHeadline: "feat: phase 7", author: "octocat" }],
      files: [{ path: "apps/web/src/code/x.ts", additions: 5, deletions: 1 }],
      checks: [
        { name: "web tests", state: "success" },
        { name: "ci/build", state: "pending" },
      ],
      reviews: [{ author: "reviewer", state: "approved", body: "LGTM" }],
      comments: [{ author: "octocat", body: "Ready." }],
      mergePreview: {
        headSha,
        mergeable: true,
        requiredChecksPassing: true,
        advertisedMergeMethods: ["merge", "squash"],
      },
    });

    const subcommands = vi
      .mocked(command.run)
      .mock.calls.map(([arguments_]) => `${arguments_[0]} ${arguments_[1]}`);
    expect(subcommands).toEqual(["pr list", "pr view", "pr diff", "api repos/octant/octant"]);
  });

  it("labels detail sections stale and stays ambiguous when gh pr view fails", async () => {
    const { port } = fixture([
      listResult([pullRequest]),
      { exitCode: 1, stdout: "private failure" },
      { exitCode: 0, stdout: diffText },
    ]);

    const result = await port.observeReview(reviewRequest, new AbortController().signal);
    expect(result).toMatchObject({
      status: "observed",
      freshness: "stale",
      ambiguous: true,
      description: "",
      diff: diffText,
      pullRequest: { number: 175, title: "", state: "open" },
    });
    expect(result.status === "observed" ? [...result.staleSections].sort() : []).toEqual([
      "checks",
      "comments",
      "commits",
      "description",
      "files",
      "reviews",
    ]);
    expect(result.status === "observed" ? result.mergePreview : undefined).toBeUndefined();
  });

  it("labels only the diff stale when gh pr diff fails", async () => {
    const { port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: detailJson },
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: repoMethodsJson },
    ]);

    await expect(
      port.observeReview(reviewRequest, new AbortController().signal),
    ).resolves.toMatchObject({
      status: "observed",
      freshness: "stale",
      ambiguous: true,
      staleSections: ["diff"],
      diff: "",
      description: "Verified implementation.",
      mergePreview: {
        headSha,
        mergeable: true,
        requiredChecksPassing: true,
        advertisedMergeMethods: ["merge", "squash"],
      },
    });
  });

  it("truncates the diff to the exact byte budget", async () => {
    const { port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: detailJson },
      { exitCode: 0, stdout: "0123456789" },
      { exitCode: 0, stdout: repoMethodsJson },
    ]);

    await expect(
      port.observeReview({ ...reviewRequest, maxDiffBytes: 4 }, new AbortController().signal),
    ).resolves.toMatchObject({ status: "observed", diff: "0123", diffTruncated: true });
  });

  it("returns none when no PR is linked and unavailable when observation fails", async () => {
    const none = fixture([listResult([])]);
    await expect(
      none.port.observeReview(reviewRequest, new AbortController().signal),
    ).resolves.toEqual({ status: "none" });
    expect(none.command.run).toHaveBeenCalledOnce();

    const broken = fixture([{ exitCode: 1, stdout: "private failure" }]);
    await expect(
      broken.port.observeReview(reviewRequest, new AbortController().signal),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

describe("GhPullRequestPort.merge", () => {
  const confirmation = {
    number: 175,
    baseRepository: target.baseRepository,
    baseBranch: target.baseBranch,
    headBranch: "feature/phase-7",
    mergeMethod: "squash" as const,
    expectedHeadSha: headSha,
  };
  const mergeRequest = {
    threadId: request.threadId,
    expectedHeadSha: headSha,
    mergeMethod: "squash" as const,
    confirmation,
  };
  const mergeDetailOpen = JSON.stringify({
    number: 175,
    url: pullRequest.url,
    title: "Delivery notes",
    state: "OPEN",
    isDraft: false,
    baseRefName: "development",
    headRefName: "feature/phase-7",
    headRefOid: headSha,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRepositoryOwner: { login: "octocat" },
  });
  const mergeDetailMerged = JSON.stringify({
    ...JSON.parse(mergeDetailOpen),
    state: "MERGED",
  });

  it("merges a clean PR with match-head-commit and never admin-bypasses", async () => {
    const { command, port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: mergeDetailOpen },
      { exitCode: 0, stdout: repoMethodsJson },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: mergeDetailMerged },
    ]);

    await expect(port.merge(mergeRequest, new AbortController().signal)).resolves.toEqual({
      status: "merged",
      pullRequest: {
        number: 175,
        url: pullRequest.url,
        baseRepository: target.baseRepository,
        baseBranch: target.baseBranch,
        headOwner: "octocat",
        headBranch: "feature/phase-7",
      },
    });

    expect(command.run).toHaveBeenCalledWith(
      [
        "pr",
        "merge",
        "175",
        "--repo",
        target.baseRepository,
        "--squash",
        "--match-head-commit",
        headSha,
      ],
      expect.objectContaining({ stdin: undefined }),
      expect.any(AbortSignal),
    );
    const mergeArgs = vi.mocked(command.run).mock.calls.find(([args]) => args[1] === "merge")?.[0];
    expect(mergeArgs).not.toContain("--admin");
    expect(mergeArgs).not.toContain("--auto");
  });

  it("fails closed on conflict without calling gh pr merge", async () => {
    const conflicting = JSON.stringify({
      ...JSON.parse(mergeDetailOpen),
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    const { command, port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: conflicting },
      { exitCode: 0, stdout: repoMethodsJson },
    ]);

    await expect(port.merge(mergeRequest, new AbortController().signal)).resolves.toEqual({
      status: "failed",
      code: "conflict",
    });
    expect(vi.mocked(command.run).mock.calls.some(([args]) => args[1] === "merge")).toBe(false);
  });

  it("fails closed on sha mismatch", async () => {
    const { command, port } = fixture([
      listResult([pullRequest]),
      { exitCode: 0, stdout: mergeDetailOpen },
      { exitCode: 0, stdout: repoMethodsJson },
    ]);

    await expect(
      port.merge(
        {
          ...mergeRequest,
          expectedHeadSha: "b".repeat(40),
          confirmation: { ...confirmation, expectedHeadSha: "b".repeat(40) },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "failed", code: "sha-mismatch" });
    expect(vi.mocked(command.run).mock.calls.some(([args]) => args[1] === "merge")).toBe(false);
  });

  it("returns merged idempotently when the confirmation PR is already merged", async () => {
    const { port } = fixture([listResult([]), { exitCode: 0, stdout: mergeDetailMerged }]);

    await expect(port.merge(mergeRequest, new AbortController().signal)).resolves.toEqual({
      status: "merged",
      pullRequest: {
        number: 175,
        url: pullRequest.url,
        baseRepository: target.baseRepository,
        baseBranch: target.baseBranch,
        headOwner: "octocat",
        headBranch: "feature/phase-7",
      },
    });
  });
});
