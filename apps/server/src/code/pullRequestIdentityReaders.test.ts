import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED,
  CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED,
  CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE,
  CODE_PROJECT_PULL_REQUEST_WATCH_RECORDED,
  CODE_PULL_REQUEST_LINK_AGGREGATE,
  CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
  decodeAggregateVersion,
  decodeCodeProjectPullRequestDetailRefreshCommand,
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeThread,
  decodeCodeThreadFollowUp,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeCodeCheckoutId,
  decodeCodeDeliveryTarget,
  decodeCodeThreadId,
} from "@octant/contracts/code";
import type { RequiredChecksState } from "@octant/domain/code-pull-request-action-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  CodeProjectPullRequestService,
  type CodeProjectPullRequestAuthorizedProject,
} from "./codeProjectPullRequestService";
import {
  CodeProjectPullRequestSwitchService,
  type PullRequestAutoFixThreads,
} from "./codeProjectPullRequestSwitchService";
import { threadDeliversPullRequest } from "./mergedThreadPutAway";
import { CodeThreadMetadataService } from "./codeThreadMetadataService";
import { FailingChecksFollowUps } from "./failingChecksFollowUps";
import { GhPullRequestPort, type GhCommandPort, type GhCommandResult } from "./ghPullRequestPort";
import { GhPullRequestSwitchPort } from "./ghPullRequestSwitchPort";
import { GitObservationPort } from "./gitObservationPort";
import {
  collectLegacyPullRequestLinks,
  PullRequestLinkService,
  type PullRequestLinkSwitchReconciler,
} from "./pullRequestLinkService";
import { createProjectPullRequestPorts } from "../wiring/code";
import { joinCodeThreadBoardPullRequests } from "./threadBoardPullRequestJoin";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("25000000-0000-4000-8000-000000000001");
const providerInstanceId = "30000000-0000-4000-8000-000000000001";
const signal = new AbortController().signal;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createRealGitRepo(remoteUrl: string): {
  readonly repoRoot: string;
  readonly gitPort: GitObservationPort;
  readonly git: (...args: readonly string[]) => void;
} {
  const root = createTempDir("octant-pr-identity-git-");
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot);
  const git = (...args: readonly string[]) => {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Octant Test");
  git("config", "user.email", "test@octant.local");
  writeFileSync(join(repoRoot, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  git("remote", "add", "origin", remoteUrl);
  const fake = createFakeSandboxConfinement();
  cleanups.push(() => rmSync(fake.root, { recursive: true, force: true }));
  const gitPort = new GitObservationPort({
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  });
  return { repoRoot, gitPort, git };
}

function openJournal(clock: () => string) {
  const dir = createTempDir("octant-pr-identity-journal-");
  const connection = openSqlite(join(dir, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  cleanups.push(() => connection.close());
  return journal;
}

interface FakeForgePr {
  readonly number: number;
  nodeId: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  headSha: string;
  headOwner: string;
  headBranch: string;
  baseBranch: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: "SUCCESS" | "FAILURE" | "PENDING";
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED";
  autoMergeEnabled: boolean;
  updatedAt: string;
  failingCheckName?: string;
}

interface FakeForgeRepoState {
  owner: string;
  name: string;
  readonly nodeId: string;
  readonly aliases: Set<string>;
  readonly pullRequests: Map<number, FakeForgePr>;
}

function createFakeForge(initial: {
  readonly owner: string;
  readonly name: string;
  readonly nodeId: string;
}) {
  const repo: FakeForgeRepoState = {
    owner: initial.owner,
    name: initial.name,
    nodeId: initial.nodeId,
    aliases: new Set([`${initial.owner.toLowerCase()}/${initial.name.toLowerCase()}`]),
    pullRequests: new Map(),
  };
  const extraRepositories = new Map<
    string,
    { readonly nodeId: string; readonly owner: string; readonly name: string }
  >();
  let omitForgeIds = false;
  const calls: string[][] = [];

  const canonicalFull = () => `${repo.owner}/${repo.name}`;
  const matchesRepo = (requested: string) => repo.aliases.has(requested.toLowerCase());

  const command: GhCommandPort = {
    run: vi.fn(async (args: readonly string[]): Promise<GhCommandResult> => {
      calls.push([...args]);
      if (args[0] === "api" && args[1] === "graphql") {
        const ownerArg = args.find((a) => a.startsWith("owner="))?.slice("owner=".length) ?? "";
        const nameArg = args.find((a) => a.startsWith("name="))?.slice("name=".length) ?? "";
        const requested = `${ownerArg}/${nameArg}`;
        const query = args.find((a) => a.startsWith("query=")) ?? "";
        if (omitForgeIds && !query.includes("reviewThreads") && !query.includes("reviews(last:")) {
          return { exitCode: 1, stdout: "", stderr: "API rate limit exceeded" };
        }
        const extra = extraRepositories.get(requested.toLowerCase());
        if (extra !== undefined && !matchesRepo(requested)) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  id: extra.nodeId,
                  owner: { login: extra.owner },
                  name: extra.name,
                },
              },
            }),
          };
        }
        if (!matchesRepo(requested)) {
          return { exitCode: 1, stdout: "", stderr: "Could not resolve to a Repository" };
        }
        if (query.includes("reviewThreads")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            }),
          };
        }
        if (query.includes("reviews(last:")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ reviews: [], comments: [] }),
          };
        }
        if (query.includes("isInMergeQueue")) {
          const openNodes = [...repo.pullRequests.values()]
            .filter((pr) => pr.state === "OPEN")
            .map((pr) => ({ number: pr.number, id: pr.nodeId, isInMergeQueue: false }));
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  id: repo.nodeId,
                  owner: { login: repo.owner },
                  name: repo.name,
                  pullRequests: { nodes: openNodes },
                },
              },
            }),
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                id: repo.nodeId,
                owner: { login: repo.owner },
                name: repo.name,
              },
            },
          }),
        };
      }

      if (args[0] === "api" && args[1]?.startsWith("repos/")) {
        const requested = args[1].slice("repos/".length);
        if (!matchesRepo(requested)) return { exitCode: 1, stdout: "", stderr: "Not Found" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            allow_auto_merge: true,
            allow_merge_commit: true,
            allow_squash_merge: true,
            allow_rebase_merge: false,
          }),
        };
      }

      if (args[0] === "pr" && args[1] === "list") {
        const repoIdx = args.indexOf("--repo");
        const requested = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
        if (!matchesRepo(requested)) {
          return { exitCode: 1, stdout: "", stderr: "Could not resolve to a Repository" };
        }
        const headIdx = args.indexOf("--head");
        const stateIdx = args.indexOf("--state");
        const wantedState = (stateIdx >= 0 ? args[stateIdx + 1] : "open")?.toUpperCase();
        const filtered = [...repo.pullRequests.values()].filter((pr) => {
          if (wantedState === "OPEN" && pr.state !== "OPEN") return false;
          if (wantedState === "CLOSED" && pr.state !== "CLOSED") return false;
          if (headIdx >= 0 && pr.headBranch !== args[headIdx + 1]) return false;
          return true;
        });
        if (headIdx >= 0) {
          const rows = filtered.map((pr) => ({
            ...(omitForgeIds ? {} : { id: pr.nodeId }),
            number: pr.number,
            url: `https://github.com/${canonicalFull()}/pull/${pr.number}`,
            state: pr.state,
            baseRefName: pr.baseBranch,
            headRefName: pr.headBranch,
            headRepositoryOwner: { login: pr.headOwner },
          }));
          return { exitCode: 0, stdout: JSON.stringify(rows) };
        }
        const rows = filtered.map((pr) => ({
          ...(omitForgeIds ? {} : { id: pr.nodeId }),
          number: pr.number,
          title: pr.title,
          isDraft: pr.draft,
          state: pr.state,
          mergeable: pr.mergeable,
          author: { login: pr.headOwner },
          updatedAt: pr.updatedAt,
          url: `https://github.com/${canonicalFull()}/pull/${pr.number}`,
          baseRefName: pr.baseBranch,
          headRefName: pr.headBranch,
          isCrossRepository: pr.headOwner.toLowerCase() !== repo.owner.toLowerCase(),
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: pr.failingCheckName ?? "ci",
              status: pr.checks === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
              conclusion: pr.checks === "PENDING" ? null : pr.checks,
            },
          ],
          reviewDecision: pr.reviewDecision,
          reviewRequests: [],
          autoMergeRequest: pr.autoMergeEnabled ? { enabledAt: pr.updatedAt } : null,
        }));
        return { exitCode: 0, stdout: JSON.stringify(rows) };
      }

      if (args[0] === "pr" && args[1] === "view") {
        const number = Number(args[2]);
        const repoIdx = args.indexOf("--repo");
        const requested = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
        if (!matchesRepo(requested)) {
          return { exitCode: 1, stdout: "", stderr: "Could not resolve to a Repository" };
        }
        const pr = repo.pullRequests.get(number);
        if (pr === undefined) return { exitCode: 1, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ...(omitForgeIds ? {} : { id: pr.nodeId }),
            number: pr.number,
            title: pr.title,
            state: pr.state,
            isDraft: pr.draft,
            mergeable: pr.mergeable,
            updatedAt: pr.updatedAt,
            body: "PR body",
            author: { login: pr.headOwner },
            baseRefName: pr.baseBranch,
            headRefName: pr.headBranch,
            headRepositoryOwner: { login: pr.headOwner },
            headRefOid: pr.headSha,
            url: `https://github.com/${canonicalFull()}/pull/${pr.number}`,
            autoMergeRequest: pr.autoMergeEnabled ? { enabledAt: pr.updatedAt } : null,
            reviewDecision: pr.reviewDecision,
            commits: [{ oid: pr.headSha, messageHeadline: "work", authors: [{ login: "dev" }] }],
            files: [{ path: "src/index.ts", additions: 2, deletions: 1 }],
            statusCheckRollup: [
              {
                __typename: "CheckRun",
                name: pr.failingCheckName ?? "ci",
                status: pr.checks === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
                conclusion: pr.checks === "PENDING" ? null : pr.checks,
              },
            ],
            reviews: [],
            comments: [],
          }),
        };
      }

      if (args[0] === "pr" && args[1] === "checks") {
        const number = Number(args[2]);
        const repoIdx = args.indexOf("--repo");
        const requested = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
        if (!matchesRepo(requested)) return { exitCode: 1, stdout: "", stderr: "Not Found" };
        const pr = repo.pullRequests.get(number);
        if (pr === undefined) return { exitCode: 1, stdout: "", stderr: "not found" };
        return {
          exitCode: pr.checks === "FAILURE" ? 8 : 0,
          stdout: JSON.stringify([
            {
              name: pr.failingCheckName ?? "ci",
              bucket:
                pr.checks === "SUCCESS" ? "pass" : pr.checks === "FAILURE" ? "fail" : "pending",
              link: "",
            },
          ]),
        };
      }

      if (args[0] === "pr" && args[1] === "diff") {
        return { exitCode: 0, stdout: "diff --git a/a b/a\n" };
      }

      if (args[0] === "pr" && args[1] === "merge") {
        const number = Number(args[2]);
        const repoIdx = args.indexOf("--repo");
        const requested = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
        if (!matchesRepo(requested)) return { exitCode: 1, stdout: "", stderr: "Not Found" };
        const pr = repo.pullRequests.get(number);
        if (pr === undefined) return { exitCode: 1, stdout: "", stderr: "not found" };
        if (args.includes("--disable-auto")) {
          pr.autoMergeEnabled = false;
          return { exitCode: 0, stdout: "" };
        }
        const shaIdx = args.indexOf("--match-head-commit");
        const expectedSha = shaIdx >= 0 ? args[shaIdx + 1] : undefined;
        if (expectedSha !== undefined && expectedSha !== pr.headSha) {
          return { exitCode: 1, stdout: "", stderr: "Head branch was modified" };
        }
        if (args.includes("--auto")) {
          pr.autoMergeEnabled = true;
          return { exitCode: 0, stdout: "" };
        }
        pr.state = "MERGED";
        return { exitCode: 0, stdout: "" };
      }

      return { exitCode: 1, stdout: "", stderr: `Unhandled gh args: ${args.join(" ")}` };
    }),
  };

  return {
    repo,
    calls,
    command,
    setOmitForgeIds(value: boolean) {
      omitForgeIds = value;
    },
    addOtherRepository(owner: string, name: string, nodeId: string) {
      extraRepositories.set(`${owner.toLowerCase()}/${name.toLowerCase()}`, {
        owner,
        name,
        nodeId,
      });
    },
    renameTo(nextOwner: string, nextName: string) {
      repo.owner = nextOwner;
      repo.name = nextName;
      repo.aliases.add(`${nextOwner.toLowerCase()}/${nextName.toLowerCase()}`);
    },
  };
}

function defaultPr(overrides: Partial<FakeForgePr> = {}): FakeForgePr {
  return {
    number: 42,
    nodeId: "PR_kwDOold042",
    title: "Add feature",
    state: "OPEN",
    draft: false,
    headSha: "1111111111111111111111111111111111111111",
    headOwner: "acme",
    headBranch: "feature/work",
    baseBranch: "main",
    mergeable: "MERGEABLE",
    checks: "SUCCESS",
    reviewDecision: "APPROVED",
    autoMergeEnabled: false,
    updatedAt: "2026-11-19T11:55:00Z",
    ...overrides,
  };
}

function buildStack(options: {
  readonly journal: Journal;
  readonly repoRoot: string;
  readonly gitPort: GitObservationPort;
  readonly forge: ReturnType<typeof createFakeForge>;
  readonly clock: () => string;
  readonly threadRepo?: { readonly owner: string; readonly name: string };
  readonly prNumbers?: ReadonlyArray<{ readonly number: number; readonly observedAt: string }>;
  readonly unlinkedPullRequests?: ReadonlyArray<{
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
    readonly unlinkedAt: string;
  }>;
  readonly requiredChecks?: (request: {
    readonly owner: string;
    readonly name: string;
    readonly number: number;
  }) => Promise<RequiredChecksState>;
  readonly legacyLinks?: ConstructorParameters<typeof PullRequestLinkService>[0]["legacyLinks"];
}) {
  let switchReconciler: PullRequestLinkSwitchReconciler | undefined;
  const links = new PullRequestLinkService({
    journal: options.journal,
    uuid: randomUUID,
    clock: options.clock,
    ...(options.legacyLinks === undefined ? {} : { legacyLinks: options.legacyLinks }),
    switchReconciler: {
      reconcileDuplicateLinks: (input) => {
        if (switchReconciler === undefined) {
          input.commitMerge?.([]);
          return Promise.resolve({ status: "reconciled" as const, disabledSwitches: [] });
        }
        return switchReconciler.reconcileDuplicateLinks(input);
      },
    },
  });
  const ghPort = new GhPullRequestPort({
    command: options.forge.command,
    resolveTarget: async () => undefined,
  });
  const switchForge = new GhPullRequestSwitchPort({ command: options.forge.command });
  const project: CodeProjectPullRequestAuthorizedProject = {
    id: projectId,
    name: "Acme App",
    type: "code",
    lifecycle: "active",
    binding: { canonicalRoot: options.repoRoot },
  };
  const threadRepo = options.threadRepo ?? { owner: "acme", name: "old-repo" };
  const requiredChecks = options.requiredChecks;
  const pullRequestService = new CodeProjectPullRequestService({
    projects: { bootstrap: async () => ({ active: [project] }) },
    remotes: { remotes: (root) => options.gitPort.observeRemotes(root) },
    list: ghPort,
    detail: ghPort,
    merge: ghPort,
    ...(requiredChecks === undefined ? {} : { requiredChecks: (req) => requiredChecks(req) }),
    pullRequestLinks: links,
    clock: options.clock,
    threads: {
      list: async () => [
        {
          threadId: String(threadId),
          projectId: String(projectId),
          title: "Feature thread",
          repository: threadRepo,
          deliveryBranch: "feature/work",
          pullRequestNumbers: options.prNumbers ?? [
            { number: 42, observedAt: "2026-11-19T11:50:00.000Z" },
          ],
          ...(options.unlinkedPullRequests === undefined
            ? {}
            : { unlinkedPullRequests: options.unlinkedPullRequests }),
        },
      ],
    },
  });
  const wokenTurns: string[] = [];
  const notices: string[] = [];
  const switchThreads: PullRequestAutoFixThreads = {
    inspect: () => ({ status: "available", turnActive: false }),
    markOutsideContent: () => true,
    startTurn: async (_threadId, text) => {
      wokenTurns.push(text);
      return true;
    },
    notifyPerson: async (_threadId, reason) => {
      notices.push(reason);
    },
  };
  const switches = new CodeProjectPullRequestSwitchService({
    authority: pullRequestService,
    pullRequestLinks: links,
    forge: switchForge,
    threads: switchThreads,
    journal: options.journal,
    clock: options.clock,
    uuid: randomUUID,
  });
  switchReconciler = switches;
  return { links, ghPort, pullRequestService, switches, wokenTurns, notices };
}

describe("pull request readers use the single forge identity owner", () => {
  it("keeps one link with its thread, board summary, watch, Auto-fix, and Merge when ready after a repository rename", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/old-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "old-repo", nodeId: "R_kgDOold001" });
    forge.repo.pullRequests.set(42, defaultPr());

    const { links, pullRequestService, switches, wokenTurns } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
    });

    const beforeRefresh = await pullRequestService.refresh(
      windowId,
      { kind: "refresh-all" },
      signal,
    );
    expect(beforeRefresh.rows).toHaveLength(1);
    expect(beforeRefresh.rows[0]?.repositoryName).toBe("old-repo");
    expect(beforeRefresh.rows[0]?.linkedThreads.map((t) => t.threadId)).toEqual([threadId]);

    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 42,
    });
    expect(
      (
        await switches.setMergeWhenReady(
          windowId,
          { kind: "enable", target: oldTarget, headSha: "1".repeat(40) },
          "local-window",
          signal,
        )
      ).status,
    ).toBe("applied");
    expect(
      (await switches.setAutoFix(windowId, { kind: "enable", target: oldTarget, threadId }, "user"))
        .status,
    ).toBe("applied");
    expect((await switches.watch({ windowId, threadId, providerInstanceId, signal })).status).toBe(
      "watching",
    );

    // Failing checks follow-up triggers once before rename and must not re-fire
    // spuriously when the same link's repository name changes.
    const followUpTriggers: string[] = [];
    const failingChecks = new FailingChecksFollowUps({
      followUps: {
        read: () => ({ threadId, followUpVersion: decodeAggregateVersion(0) }),
        observeTrigger: async (input) => {
          followUpTriggers.push(input.reason);
          return decodeCodeThreadFollowUp({
            threadId: input.threadId,
            state: "open",
            origin: input.origin,
            reason: input.reason,
            triggerSequence: input.sourceSequence,
            acknowledgedThroughSequence: 0,
            createdAt: input.triggeredAt,
          });
        },
      },
      uuid: randomUUID,
      clock,
    });

    // Rename on GitHub and update local Git remote.
    nowMs += 5_000;
    forge.renameTo("acme", "new-repo");
    git("remote", "set-url", "origin", "https://github.com/acme/new-repo.git");

    const afterRefresh = await pullRequestService.refresh(
      windowId,
      { kind: "refresh-all" },
      signal,
    );
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
      pullRequestNodeId: "PR_kwDOold042",
      baseRepositoryNodeId: "R_kgDOold001",
      threadIds: [threadId],
    });
    expect(afterRefresh.rows).toHaveLength(1);
    expect(afterRefresh.rows[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
      checks: "passing",
      mergeability: "mergeable",
      linkId: links.listActive()[0]?.linkId,
    });
    expect(afterRefresh.rows[0]?.linkedThreads.map((t) => t.threadId)).toEqual([threadId]);

    // Thread board metadata preserves matchesDeliveryBranch and updates display repo.
    const metadataService = new CodeThreadMetadataService({
      git: { observe: () => ({ status: "unavailable" }) },
      history: { read: () => ({ status: "ok", frames: [] }) },
      github: {
        observe: () => ({
          status: "observed",
          freshness: "fresh",
          pullRequest: {
            number: 42,
            url: "https://github.com/acme/old-repo/pull/42",
            baseRepository: "acme/old-repo",
            baseBranch: "main",
            headBranch: "feature/work",
            state: "open",
          },
          checks: "passing",
          review: "approved",
        }),
      },
      pullRequestLinks: links,
    });
    const codeThread = decodeCodeThread({
      id: threadId,
      projectId,
      bindingRevisionId: "50000000-0000-4000-8000-000000000001",
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId,
      title: "Feature thread",
      lifecycle: "active",
      providerInstanceId,
      modelId: "test-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        outcomeKind: "opened-pr",
        branchIntent: "feature/work",
        remoteName: "origin",
        proposedBaseRepository: "acme/old-repo",
        proposedBaseBranch: "main",
        confirmedAt: clock(),
      },
      version: 1,
      createdAt: clock(),
      updatedAt: clock(),
    });
    const projected = await metadataService.project([
      { thread: codeThread, projectProjectionPresent: true },
    ]);
    expect(projected.threads[0]?.linkedPullRequest).toMatchObject({
      kind: "linked",
      baseRepository: "acme/new-repo",
      matchesDeliveryBranch: true,
    });

    // Thread board join shows ONE summary with updated display name and fresh checks.
    const boardSnap = await pullRequestService.boardSnapshot(windowId);
    const boardSummary = joinCodeThreadBoardPullRequests({ threadId, snapshot: boardSnap });
    expect(boardSummary.items).toHaveLength(1);
    expect(boardSummary.items[0]).toMatchObject({
      identity: { projectId, repositoryOwner: "acme", repositoryName: "new-repo", number: 42 },
      checks: "passing",
      mergeability: "mergeable",
      readyToMerge: true,
    });

    // Switches queried under the new repository name remain ON.
    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
    });
    const switchesAfter = await switches.query(windowId, newTarget);
    expect(switchesAfter.mergeWhenReady.status).toBe("on");
    expect(switchesAfter.autoFix.status).toBe("on");

    // Failing check wakes Auto-fix with the new repository name and keeps Merge when ready ON.
    nowMs += 5_000;
    const pr = forge.repo.pullRequests.get(42);
    if (pr !== undefined) {
      pr.checks = "FAILURE";
      pr.failingCheckName = "unit-tests";
    }
    const failingRows = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    await failingChecks.observe(failingRows.rows);
    expect(followUpTriggers).toHaveLength(1);
    // A second rename while checks remain failing does not re-fire the failing-checks follow-up.
    forge.renameTo("acme", "newest-repo");
    git("remote", "set-url", "origin", "https://github.com/acme/newest-repo.git");
    const stillFailingRows = await pullRequestService.refresh(
      windowId,
      { kind: "refresh-all" },
      signal,
    );
    await failingChecks.observe(stillFailingRows.rows);
    expect(followUpTriggers).toHaveLength(1);

    await switches.tick(signal);
    expect(wokenTurns.length).toBeGreaterThanOrEqual(1);
    expect(wokenTurns[0]).toContain("acme/newest-repo");
    const newestTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "newest-repo",
      number: 42,
    });
    const switchesAfterTick = await switches.query(windowId, newestTarget);
    expect(switchesAfterTick.autoFix.status).toBe("on");
    expect(switchesAfterTick.mergeWhenReady.status).toBe("on");
  });

  it("shows a thread with a placeholder target the merge of the pull request Octant opened for it", async () => {
    const clock = () => "2026-11-19T12:00:00.000Z";
    const { repoRoot, gitPort } = createRealGitRepo("https://github.com/acme/app.git");
    const forge = createFakeForge({ owner: "acme", name: "app", nodeId: "R_kgDOapp001" });
    forge.repo.pullRequests.set(42, defaultPr());
    const { links, pullRequestService } = buildStack({
      journal: openJournal(clock),
      repoRoot,
      gitPort,
      forge,
      clock,
      // What the composer proposes when it can read no remote.
      threadRepo: { owner: "local", name: "App" },
      prNumbers: [],
    });
    // What the create operation records.
    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 42,
      headBranch: "feature/work",
      threadIds: [threadId],
    });
    const merges = () =>
      pullRequestService.mergedPullRequestsForThread(String(threadId), (pullRequest) =>
        threadDeliversPullRequest({
          thread: {
            projectId,
            deliveryTarget: decodeCodeDeliveryTarget({
              outcomeKind: "opened-pr",
              branchIntent: "feature/work",
              remoteName: "origin",
              proposedBaseRepository: "local/App",
              proposedBaseBranch: "main",
              confirmedAt: "2026-11-19T12:00:00.000Z",
            }),
          },
          own: [{ number: 42, repository: { owner: "acme", name: "app" } }],
          pullRequest,
          sameRepository: (project, left, right) => links.areSameRepository(project, left, right),
        }),
      );

    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(merges()).toEqual([]);
    forge.repo.pullRequests.set(42, defaultPr({ state: "MERGED" }));
    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(merges()).toEqual([{ baseRepository: "acme/app", number: 42 }]);
  });

  it("keeps an unlinked pull request off the thread across a repository rename, until the thread touches it again", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/old-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "old-repo", nodeId: "R_kgDOold001" });
    forge.repo.pullRequests.set(42, defaultPr());
    const prNumbers = [{ number: 42, observedAt: "2026-11-19T11:50:00.000Z" }];
    const unlinkedPullRequests: Array<{
      owner: string;
      repository: string;
      number: number;
      unlinkedAt: string;
    }> = [];
    const { pullRequestService } = buildStack({
      journal: openJournal(clock),
      repoRoot,
      gitPort,
      forge,
      clock,
      prNumbers,
      unlinkedPullRequests,
    });
    const refresh = () =>
      pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal).then(() => undefined);
    // Every reader answers for itself: the board filters unlinks on its own, so
    // reading it alone would hide one that the detail or the switches missed.
    const linked = async () => {
      const target = {
        projectId,
        repositoryOwner: "acme",
        repositoryName: forge.repo.name,
        number: 42,
      };
      const board = (await pullRequestService.boardSnapshot(windowId)).rows
        .flatMap((row) => row.linkedThreads)
        .map((thread) => String(thread.threadId));
      const authorized = async () =>
        expect(
          await pullRequestService.authorizePullRequest(
            windowId,
            decodeCodeProjectPullRequestSwitchTarget(target),
          ),
        ).toMatchObject({ status: "authorized", linkedThreadIds: board });
      // The switches answer alone, and again once a detail refresh has
      // recorded the link it observed.
      await authorized();
      const detail = await pullRequestService.refreshDetail(
        windowId,
        decodeCodeProjectPullRequestDetailRefreshCommand(target),
        signal,
      );
      expect(detail.linkedThreads.map((thread) => String(thread.threadId))).toEqual(board);
      await authorized();
      return board;
    };
    const unlink = (repository: string) =>
      unlinkedPullRequests.push({ owner: "acme", repository, number: 42, unlinkedAt: clock() });
    const rename = (repository: string) => {
      forge.renameTo("acme", repository);
      git("remote", "set-url", "origin", `https://github.com/acme/${repository}.git`);
    };

    await refresh();
    expect(await linked()).toEqual([threadId]);
    // Unlinked under the old name; the rename must not bring it back.
    unlink("old-repo");
    expect(await linked()).toEqual([]);
    nowMs += 5_000;
    rename("new-repo");
    await refresh();
    expect(await linked()).toEqual([]);

    // The thread still names the old repository, and its own operations record
    // a number alone. Touching the pull request again links it again.
    nowMs += 5_000;
    prNumbers.push({ number: 42, observedAt: clock() });
    expect(await linked()).toEqual([threadId]);
    await refresh();
    expect(await linked()).toEqual([threadId]);

    // Unlinked again, now under the name the list shows: the newest unlink holds.
    nowMs += 5_000;
    unlink("new-repo");
    expect(await linked()).toEqual([]);
    await refresh();
    expect(await linked()).toEqual([]);
  });

  it("keeps one link and all reader state when a repository is transferred to another owner", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/old-owner/app.git");
    const forge = createFakeForge({ owner: "old-owner", name: "app", nodeId: "R_kgDOxfer001" });
    forge.repo.pullRequests.set(
      17,
      defaultPr({ number: 17, nodeId: "PR_kwDOxfer017", headOwner: "old-owner" }),
    );

    const { links, pullRequestService, switches } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      threadRepo: { owner: "old-owner", name: "app" },
      prNumbers: [{ number: 17, observedAt: "2026-11-19T11:50:00.000Z" }],
    });

    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "old-owner",
      repositoryName: "app",
      number: 17,
    });
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "1".repeat(40) },
      "local-window",
      signal,
    );
    await switches.setAutoFix(windowId, { kind: "enable", target: oldTarget, threadId }, "user");
    await switches.watch({ windowId, threadId, providerInstanceId, signal });

    // Transfer repository to a different GitHub owner and update local origin.
    nowMs += 5_000;
    forge.renameTo("new-owner", "app");
    const pr = forge.repo.pullRequests.get(17);
    if (pr !== undefined) pr.headOwner = "new-owner";
    git("remote", "set-url", "origin", "https://github.com/new-owner/app.git");

    const refreshed = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]).toMatchObject({
      repositoryOwner: "new-owner",
      repositoryName: "app",
      number: 17,
      pullRequestNodeId: "PR_kwDOxfer017",
      baseRepositoryNodeId: "R_kgDOxfer001",
      threadIds: [threadId],
    });
    expect(refreshed.rows).toHaveLength(1);
    expect(refreshed.rows[0]).toMatchObject({
      repositoryOwner: "new-owner",
      repositoryName: "app",
      checks: "passing",
      mergeability: "mergeable",
    });

    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "new-owner",
      repositoryName: "app",
      number: 17,
    });
    const switchesAfter = await switches.query(windowId, newTarget);
    expect(switchesAfter.mergeWhenReady.status).toBe("on");
    expect(switchesAfter.autoFix.status).toBe("on");
    expect(await switches.unwatch({ threadId, providerInstanceId })).toEqual({
      status: "unwatched",
      target: newTarget,
    });

    // GhPullRequestPort.locate also handles owner transfer on a same-repo PR even
    // when the delivery target still names the pre-transfer owner.
    const locatePort = new GhPullRequestPort({
      command: forge.command,
      resolveTarget: async () => ({
        authorization: "confirmed-delivery-target",
        baseRepository: "old-owner/app",
        baseBranch: "main",
        head: "old-owner:feature/work",
      }),
    });
    const located = await locatePort.locate(threadId, "open", signal);
    expect(located.status).toBe("found");
    if (located.status === "found") {
      expect(located.pullRequest.pullRequestNodeId).toBe("PR_kwDOxfer017");
      expect(located.pullRequest.canonicalBaseRepository).toBe("new-owner/app");
    }
  });

  it("collapses a stale second remote pointing at the old repository name while still refusing genuinely different remotes", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/old-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "old-repo", nodeId: "R_kgDOstale001" });
    forge.repo.pullRequests.set(42, defaultPr({ nodeId: "PR_kwDOstale042" }));
    forge.addOtherRepository("other-org", "different-repo", "R_kgDOdiff999");

    const { links, pullRequestService, switches } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
    });

    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 42,
    });
    await switches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget, headSha: "1".repeat(40) },
      "local-window",
      signal,
    );

    // Rename on GitHub, update origin to new name, AND keep a stale second remote
    // `upstream` pointing at the old name.
    nowMs += 5_000;
    forge.renameTo("acme", "new-repo");
    git("remote", "set-url", "origin", "https://github.com/acme/new-repo.git");
    git("remote", "add", "upstream", "https://github.com/acme/old-repo.git");

    const afterStaleRemote = await pullRequestService.refresh(
      windowId,
      { kind: "refresh-all" },
      signal,
    );
    expect(afterStaleRemote.projects).toEqual([
      {
        kind: "connected",
        projectId,
        projectName: "Acme App",
        repositoryOwner: "acme",
        repositoryName: "new-repo",
      },
    ]);
    expect(afterStaleRemote.rows).toHaveLength(1);
    expect(afterStaleRemote.rows[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
      checks: "passing",
      mergeability: "mergeable",
    });
    expect(links.listActive()).toHaveLength(1);
    expect(
      (
        await switches.query(
          windowId,
          decodeCodeProjectPullRequestSwitchTarget({
            projectId,
            repositoryOwner: "acme",
            repositoryName: "new-repo",
            number: 42,
          }),
        )
      ).mergeWhenReady.status,
    ).toBe("on");

    // Read-only board snapshot after stale remote stays connected with ONE row.
    const boardSnap = await pullRequestService.boardSnapshot(windowId);
    expect(joinCodeThreadBoardPullRequests({ threadId, snapshot: boardSnap }).items).toHaveLength(
      1,
    );

    // Replacing `upstream` with a genuinely different repository fails closed.
    git("remote", "set-url", "upstream", "https://github.com/other-org/different-repo.git");
    const conflicting = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(conflicting.projects).toEqual([
      { kind: "unconnected", projectId, projectName: "Acme App" },
    ]);
  });

  it("uses the base repository node ID for a fork pull request and keeps head owner display-only across renames", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/base-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "base-repo", nodeId: "R_kgDOBaseRepo" });
    forge.repo.pullRequests.set(
      88,
      defaultPr({
        number: 88,
        nodeId: "PR_kwDOFork088",
        headOwner: "external-contributor",
        headBranch: "contributor/fix",
      }),
    );

    const { links, pullRequestService } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      threadRepo: { owner: "acme", name: "base-repo" },
      prNumbers: [{ number: 88, observedAt: "2026-11-19T11:50:00.000Z" }],
    });

    const before = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]?.crossRepository).toBe(true);
    await pullRequestService.refreshDetail(
      windowId,
      { projectId, repositoryOwner: "acme", repositoryName: "base-repo", number: 88 },
      signal,
    );
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "base-repo",
      number: 88,
      pullRequestNodeId: "PR_kwDOFork088",
      baseRepositoryNodeId: "R_kgDOBaseRepo",
      headOwner: "external-contributor",
    });

    // Rename base repository: fork head owner stays display-only and identity stays one link.
    nowMs += 5_000;
    forge.renameTo("acme", "base-renamed");
    git("remote", "set-url", "origin", "https://github.com/acme/base-renamed.git");
    const after = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "base-renamed",
      baseRepositoryNodeId: "R_kgDOBaseRepo",
      headOwner: "external-contributor",
    });
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "base-renamed",
      crossRepository: true,
    });
    // Head owner's fork is never treated as equivalent to the base repository.
    expect(
      links.areSameRepository(
        projectId,
        { owner: "acme", name: "base-renamed" },
        { owner: "external-contributor", name: "base-repo" },
      ),
    ).toBe(false);
  });

  it("keeps pull-request identity cleanly when a pull request is closed and reopened", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort } = createRealGitRepo("https://github.com/acme/app.git");
    const forge = createFakeForge({ owner: "acme", name: "app", nodeId: "R_kgDOreopen01" });
    forge.repo.pullRequests.set(42, defaultPr({ nodeId: "PR_kwDOreopen42" }));

    const { links, pullRequestService } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      threadRepo: { owner: "acme", name: "app" },
    });

    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    const initialLinkId = links.listActive()[0]?.linkId;
    expect(initialLinkId).toBeDefined();

    // Close the PR and refresh: recovered as closed under the same link ID.
    nowMs += 5_000;
    const pr = forge.repo.pullRequests.get(42);
    if (pr !== undefined) pr.state = "CLOSED";
    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    const closedBoard = await pullRequestService.boardSnapshot(windowId);
    expect(joinCodeThreadBoardPullRequests({ threadId, snapshot: closedBoard }).items).toEqual([
      expect.objectContaining({ state: "closed" }),
    ]);
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]?.linkId).toBe(initialLinkId);

    // Reopen the PR and refresh: returns as open under the exact same link ID with no duplicates.
    nowMs += 5_000;
    if (pr !== undefined) pr.state = "OPEN";
    const reopened = await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(reopened.rows).toHaveLength(1);
    expect(reopened.rows[0]).toMatchObject({
      state: "open",
      number: 42,
      linkId: initialLinkId,
    });
    expect(links.listActive()).toHaveLength(1);
    expect(links.listActive()[0]?.linkId).toBe(initialLinkId);
  });

  it("replays a pre-identity journal cleanly, backfills forge IDs once, and falls back gracefully when forge IDs are missing", async () => {
    let nowMs = Date.parse("2026-11-19T10:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/legacy-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "legacy-repo", nodeId: "R_kgDOleg001" });
    forge.repo.pullRequests.set(42, defaultPr({ nodeId: "PR_kwDOleg042" }));

    // Seed a pre-Part-2 journal with ONLY switch events and NO code-pull-request-link events.
    const legacyTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "legacy-repo",
      number: 42,
    });
    const appendSwitch = (eventName: string, payload: unknown) => {
      journal.append({
        aggregate: {
          aggregateType: CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE,
          aggregateId: randomUUID(),
        },
        expectedVersion: 0,
        events: [
          {
            eventId: randomUUID(),
            eventName,
            eventVersion: 1,
            correlationId: randomUUID(),
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            occurredAt: clock(),
            payload,
          },
        ],
      });
    };
    appendSwitch(CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED, {
      target: legacyTarget,
      change: { kind: "enabled", method: "squash", headSha: "1".repeat(40) },
    });
    appendSwitch(CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED, {
      target: legacyTarget,
      threadId,
      change: { kind: "enabled" },
    });
    appendSwitch(CODE_PROJECT_PULL_REQUEST_WATCH_RECORDED, {
      target: legacyTarget,
      threadId,
      change: { kind: "enabled", baseline: [] },
    });

    const legacyLinks = (pid: typeof projectId) =>
      collectLegacyPullRequestLinks({
        journal,
        threads: [{ threadId, projectId: pid, frames: [] }],
      });

    const firstBoot = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      threadRepo: { owner: "acme", name: "legacy-repo" },
      legacyLinks,
    });

    // Before any live refresh, read-only replay writes zero link events and serves pre-Part-2 state.
    expect(
      journal.replayAggregateType({
        aggregateType: CODE_PULL_REQUEST_LINK_AGGREGATE,
        afterSequence: 0,
        limit: 100,
      }),
    ).toHaveLength(0);
    const replayedSwitches = await firstBoot.switches.query(windowId, legacyTarget);
    expect(replayedSwitches.mergeWhenReady.status).toBe("on");
    expect(replayedSwitches.autoFix.status).toBe("on");

    // First observation when forge IDs are missing (rate limited): still succeeds without refusing.
    forge.setOmitForgeIds(true);
    nowMs += 5_000;
    const offlineRefresh = await firstBoot.pullRequestService.refresh(
      windowId,
      { kind: "refresh-all" },
      signal,
    );
    expect(offlineRefresh.rows).toHaveLength(1);
    expect(firstBoot.links.listActive()[0]?.pullRequestNodeId).toBeUndefined();

    // Later observation with forge IDs available after a repo rename backfills ONCE and updates display.
    forge.setOmitForgeIds(false);
    nowMs += 5_000;
    forge.renameTo("acme", "modern-repo");
    git("remote", "set-url", "origin", "https://github.com/acme/modern-repo.git");
    await firstBoot.pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    await firstBoot.pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);

    const linkEvents = journal.replayAggregateType({
      aggregateType: CODE_PULL_REQUEST_LINK_AGGREGATE,
      afterSequence: 0,
      limit: 100,
    });
    expect(
      linkEvents.filter((event) => event.eventName === CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED),
    ).toHaveLength(1);

    // Cold restart from the same journal preserves ONE link and ALL switches under the renamed repo.
    const secondBoot = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      threadRepo: { owner: "acme", name: "legacy-repo" },
      legacyLinks,
    });
    const modernTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "modern-repo",
      number: 42,
    });
    const afterRestart = await secondBoot.switches.query(windowId, modernTarget);
    expect(afterRestart.mergeWhenReady.status).toBe("on");
    expect(afterRestart.autoFix.status).toBe("on");
    expect(secondBoot.links.listActive()).toHaveLength(1);
    expect(secondBoot.links.listActive()[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "modern-repo",
      pullRequestNodeId: "PR_kwDOleg042",
      baseRepositoryNodeId: "R_kgDOleg001",
    });
  });

  it("still checks reviewed head and required checks after a rename and never passes a head check against another PR's row", async () => {
    let nowMs = Date.parse("2026-11-19T12:00:00.000Z");
    const clock = () => new Date(nowMs).toISOString();
    const journal = openJournal(clock);
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/old-repo.git");
    const forge = createFakeForge({ owner: "acme", name: "old-repo", nodeId: "R_kgDOsec001" });
    forge.repo.pullRequests.set(
      42,
      defaultPr({ nodeId: "PR_kwDOsec042", headSha: "a".repeat(40) }),
    );

    let requiredChecksState: RequiredChecksState = "failing";
    const { pullRequestService, switches, wokenTurns } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
      requiredChecks: async () => requiredChecksState,
    });

    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 42,
    });
    await switches.setAutoFix(windowId, { kind: "enable", target: oldTarget, threadId }, "user");

    // Rename repository.
    nowMs += 5_000;
    forge.renameTo("acme", "new-repo");
    git("remote", "set-url", "origin", "https://github.com/acme/new-repo.git");
    await pullRequestService.refresh(windowId, { kind: "refresh-all" }, signal);

    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
    });

    // 1. Confirmed merge after rename still refuses when required checks are not passing.
    const refusedChecks = await pullRequestService.merge(
      windowId,
      {
        ...newTarget,
        method: "squash",
        headSha: "a".repeat(40),
        confirmed: true,
      },
      signal,
      "remote-device",
    );
    expect(refusedChecks).toEqual({ status: "refused", reason: "checks-not-passing" });

    // 2. Even with passing required checks, a stale head SHA is refused.
    requiredChecksState = "passing";
    const refusedStaleHead = await pullRequestService.merge(
      windowId,
      {
        ...newTarget,
        method: "squash",
        headSha: "b".repeat(40),
        confirmed: true,
      },
      signal,
      "remote-device",
    );
    expect(refusedStaleHead).toEqual({ status: "refused", reason: "stale" });

    // 3. If the forge answers with a DIFFERENT PR's node ID carrying the SAME head SHA,
    //    merge, Merge when ready, and Auto-fix ALL refuse/ignore it — never passing a head
    //    check against another PR's row!
    const pr = forge.repo.pullRequests.get(42);
    if (pr !== undefined) {
      pr.nodeId = "PR_kwDOdifferent999";
      pr.checks = "FAILURE";
      pr.failingCheckName = "spoofed-check";
    }
    const refusedWrongPrMerge = await pullRequestService.merge(
      windowId,
      {
        ...newTarget,
        method: "squash",
        headSha: "a".repeat(40),
        confirmed: true,
      },
      signal,
      "remote-device",
    );
    expect(refusedWrongPrMerge).toEqual({ status: "refused", reason: "stale" });

    const refusedWrongPrMwr = await switches.setMergeWhenReady(
      windowId,
      {
        kind: "enable",
        target: newTarget,
        headSha: "a".repeat(40),
        confirmed: true,
      },
      "remote-device",
      signal,
    );
    expect(refusedWrongPrMwr).toEqual({ status: "refused", reason: "stale" });

    await switches.tick(signal);
    expect(wokenTurns).toHaveLength(0);

    // 4. Restoring the real PR's node ID allows Auto-fix to wake and allows the
    //    reviewed head with passing checks to merge cleanly.
    if (pr !== undefined) {
      pr.nodeId = "PR_kwDOsec042";
    }
    await switches.tick(signal);
    expect(wokenTurns).toHaveLength(1);
    expect(wokenTurns[0]).toContain("acme/new-repo");

    if (pr !== undefined) pr.checks = "SUCCESS";
    const merged = await pullRequestService.merge(
      windowId,
      {
        ...newTarget,
        method: "squash",
        headSha: "a".repeat(40),
        confirmed: true,
      },
      signal,
      "remote-device",
    );
    expect(merged.status).toBe("merged");
  });

  it("preserves survivor switches and thread owners on cold restart after replaying a journal with legacy duplicate reconciliation", async () => {
    let now = "2026-11-19T10:00:00.000Z";
    const journal = openJournal(() => now);
    const threadA = decodeCodeThreadId("20000000-0000-4000-8000-000000000101");
    const threadB = decodeCodeThreadId("20000000-0000-4000-8000-000000000102");

    const oldTarget42 = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 42,
    });
    const newTarget42 = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
    });
    const oldTarget43 = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 43,
    });
    const newTarget43 = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 43,
    });

    const createSwitchHarness = (options: {
      readonly pullRequestLinks?: PullRequestLinkService;
    }) => {
      const threads: PullRequestAutoFixThreads = {
        inspect: () => ({ status: "available", turnActive: false }),
        markOutsideContent: () => true,
        startTurn: vi.fn(async () => true),
        notifyPerson: vi.fn(async () => undefined),
      };
      return new CodeProjectPullRequestSwitchService({
        authority: {
          authorizePullRequest: async (_wid, target) => ({
            status: "authorized",
            canonicalTarget: target,
            linkedThreadIds: [String(threadA), String(threadB)],
          }),
          linkedPullRequests: async (_wid, tid) =>
            String(tid) === String(threadA) ? [oldTarget42] : [newTarget42],
        },
        forge: {
          readAutoMergeSettings: async () => ({
            status: "read",
            allowAutoMerge: true,
            methods: { merge: true, squash: true, rebase: false },
          }),
          enableAutoMerge: async () => ({ status: "enabled" }),
          disableAutoMerge: async () => ({ status: "disabled" }),
          readCiLogs: async () => ({ status: "unavailable" }),
          planCiRerun: async () => ({ status: "unavailable" }),
          rerunCi: async () => ({ status: "unavailable" }),
          observe: async () => ({
            status: "observed",
            state: "open",
            headSha: "a".repeat(40),
            headBranch: "feature/work",
            baseBranch: "main",
            autoMergeEnabled: true,
            waitingOn: [],
            failures: [],
            activity: {
              checks: "passed",
              failedChecks: [],
              conflicting: false,
              reviews: [],
              comments: [],
            },
          }),
        },
        threads,
        journal,
        ...(options.pullRequestLinks === undefined
          ? {}
          : { pullRequestLinks: options.pullRequestLinks }),
        clock: () => now,
        uuid: randomUUID,
      });
    };

    // Phase 1: simulate a pre-reader-migration journal where standalone
    // SwitchService reconciled duplicate links and wrote retirement `disabled`
    // events on `newTarget42` for switches that stayed ON on both links.
    const legacySwitches = createSwitchHarness({});
    const legacyLinks = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: legacySwitches,
    });

    await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 42,
      threadIds: [threadA],
    });
    now = "2026-11-19T10:01:00.000Z";
    await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
      threadIds: [threadB],
    });
    await legacySwitches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget42, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await legacySwitches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: newTarget42, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await legacySwitches.setAutoFix(
      windowId,
      { kind: "enable", target: oldTarget42, threadId: threadA },
      "user",
    );
    await legacySwitches.setAutoFix(
      windowId,
      { kind: "enable", target: newTarget42, threadId: threadB },
      "user",
    );
    await legacySwitches.watch({ windowId, threadId: threadA, providerInstanceId, signal });
    await legacySwitches.watch({ windowId, threadId: threadB, providerInstanceId, signal });

    // Also record a mixed-switch duplicate (#43: Merge when ready ON on old only).
    await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 43,
      threadIds: [threadA],
    });
    now = "2026-11-19T10:02:00.000Z";
    await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 43,
      threadIds: [threadB],
    });
    await legacySwitches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: oldTarget43, headSha: "b".repeat(40), method: "squash" },
      "local-window",
      signal,
    );

    // Reconcile both pairs through legacy standalone SwitchService.
    now = "2026-11-19T10:05:00.000Z";
    const merged42 = await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "old-repo",
      number: 42,
      pullRequestNodeId: "PR_kwDOreplay42",
      baseRepositoryNodeId: "R_kgDOreplay1",
    });
    expect(merged42.status).toBe("merged");

    now = "2026-11-19T10:06:00.000Z";
    const merged43 = await legacyLinks.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "old-repo",
      number: 43,
      pullRequestNodeId: "PR_kwDOreplay43",
      baseRepositoryNodeId: "R_kgDOreplay1",
    });
    expect(merged43.status).toBe("merged");

    // Phase 2: cold restart with PullRequestLinkService wired into SwitchService.
    const restartedLinks = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });
    const restartedSwitches = createSwitchHarness({ pullRequestLinks: restartedLinks });

    const view42 = await restartedSwitches.query(windowId, newTarget42);
    expect(view42.mergeWhenReady.status).toBe("on");
    expect(view42.autoFix).toMatchObject({ status: "on", threadId: threadA });
    // Watch on the survivor's thread A stays active (not retired or clobbered by thread B).
    await expect(
      restartedSwitches.unwatch({ threadId: threadA, providerInstanceId }),
    ).resolves.toEqual({ status: "unwatched", target: newTarget42 });

    // Mixed switch (#43) remains OFF after cold restart.
    const view43 = await restartedSwitches.query(windowId, newTarget43);
    expect(view43.mergeWhenReady.status).toBe("off");

    // A genuine subsequent disable on the renamed target still sticks across restart.
    now = "2026-11-19T11:00:00.000Z";
    await restartedSwitches.setMergeWhenReady(
      windowId,
      { kind: "disable", target: newTarget42 },
      "local-window",
      signal,
    );
    const secondRestartLinks = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });
    const secondRestartSwitches = createSwitchHarness({ pullRequestLinks: secondRestartLinks });
    expect((await secondRestartSwitches.query(windowId, newTarget42)).mergeWhenReady.status).toBe(
      "off",
    );
    expect((await secondRestartSwitches.query(windowId, newTarget42)).autoFix).toMatchObject({
      status: "on",
      threadId: threadA,
    });
  });

  it("recovers from a stale second remote through production createProjectPullRequestPorts wiring", async () => {
    const { repoRoot, gitPort, git } = createRealGitRepo("https://github.com/acme/new-repo.git");
    git("remote", "add", "upstream", "https://github.com/acme/old-repo.git");

    const binDir = mkdtempSync(join(tmpdir(), "octant-fake-gh-"));
    cleanups.push(() => rmSync(binDir, { recursive: true, force: true }));
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  case "$*" in
    *owner{login}*)
      printf '{"data":{"repository":{"id":"R_kgDOprodWiring1","owner":{"login":"acme"},"name":"new-repo"}}}\\n'
      exit 0
      ;;
    *)
      printf '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\\n'
      exit 0
      ;;
  esac
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[{"id":"PR_kwDOprodWiring42","number":42,"title":"Wired stale remote PR","isDraft":false,"state":"OPEN","mergeable":"MERGEABLE","author":{"login":"octocat"},"updatedAt":"2026-11-19T10:00:00Z","url":"https://github.com/acme/new-repo/pull/42","baseRefName":"main","headRefName":"feature/work","headRepositoryOwner":{"login":"acme"},"statusCheckRollup":[{"state":"SUCCESS"}],"reviewDecision":"APPROVED"}]\\n'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
      "utf8",
    );
    chmodSync(fakeGh, 0o755);

    const ports = createProjectPullRequestPorts(fakeGh);
    expect(ports.ghAvailable).toBe(true);
    expect(typeof ports.list.observeBaseRepository).toBe("function");

    const journal = openJournal(() => "2026-11-19T10:00:00.000Z");
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => "2026-11-19T10:00:00.000Z",
    });
    const service = new CodeProjectPullRequestService({
      projects: {
        bootstrap: async () => ({
          active: [
            {
              id: projectId,
              name: "Wired Project",
              type: "code",
              lifecycle: "active",
              binding: { canonicalRoot: repoRoot },
            },
          ],
        }),
      },
      remotes: { remotes: (root) => gitPort.observeRemotes(root) },
      list: ports.list,
      detail: ports.detail,
      merge: ports.merge,
      threads: { list: async () => [] },
      pullRequestLinks: links,
      clock: () => "2026-11-19T10:00:00.000Z",
    });

    const refreshed = await service.refresh(windowId, { kind: "refresh-all" }, signal);
    expect(refreshed.projects[0]).toMatchObject({
      projectId,
      kind: "connected",
      repositoryOwner: "acme",
      repositoryName: "new-repo",
    });
    expect(refreshed.rows).toHaveLength(1);
    expect(refreshed.rows[0]).toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 42,
    });
  });

  it("refuses to authorize an earlier renamed repository when a different repository node ID reuses the old name", async () => {
    const clock = () => "2026-11-19T10:00:00.000Z";
    const journal = openJournal(clock);
    const { repoRoot, gitPort } = createRealGitRepo("https://github.com/acme/reused.git");
    const forge = createFakeForge({ owner: "acme", name: "reused", nodeId: "R_kgDOnewrepo2" });
    forge.repo.pullRequests.set(42, defaultPr({ nodeId: "PR_kwDOnew42" }));

    const { links, pullRequestService } = buildStack({
      journal,
      repoRoot,
      gitPort,
      forge,
      clock,
    });

    // Earlier link from R_kgDOoldrepo1 lived at acme/reused and renamed to acme/original-renamed.
    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "reused",
      number: 42,
      pullRequestNodeId: "PR_kwDOold42",
      baseRepositoryNodeId: "R_kgDOoldrepo1",
      threadIds: [threadId],
    });
    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "original-renamed",
      number: 42,
      pullRequestNodeId: "PR_kwDOold42",
      baseRepositoryNodeId: "R_kgDOoldrepo1",
    });

    // A distinct repository (R_kgDOnewrepo2) now occupies acme/reused.
    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "reused",
      number: 42,
      pullRequestNodeId: "PR_kwDOnew42",
      baseRepositoryNodeId: "R_kgDOnewrepo2",
    });

    expect(
      links.areSameRepository(
        projectId,
        { owner: "acme", name: "reused" },
        { owner: "acme", name: "original-renamed" },
      ),
    ).toBe(false);

    // The project checkout points at acme/reused (R_kgDOnewrepo2), so authorizing
    // acme/original-renamed (R_kgDOoldrepo1) must fail closed.
    const refused = await pullRequestService.authorizePullRequest(
      windowId,
      decodeCodeProjectPullRequestSwitchTarget({
        projectId,
        repositoryOwner: "acme",
        repositoryName: "original-renamed",
        number: 42,
      }),
    );
    expect(refused).toEqual({ status: "not-authorized" });

    // Authorizing the actual connected repo acme/reused still succeeds.
    const allowed = await pullRequestService.authorizePullRequest(
      windowId,
      decodeCodeProjectPullRequestSwitchTarget({
        projectId,
        repositoryOwner: "acme",
        repositoryName: "reused",
        number: 42,
      }),
    );
    expect(allowed.status).toBe("authorized");
  });

  it("replays recorded turn-off disables onto terminal survivor switch states instead of restoring obsolete stopped or turned-off-by-forge states", async () => {
    let now = "2026-11-19T10:00:00.000Z";
    const journal = openJournal(() => now);
    const threadA = decodeCodeThreadId("20000000-0000-4000-8000-000000000201");
    const threadB = decodeCodeThreadId("20000000-0000-4000-8000-000000000202");
    const oldTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 44,
    });
    const newTarget = decodeCodeProjectPullRequestSwitchTarget({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 44,
    });

    const createSwitches = (links: PullRequestLinkService) =>
      new CodeProjectPullRequestSwitchService({
        authority: {
          authorizePullRequest: async (_wid, target) => ({
            status: "authorized",
            canonicalTarget: target,
            linkedThreadIds: [String(threadA), String(threadB)],
          }),
          linkedPullRequests: async (_wid, tid) =>
            String(tid) === String(threadA) ? [oldTarget] : [newTarget],
        },
        forge: {
          readAutoMergeSettings: async () => ({
            status: "read",
            allowAutoMerge: true,
            methods: { merge: true, squash: true, rebase: false },
          }),
          enableAutoMerge: async () => ({ status: "enabled" }),
          disableAutoMerge: async () => ({ status: "disabled" }),
          readCiLogs: async () => ({ status: "unavailable" }),
          planCiRerun: async () => ({ status: "unavailable" }),
          rerunCi: async () => ({ status: "unavailable" }),
          observe: async () => ({
            status: "observed",
            state: "open",
            headSha: "a".repeat(40),
            headBranch: "feature/work",
            baseBranch: "main",
            autoMergeEnabled: true,
            waitingOn: [],
            failures: [],
            activity: {
              checks: "passed",
              failedChecks: [],
              conflicting: false,
              reviews: [],
              comments: [],
            },
          }),
        },
        threads: {
          inspect: () => ({ status: "available", turnActive: false }),
          markOutsideContent: () => true,
          startTurn: vi.fn(async () => true),
          notifyPerson: vi.fn(async () => undefined),
        },
        journal,
        pullRequestLinks: links,
        clock: () => now,
        uuid: randomUUID,
      });

    let switchReconciler: PullRequestLinkSwitchReconciler | undefined;
    const links = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
      switchReconciler: {
        reconcileDuplicateLinks: (input) => {
          if (switchReconciler === undefined) {
            input.commitMerge?.([]);
            return Promise.resolve({ status: "reconciled" as const, disabledSwitches: [] });
          }
          return switchReconciler.reconcileDuplicateLinks(input);
        },
      },
    });
    const switches = createSwitches(links);
    switchReconciler = switches;

    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "old-repo",
      number: 44,
      threadIds: [threadA],
    });
    now = "2026-11-19T10:01:00.000Z";
    await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      number: 44,
      threadIds: [threadB],
    });

    // Put the survivor into terminal states (`turned-off-by-forge` for Merge
    // when ready, `stopped` for Auto-fix) and keep watch ON on both links.
    const switchAggregate = {
      aggregateType: CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE,
      aggregateId: randomUUID(),
    };
    journal.append({
      aggregate: switchAggregate,
      expectedVersion: decodeAggregateVersion(0),
      events: [
        {
          eventId: randomUUID(),
          eventName: CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: "2026-11-19T10:01:10.000Z",
          payload: { target: oldTarget, change: { kind: "turned-off-by-forge" } },
        },
        {
          eventId: randomUUID(),
          eventName: CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: "2026-11-19T10:01:20.000Z",
          payload: {
            target: oldTarget,
            threadId: threadA,
            change: { kind: "stopped", reason: "attempt-limit" },
          },
        },
      ],
    });

    // Reload switches so the in-memory folds reflect the terminal survivor states.
    const liveSwitches = createSwitches(links);
    switchReconciler = liveSwitches;
    expect((await liveSwitches.query(windowId, oldTarget)).mergeWhenReady.status).toBe(
      "turned-off-by-forge",
    );
    expect((await liveSwitches.query(windowId, oldTarget)).autoFix.status).toBe("stopped");

    // Enable Merge when ready, Auto-fix, and Watch on the duplicate, and Watch on survivor.
    now = "2026-11-19T10:02:00.000Z";
    await liveSwitches.setMergeWhenReady(
      windowId,
      { kind: "enable", target: newTarget, headSha: "a".repeat(40), method: "squash" },
      "local-window",
      signal,
    );
    await liveSwitches.setAutoFix(
      windowId,
      { kind: "enable", target: newTarget, threadId: threadB },
      "user",
    );
    await liveSwitches.watch({ windowId, threadId: threadA, providerInstanceId, signal });
    await liveSwitches.watch({ windowId, threadId: threadB, providerInstanceId, signal });

    // Trigger live duplicate reconciliation.
    now = "2026-11-19T10:05:00.000Z";
    const merged = await links.recordObservation({
      projectId,
      repositoryOwner: "acme",
      repositoryName: "new-repo",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "old-repo",
      number: 44,
      pullRequestNodeId: "PR_kwDOterm44",
      baseRepositoryNodeId: "R_kgDOterm1",
    });
    expect(merged.status).toBe("merged");

    const liveView = await liveSwitches.query(windowId, newTarget);
    expect(liveView.mergeWhenReady.status).toBe("off");
    expect(liveView.autoFix.status).toBe("off");

    // Cold restart: terminal states must stay `off`, and retained watch on threadA stays ON.
    const restartedLinks = new PullRequestLinkService({
      journal,
      uuid: randomUUID,
      clock: () => now,
    });
    const restartedSwitches = createSwitches(restartedLinks);
    const restartedView = await restartedSwitches.query(windowId, newTarget);
    expect(restartedView.mergeWhenReady.status).toBe("off");
    expect(restartedView.autoFix.status).toBe("off");
    await expect(
      restartedSwitches.unwatch({ threadId: threadA, providerInstanceId }),
    ).resolves.toEqual({ status: "unwatched", target: newTarget });
  });
});
