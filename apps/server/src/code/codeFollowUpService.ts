import {
  ActorId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeCodeFailure,
  decodeCodeFollowUpCommand,
  type AggregateVersion,
  type CodeFailure,
  type CodeFollowUpCommand,
  type CodeThreadFollowUp,
  type CodeThreadFollowUpUpdated,
  type CodeThreadFollowUpView,
  type CodeThreadId,
} from "@octant/contracts";
import {
  CodeFollowUpPolicyRejected,
  completeCodeFollowUp,
  evaluateCodeFollowUpTrigger,
} from "@octant/domain/code-follow-up-policy";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProjectionApplicationFailed } from "../persistence/projection";
import {
  CODE_FOLLOW_UP_AGGREGATE_TYPE,
  hasProcessedCodeFollowUpTrigger,
  readCodeFollowUpAggregateVersion,
  readCodeThreadFollowUp,
} from "../persistence/codeProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const FOLLOW_UP_EVENT = "code.follow-up-updated@1";

/**
 * An edge-derived automatic follow-up trigger observed from the live Code
 * operation runtime. `sourceEventId` makes the trigger idempotent across
 * duplicate, delayed, replayed, or out-of-order delivery: a source already
 * projected as a causation of this thread's follow-up aggregate is ignored.
 * `sourceSequence` is the monotonic sequence used for edge-based evaluation.
 */
export interface CodeFollowUpTriggerObservation {
  readonly threadId: CodeThreadId;
  readonly sourceEventId: string;
  readonly sourceSequence: number;
  readonly reason: string;
  readonly origin: "automatic";
  readonly triggeredAt: string;
}

export interface CodeFollowUpServiceOptions {
  readonly persistence: PersistenceService;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class CodeFollowUpServiceError extends Error {
  override readonly name = "CodeFollowUpServiceError";

  constructor(readonly failure: CodeFailure) {
    super(failure.message);
  }
}

/**
 * Owns the persistent {@link CodeThreadFollowUp} obligation for Code threads.
 *
 * Follow-up is a durable user obligation, deliberately independent of unread,
 * runtime status, and work-item state. It reuses the mode-neutral
 * `thread-follow-up` aggregate and its journal-rebuildable projection so a
 * single normalized model spans Chat, Work, and Code; only the thread guard
 * (a real, active Code thread) and the Code follow-up policy are Code-specific.
 * Manual `Mark for follow-up` and automatic edge triggers open it; only an
 * explicit `Complete follow-up` acknowledges the current trigger. Viewing a
 * thread never clears it.
 */
export class CodeFollowUpService {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: CodeFollowUpServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  read(threadId: CodeThreadId): CodeThreadFollowUpView {
    this.#assertReadableThread(threadId);
    const followUp = this.#readFollowUp(threadId);
    return {
      threadId,
      followUpVersion: this.#version(threadId),
      ...(followUp === undefined ? {} : { followUp }),
    };
  }

  async execute(input: unknown): Promise<CodeThreadFollowUpUpdated> {
    try {
      const command = decodeCodeFollowUpCommand(input);
      this.#assertMutableThread(command.threadId);
      return this.#executeCommand(command);
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  /**
   * Applies one automatic edge trigger. Idempotent by `sourceEventId`; safe to
   * call on replay or reconnect. Returns the resulting follow-up state.
   */
  async observeTrigger(input: CodeFollowUpTriggerObservation): Promise<CodeThreadFollowUp> {
    this.#assertMutableThread(input.threadId);
    try {
      if (this.#alreadyProcessed(input.threadId, input.sourceEventId)) {
        return this.#requireFollowUp(input.threadId);
      }

      const current = this.#readFollowUp(input.threadId);
      const next = evaluateCodeFollowUpTrigger(input.threadId, current, {
        sequence: input.sourceSequence,
        reason: input.reason,
        origin: input.origin,
        triggeredAt: decodeTimestamp(input.triggeredAt),
      });
      if (this.#equivalent(current, next)) {
        return next;
      }

      const expectedVersion = this.#version(input.threadId);
      this.#append(input.threadId, expectedVersion, next, {
        causationId: input.sourceEventId,
        actorKind: "system",
      });
      return this.#requireFollowUp(input.threadId);
    } catch (error) {
      if (
        error instanceof ConcurrencyConflict &&
        this.#alreadyProcessed(input.threadId, input.sourceEventId)
      ) {
        return this.#requireFollowUp(input.threadId);
      }
      throw this.#mapFailure(error);
    }
  }

  #executeCommand(command: CodeFollowUpCommand): CodeThreadFollowUpUpdated {
    const timestamp = decodeTimestamp(this.#clock());
    const currentVersion = this.#version(command.threadId);
    if (currentVersion !== command.expectedVersion) {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({
          category: "stale",
          message: "Thread follow-up changed; reload and retry.",
        }),
      );
    }
    const current = this.#readFollowUp(command.threadId);
    const next =
      command.kind === "open-code-follow-up"
        ? evaluateCodeFollowUpTrigger(command.threadId, current, {
            sequence: command.triggerSequence,
            reason: command.reason,
            origin: command.origin,
            triggeredAt: timestamp,
          })
        : completeCodeFollowUp(currentVersion, this.#requireOpen(current, command.threadId), {
            expectedVersion: command.expectedVersion,
            acknowledgedThroughSequence: command.acknowledgedThroughSequence,
            completedAt: timestamp,
          });

    if (this.#equivalent(current, next)) {
      return { kind: "code-follow-up-updated", followUp: this.#requireFollowUp(command.threadId) };
    }

    this.#append(command.threadId, command.expectedVersion, next);
    return { kind: "code-follow-up-updated", followUp: this.#requireFollowUp(command.threadId) };
  }

  #append(
    threadId: CodeThreadId,
    expectedVersion: AggregateVersion,
    followUp: CodeThreadFollowUp,
    options?: { readonly causationId?: string; readonly actorKind?: "local-user" | "system" },
  ): void {
    this.#persistence.journal.append({
      aggregate: { aggregateType: CODE_FOLLOW_UP_AGGREGATE_TYPE, aggregateId: threadId },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: FOLLOW_UP_EVENT,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          causationId:
            options?.causationId === undefined ? undefined : decodeEventId(options.causationId),
          actor: {
            kind: options?.actorKind ?? "local-user",
            actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
          },
          occurredAt: decodeTimestamp(this.#clock()),
          payload: {
            kind: "code-follow-up-updated",
            followUp: this.#serialize(followUp),
          },
        },
      ],
    });
  }

  #serialize(followUp: CodeThreadFollowUp): CodeThreadFollowUp {
    const { completedAt, ...rest } = followUp;
    return (completedAt === undefined ? rest : { ...rest, completedAt }) as CodeThreadFollowUp;
  }

  #readFollowUp(threadId: CodeThreadId): CodeThreadFollowUp | undefined {
    return readCodeThreadFollowUp(this.#persistence.connection, threadId);
  }

  #version(threadId: CodeThreadId): AggregateVersion {
    return readCodeFollowUpAggregateVersion(
      this.#persistence.connection,
      threadId,
    ) as AggregateVersion;
  }

  #alreadyProcessed(threadId: CodeThreadId, sourceEventId: string): boolean {
    return hasProcessedCodeFollowUpTrigger(this.#persistence.connection, threadId, sourceEventId);
  }

  #requireFollowUp(threadId: CodeThreadId): CodeThreadFollowUp {
    const followUp = this.#readFollowUp(threadId);
    if (followUp === undefined) {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({
          category: "invalid",
          message: "Thread follow-up projection is inconsistent.",
        }),
      );
    }
    return followUp;
  }

  #requireOpen(
    followUp: CodeThreadFollowUp | undefined,
    threadId: CodeThreadId,
  ): CodeThreadFollowUp {
    if (followUp === undefined || followUp.threadId !== threadId || followUp.state !== "open") {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({ category: "invalid", message: "Thread follow-up is not open." }),
      );
    }
    return followUp;
  }

  #equivalent(current: CodeThreadFollowUp | undefined, next: CodeThreadFollowUp): boolean {
    return current !== undefined && JSON.stringify(current) === JSON.stringify(next);
  }

  #assertReadableThread(threadId: CodeThreadId): void {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({ category: "invalid", message: "Code thread was not found." }),
      );
    }
  }

  #assertMutableThread(threadId: CodeThreadId): void {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({ category: "invalid", message: "Code thread was not found." }),
      );
    }
    if (thread.lifecycle === "archived") {
      throw new CodeFollowUpServiceError(
        decodeCodeFailure({
          category: "invalid",
          message: "Code thread is archived.",
        }),
      );
    }
  }

  #mapFailure(error: unknown): CodeFollowUpServiceError {
    if (error instanceof CodeFollowUpServiceError) return error;
    if (error instanceof CodeFollowUpPolicyRejected) {
      if (error.code === "stale-version") {
        return new CodeFollowUpServiceError(
          decodeCodeFailure({
            category: "stale",
            message: "Thread follow-up changed; reload and retry.",
          }),
        );
      }
      return new CodeFollowUpServiceError(
        decodeCodeFailure({ category: "invalid", message: error.message }),
      );
    }
    if (error instanceof ConcurrencyConflict) {
      return new CodeFollowUpServiceError(
        decodeCodeFailure({
          category: "stale",
          message: "Thread follow-up changed; reload and retry.",
        }),
      );
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#unavailable();
    }
    if (error instanceof Error && error.name === "EventPayloadInvalid") {
      return new CodeFollowUpServiceError(
        decodeCodeFailure({ category: "invalid", message: "Thread follow-up command is invalid." }),
      );
    }
    return new CodeFollowUpServiceError(
      decodeCodeFailure({ category: "invalid", message: "Thread follow-up command is invalid." }),
    );
  }

  #unavailable(): CodeFollowUpServiceError {
    return new CodeFollowUpServiceError(
      decodeCodeFailure({
        category: "unavailable",
        message: "Thread follow-up storage is unavailable.",
      }),
    );
  }
}
