import {
  decodeBindingRevisionId,
  decodeCodeCheckoutHead,
  decodeCodeEvidenceContentId,
  decodeCodeThread,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeCodeThreadOperationalMetadataView,
  decodeProjectId,
  type CodeDeliveryOutcomeKind,
  type CodeOperationEventFrame,
  type CodeThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CodeThreadMetadataService,
  MAX_CODE_THREAD_KNOWN_PULL_REQUESTS,
  pullRequestIdentitiesFromHistory,
  type CodeGitWorktreeObservation,
  type CodeGithubMetadataObservation,
  type CodeThreadMetadataInput,
  type CodeThreadOperationHistory,
} from "./codeThreadMetadataService";

describe("Code thread known pull-request identities", () => {
  it("recovers, deduplicates, and bounds exact identities from journal history", () => {
    const frames = Array.from({ length: MAX_CODE_THREAD_KNOWN_PULL_REQUESTS + 2 }, (_, index) =>
      frame(
        {
          kind: "operation-result",
          result: {
            kind: "pull-request-state",
            operationId: ids.operation,
            state: "existing",
            number: index + 1,
            url: `https://github.com/acme/repo/pull/${index + 1}`,
            headRepository: "acme/repo",
            headBranch: `feature/${index + 1}`,
            baseRepository: "acme/repo",
            baseBranch: "development",
          },
        } as never,
        `2026-07-20T${String(index).padStart(2, "0")}:00:00.000Z`,
        index + 1,
      ),
    );
    frames.push(
      frame(
        {
          kind: "operation-result",
          result: {
            kind: "pull-request-state",
            operationId: ids.operation,
            state: "merged",
            number: 1,
            url: "https://github.com/acme/repo/pull/1",
            headRepository: "acme/repo",
            headBranch: "feature/1",
            baseRepository: "acme/repo",
            baseBranch: "development",
          },
        } as never,
        "2026-07-21T23:00:00.000Z",
        frames.length + 1,
      ),
    );

    const identities = pullRequestIdentitiesFromHistory({ status: "ok", frames });
    expect(identities).toHaveLength(MAX_CODE_THREAD_KNOWN_PULL_REQUESTS);
    expect(identities[0]).toEqual({ number: 1, observedAt: "2026-07-21T23:00:00.000Z" });
    expect(new Set(identities.map((identity) => identity.number)).size).toBe(identities.length);
    expect(pullRequestIdentitiesFromHistory({ status: "rebuild-required" })).toEqual([]);
  });
});

const now = "2026-07-20T23:00:00.000Z";
const later = "2026-07-20T23:30:00.000Z";
const repositoryId = `repo_${"d".repeat(64)}`;

const ids = {
  thread: decodeCodeThreadId("00000000-0000-4000-8000-000000002001"),
  other: decodeCodeThreadId("00000000-0000-4000-8000-000000002002"),
  project: decodeProjectId("00000000-0000-4000-8000-000000002003"),
  binding: decodeBindingRevisionId("00000000-0000-4000-8000-000000002004"),
  checkout: "00000000-0000-4000-8000-000000002005",
  provider: "00000000-0000-4000-8000-000000002006",
  operation: decodeCodeOperationId("00000000-0000-4000-8000-000000002007"),
} as const;

function thread(
  overrides: {
    readonly id?: CodeThread["id"];
    readonly lifecycle?: CodeThread["lifecycle"];
    readonly outcomeKind?: CodeDeliveryOutcomeKind;
  } = {},
): CodeThread {
  return decodeCodeThread({
    id: overrides.id ?? ids.thread,
    projectId: ids.project,
    bindingRevisionId: ids.binding,
    repositoryId,
    checkoutId: ids.checkout,
    title: "Thread metadata",
    lifecycle: overrides.lifecycle ?? "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/x",
      remoteName: "origin",
      proposedBaseRepository: "acme/repo",
      proposedBaseBranch: "development",
      outcomeKind: overrides.outcomeKind ?? "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

const branchHead = decodeCodeCheckoutHead({
  kind: "branch",
  name: "feature/x",
  oid: "a".repeat(40),
});

function gitObserved(
  overrides: Partial<Extract<CodeGitWorktreeObservation, { status: "observed" }>> = {},
): CodeGitWorktreeObservation {
  return {
    status: "observed",
    path: "/home/ubuntu/wt/thread",
    head: branchHead,
    changedPathCount: 0,
    stagedCount: 0,
    committedAhead: 0,
    workingTreeClean: true,
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

function githubObserved(
  overrides: Partial<Extract<CodeGithubMetadataObservation, { status: "observed" }>> = {},
): CodeGithubMetadataObservation {
  return {
    status: "observed",
    pullRequest: null,
    checks: "unknown",
    review: "unknown",
    ...overrides,
  };
}

function frame(
  event: CodeOperationEventFrame["event"],
  occurredAt: string,
  cursor = 1,
  operationId: string = ids.operation,
): CodeOperationEventFrame {
  return {
    threadId: ids.thread,
    operationId,
    cursor,
    occurredAt,
    event,
  } as CodeOperationEventFrame;
}

const matchingPullRequest = {
  number: 7,
  url: "https://github.com/acme/repo/pull/7",
  baseRepository: "acme/repo",
  baseBranch: "development",
  headBranch: "feature/x",
  state: "open",
} as const;

function serviceFixture(
  overrides: {
    readonly git?: () => CodeGitWorktreeObservation | Promise<CodeGitWorktreeObservation>;
    readonly github?: () => CodeGithubMetadataObservation | Promise<CodeGithubMetadataObservation>;
    readonly history?: () => CodeThreadOperationHistory | Promise<CodeThreadOperationHistory>;
  } = {},
) {
  const git = {
    observe: vi.fn(overrides.git ?? (() => gitObserved())),
  };
  const github = {
    observe: vi.fn(overrides.github ?? (() => githubObserved())),
  };
  const history = {
    read: vi.fn(
      overrides.history ?? ((): CodeThreadOperationHistory => ({ status: "ok", frames: [] })),
    ),
  };
  const service = new CodeThreadMetadataService({ git, github, history });
  return { service, git, github, history };
}

function input(overrides: Partial<CodeThreadMetadataInput> = {}): CodeThreadMetadataInput {
  return {
    thread: overrides.thread ?? thread(),
    projectProjectionPresent: overrides.projectProjectionPresent ?? true,
  };
}

function journaledGitObserved(options: { readonly omitLineTotals?: boolean } = {}) {
  return {
    kind: "git-observed",
    operationId: ids.operation,
    gitOperationId: ids.operation,
    head: { kind: "branch", name: "feature/x", oid: "a".repeat(40) },
    stateToken: "a".repeat(64),
    status: [
      { path: "src/a.ts", index: "M", worktree: " " },
      { path: "src/b.ts", index: " ", worktree: "M" },
    ],
    changedPaths: ["src/a.ts", "src/b.ts"],
    ...(options.omitLineTotals === true ? {} : { insertions: 12, deletions: 3 }),
    diff: {
      contentId: "00000000-0000-4000-8000-0000000020a1",
      digest: "a".repeat(64),
      byteLength: 1,
    },
    remotes: [],
    upstream: null,
    worktrees: [],
  } as never;
}

describe("CodeThreadMetadataService projection", () => {
  it("projects worktree, branch, changes, PR, checks, review, child agents, and activity", async () => {
    const fixture = serviceFixture({
      git: () =>
        gitObserved({
          changedPathCount: 3,
          stagedCount: 1,
          committedAhead: 2,
          workingTreeClean: false,
          insertions: 12,
          deletions: 3,
        }),
      github: () =>
        githubObserved({
          pullRequest: {
            number: 7,
            url: "https://github.com/acme/repo/pull/7",
            baseRepository: "acme/repo",
            baseBranch: "development",
            headBranch: "feature/x",
            state: "open",
          },
          checks: "passing",
          review: "approved",
        }),
      history: () => ({
        status: "ok",
        frames: [
          frame(
            { kind: "child-activity", childId: "c1", state: "running", summary: "Refactoring" },
            now,
            1,
          ),
          frame(
            { kind: "child-activity", childId: "c2", state: "completed", summary: "Done tests" },
            later,
            2,
          ),
        ],
      }),
    });

    const view = await fixture.service.project([input()]);

    expect(view.version).toBe(1);
    expect(view.threads).toHaveLength(1);
    const metadata = view.threads[0]!;
    expect(metadata.threadId).toBe(ids.thread);
    expect(metadata.checkoutId).toBe(ids.checkout);
    expect(metadata.worktree).toEqual({
      kind: "available",
      checkoutId: ids.checkout,
      path: "/home/ubuntu/wt/thread",
      head: branchHead,
    });
    expect(metadata.changedFiles).toEqual({
      kind: "observed",
      freshness: "fresh",
      changedPathCount: 3,
      stagedCount: 1,
      committedAhead: 2,
      workingTreeClean: false,
      insertions: 12,
      deletions: 3,
    });
    expect(metadata.linkedPullRequest).toEqual({
      kind: "linked",
      freshness: "fresh",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      baseRepository: "acme/repo",
      baseBranch: "development",
      headBranch: "feature/x",
      state: "open",
      matchesDeliveryBranch: true,
    });
    expect(metadata.checks).toEqual({ freshness: "fresh", state: "passing" });
    expect(metadata.reviewState).toEqual({ freshness: "fresh", state: "approved" });
    expect(metadata.childAgents).toEqual({
      active: 1,
      completed: 1,
      failed: 0,
      // The completed child c2 has a result the user has not acknowledged yet.
      unacknowledgedResults: 1,
      latestSummary: "Done tests",
      latestActivityAt: later,
    });
    expect(metadata.lastMeaningfulActivityAt).toBe(later);
    expect(metadata.githubFreshness).toBe("fresh");
    expect(metadata.recovery).toEqual({ kind: "ok" });
    expect(metadata.rebuiltFromJournal).toBe(true);

    // An open PR matching the delivery branch, with no outstanding child work
    // beyond the active child agent, keeps an opened-pr target waiting on the
    // child, never falsely done.
    expect(metadata.deliverySatisfaction).toBe("waiting");

    // The whole view round-trips through the strict contract decoder.
    expect(decodeCodeThreadOperationalMetadataView(view)).toEqual(view);
  });

  it("marks an opened-pr target done when its PR is fresh and matches with no child work", async () => {
    const fixture = serviceFixture({
      github: () =>
        githubObserved({
          pullRequest: {
            number: 7,
            url: "https://github.com/acme/repo/pull/7",
            baseRepository: "acme/repo",
            baseBranch: "development",
            headBranch: "feature/x",
            state: "open",
          },
          checks: "passing",
          review: "approved",
        }),
    });

    const view = await fixture.service.project([input()]);

    expect(view.threads[0]!.deliverySatisfaction).toBe("done");
  });

  it("excludes archived threads from the projection", async () => {
    const fixture = serviceFixture();

    const view = await fixture.service.project([
      input({ thread: thread({ lifecycle: "archived" }) }),
      input({ thread: thread({ id: ids.other }) }),
    ]);

    expect(view.threads.map((metadata) => metadata.threadId)).toEqual([ids.other]);
  });
});

describe("CodeThreadMetadataService staleness", () => {
  it("labels GitHub metadata stale when it cannot refresh and carries the last-known PR", async () => {
    const fresh = serviceFixture({
      github: () =>
        githubObserved({
          pullRequest: {
            number: 7,
            url: "https://github.com/acme/repo/pull/7",
            baseRepository: "acme/repo",
            baseBranch: "development",
            headBranch: "feature/x",
            state: "open",
          },
          checks: "passing",
          review: "approved",
        }),
    });
    const first = await fresh.service.project([input()]);
    expect(first.threads[0]!.deliverySatisfaction).toBe("done");

    const offline = serviceFixture({ github: () => ({ status: "unavailable" }) });
    const second = await offline.service.project([input()], first);
    const metadata = second.threads[0]!;

    expect(metadata.githubFreshness).toBe("stale");
    expect(metadata.linkedPullRequest).toEqual({
      kind: "linked",
      freshness: "stale",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      baseRepository: "acme/repo",
      baseBranch: "development",
      headBranch: "feature/x",
      state: "open",
      matchesDeliveryBranch: true,
    });
    expect(metadata.checks.freshness).toBe("stale");
    expect(metadata.reviewState.freshness).toBe("stale");
    // Stale GitHub metadata can never satisfy a PR delivery target.
    expect(metadata.deliverySatisfaction).toBe("waiting");
  });

  it("treats a PR delivery target with unrefreshable GitHub and no prior PR as waiting", async () => {
    const fixture = serviceFixture({ github: () => ({ status: "unavailable" }) });

    const view = await fixture.service.project([input()]);
    const metadata = view.threads[0]!;

    expect(metadata.githubFreshness).toBe("stale");
    expect(metadata.linkedPullRequest).toEqual({ kind: "none", freshness: "stale" });
    expect(metadata.deliverySatisfaction).toBe("waiting");
  });

  it("throws in the GitHub source are treated as an unrefreshable observation", async () => {
    const fixture = serviceFixture({
      github: () => {
        throw new Error("gh exploded");
      },
    });

    const view = await fixture.service.project([input()]);
    expect(view.threads[0]!.githubFreshness).toBe("stale");
  });

  it("marks the worktree unavailable and a local-implementation target waiting when Git cannot observe", async () => {
    const fixture = serviceFixture({
      git: () => ({ status: "unavailable" }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "local-implementation" }) }),
    ]);
    const metadata = view.threads[0]!;

    expect(metadata.worktree).toEqual({ kind: "unavailable", checkoutId: ids.checkout });
    expect(metadata.changedFiles).toEqual({ kind: "unavailable" });
    expect(metadata.changedFiles).not.toHaveProperty("changedPathCount");
    expect(metadata.changedFiles).not.toHaveProperty("insertions");
    expect(metadata.changedFiles).not.toHaveProperty("deletions");
    expect(metadata.deliverySatisfaction).toBe("waiting");
  });

  it("carries last-known insertion and deletion totals as stale when Git cannot refresh", async () => {
    const fresh = serviceFixture({
      git: () =>
        gitObserved({
          changedPathCount: 2,
          stagedCount: 1,
          committedAhead: 1,
          workingTreeClean: false,
          insertions: 12,
          deletions: 3,
        }),
    });
    const first = await fresh.service.project([
      input({ thread: thread({ outcomeKind: "local-implementation" }) }),
    ]);
    expect(first.threads[0]!.changedFiles).toEqual({
      kind: "observed",
      freshness: "fresh",
      changedPathCount: 2,
      stagedCount: 1,
      committedAhead: 1,
      workingTreeClean: false,
      insertions: 12,
      deletions: 3,
    });

    const offline = serviceFixture({ git: () => ({ status: "unavailable" }) });
    const second = await offline.service.project(
      [input({ thread: thread({ outcomeKind: "local-implementation" }) })],
      first,
    );
    expect(second.threads[0]!.changedFiles).toEqual({
      kind: "observed",
      freshness: "stale",
      changedPathCount: 2,
      stagedCount: 1,
      committedAhead: 1,
      workingTreeClean: false,
      insertions: 12,
      deletions: 3,
    });
  });

  it("keeps a local-implementation target done only with fresh committed, clean work", async () => {
    const done = serviceFixture({
      git: () => gitObserved({ committedAhead: 1, workingTreeClean: true }),
    });
    const doneView = await done.service.project([
      input({ thread: thread({ outcomeKind: "local-implementation" }) }),
    ]);
    expect(doneView.threads[0]!.deliverySatisfaction).toBe("done");

    const dirty = serviceFixture({
      git: () => gitObserved({ committedAhead: 1, workingTreeClean: false, changedPathCount: 1 }),
    });
    const dirtyView = await dirty.service.project([
      input({ thread: thread({ outcomeKind: "local-implementation" }) }),
    ]);
    expect(dirtyView.threads[0]!.deliverySatisfaction).toBe("waiting");
  });
});

describe("CodeThreadMetadataService recovery and rebuild", () => {
  it("keeps a thread visible with a recovery reason when its Project projection is missing", async () => {
    const fixture = serviceFixture();

    const view = await fixture.service.project([input({ projectProjectionPresent: false })]);
    const metadata = view.threads[0]!;

    expect(metadata.threadId).toBe(ids.thread);
    expect(metadata.recovery).toEqual({
      kind: "recovering",
      reasons: ["project-projection-missing"],
    });
  });

  it("recovers with an operation-journal reason and stale activity when the journal must rebuild", async () => {
    const seed = serviceFixture({
      history: () => ({
        status: "ok",
        frames: [
          frame(
            { kind: "child-activity", childId: "c1", state: "running", summary: "Working" },
            later,
            1,
          ),
        ],
      }),
    });
    const first = await seed.service.project([input()]);
    expect(first.threads[0]!.childAgents.active).toBe(1);

    const interrupted = serviceFixture({ history: () => ({ status: "rebuild-required" }) });
    const second = await interrupted.service.project([input()], first);
    const metadata = second.threads[0]!;

    expect(metadata.recovery).toEqual({
      kind: "recovering",
      reasons: ["operation-journal-rebuild-required"],
    });
    // The last-known child-agent summary and activity are preserved, not lost.
    expect(metadata.childAgents.active).toBe(1);
    expect(metadata.lastMeaningfulActivityAt).toBe(later);
  });

  it("rebuilds cleanly from the journal when a prior projection entry is missing or invalid", async () => {
    const fixture = serviceFixture();

    const first = await fixture.service.project([input()]);
    expect(first.threads[0]!.rebuiltFromJournal).toBe(true);

    const second = await fixture.service.project([input()], first);
    expect(second.threads[0]!.rebuiltFromJournal).toBe(false);

    // A corrupt previous entry is ignored and the thread is rebuilt from scratch.
    const corrupt = {
      version: 1 as const,
      threads: [{ threadId: ids.thread, not: "valid" } as never],
    };
    const third = await fixture.service.project([input()], corrupt);
    expect(third.threads[0]!.rebuiltFromJournal).toBe(true);
  });

  it("surfaces both a missing Project projection and a journal rebuild together", async () => {
    const fixture = serviceFixture({ history: () => ({ status: "rebuild-required" }) });

    const view = await fixture.service.project([input({ projectProjectionPresent: false })]);
    expect(view.threads[0]!.recovery).toEqual({
      kind: "recovering",
      reasons: ["project-projection-missing", "operation-journal-rebuild-required"],
    });
  });
});

describe("CodeThreadMetadataService cached GitHub evidence", () => {
  it("reconstructs PR evidence from the operation journal without a GitHub source", async () => {
    const github = { observe: vi.fn() };
    const service = new CodeThreadMetadataService({
      git: { observe: () => gitObserved() },
      history: {
        read: () => ({
          status: "ok",
          frames: [
            frame(
              {
                kind: "operation-result",
                result: {
                  kind: "pull-request-review",
                  operationId: ids.operation as never,
                  state: "observed",
                  freshness: "fresh",
                  ambiguous: false,
                  staleSections: [],
                  number: 18,
                  url: "https://github.com/acme/repo/pull/18",
                  title: "Parser",
                  pullRequestState: "open",
                  baseRepository: "acme/repo",
                  baseBranch: "development",
                  headRepository: "acme/repo",
                  headBranch: "feature/x",
                  author: "octant",
                  matchesDeliveryBranch: true,
                  description: {
                    contentId: "00000000-0000-4000-8000-0000000020a1" as never,
                    digest: "a".repeat(64),
                    byteLength: 1,
                  },
                  diff: {
                    contentId: "00000000-0000-4000-8000-0000000020a2" as never,
                    digest: "b".repeat(64),
                    byteLength: 1,
                  },
                  commits: [],
                  files: [],
                  checks: [{ name: "ci", state: "success" }],
                  reviews: [{ author: "reviewer", state: "approved", body: "lgtm" }],
                  comments: [],
                },
              } as never,
              now,
            ),
          ],
        }),
      },
    });

    const view = await service.project([input()]);
    expect(github.observe).not.toHaveBeenCalled();
    expect(view.threads[0]!.linkedPullRequest).toMatchObject({
      kind: "linked",
      freshness: "fresh",
      number: 18,
    });
    expect(view.threads[0]!.checks).toEqual({ freshness: "fresh", state: "passing" });
    expect(view.threads[0]!.reviewState).toEqual({ freshness: "fresh", state: "approved" });
  });
});

describe("CodeThreadMetadataService cached Git observation", () => {
  it("rebuilds stale path and line totals from the same journaled git observation", async () => {
    const fixture = serviceFixture({
      git: () => ({ status: "unavailable" }),
      history: () => ({
        status: "ok",
        frames: [frame({ kind: "operation-result", result: journaledGitObserved() }, now)],
      }),
    });

    const view = await fixture.service.project([input()]);
    expect(view.threads[0]!.changedFiles).toEqual({
      kind: "observed",
      freshness: "stale",
      changedPathCount: 2,
      stagedCount: 1,
      committedAhead: 0,
      workingTreeClean: false,
      insertions: 12,
      deletions: 3,
    });
  });

  it("does not reconstruct partial changed-file numbers from a journaled observation that lacks line totals", async () => {
    const fixture = serviceFixture({
      git: () => ({ status: "unavailable" }),
      history: () => ({
        status: "ok",
        frames: [
          frame(
            {
              kind: "operation-result",
              result: journaledGitObserved({ omitLineTotals: true }),
            },
            now,
          ),
        ],
      }),
    });

    const view = await fixture.service.project([input()]);
    expect(view.threads[0]!.changedFiles).toEqual({ kind: "unavailable" });
    expect(view.threads[0]!.changedFiles).not.toHaveProperty("changedPathCount");
    expect(view.threads[0]!.changedFiles).not.toHaveProperty("insertions");
    expect(view.threads[0]!.changedFiles).not.toHaveProperty("deletions");
  });
});

describe("CodeThreadMetadataService investigation-result gating", () => {
  it("does not treat a completed terminal/test/git operation as an investigation result", async () => {
    const fixture = serviceFixture({
      history: () => ({
        status: "ok",
        // A completed generic operation-state (e.g. a terminal command, test
        // run, or Git operation finishing) that is not correlated with any
        // provider turn.
        frames: [frame({ kind: "operation-state", state: "completed" }, now, 1)],
      }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "investigation-result" }) }),
    ]);

    // No provider-turn result was delivered, so the investigation is not done.
    expect(view.threads[0]!.deliverySatisfaction).toBe("pending");
  });

  it("marks an investigation-result target done on a completed provider-turn result", async () => {
    const fixture = serviceFixture({
      history: () => ({
        status: "ok",
        frames: [
          frame(
            {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: decodeCodeOperationId(ids.operation),
                state: "completed",
              },
            },
            now,
            1,
          ),
        ],
      }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "investigation-result" }) }),
    ]);

    expect(view.threads[0]!.deliverySatisfaction).toBe("done");
  });

  it("accepts a completed operation-state only when correlated with a provider turn", async () => {
    const fixture = serviceFixture({
      history: () => ({
        status: "ok",
        frames: [
          // The provider turn for this operation is running, then the
          // operation-state completes for the same operationId — a completion
          // correlated with the investigation's provider turn.
          frame(
            {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: decodeCodeOperationId(ids.operation),
                state: "running",
              },
            },
            now,
            1,
          ),
          frame({ kind: "operation-state", state: "completed" }, later, 2),
        ],
      }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "investigation-result" }) }),
    ]);

    expect(view.threads[0]!.deliverySatisfaction).toBe("done");
  });

  it("ignores a completed operation-state uncorrelated with the running provider turn", async () => {
    const otherOperation = "00000000-0000-4000-8000-000000002099";
    const fixture = serviceFixture({
      history: () => ({
        status: "ok",
        frames: [
          // The provider turn (a different operation) never completes, and the
          // completed operation-state belongs to an unrelated operation.
          frame(
            {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: decodeCodeOperationId(otherOperation),
                state: "running",
              },
            },
            now,
            1,
            otherOperation,
          ),
          frame({ kind: "operation-state", state: "completed" }, later, 2),
        ],
      }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "investigation-result" }) }),
    ]);

    expect(view.threads[0]!.deliverySatisfaction).toBe("pending");
  });
});

describe("CodeThreadMetadataService child-result acknowledgement gating", () => {
  it("keeps an opened-pr target waiting while a completed child result is unacknowledged", async () => {
    const fixture = serviceFixture({
      github: () =>
        githubObserved({ pullRequest: matchingPullRequest, checks: "passing", review: "approved" }),
      history: () => ({
        status: "ok",
        frames: [
          frame(
            { kind: "child-activity", childId: "c1", state: "completed", summary: "Child done" },
            now,
            1,
          ),
        ],
      }),
    });

    const view = await fixture.service.project([input()]);
    const metadata = view.threads[0]!;

    // The completed child is not auto-acknowledged, so it still blocks the
    // otherwise-satisfied PR target instead of clearing on the terminal frame.
    expect(metadata.childAgents).toMatchObject({
      active: 0,
      completed: 1,
      failed: 0,
      unacknowledgedResults: 1,
    });
    expect(metadata.deliverySatisfaction).toBe("waiting");
  });

  it("keeps a local-implementation target waiting while a failed child result is unacknowledged", async () => {
    const fixture = serviceFixture({
      git: () => gitObserved({ committedAhead: 1, workingTreeClean: true }),
      history: () => ({
        status: "ok",
        frames: [
          frame(
            { kind: "child-activity", childId: "c1", state: "failed", summary: "Child failed" },
            now,
            1,
          ),
        ],
      }),
    });

    const view = await fixture.service.project([
      input({ thread: thread({ outcomeKind: "local-implementation" }) }),
    ]);
    const metadata = view.threads[0]!;

    expect(metadata.childAgents).toMatchObject({
      active: 0,
      completed: 0,
      failed: 1,
      unacknowledgedResults: 1,
    });
    expect(metadata.deliverySatisfaction).toBe("waiting");
  });
});

describe("CodeThreadMetadataService cached GitHub evidence", () => {
  it("reconstructs already-cached PR evidence from the journal and never calls GitHub", async () => {
    const github = { observe: vi.fn() };
    const history = {
      read: vi.fn(
        (): CodeThreadOperationHistory => ({
          status: "ok",
          frames: [
            frame(
              {
                kind: "operation-result",
                result: {
                  kind: "pull-request-state",
                  operationId: decodeCodeOperationId(ids.operation),
                  state: "created",
                  number: 7,
                  url: "https://github.com/acme/repo/pull/7",
                  headRepository: "acme/repo",
                  headBranch: "feature/x",
                  baseRepository: "acme/repo",
                  baseBranch: "development",
                },
              },
              now,
            ),
          ],
        }),
      ),
    };
    const service = new CodeThreadMetadataService({
      git: { observe: () => gitObserved() },
      history,
    });

    const view = await service.project([input()]);
    const metadata = view.threads[0]!;

    expect(github.observe).not.toHaveBeenCalled();
    expect(metadata.linkedPullRequest).toEqual({
      kind: "linked",
      freshness: "stale",
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      baseRepository: "acme/repo",
      baseBranch: "development",
      headBranch: "feature/x",
      state: "open",
      matchesDeliveryBranch: true,
    });
    expect(metadata.githubFreshness).toBe("stale");
    expect(metadata.checks).toEqual({ freshness: "stale", state: "unknown" });
    expect(metadata.reviewState).toEqual({ freshness: "stale", state: "unknown" });
  });
});
