import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CodeProjectPullRequestService,
  type CodeProjectPullRequestAuthorizedProject,
} from "./codeProjectPullRequestService";
import { GhPullRequestPort, type GhCommandPort, type GhCommandResult } from "./ghPullRequestPort";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectA = decodeProjectId("10000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("10000000-0000-4000-8000-000000000002");
const now = "2026-08-22T08:00:00.000Z";

function codeProject(input: {
  readonly id: typeof projectA;
  readonly name: string;
  readonly root: string;
}): CodeProjectPullRequestAuthorizedProject {
  return {
    id: input.id,
    name: input.name,
    type: "code",
    lifecycle: "active",
    binding: { canonicalRoot: input.root },
  };
}

function activeListJson(number: number): string {
  return JSON.stringify([
    {
      number,
      title: `Active ${number}`,
      isDraft: false,
      author: { login: "octocat" },
      updatedAt: "2026-08-22T07:00:00Z",
      url: `https://github.com/octant/r${number}/pull/${number}`,
      baseRefName: "development",
      headRefName: "feature/manual-refresh",
      statusCheckRollup: [{ state: "SUCCESS" }],
      reviewDecision: "APPROVED",
    },
  ]);
}

function detailJson(number: number): string {
  return JSON.stringify({
    number,
    title: `Active ${number}`,
    state: "OPEN",
    isDraft: false,
    body: "Verified implementation.",
    author: { login: "octocat" },
    baseRefName: "development",
    headRefName: "feature/manual-refresh",
    headRefOid: "a".repeat(40),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    url: `https://github.com/octant/r${number}/pull/${number}`,
    commits: [{ oid: "a".repeat(40), messageHeadline: "feat: refresh", authors: [{ login: "octocat" }] }],
    files: [{ path: "apps/server/src/x.ts", additions: 5, deletions: 1 }],
    statusCheckRollup: [{ __typename: "CheckRun", name: "web tests", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [{ author: { login: "reviewer" }, state: "APPROVED", body: "LGTM" }],
    comments: [{ author: { login: "octocat" }, body: "Ready." }],
  });
}

describe("fake-gh project pull-request port", () => {
  it("executes zero gh commands on query and only sequential bounded list commands on refresh", async () => {
    const calls: string[][] = [];
    const command: GhCommandPort = {
      run: vi.fn(async (arguments_) => {
        calls.push([...arguments_]);
        const repo = arguments_[3] ?? "octant/unknown";
        const suffix = repo.split("/")[1] ?? "1";
        const number = Number(suffix.replace(/\D/g, "")) || 1;
        return { exitCode: 0, stdout: activeListJson(number) } satisfies GhCommandResult;
      }),
    };
    const port = new GhPullRequestPort({
      command,
      resolveTarget: async () => undefined,
    });
    const service = new CodeProjectPullRequestService({
      projects: {
        bootstrap: async () => ({
          active: [
            codeProject({ id: projectA, name: "One", root: "/repos/1" }),
            codeProject({ id: projectB, name: "Two", root: "/repos/2" }),
          ],
        }),
      },
      remotes: {
        remotes: async (root) => [
          {
            name: "origin",
            fetchUrl:
              root === "/repos/1"
                ? "https://github.com/octant/r1.git"
                : "https://github.com/octant/r2.git",
          },
        ],
      },
      list: port,
      detail: port,
      threads: { list: async () => [] },
      clock: () => now,
    });

    await service.query(windowId, { version: 1 });
    expect(calls).toEqual([]);

    await service.refresh(windowId, { kind: "refresh-all" }, new AbortController().signal);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "pr",
      "list",
      "--repo",
      "octant/r1",
      "--state",
      "open",
      "--limit",
      "101",
      "--json",
      "number,title,isDraft,author,updatedAt,url,baseRefName,headRefName,statusCheckRollup,reviewDecision",
    ]);
    expect(calls[1]?.[3]).toBe("octant/r2");
    expect(calls.every((arguments_) => arguments_[0] === "pr" && arguments_[1] === "list")).toBe(
      true,
    );
    expect(
      calls.some(
        (arguments_) =>
          arguments_[0] === "pr" &&
          (arguments_[1] === "merge" ||
            arguments_[1] === "review" ||
            arguments_[1] === "comment" ||
            arguments_[1] === "close" ||
            arguments_[1] === "create" ||
            arguments_[1] === "edit"),
      ),
    ).toBe(false);
  });

  it("executes zero gh commands on detail query and only gh pr view plus gh pr diff on detail refresh", async () => {
    const calls: string[][] = [];
    const command: GhCommandPort = {
      run: vi.fn(async (arguments_) => {
        calls.push([...arguments_]);
        if (arguments_[1] === "list") {
          return { exitCode: 0, stdout: activeListJson(12) } satisfies GhCommandResult;
        }
        if (arguments_[1] === "view") {
          return { exitCode: 0, stdout: detailJson(12) } satisfies GhCommandResult;
        }
        if (arguments_[1] === "diff") {
          return { exitCode: 0, stdout: "diff --git a/x b/x\n" } satisfies GhCommandResult;
        }
        return { exitCode: 1, stdout: "" } satisfies GhCommandResult;
      }),
    };
    const port = new GhPullRequestPort({
      command,
      resolveTarget: async () => undefined,
    });
    const service = new CodeProjectPullRequestService({
      projects: {
        bootstrap: async () => ({
          active: [codeProject({ id: projectA, name: "One", root: "/repos/1" })],
        }),
      },
      remotes: {
        remotes: async () => [{ name: "origin", fetchUrl: "https://github.com/octant/r1.git" }],
      },
      list: port,
      detail: port,
      threads: { list: async () => [] },
      clock: () => now,
    });
    const detailQuery = {
      projectId: projectA,
      repositoryOwner: "octant",
      repositoryName: "r1",
      number: 12,
    } as const;

    await service.queryDetail(windowId, detailQuery);
    expect(calls).toEqual([]);

    await service.refreshDetail(windowId, detailQuery, new AbortController().signal);
    expect(calls.map((arguments_) => `${arguments_[0]} ${arguments_[1]}`)).toEqual([
      "pr view",
      "pr diff",
    ]);
  });
});
