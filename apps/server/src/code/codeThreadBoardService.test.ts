import {
  decodeBindingRevisionId,
  decodeCodeBoardQuery,
  decodeCodeBoardView,
  decodeCodeCheckoutHead,
  decodeCodeCheckoutIdentity,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeDeliveryOutcomeKind,
  type CodeRuntimeWork,
  type CodeThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import {
  CodeThreadMetadataService,
  type CodeGithubMetadataObservation,
  type CodeGitWorktreeObservation,
  type CodeThreadOperationHistory,
} from "./codeThreadMetadataService";
import {
  boardRuntimeActivityFromWorks,
  CodeThreadBoardService,
  type CodeBoardRuntimeActivity,
  type CodeBoardThread,
} from "./codeThreadBoardService";

const now = "2026-07-22T10:00:00.000Z";
const repositoryId = `repo_${"d".repeat(64)}`;

const ids = {
  done: decodeCodeThreadId("00000000-0000-4000-8000-000000003001"),
  waiting: decodeCodeThreadId("00000000-0000-4000-8000-000000003002"),
  executing: decodeCodeThreadId("00000000-0000-4000-8000-000000003003"),
  ready: decodeCodeThreadId("00000000-0000-4000-8000-000000003004"),
  archived: decodeCodeThreadId("00000000-0000-4000-8000-000000003005"),
  projectA: decodeProjectId("00000000-0000-4000-8000-0000000030a1"),
  projectB: decodeProjectId("00000000-0000-4000-8000-0000000030a2"),
  binding: decodeBindingRevisionId("00000000-0000-4000-8000-000000003009"),
  checkout: "00000000-0000-4000-8000-000000003010",
  providerA: "00000000-0000-4000-8000-000000003011",
  providerB: "00000000-0000-4000-8000-000000003012",
} as const;

function thread(overrides: {
  readonly id: CodeThread["id"];
  readonly projectId?: CodeThread["projectId"];
  readonly outcomeKind?: CodeDeliveryOutcomeKind;
  readonly lifecycle?: CodeThread["lifecycle"];
  readonly providerInstanceId?: string;
  readonly title?: string;
}): CodeThread {
  return decodeCodeThread({
    id: overrides.id,
    projectId: overrides.projectId ?? ids.projectA,
    bindingRevisionId: ids.binding,
    repositoryId,
    checkoutId: ids.checkout,
    title: overrides.title ?? "Board thread",
    lifecycle: overrides.lifecycle ?? "active",
    providerInstanceId: overrides.providerInstanceId ?? ids.providerA,
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/x",
      remoteName: "origin",
      proposedBaseRepository: "acme/repo",
      proposedBaseBranch: "development",
      outcomeKind: overrides.outcomeKind ?? "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function boardThread(
  overrides: Partial<CodeBoardThread> & { readonly thread: CodeThread },
): CodeBoardThread {
  return {
    thread: overrides.thread,
    project: overrides.project ?? { id: overrides.thread.projectId, name: "Project A" },
    checkout:
      overrides.checkout ??
      decodeCodeCheckoutIdentity({
        id: overrides.thread.checkoutId,
        repositoryId,
        kind: "managed-worktree",
        availability: "available",
        head: {
          kind: "branch",
          name: "feature/x",
          oid: "a".repeat(40),
        },
        ownershipReceiptId: "00000000-0000-4000-8000-000000003013",
        observedAt: now,
      }),
    projectProjectionPresent: overrides.projectProjectionPresent ?? true,
    followUp: overrides.followUp ?? false,
  };
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

// A metadata service whose Git/GitHub/history observations depend on threadId so
// each fixture thread resolves to a deterministic delivery satisfaction.
function metadataService() {
  const git = {
    observe: vi.fn((input: { threadId: unknown }): CodeGitWorktreeObservation => {
      if (input.threadId === ids.done)
        return gitObserved({ committedAhead: 1, workingTreeClean: true });
      return gitObserved();
    }),
  };
  const github = {
    observe: vi.fn((input: { threadId: unknown }): CodeGithubMetadataObservation => {
      if (input.threadId === ids.waiting) return { status: "unavailable" };
      return githubObserved();
    }),
  };
  const history = {
    read: vi.fn((): CodeThreadOperationHistory => ({ status: "ok", frames: [] })),
  };
  return new CodeThreadMetadataService({ git, github, history });
}

function runtimeSource(
  activity: (threadId: unknown) => CodeBoardRuntimeActivity = () => ({
    executing: false,
    awaitingInput: false,
    interrupted: false,
  }),
) {
  return { observe: vi.fn((threadId: unknown) => activity(threadId)) };
}

function service(options: {
  readonly threads: readonly CodeBoardThread[];
  readonly runtime?: (threadId: unknown) => CodeBoardRuntimeActivity;
}) {
  return new CodeThreadBoardService({
    threads: { list: () => [...options.threads] },
    metadata: metadataService(),
    runtime: runtimeSource(options.runtime),
    clock: () => now,
  });
}

const allThreads: readonly CodeBoardThread[] = [
  boardThread({ thread: thread({ id: ids.done, outcomeKind: "local-implementation" }) }),
  boardThread({
    thread: thread({
      id: ids.waiting,
      outcomeKind: "opened-pr",
      projectId: ids.projectB,
      providerInstanceId: ids.providerB,
    }),
    project: { id: ids.projectB, name: "Project B" },
  }),
  boardThread({ thread: thread({ id: ids.executing, outcomeKind: "local-implementation" }) }),
  boardThread({ thread: thread({ id: ids.ready, outcomeKind: "opened-pr" }) }),
];

function cardFor(cards: readonly CodeBoardCard[], threadId: unknown): CodeBoardCard {
  const card = cards.find((candidate) => candidate.threadId === threadId);
  if (card === undefined) throw new Error("card not found");
  return card;
}

describe("CodeThreadBoardService derivation", () => {
  it("resolves one card per non-archived thread with a runtime-derived status", async () => {
    const board = service({
      threads: [
        ...allThreads,
        boardThread({ thread: thread({ id: ids.archived, lifecycle: "archived" }) }),
      ],
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, awaitingInput: false, interrupted: false }
          : { executing: false, awaitingInput: false, interrupted: false },
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));

    // Archived threads are excluded; every other thread appears exactly once.
    expect(view.cards.map((card) => card.threadId).sort()).toEqual(
      [ids.done, ids.waiting, ids.executing, ids.ready].sort(),
    );
    expect(cardFor(view.cards, ids.done).status).toBe("done");
    expect(cardFor(view.cards, ids.waiting).status).toBe("waiting");
    expect(cardFor(view.cards, ids.executing).status).toBe("in-progress");
    expect(cardFor(view.cards, ids.ready).status).toBe("ready");
    expect(cardFor(view.cards, ids.ready).projectId).toBe(ids.projectA);

    // The default query echoes the applied all-status filter.
    expect(view.query.statuses).toEqual(["ready", "in-progress", "waiting", "done"]);
    expect(view.generatedAt).toBe(now);
    // The whole view round-trips through the strict contract decoder.
    expect(decodeCodeBoardView(view)).toEqual(view);
  });

  it("makes zero GitHub calls and shows only already-cached PR evidence with freshness", async () => {
    const github = { observe: vi.fn() };
    const history = {
      read: vi.fn((): CodeThreadOperationHistory => {
        return {
          status: "ok",
          frames: [
            {
              threadId: ids.ready,
              operationId: "00000000-0000-4000-8000-000000003099",
              cursor: 1,
              occurredAt: now,
              event: {
                kind: "operation-result",
                result: {
                  kind: "pull-request-state",
                  operationId: "00000000-0000-4000-8000-000000003099",
                  state: "created",
                  number: 18,
                  url: "https://github.com/acme/repo/pull/18",
                  headRepository: "acme/repo",
                  headBranch: "feature/x",
                  baseRepository: "acme/repo",
                  baseBranch: "development",
                },
              },
            } as never,
          ],
        } as unknown as CodeThreadOperationHistory;
      }),
    };
    const board = new CodeThreadBoardService({
      threads: {
        list: () => [boardThread({ thread: thread({ id: ids.ready, outcomeKind: "opened-pr" }) })],
      },
      metadata: new CodeThreadMetadataService({
        git: { observe: () => gitObserved() },
        history,
      }),
      runtime: runtimeSource(),
      clock: () => now,
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);

    expect(github.observe).not.toHaveBeenCalled();
    expect(card.linkedPullRequest).toMatchObject({
      kind: "linked",
      freshness: "stale",
      number: 18,
    });
    expect(card.githubFreshness).toBe("stale");
    expect(card.status).toBe("waiting");
    expect(card.statusReason).toBe("delivery-waiting");
  });

  it("keeps a recovering thread visible and in Waiting", async () => {
    const board = service({
      threads: [
        boardThread({
          thread: thread({ id: ids.ready, outcomeKind: "local-implementation" }),
          projectProjectionPresent: false,
        }),
      ],
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.recovery).toEqual({ kind: "recovering", reasons: ["project-projection-missing"] });
    expect(card.status).toBe("waiting");
    expect(card.statusReason).toBe("recovering");
  });

  it("carries follow-up without letting it change status and omits client unread", async () => {
    const board = new CodeThreadBoardService({
      threads: {
        list: () => [
          boardThread({
            thread: thread({ id: ids.done, outcomeKind: "local-implementation" }),
            followUp: true,
          }),
        ],
      },
      metadata: metadataService(),
      runtime: runtimeSource(),
      clock: () => now,
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.done);
    expect(card.followUp).toBe(true);
    expect(card).not.toHaveProperty("unread");
    // Delivery is objectively satisfied, so it is Done despite follow-up.
    expect(card.status).toBe("done");
    expect(card.statusReason).toBe("delivery-satisfied");
  });

  it("names a specific reason for Ready, In Progress, Waiting, and Done", async () => {
    const board = service({
      threads: allThreads,
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, awaitingInput: false, interrupted: false }
          : { executing: false, awaitingInput: false, interrupted: false },
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    expect(cardFor(view.cards, ids.done).statusReason).toBe("delivery-satisfied");
    expect(cardFor(view.cards, ids.executing).statusReason).toBe("executing");
    expect(cardFor(view.cards, ids.waiting).statusReason).toBe("delivery-waiting");
    expect(cardFor(view.cards, ids.ready).statusReason).toBe("idle-unmet-delivery");
  });

  it("does not treat a completed model turn as Done when the delivery target is unmet", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.ready, outcomeKind: "opened-pr" }) })],
      runtime: () => ({ executing: false, awaitingInput: false, interrupted: false }),
    });

    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.status).toBe("ready");
    expect(card.deliverySatisfaction).not.toBe("done");
  });

  it("shows checkout or worktree and branch from the thread's checkout identity", async () => {
    const board = new CodeThreadBoardService({
      threads: {
        list: () => [boardThread({ thread: thread({ id: ids.ready, outcomeKind: "opened-pr" }) })],
      },
      metadata: new CodeThreadMetadataService({
        git: { observe: () => ({ status: "unavailable" }) },
        history: { read: () => ({ status: "ok", frames: [] }) },
      }),
      runtime: runtimeSource(),
      clock: () => now,
    });
    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.checkoutKind).toBe("managed-worktree");
    expect(card.worktree).toMatchObject({
      kind: "available",
      path: "Managed worktree",
      head: { kind: "branch", name: "feature/x" },
    });
  });

  it("does not include a thread the window-filtered source omitted", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.ready, projectId: ids.projectA }) })],
    });
    const view = await board.query(decodeCodeBoardQuery({ version: 1 }));
    expect(view.cards.map((card) => card.threadId)).toEqual([ids.ready]);
    expect(view.cards.some((card) => card.threadId === ids.waiting)).toBe(false);
  });

  it("scopes cards to Code threads of the requested Project", async () => {
    const board = service({ threads: allThreads });
    const view = await board.query(
      decodeCodeBoardQuery({ version: 1, projectIds: [ids.projectB] }),
    );
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.projectId).toBe(ids.projectB);
    expect(view.cards[0]?.threadId).toBe(ids.waiting);
  });
});

describe("CodeThreadBoardService filters", () => {
  async function query(q: CodeBoardQuery) {
    const board = service({
      threads: allThreads,
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, awaitingInput: false, interrupted: false }
          : { executing: false, awaitingInput: false, interrupted: false },
    });
    return board.query(q);
  }

  it("defaults to all four statuses including Done", async () => {
    const view = await query(decodeCodeBoardQuery({ version: 1 }));
    expect(view.cards.some((card) => card.status === "done")).toBe(true);
    expect(view.cards).toHaveLength(4);
  });

  it("applies an explicit status filter", async () => {
    const view = await query(decodeCodeBoardQuery({ version: 1, statuses: ["waiting"] }));
    expect(view.cards.map((card) => card.threadId)).toEqual([ids.waiting]);
    expect(view.query.statuses).toEqual(["waiting"]);
  });

  it("filters by project, provider, and delivery target", async () => {
    const byProject = await query(decodeCodeBoardQuery({ version: 1, projectIds: [ids.projectB] }));
    expect(byProject.cards.map((card) => card.threadId)).toEqual([ids.waiting]);

    const byProvider = await query(
      decodeCodeBoardQuery({ version: 1, providerInstanceIds: [ids.providerB] }),
    );
    expect(byProvider.cards.map((card) => card.threadId)).toEqual([ids.waiting]);

    const byTarget = await query(
      decodeCodeBoardQuery({ version: 1, deliveryTargets: ["opened-pr"] }),
    );
    expect(byTarget.cards.map((card) => card.threadId).sort()).toEqual(
      [ids.waiting, ids.ready].sort(),
    );
  });

  it("filters by text search over the thread title", async () => {
    const board = service({
      threads: [
        boardThread({ thread: thread({ id: ids.ready, title: "Parser refactor" }) }),
        boardThread({
          thread: thread({
            id: ids.done,
            title: "Docs update",
            outcomeKind: "local-implementation",
          }),
        }),
      ],
    });
    const view = await board.query(decodeCodeBoardQuery({ version: 1, text: "parser" }));
    expect(view.cards.map((card) => card.threadId)).toEqual([ids.ready]);
  });

  it("filters by follow-up state without hiding Done by default", async () => {
    const board = service({
      threads: [
        boardThread({
          thread: thread({ id: ids.done, outcomeKind: "local-implementation" }),
          followUp: true,
        }),
        boardThread({ thread: thread({ id: ids.ready, outcomeKind: "opened-pr" }) }),
      ],
    });
    const only = await board.query(decodeCodeBoardQuery({ version: 1, followUp: "only" }));
    expect(only.cards.map((card) => card.threadId)).toEqual([ids.done]);
    const excluded = await board.query(decodeCodeBoardQuery({ version: 1, followUp: "excluded" }));
    expect(excluded.cards.map((card) => card.threadId)).toEqual([ids.ready]);
  });
});

describe("boardRuntimeActivityFromWorks", () => {
  // `firstSequence` is the journal position where the record first appeared, so
  // a higher number always means the work started later. `updatedAt` only says
  // when the record last moved and defaults to a value no assertion depends on.
  const work = (
    kind: CodeRuntimeWork["kind"],
    state: CodeRuntimeWork["state"],
    firstSequence: number,
    updatedAt = "2026-07-22T09:00:00.000Z",
  ): ProjectedCodeRuntimeWork => ({
    work: {
      id: `${kind}-${firstSequence}`,
      threadId: ids.done,
      kind,
      state,
      updatedAt,
    } as never,
    firstSequence,
  });

  it("ignores restart-frozen tool work and superseded turns", () => {
    // A restart marked an old terminal and test run interrupted because their
    // processes are gone, and the previous turn's wait was superseded by a
    // newer completed turn. Nothing here still needs the person.
    expect(
      boardRuntimeActivityFromWorks([
        work("terminal", "interrupted", 1),
        work("test", "interrupted", 2),
        work("provider-turn", "interrupted", 3),
        work("provider-turn", "completed", 4),
      ]),
    ).toEqual({ executing: false, awaitingInput: false, interrupted: false });
  });

  it("ignores a superseded provider turn still frozen in running or waiting", () => {
    // A newer turn finished; whatever state the older row was frozen in, it no
    // longer speaks for the thread.
    for (const stale of ["running", "waiting", "ambiguous"] as const) {
      expect(
        boardRuntimeActivityFromWorks([
          work("provider-turn", stale, 1),
          work("provider-turn", "completed", 2),
        ]),
      ).toEqual({ executing: false, awaitingInput: false, interrupted: false });
    }
  });

  it("ranks turns by when they started, not by when their records last moved", () => {
    const tie = "2026-07-22T09:00:00.000Z";
    // Two turns whose records were last written in the same millisecond. Their
    // stamps cannot separate them, but the journal chronology can: the second
    // turn finished, so nothing is still running.
    const stale = work("provider-turn", "running", 1, tie);
    const latest = work("provider-turn", "completed", 2, tie);
    for (const order of [
      [stale, latest],
      [latest, stale],
    ]) {
      expect(boardRuntimeActivityFromWorks(order)).toEqual({
        executing: false,
        awaitingInput: false,
        interrupted: false,
      });
    }

    // A wall-clock stamp can also run backwards — the host clock guard exists
    // because local time rolls back. The turn that started later still decides,
    // whatever its record claims about the hour it moved.
    expect(
      boardRuntimeActivityFromWorks([
        work("provider-turn", "running", 1, "2026-07-22T09:30:00.000Z"),
        work("provider-turn", "completed", 2, "2026-07-22T09:00:00.000Z"),
      ]),
    ).toEqual({ executing: false, awaitingInput: false, interrupted: false });
  });

  it("keeps the thread Waiting for the latest interrupted provider turn", () => {
    expect(
      boardRuntimeActivityFromWorks([
        work("provider-turn", "completed", 1),
        work("provider-turn", "interrupted", 2),
      ]),
    ).toEqual({
      executing: false,
      awaitingInput: false,
      interrupted: true,
      blockingReason: "The last agent turn was interrupted.",
    });
  });

  it("preserves an authoritative wait from every runtime work kind", () => {
    // Git, delivery, review, and file work that genuinely reports `waiting` or
    // `ambiguous` still owes the person a decision, even though the thread's
    // latest provider turn has finished.
    for (const kind of ["git", "delivery", "review", "file"] as const) {
      expect(
        boardRuntimeActivityFromWorks([
          work("provider-turn", "completed", 2),
          work(kind, "waiting", 1),
        ]),
      ).toEqual({
        executing: false,
        awaitingInput: true,
        interrupted: false,
        blockingReason: "Runtime work is waiting for a decision or input.",
      });
    }

    expect(boardRuntimeActivityFromWorks([work("test", "ambiguous", 1)])).toMatchObject({
      executing: false,
      awaitingInput: true,
      interrupted: false,
    });
  });

  it("reports executing work without a blocking reason", () => {
    expect(
      boardRuntimeActivityFromWorks([
        work("provider-turn", "interrupted", 1),
        work("terminal", "running", 2),
      ]),
    ).toEqual({ executing: true, awaitingInput: false, interrupted: true });
  });
});
