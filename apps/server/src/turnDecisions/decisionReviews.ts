import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  ActorId,
  AggregateId,
  CorrelationId,
  EventId,
  LOCAL_HOST_ID,
  decodeUtcTimestamp,
  type PendingRequest,
  type ProviderInstanceId,
  type ProviderModelId,
  type TurnDecisionReview,
  type TurnUsage,
} from "@octant/contracts";
import { DecisionReviewRecorded } from "@octant/contracts/pending-requests";
import {
  DECISION_REVIEW_INSTRUCTIONS,
  decisionReviewPrompt,
  readDecisionReview,
} from "@octant/domain/turn-decision-policy";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

export const DECISION_REVIEW_EVENT = "decision-review.recorded@1";
const aggregateType = "decision-review";
const aggregateId = Schema.decodeUnknownSync(AggregateId)("00000000-0000-4000-8000-0000000000da");
const decodeRecord = Schema.decodeUnknownSync(DecisionReviewRecorded);

/** One request at a time and a short queue: a second opinion is a courtesy, never a backlog. */
export const MAX_QUEUED_DECISION_REVIEWS = 16;
export const DECISION_REVIEW_TIMEOUT_MS = 60_000;
/** An account that could not be asked is left alone this long before the same decision asks again. */
export const DECISION_REVIEW_COOLDOWN_MS = 5 * 60_000;
export const DECISION_REVIEW_RETENTION_MS = 30 * 24 * 60 * 60_000;

type DecisionRequest = Extract<PendingRequest, { readonly kind: "decision" }>;

export interface DecisionReviewModel {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export type DecisionReviewAnswer =
  | { readonly status: "answered"; readonly text: string; readonly usage?: TurnUsage | undefined }
  /** The call ran and was paid for, but the reply read outside content and is not used. */
  | { readonly status: "withheld"; readonly usage?: TurnUsage | undefined }
  /** Timed out, never reached, interrupted or failed: nothing was learned. */
  | { readonly status: "unavailable" };

export interface DecisionReviewDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregate">;
  readonly connection: SqliteConnection;
  /** The model the person chose for second opinions; absent while the job is off. */
  readonly chosenModel: () => DecisionReviewModel | undefined;
  /** Why the chosen account cannot be asked now; undefined when it can. */
  readonly accountUnavailable: (providerInstanceId: ProviderInstanceId) => string | undefined;
  /** Whether the decision's Project lets its content go to this account and model. */
  readonly projectAllows: (input: {
    readonly projectId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => boolean;
  readonly providerIdentity: (
    providerInstanceId: ProviderInstanceId,
  ) => { readonly displayName: string; readonly driverKind: string } | undefined;
  /**
   * The decision's own thread re-read at run time: undefined once it is no
   * longer open, else the end of the reply before it (not yet redacted).
   */
  readonly readOpen: (decision: DecisionRequest) => { readonly context: string } | undefined;
  readonly redact: (text: string) => string;
  readonly complete: (input: {
    readonly model: DecisionReviewModel;
    readonly instructions: string;
    readonly prompt: string;
    readonly timeoutMs: number;
  }) => Promise<DecisionReviewAnswer>;
  readonly recordUsage: (input: {
    readonly threadId: string;
    readonly model: DecisionReviewModel;
    readonly usage?: TurnUsage | undefined;
  }) => void;
  readonly now?: () => number;
}

/**
 * The second opinion each open decision gets from the model the person chose.
 * It is advisory and never answers or changes a decision. Outcomes that say
 * something about the decision are journaled under its identity key, so a
 * restart does not pay again; an account that cannot be asked is not, and
 * waits out a cooldown. A read of the list never waits on a review.
 */
export class DecisionReviews {
  readonly #dependencies: DecisionReviewDependencies;
  readonly #records = new Map<string, DecisionReviewRecorded>();
  readonly #queue: Array<{ readonly key: string; readonly decision: DecisionRequest }> = [];
  readonly #waiting = new Set<string>();
  readonly #cooldownUntil = new Map<string, number>();
  #working: Promise<void> | undefined;

  constructor(dependencies: DecisionReviewDependencies) {
    this.#dependencies = dependencies;
    this.#replay();
  }

  /**
   * What a decision's card shows, and a review queued if it has none yet.
   * Absent while the job is off or the chosen account cannot be asked.
   */
  reviewFor(key: string, decision: DecisionRequest): TurnDecisionReview | undefined {
    const chosen = this.#dependencies.chosenModel();
    if (chosen === undefined) return undefined;
    const stored = this.#records.get(key);
    if (stored !== undefined) {
      const { outcome } = stored;
      if (outcome.kind !== "reviewed") return { status: outcome.kind };
      const identity = this.#dependencies.providerIdentity(stored.providerInstanceId);
      return {
        status: "reviewed",
        providerInstanceId: stored.providerInstanceId,
        modelId: stored.modelId,
        ...(identity === undefined
          ? {}
          : { providerName: identity.displayName, driverKind: identity.driverKind }),
        backs: outcome.backs,
        reason: outcome.reason,
        reviewedAt: stored.reviewedAt,
      };
    }
    if (this.#waiting.has(key)) return { status: "pending" };
    if ((this.#cooldownUntil.get(key) ?? 0) > this.#now()) return undefined;
    if (this.#dependencies.accountUnavailable(chosen.providerInstanceId) !== undefined) {
      return undefined;
    }
    // A full queue drops this one; a later read offers it again.
    if (this.#queue.length >= MAX_QUEUED_DECISION_REVIEWS) return undefined;
    this.#queue.push({ key, decision });
    this.#waiting.add(key);
    this.#work();
    return { status: "pending" };
  }

  /** Resolves when no review is queued or running. */
  async settled(): Promise<void> {
    while (this.#working !== undefined) await this.#working;
  }

  #now(): number {
    return (this.#dependencies.now ?? Date.now)();
  }

  #work(): void {
    if (this.#working !== undefined) return;
    this.#working = (async () => {
      // Let the read that queued this finish first, so it never waits on a review.
      await Promise.resolve();
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        try {
          await this.#review(next.key, next.decision);
        } catch {
          // A journal or model-port failure is retried after the cooldown.
          this.#cooldownUntil.set(next.key, this.#now() + DECISION_REVIEW_COOLDOWN_MS);
        } finally {
          this.#waiting.delete(next.key);
        }
      }
    })().finally(() => {
      this.#working = undefined;
    });
  }

  async #review(key: string, decision: DecisionRequest): Promise<void> {
    const chosen = this.#dependencies.chosenModel();
    if (chosen === undefined) return;
    // A decision that closed while it waited its turn is not worth a request.
    const open = this.#dependencies.readOpen(decision);
    if (open === undefined) return;
    if (this.#dependencies.accountUnavailable(chosen.providerInstanceId) !== undefined) {
      this.#cooldownUntil.set(key, this.#now() + DECISION_REVIEW_COOLDOWN_MS);
      return;
    }
    if (
      !this.#dependencies.projectAllows({
        projectId: String(decision.projectId),
        providerInstanceId: chosen.providerInstanceId,
        modelId: chosen.modelId,
      })
    ) {
      this.#record(key, chosen, { kind: "not-allowed" });
      return;
    }
    const answer = await this.#dependencies.complete({
      model: chosen,
      instructions: DECISION_REVIEW_INSTRUCTIONS,
      prompt: this.#dependencies.redact(
        decisionReviewPrompt({
          decision: {
            ask: decision.text,
            ...(decision.why === undefined ? {} : { why: decision.why }),
            options: decision.options.map((option) => ({
              label: option.label,
              recommended: option.recommended,
              ...(option.detail === undefined ? {} : { detail: option.detail }),
            })),
          },
          context: open.context,
        }),
      ),
      timeoutMs: DECISION_REVIEW_TIMEOUT_MS,
    });
    if (answer.status === "unavailable") {
      this.#cooldownUntil.set(key, this.#now() + DECISION_REVIEW_COOLDOWN_MS);
      return;
    }
    // Both a read reply and a withheld one were paid for.
    this.#dependencies.recordUsage({
      threadId: String(decision.threadId),
      model: chosen,
      usage: answer.usage,
    });
    if (answer.status === "withheld") {
      this.#record(key, chosen, { kind: "withheld" });
      return;
    }
    const reading = readDecisionReview(
      answer.text,
      decision.options.map((option) => option.label),
    );
    this.#record(
      key,
      chosen,
      reading.status === "reviewed"
        ? { kind: "reviewed", backs: reading.backs, reason: reading.reason }
        : { kind: "failed" },
    );
  }

  #record(key: string, model: DecisionReviewModel, outcome: DecisionReviewRecorded["outcome"]) {
    const record = decodeRecord({
      key,
      providerInstanceId: model.providerInstanceId,
      modelId: model.modelId,
      reviewedAt: new Date(this.#now()).toISOString(),
      outcome,
    });
    this.#dependencies.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion: readAggregateVersion(
        this.#dependencies.connection,
        aggregateType,
        String(aggregateId),
      ),
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)(randomUUID()),
          eventName: DECISION_REVIEW_EVENT,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(randomUUID()),
          actor: {
            kind: "system",
            actorId: Schema.decodeUnknownSync(ActorId)(OCTANT_LOCAL_ACTOR_ID),
          },
          occurredAt: decodeUtcTimestamp(record.reviewedAt),
          payload: record,
        },
      ],
    });
    this.#records.set(key, record);
  }

  /** The latest record per key, without anything older than the retention window. */
  #replay(): void {
    const oldest = this.#now() - DECISION_REVIEW_RETENTION_MS;
    let afterVersion = 0;
    for (;;) {
      const page = this.#dependencies.journal.replayAggregate({
        aggregateType,
        aggregateId,
        afterVersion,
        limit: 1000,
      });
      for (const event of page) {
        const record = decodeRecord(event.payload);
        afterVersion = event.aggregateVersion;
        if (Date.parse(record.reviewedAt) < oldest) this.#records.delete(record.key);
        else this.#records.set(record.key, record);
      }
      if (page.length < 1000) break;
    }
  }
}
