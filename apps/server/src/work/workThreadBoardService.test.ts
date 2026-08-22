import {
  decodeWorkBoardQuery,
  decodeWorkBoardView,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
  type WorkBoardCard,
  type WorkBoardQuery,
  type WorkThread,
  type WorkTurnState,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  boardRuntimeActivityFromTurnsAndSignals,
  WorkThreadBoardService,
  type WorkBoardEvidence,
  type WorkBoardRuntimeActivity,
  type WorkBoardThread,
} from "./workThreadBoardService";

const now = "2026-07-22T10:00:00.000Z";

const ids = {
  done: decodeWorkThreadId("00000000-0000-4000-8000-000000007001"),
  waiting: decodeWorkThreadId("00000000-0000-4000-8000-000000007002"),
  executing: decodeWorkThreadId("00000000-0000-4000-8000-000000007003"),
  ready: decodeWorkThreadId("00000000-0000-4000-8000-000000007004"),
  archived: decodeWorkThreadId("00000000-0000-4000-8000-000000007005"),
  projectA: decodeProjectId("00000000-0000-4000-8000-0000000070a1"),
  projectB: decodeProjectId("00000000-0000-4000-8000-0000000070a2"),
  providerA: "00000000-0000-4000-8000-000000007011",
  providerB: "00000000-0000-4000-8000-000000007012",
} as const;

function thread(overrides: {
  readonly id: WorkThread["id"];
  readonly projectId?: WorkThread["projectId"];
  readonly lifecycle?: WorkThread["lifecycle"];
  readonly providerInstanceId?: string;
  readonly title?: string;
  readonly completionConfirmed?: boolean;
}): WorkThread {
  return decodeWorkThread({
    id: overrides.id,
    projectId: overrides.projectId ?? ids.projectA,
    title: overrides.title ?? "Draft brief",
    lifecycle: overrides.lifecycle ?? "active",
    ...(overrides.completionConfirmed === true
      ? {
          completionConfirmed: true,
          completionEvidence: {
            deliveryTarget: overrides.title ?? "Draft brief",
            satisfactionEvidence: "The brief is in the Project root.",
          },
        }
      : {}),
    providerInstanceId: overrides.providerInstanceId ?? ids.providerA,
    modelId: "model-a",
    workingDirectory: ".",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function boardThread(
  overrides: Partial<WorkBoardThread> & { readonly thread: WorkThread },
): WorkBoardThread {
  return {
    thread: overrides.thread,
    project: overrides.project ?? { id: overrides.thread.projectId, name: "Project A" },
    projectProjectionPresent: overrides.projectProjectionPresent ?? true,
    bindingRevisionCurrent: overrides.bindingRevisionCurrent ?? true,
    followUp: overrides.followUp ?? false,
  };
}

function emptyEvidence(overrides: Partial<WorkBoardEvidence> = {}): WorkBoardEvidence {
  return {
    artifacts: overrides.artifacts ?? { count: 0 },
    citations: overrides.citations ?? { count: 0, staleCount: 0 },
    goal: overrides.goal ?? { kind: "none" },
    childRuns: overrides.childRuns ?? {
      active: 0,
      completed: 0,
      failed: 0,
      unacknowledgedResults: 0,
    },
    activeRequest: overrides.activeRequest ?? { kind: "none" },
    staleEvidence: overrides.staleEvidence ?? false,
    lastMeaningfulActivityAt: overrides.lastMeaningfulActivityAt ?? null,
  };
}

function idleRuntime(): WorkBoardRuntimeActivity {
  return { executing: false, awaitingInput: false, interrupted: false };
}

function service(input: {
  readonly threads: readonly WorkBoardThread[];
  readonly runtime?: (threadId: WorkThread["id"]) => WorkBoardRuntimeActivity;
  readonly evidence?: (entry: WorkBoardThread) => WorkBoardEvidence;
}): WorkThreadBoardService {
  return new WorkThreadBoardService({
    threads: { list: () => input.threads },
    evidence: {
      forThread: (entry) => input.evidence?.(entry) ?? emptyEvidence(),
    },
    runtime: {
      observe: (threadId) => input.runtime?.(threadId) ?? idleRuntime(),
    },
    clock: () => now,
  });
}

const allThreads = [
  boardThread({
    thread: thread({ id: ids.done, title: "Shipped brief", completionConfirmed: true }),
  }),
  boardThread({
    thread: thread({ id: ids.waiting, projectId: ids.projectB, title: "Needs a decision" }),
    project: { id: ids.projectB, name: "Project B" },
  }),
  boardThread({ thread: thread({ id: ids.executing, title: "Writing" }) }),
  boardThread({ thread: thread({ id: ids.ready, title: "Idle brief" }) }),
];

function cardFor(cards: readonly WorkBoardCard[], threadId: unknown): WorkBoardCard {
  const card = cards.find((candidate) => candidate.threadId === threadId);
  if (card === undefined) throw new Error("card not found");
  return card;
}

describe("WorkThreadBoardService derivation", () => {
  it("resolves one card per non-archived thread with a runtime-derived status", async () => {
    const board = service({
      threads: [
        ...allThreads,
        boardThread({ thread: thread({ id: ids.archived, lifecycle: "archived" }) }),
      ],
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, awaitingInput: false, interrupted: false }
          : threadId === ids.waiting
            ? { executing: false, awaitingInput: true, interrupted: false }
            : idleRuntime(),
    });

    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));

    expect(view.cards.map((card) => card.threadId).sort()).toEqual(
      [ids.done, ids.waiting, ids.executing, ids.ready].sort(),
    );
    expect(cardFor(view.cards, ids.done).status).toBe("done");
    expect(cardFor(view.cards, ids.waiting).status).toBe("waiting");
    expect(cardFor(view.cards, ids.executing).status).toBe("in-progress");
    expect(cardFor(view.cards, ids.ready).status).toBe("ready");
    expect(view.query.statuses).toEqual(["ready", "in-progress", "waiting", "done"]);
    expect(decodeWorkBoardView(view)).toEqual(view);
  });

  it("is Done only when the confirmed Work delivery target has objective evidence", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.done, completionConfirmed: true }) })],
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.done);
    expect(card.status).toBe("done");
    expect(card.statusReason).toBe("delivery-satisfied");
    expect(card.deliverySatisfaction).toBe("done");
    expect(card.deliveryTarget).toBe("Draft brief");
  });

  it("does not treat a completed model turn as Done when the delivery target is unmet", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.ready }) })],
      runtime: () => idleRuntime(),
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.status).toBe("ready");
    expect(card.deliverySatisfaction).not.toBe("done");
  });

  it("waits when confirmation evidence is stale even if the user confirmed", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.done, completionConfirmed: true }) })],
      evidence: () => emptyEvidence({ staleEvidence: true }),
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.done);
    expect(card.status).toBe("waiting");
    expect(card.statusReason).toBe("delivery-waiting");
    expect(card.deliverySatisfaction).toBe("waiting");
  });

  it("keeps a recovering thread visible and in Waiting", async () => {
    const board = service({
      threads: [
        boardThread({
          thread: thread({ id: ids.ready }),
          projectProjectionPresent: false,
        }),
      ],
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.recovery).toEqual({
      kind: "recovering",
      reasons: ["project-projection-missing"],
    });
    expect(card.status).toBe("waiting");
    expect(card.statusReason).toBe("recovering");
  });

  it("carries follow-up without letting it change status and omits client unread", async () => {
    const board = service({
      threads: [
        boardThread({
          thread: thread({ id: ids.done, completionConfirmed: true }),
          followUp: true,
        }),
      ],
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.done);
    expect(card.followUp).toBe(true);
    expect(card).not.toHaveProperty("unread");
    expect(card.status).toBe("done");
  });

  it("shows Project binding, active request, artifacts, citations, goal, child runs, and activity", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.ready }) })],
      evidence: () =>
        emptyEvidence({
          artifacts: { count: 2, latestDisplayName: "Brief.md" },
          citations: { count: 3, staleCount: 1 },
          goal: { kind: "present", status: "active", objective: "Finish the brief" },
          childRuns: {
            active: 1,
            completed: 0,
            failed: 0,
            unacknowledgedResults: 0,
            latestSummary: "Research pass",
          },
          activeRequest: {
            kind: "pending",
            requestKind: "approval",
            summary: "Write the export",
          },
          staleEvidence: true,
          lastMeaningfulActivityAt: now,
        }),
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.ready);
    expect(card.binding).toEqual({ kind: "bound", workingDirectory: "." });
    expect(card.activeRequest.kind).toBe("pending");
    expect(card.artifacts).toEqual({ count: 2, latestDisplayName: "Brief.md" });
    expect(card.citations).toEqual({ count: 3, staleCount: 1 });
    expect(card.goal).toEqual({
      kind: "present",
      status: "active",
      objective: "Finish the brief",
    });
    expect(card.childRuns.active).toBe(1);
    expect(card.staleEvidence).toBe(true);
    expect(card.lastMeaningfulActivityAt).toBe(now);
  });

  it("waits when confirmed delivery still has unacknowledged child runs", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.done, completionConfirmed: true }) })],
      evidence: () =>
        emptyEvidence({
          childRuns: { active: 0, completed: 1, failed: 0, unacknowledgedResults: 1 },
        }),
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    const card = cardFor(view.cards, ids.done);
    expect(card.status).toBe("waiting");
    expect(card.statusReason).toBe("delivery-waiting");
    expect(card.deliverySatisfaction).toBe("waiting");
  });

  it("does not include a thread the window-filtered source omitted", async () => {
    const board = service({
      threads: [boardThread({ thread: thread({ id: ids.ready, projectId: ids.projectA }) })],
    });
    const view = await board.query(decodeWorkBoardQuery({ version: 1 }));
    expect(view.cards.map((card) => card.threadId)).toEqual([ids.ready]);
  });
});

describe("WorkThreadBoardService filters", () => {
  async function query(q: WorkBoardQuery) {
    const board = service({
      threads: allThreads,
      runtime: (threadId) =>
        threadId === ids.executing
          ? { executing: true, awaitingInput: false, interrupted: false }
          : threadId === ids.waiting
            ? { executing: false, awaitingInput: true, interrupted: false }
            : idleRuntime(),
    });
    return board.query(q);
  }

  it("defaults to all four statuses including Done", async () => {
    const view = await query(decodeWorkBoardQuery({ version: 1 }));
    expect(view.cards).toHaveLength(4);
    expect(view.cards.some((card) => card.status === "done")).toBe(true);
  });

  it("scopes cards to Work threads of the requested Project", async () => {
    const view = await query(decodeWorkBoardQuery({ version: 1, projectIds: [ids.projectB] }));
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.projectId).toBe(ids.projectB);
  });

  it("filters follow-up independently of status", async () => {
    const board = service({
      threads: [
        boardThread({ thread: thread({ id: ids.ready }), followUp: true }),
        boardThread({ thread: thread({ id: ids.executing, title: "Other" }) }),
      ],
    });
    const only = await board.query(decodeWorkBoardQuery({ version: 1, followUp: "only" }));
    expect(only.cards.map((card) => card.threadId)).toEqual([ids.ready]);
    const excluded = await board.query(decodeWorkBoardQuery({ version: 1, followUp: "excluded" }));
    expect(excluded.cards.map((card) => card.threadId)).toEqual([ids.executing]);
  });

  it("filters pending requests without changing status derivation", async () => {
    const board = service({
      threads: [
        boardThread({ thread: thread({ id: ids.ready }) }),
        boardThread({ thread: thread({ id: ids.waiting, title: "Needs a decision" }) }),
      ],
      evidence: (entry) =>
        String(entry.thread.id) === String(ids.waiting)
          ? emptyEvidence({
              activeRequest: {
                kind: "pending",
                requestKind: "user-input",
                summary: "Which tone?",
              },
            })
          : emptyEvidence(),
    });
    const only = await board.query(decodeWorkBoardQuery({ version: 1, pendingRequest: "only" }));
    expect(only.cards.map((card) => card.threadId)).toEqual([ids.waiting]);
  });
});

describe("boardRuntimeActivityFromTurnsAndSignals", () => {
  function turn(
    status: WorkTurnState["status"],
    failure?: WorkTurnState["failure"],
  ): {
    readonly status: WorkTurnState["status"];
    readonly failure?: WorkTurnState["failure"];
    readonly transcript: WorkTurnState["transcript"];
  } {
    return {
      status,
      transcript: [{ role: "user", text: "Write the brief" }],
      ...(failure === undefined ? {} : { failure }),
    };
  }

  it("treats a running latest turn as executing and ignores an older waiting turn", () => {
    const activity = boardRuntimeActivityFromTurnsAndSignals({
      turns: [turn("waiting"), turn("running")],
      pendingRequest: false,
      childActive: 0,
      childWaiting: 0,
    });
    expect(activity.executing).toBe(true);
    expect(activity.awaitingInput).toBe(false);
  });

  it("waits on a pending request even when the latest turn has finished", () => {
    const activity = boardRuntimeActivityFromTurnsAndSignals({
      turns: [turn("completed")],
      pendingRequest: true,
      childActive: 0,
      childWaiting: 0,
    });
    expect(activity.awaitingInput).toBe(true);
    expect(activity.executing).toBe(false);
    expect(activity.blockingReason).toBe("Runtime work is waiting for a decision or input.");
  });

  it("holds Waiting from an interrupted latest turn", () => {
    const activity = boardRuntimeActivityFromTurnsAndSignals({
      turns: [
        turn("waiting", {
          category: "interrupted",
          message: "Work provider turn was interrupted by a host restart.",
        }),
      ],
      pendingRequest: false,
      childActive: 0,
      childWaiting: 0,
    });
    expect(activity.interrupted).toBe(true);
    expect(activity.awaitingInput).toBe(false);
    expect(activity.blockingReason).toBe("The last agent turn was interrupted.");
  });
});
