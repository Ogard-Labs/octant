import {
  decodeBindingRevisionId,
  decodeCodeBoardQuery,
  decodeCodeBoardView,
  decodeCodeCheckoutHead,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeDeliveryOutcomeKind,
  type CodeThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CodeThreadMetadataService,
  type CodeGithubMetadataObservation,
  type CodeGitWorktreeObservation,
  type CodeThreadOperationHistory,
} from "./codeThreadMetadataService";
import {
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
    projectProjectionPresent: overrides.projectProjectionPresent ?? true,
    unread: overrides.unread ?? false,
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
    waiting: false,
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
          ? { executing: true, waiting: false }
          : { executing: false, waiting: false },
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

    // The default query echoes the applied all-status filter.
    expect(view.query.statuses).toEqual(["ready", "in-progress", "waiting", "done"]);
    expect(view.generatedAt).toBe(now);
    // The whole view round-trips through the strict contract decoder.
    expect(decodeCodeBoardView(view)).toEqual(view);
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
  });

  it("carries unread and follow-up without letting them change status", async () => {
    const board = new CodeThreadBoardService({
      threads: {
        list: () => [
          boardThread({
            thread: thread({ id: ids.done, outcomeKind: "local-implementation" }),
            unread: true,
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
    expect(card.unread).toBe(true);
    expect(card.followUp).toBe(true);
    // Delivery is objectively satisfied, so it is Done despite unread/follow-up.
    expect(card.status).toBe("done");
  });
});

describe("CodeThreadBoardService filters", () => {
  async function query(q: CodeBoardQuery) {
    const board = service({
      threads: allThreads,
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, waiting: false }
          : { executing: false, waiting: false },
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
