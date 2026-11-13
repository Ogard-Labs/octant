import {
  AggregateId,
  CANVAS_CHOICE_ANSWER_CLEARED,
  CANVAS_CHOICE_ANSWER_SET,
  CanvasChoiceAnswerCleared,
  CanvasChoiceAnswerSet,
  CorrelationId,
  EventActor,
  EventId,
  decodeCanvasActor,
  decodeCanvasChoiceAnswerEvent,
  decodeCanvasChoiceAnswersOutcome,
  decodeCanvasId,
  type CanvasActor,
  type CanvasChoiceAnswer,
  type CanvasChoiceAnswerEvent,
  type CanvasChoiceAnswersOutcome,
  type CanvasChoiceAnswersReviseResult,
  type CanvasId,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  EMPTY_CANVAS_CHOICE_ANSWER_STATE,
  admitCanvasChoiceAnswersRevision,
  applyCanvasChoiceAnswerEvent,
  type CanvasChoiceAnswerState,
} from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";
import type { CanvasProjection } from "./canvasProjection";
import type { CanvasAuthorizationContext, CanvasProjectRecord } from "./canvasService";

export const CANVAS_CHOICE_ANSWER_AGGREGATE_TYPE = "canvas-choice-answers";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

/** Register the decision-form answer frames so they can be appended and replayed. */
export function registerCanvasChoiceAnswerEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_CHOICE_ANSWER_SET, 1, CanvasChoiceAnswerSet)
    .register(CANVAS_CHOICE_ANSWER_CLEARED, 1, CanvasChoiceAnswerCleared);
}

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export interface CanvasChoiceAnswerServiceOptions {
  readonly journal: JournalPort;
  readonly projection: Pick<CanvasProjection, "getById">;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly now: () => UtcTimestamp;
}

export interface CanvasChoiceAnswerServiceDependencies {
  readonly authorize: (
    entry: NonNullable<ReturnType<CanvasProjection["getById"]>>,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ) => boolean;
}

function eventFromEnvelope(envelope: EventEnvelope): CanvasChoiceAnswerEvent | undefined {
  const kind =
    envelope.eventName === CANVAS_CHOICE_ANSWER_SET
      ? "set"
      : envelope.eventName === CANVAS_CHOICE_ANSWER_CLEARED
        ? "cleared"
        : undefined;
  if (kind === undefined) return undefined;
  try {
    return decodeCanvasChoiceAnswerEvent({ kind, event: envelope.payload });
  } catch {
    // An undecodable frame is skipped rather than repaired into an answer the
    // policy never admitted; the journal stays authoritative.
    return undefined;
  }
}

/**
 * A person's answers to a Canvas decision form are journaled facts of one
 * `canvas-choice-answers` aggregate per Canvas, whose version is the answer
 * sequence. A change's `expectedSequence` is the version the window saw, so two
 * windows answering at once conflict on the journal instead of both being told
 * they won. The host names the author itself: no agent operation reaches this
 * service, and a request cannot name an actor. A batch of changes is one
 * journal append, so it lands whole or not at all.
 */
export class CanvasChoiceAnswerService {
  readonly #journal: JournalPort;
  readonly #projection: Pick<CanvasProjection, "getById">;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #person: CanvasActor;
  readonly #now: () => UtcTimestamp;
  readonly #authorize: CanvasChoiceAnswerServiceDependencies["authorize"];
  readonly #state = new Map<string, CanvasChoiceAnswerState>();
  #replayed = false;

  constructor(
    options: CanvasChoiceAnswerServiceOptions,
    dependencies: CanvasChoiceAnswerServiceDependencies,
  ) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#person = decodeCanvasActor({ kind: "local-user", actorId: this.#actor.actorId });
    this.#now = options.now;
    this.#authorize = dependencies.authorize;
  }

  /** The saved answers a workspace may read. An unauthorized read carries none. */
  answers(
    canvasId: CanvasId,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): CanvasChoiceAnswersOutcome {
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return decodeCanvasChoiceAnswersOutcome({
        kind: "unavailable",
        canvasId,
        reason: "Canvas is unavailable. Reopen it from the Project.",
      });
    }
    if (!this.#authorize(entry, context, project)) {
      return decodeCanvasChoiceAnswersOutcome({ kind: "unauthorized", canvasId });
    }
    const state = this.#stateFor(canvasId);
    return decodeCanvasChoiceAnswersOutcome({
      kind: "ready",
      canvasId,
      sequence: state.sequence,
      answers: state.answers,
    });
  }

  /**
   * The answers for the Canvas tool's `read`. It does not pass through
   * `authorize`: the tool has already read the Canvas under the thread's own
   * scope, and only the Canvas's owning thread is handed these.
   */
  answersForAgent(canvasId: CanvasId): ReadonlyArray<CanvasChoiceAnswer> {
    return this.#stateFor(canvasId).answers;
  }

  /** Admit and journal a person's changes to a form's answers. */
  revise(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): CanvasChoiceAnswersReviseResult {
    let canvasId: CanvasId;
    try {
      canvasId = decodeCanvasId((requestInput as { canvasId?: unknown } | null)?.canvasId);
    } catch {
      return {
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas answers change is malformed.",
      };
    }
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return {
        kind: "denied",
        denialCode: "unavailable",
        message: "Canvas is unavailable. Reopen it from the Project.",
      };
    }
    if (!this.#authorize(entry, context, project)) {
      return {
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas answers are not authorized in this workspace.",
      };
    }
    const state = this.#stateFor(canvasId);
    const admitted = admitCanvasChoiceAnswersRevision(
      requestInput,
      entry.currentVersion.definition,
      state,
      this.#person,
      this.#now(),
    );
    if (admitted.kind === "rejected") {
      return { kind: "denied", denialCode: admitted.code, message: admitted.message };
    }
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: CANVAS_CHOICE_ANSWER_AGGREGATE_TYPE,
          aggregateId: decodeAggregateId(String(canvasId)),
        },
        expectedVersion: state.sequence,
        events: admitted.events.map((event) => ({
          eventId: decodeEventId(this.#uuid()),
          eventName: event.kind === "set" ? CANVAS_CHOICE_ANSWER_SET : CANVAS_CHOICE_ANSWER_CLEARED,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: event.kind === "set" ? event.event.answer.answeredAt : event.event.clearedAt,
          payload: event.event,
        })),
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict || error instanceof DuplicateEventIdentity) {
        return {
          kind: "denied",
          denialCode: "stale-version",
          message: "The answers changed on the host; reload and try again.",
        };
      }
      throw error;
    }
    const next = admitted.events.reduce(applyCanvasChoiceAnswerEvent, state);
    this.#state.set(String(canvasId), next);
    return { kind: "accepted", canvasId, sequence: next.sequence };
  }

  #stateFor(canvasId: CanvasId): CanvasChoiceAnswerState {
    if (!this.#replayed) this.#replay();
    return this.#state.get(String(canvasId)) ?? EMPTY_CANVAS_CHOICE_ANSWER_STATE;
  }

  #replay(): void {
    this.#replayed = true;
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      CANVAS_CHOICE_ANSWER_AGGREGATE_TYPE,
    ])) {
      const event = eventFromEnvelope(envelope);
      if (event === undefined) continue;
      const key = String(event.event.canvasId);
      this.#state.set(
        key,
        applyCanvasChoiceAnswerEvent(
          this.#state.get(key) ?? EMPTY_CANVAS_CHOICE_ANSWER_STATE,
          event,
        ),
      );
    }
  }
}
