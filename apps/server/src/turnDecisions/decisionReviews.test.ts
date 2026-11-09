import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePendingRequest,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type PendingRequest,
} from "@octant/contracts";
import { Schema } from "effect";
import { AggregateId } from "@octant/contracts";
import { DecisionReviewRecorded } from "@octant/contracts/pending-requests";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  DECISION_REVIEW_COOLDOWN_MS,
  DECISION_REVIEW_EVENT,
  DecisionReviews,
  MAX_QUEUED_DECISION_REVIEWS,
  type DecisionReviewAnswer,
  type DecisionReviewDependencies,
} from "./decisionReviews";
import { createDecisionReviewModelPort } from "./decisionReviewWiring";

const reviewer = {
  providerInstanceId: decodeProviderInstanceId("00000000-0000-4000-8000-0000000000b1"),
  modelId: decodeProviderModelId("reviewer-model"),
};
const project = "00000000-0000-4000-8000-000000000901";

function decision(n = 1): Extract<PendingRequest, { kind: "decision" }> {
  const item = decodePendingRequest({
    mode: "code",
    kind: "decision",
    projectId: project,
    threadId: "00000000-0000-4000-8000-000000000910",
    threadTitle: "Ship the parser",
    text: "Open the pull request now?",
    why: "Friday is close.",
    options: [
      { label: "Open it", recommended: true, detail: "Fast" },
      { label: "Wait", recommended: false },
    ],
    requestedAt: "2026-10-06T08:00:30.000Z",
    answer: {
      threadId: "00000000-0000-4000-8000-000000000910",
      checkoutId: "00000000-0000-4000-8000-000000000911",
      operationId: `00000000-0000-4000-8000-0000000009${String(10 + n)}`,
    },
  });
  if (item.kind !== "decision") throw new Error("not a decision");
  return item;
}

const key = (n: number) => n.toString(16).padStart(64, "0");

let folder: string;
let connection: SqliteConnection;
let journal: Journal;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "octant-decision-reviews-"));
  connection = openSqlite(join(folder, "journal.sqlite"));
  applyMigrations(connection, MIGRATIONS, () => new Date().toISOString());
  journal = new Journal({
    connection,
    registry: new EventRegistry().register(DECISION_REVIEW_EVENT, 1, DecisionReviewRecorded),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => new Date().toISOString(),
  });
});
afterEach(() => {
  connection.close();
  rmSync(folder, { recursive: true, force: true });
});

function reviews(
  overrides: Partial<DecisionReviewDependencies> & { readonly answer?: DecisionReviewAnswer } = {},
) {
  let clock = Date.parse("2026-10-06T09:00:00Z");
  const complete = vi.fn(
    async (_input: Parameters<DecisionReviewDependencies["complete"]>[0]) =>
      overrides.answer ??
      ({
        status: "answered",
        text: '{"backs":"Wait","reason":"Review is not done."}',
        usage: { inputTokens: 10, outputTokens: 5 },
      } satisfies DecisionReviewAnswer),
  );
  const recordUsage = vi.fn();
  const dependencies: DecisionReviewDependencies = {
    journal,
    connection,
    chosenModel: () => reviewer,
    accountUnavailable: () => undefined,
    projectAllows: () => true,
    keptOutOfMemory: () => false,
    providerIdentity: () => ({ displayName: "Reviewer account", driverKind: "codex" }),
    readOpen: () => ({ context: "The fix is in." }),
    redact: (text) => text,
    complete,
    recordUsage,
    now: () => clock,
    ...overrides,
  };
  return {
    service: new DecisionReviews(dependencies),
    dependencies,
    complete,
    recordUsage,
    advance: (ms: number) => {
      clock += ms;
    },
    restart: () => new DecisionReviews(dependencies),
  };
}

describe("a second opinion on a decision", () => {
  it("is queued once, never waits the list read, and is listed as reviewed once it lands", async () => {
    const { service, complete } = reviews();
    const item = decision();
    expect(service.reviewFor(key(1), item)).toEqual({ status: "pending" });
    expect(service.reviewFor(key(1), item)).toEqual({ status: "pending" });
    await service.settled();
    expect(complete).toHaveBeenCalledOnce();
    expect(service.reviewFor(key(1), item)).toMatchObject({
      status: "reviewed",
      providerName: "Reviewer account",
      driverKind: "codex",
      modelId: "reviewer-model",
      backs: "Wait",
      reason: "Review is not done.",
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("sends the question, why, options with the recommendation and the preceding text, with fixed instructions", async () => {
    const { service, complete } = reviews({ redact: (text) => text.replace("Friday", "[day]") });
    service.reviewFor(key(1), decision());
    await service.settled();
    const sent = complete.mock.calls[0]?.[0];
    expect(sent?.prompt).toContain("Open the pull request now?");
    expect(sent?.prompt).toContain("Why it was asked: [day] is close.");
    expect(sent?.prompt).toContain("- Open it (the agent recommends this): Fast");
    expect(sent?.prompt).toContain("The fix is in.");
    expect(sent?.instructions).not.toContain("parser");
    expect(sent?.model).toEqual(reviewer);
  });

  it("does nothing and shows nothing while no model is chosen", async () => {
    const { service, complete } = reviews({ chosenModel: () => undefined });
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("journals a label that is not an option as failed, and records the spend", async () => {
    const { service, recordUsage } = reviews({
      answer: {
        status: "answered",
        text: '{"backs":"Ship it","reason":"x"}',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "failed" });
    expect(recordUsage).toHaveBeenCalledWith({
      threadId: "00000000-0000-4000-8000-000000000910",
      model: reviewer,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("journals a withheld reply as withheld and still records its usage", async () => {
    const { service, recordUsage } = reviews({
      answer: { status: "withheld", usage: { inputTokens: 4, outputTokens: 1 } },
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "withheld" });
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it("sends nothing and marks the review not allowed when the Project refuses the reviewer", async () => {
    const { service, complete, recordUsage } = reviews({ projectAllows: () => false });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "not-allowed" });
  });

  it("does not journal an unavailable account, shows nothing, and asks again only after the cooldown", async () => {
    const { service, complete, advance, recordUsage } = reviews({
      answer: { status: "unavailable" },
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
    advance(DECISION_REVIEW_COOLDOWN_MS - 1000);
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    await service.settled();
    expect(complete).toHaveBeenCalledOnce();
    advance(2000);
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    await service.settled();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(
      journal.replayAggregateType({
        aggregateType: "decision-review",
        afterSequence: 0,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("records one unreported usage row for a sent call that got no answer, and asks again after the cooldown", async () => {
    const { service, complete, advance, recordUsage } = reviews({
      answer: { status: "attempted" },
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith({
      threadId: "00000000-0000-4000-8000-000000000910",
      model: reviewer,
      usage: undefined,
    });
    advance(DECISION_REVIEW_COOLDOWN_MS + 1000);
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    await service.settled();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it("does not ask an account that is off or at its limit", async () => {
    const { service, complete } = reviews({ accountUnavailable: () => "The account is off." });
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("skips a decision that closed before its turn in the queue came", async () => {
    let open = true;
    const { service, complete } = reviews({ readOpen: () => (open ? { context: "" } : undefined) });
    service.reviewFor(key(1), decision());
    open = false;
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("runs one review at a time and queues at most sixteen behind it", async () => {
    let running = 0;
    let most = 0;
    const gate: Array<() => void> = [];
    const { service } = reviews({
      complete: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => gate.push(resolve));
        running -= 1;
        return { status: "answered", text: '{"backs":"Wait","reason":"ok"}' };
      },
    });
    const total = MAX_QUEUED_DECISION_REVIEWS + 3;
    const states = Array.from({ length: total }, (_, index) =>
      service.reviewFor(key(index + 1), decision(index + 1 > 9 ? 9 : index + 1)),
    );
    // The rest wait for a later read.
    expect(states.filter((state) => state?.status === "pending")).toHaveLength(
      MAX_QUEUED_DECISION_REVIEWS,
    );
    for (let released = 0; released < MAX_QUEUED_DECISION_REVIEWS; released += 1) {
      while (gate.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      gate.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await service.settled();
    expect(most).toBe(1);
  });

  it("rebuilds the latest record after a restart without asking again", async () => {
    const first = reviews();
    first.service.reviewFor(key(1), decision());
    await first.service.settled();
    const restarted = first.restart();
    expect(restarted.reviewFor(key(1), decision())).toMatchObject({
      status: "reviewed",
      backs: "Wait",
    });
    expect(first.complete).toHaveBeenCalledOnce();
  });

  it("drops records older than thirty days on replay", async () => {
    const first = reviews();
    first.service.reviewFor(key(1), decision());
    await first.service.settled();
    first.advance(31 * 24 * 60 * 60_000);
    const restarted = first.restart();
    expect(restarted.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    await restarted.settled();
  });

  it("skips an unreadable journal record on replay and keeps the good one", async () => {
    const first = reviews();
    first.service.reviewFor(key(1), decision());
    await first.service.settled();
    // The registry would refuse such a payload, so hand replay the page an older build could have left.
    const withUnreadable: DecisionReviewDependencies["journal"] = {
      append: journal.append.bind(journal),
      replayAggregate: (query) => {
        const page = journal.replayAggregate(query);
        const last = page.at(-1);
        return last === undefined
          ? page
          : [
              ...page,
              {
                ...last,
                payload: { key: key(2), garbage: true },
              },
            ];
      },
    };
    const restarted = new DecisionReviews({ ...first.dependencies, journal: withUnreadable });
    expect(restarted.reviewFor(key(1), decision())).toMatchObject({ status: "reviewed" });
    expect(first.complete).toHaveBeenCalledOnce();
  });

  it("never sends a decision whose thread is marked Leave no trace or whose Project is kept out of memory", () => {
    const store = (untraced: boolean, excluded: boolean) => ({
      settings: () => ({ decisionReviewModel: reviewer }) as never,
      leavesNoTrace: () => untraced,
      projectExcluded: () => excluded,
    });
    const keptOut = (untraced: boolean, excluded: boolean) =>
      createDecisionReviewModelPort({
        persistence: {} as never,
        store: store(untraced, excluded),
        resolveDriver: () => undefined,
        accountUnavailable: () => undefined,
        scratchRoot: folder,
      }).keptOutOfMemory(decision());
    expect(keptOut(true, false)).toBe(true);
    expect(keptOut(false, true)).toBe(true);
    expect(keptOut(false, false)).toBe(false);
  });

  it("does nothing and journals nothing for a decision kept out of memory", async () => {
    const { service, complete } = reviews({ keptOutOfMemory: () => true });
    expect(service.reviewFor(key(1), decision())).toBeUndefined();
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
    expect(
      journal.replayAggregate({
        aggregateType: "decision-review",
        aggregateId: Schema.decodeUnknownSync(AggregateId)("00000000-0000-4000-8000-0000000000da"),
        afterVersion: 0,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("drops a queued decision whose thread became Leave no trace before its turn", async () => {
    let marked = false;
    const { service, complete } = reviews({ keptOutOfMemory: () => marked });
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    marked = true;
    await service.settled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("asks again under a newly chosen model even after a final outcome from the old one", async () => {
    let model = reviewer;
    const { service, complete } = reviews({
      chosenModel: () => model,
      projectAllows: () => model !== reviewer,
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "not-allowed" });
    model = { ...reviewer, modelId: decodeProviderModelId("other-model") };
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    await service.settled();
    expect(complete).toHaveBeenCalledOnce();
    expect(service.reviewFor(key(1), decision())).toMatchObject({
      status: "reviewed",
      modelId: "other-model",
    });
  });

  it("starts a new drain for a read that lands as the previous one finishes", async () => {
    const { service, complete } = reviews();
    service.reviewFor(key(1), decision());
    // Wait until the loop has emptied the queue but its promise has not yet been observed.
    while (complete.mock.calls.length === 0) await Promise.resolve();
    await Promise.resolve();
    service.reviewFor(key(2), decision());
    await service.settled();
    expect(service.reviewFor(key(2), decision())).toMatchObject({ status: "reviewed" });
  });

  it("does not ask again in this host's lifetime when journaling a paid answer failed", async () => {
    const failing = {
      replayAggregate: journal.replayAggregate.bind(journal),
      append: vi.fn(() => {
        throw new Error("disk full");
      }),
    };
    const { service, complete, advance } = reviews({ journal: failing });
    service.reviewFor(key(1), decision());
    await service.settled();
    advance(DECISION_REVIEW_COOLDOWN_MS + 1000);
    expect(service.reviewFor(key(1), decision())).toMatchObject({ status: "reviewed" });
    await service.settled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not ask again when recording the usage of a paid answer failed", async () => {
    const { service, complete, advance } = reviews({
      recordUsage: () => {
        throw new Error("ledger down");
      },
    });
    service.reviewFor(key(1), decision());
    await service.settled();
    advance(DECISION_REVIEW_COOLDOWN_MS + 1000);
    expect(service.reviewFor(key(1), decision())).toMatchObject({ status: "reviewed" });
    await service.settled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("forgets an in-memory record older than thirty days when it is read", async () => {
    const { service, advance, complete } = reviews();
    service.reviewFor(key(1), decision());
    await service.settled();
    advance(31 * 24 * 60 * 60_000);
    expect(service.reviewFor(key(1), decision())).toEqual({ status: "pending" });
    await service.settled();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
