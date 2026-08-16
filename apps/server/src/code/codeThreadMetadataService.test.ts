import {
  decodeBindingRevisionId,
  decodeCodeCheckoutHead,
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
  type CodeGitWorktreeObservation,
  type CodeGithubMetadataObservation,
  type CodeThreadMetadataInput,
  type CodeThreadOperationHistory,
} from "./codeThreadMetadataService";

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
  operation: "00000000-0000-4000-8000-000000002007",
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

describe("CodeThreadMetadataService projection", () => {
  it("projects worktree, branch, changes, PR, checks, review, child agents, and activity", async () => {
    const fixture = serviceFixture({
      git: () =>
        gitObserved({
          changedPathCount: 3,
          stagedCount: 1,
          committedAhead: 2,
          workingTreeClean: false,
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
    expect(metadata.deliverySatisfaction).toBe("waiting");
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
