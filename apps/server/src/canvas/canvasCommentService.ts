import {
  AggregateId,
  CanvasCommentAdded,
  CanvasCommentDeleted,
  CanvasCommentReplied,
  CanvasCommentResolved,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeCanvasCommentEvent,
  decodeCanvasCommentsOutcome,
  decodeCanvasId,
  type CanvasCommentCommandResult,
  type CanvasCommentDenialCode,
  type CanvasCommentEvent,
  type CanvasCommentOrigin,
  type CanvasCommentsOutcome,
  type CanvasId,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  CANVAS_COMMENT_ADDED,
  CANVAS_COMMENT_DELETED,
  CANVAS_COMMENT_REPLIED,
  CANVAS_COMMENT_RESOLVED,
} from "@octant/contracts/canvas-board";
import {
  EMPTY_CANVAS_COMMENT_STATE,
  admitCanvasCommentCommand,
  applyCanvasCommentEvent,
  type CanvasBoardRejectionCode,
  type CanvasCommentState,
} from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";
import type { CanvasProjection } from "./canvasProjection";
import type { CanvasAuthorizationContext, CanvasProjectRecord } from "./canvasService";

export const CANVAS_COMMENT_AGGREGATE_TYPE = "canvas-comments";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

/** Register the Canvas comment journal frames so they can be appended and replayed. */
export function registerCanvasCommentEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_COMMENT_ADDED, 1, CanvasCommentAdded)
    .register(CANVAS_COMMENT_REPLIED, 1, CanvasCommentReplied)
    .register(CANVAS_COMMENT_RESOLVED, 1, CanvasCommentResolved)
    .register(CANVAS_COMMENT_DELETED, 1, CanvasCommentDeleted);
}

type JournalPort = Pick<Journal, "append" | "replay">;

export interface CanvasCommentServiceOptions {
  readonly journal: JournalPort;
  readonly projection: Pick<CanvasProjection, "getById">;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface CanvasCommentServiceDependencies {
  readonly authorize: (
    entry: NonNullable<ReturnType<CanvasProjection["getById"]>>,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ) => boolean;
}

function eventNameOf(event: CanvasCommentEvent): string {
  switch (event.kind) {
    case "added":
      return CANVAS_COMMENT_ADDED;
    case "replied":
      return CANVAS_COMMENT_REPLIED;
    case "resolved":
      return CANVAS_COMMENT_RESOLVED;
    case "deleted":
      return CANVAS_COMMENT_DELETED;
  }
}

function eventFromEnvelope(envelope: EventEnvelope): CanvasCommentEvent | undefined {
  const kind =
    envelope.eventName === CANVAS_COMMENT_ADDED
      ? "added"
      : envelope.eventName === CANVAS_COMMENT_REPLIED
        ? "replied"
        : envelope.eventName === CANVAS_COMMENT_RESOLVED
          ? "resolved"
          : envelope.eventName === CANVAS_COMMENT_DELETED
            ? "deleted"
            : undefined;
  if (kind === undefined) return undefined;
  try {
    return decodeCanvasCommentEvent({ kind, event: envelope.payload });
  } catch {
    // An undecodable frame is skipped rather than repaired into a comment the
    // policy never admitted; the journal stays authoritative.
    return undefined;
  }
}

/**
 * Comments on a Canvas are journaled facts of one `canvas-comments` aggregate
 * per Canvas, whose version is the board's comment sequence. The command's
 * `expectedSequence` is the aggregate version the caller saw, so two people
 * commenting at once conflict on the journal instead of both being told they
 * won. State is rebuilt from the journal by the same pure reducer replay uses;
 * shared snapshots serialise the Canvas definition, so they never carry these.
 */
export class CanvasCommentService {
  readonly #journal: JournalPort;
  readonly #projection: Pick<CanvasProjection, "getById">;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #authorize: CanvasCommentServiceDependencies["authorize"];
  readonly #state = new Map<string, CanvasCommentState>();
  #replayed = false;

  constructor(
    options: CanvasCommentServiceOptions,
    dependencies: CanvasCommentServiceDependencies,
  ) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#authorize = dependencies.authorize;
  }

  /** The comments a workspace may read. Unauthorized reads carry no bodies. */
  comments(
    canvasId: CanvasId,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): CanvasCommentsOutcome {
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return decodeCanvasCommentsOutcome({
        kind: "unavailable",
        canvasId,
        reason: "Canvas is unavailable. Reopen it from the Project.",
      });
    }
    if (!this.#authorize(entry, context, project)) {
      return decodeCanvasCommentsOutcome({ kind: "unauthorized", canvasId });
    }
    const state = this.#stateFor(canvasId);
    return decodeCanvasCommentsOutcome({
      kind: "ready",
      canvasId,
      sequence: state.sequence,
      threads: state.comments.map((comment) => ({
        comment,
        replies: state.replies.filter(
          (reply) => String(reply.commentId) === String(comment.commentId),
        ),
      })),
    });
  }

  /**
   * Admit and journal one comment command. `origin` is the device the server
   * authenticated the request from; the command never names it.
   */
  comment(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    origin: CanvasCommentOrigin,
  ): CanvasCommentCommandResult {
    let canvasId: CanvasId;
    try {
      canvasId = decodeCanvasId((requestInput as { canvasId?: unknown } | null)?.canvasId);
    } catch {
      return {
        kind: "denied",
        denialCode: "malformed-request",
        message: "Canvas comment command is malformed.",
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
        message: "Canvas comments are not authorized in this workspace.",
      };
    }
    const state = this.#stateFor(canvasId);
    const admitted = admitCanvasCommentCommand(requestInput, state, origin);
    if (admitted.kind === "rejected") {
      return {
        kind: "denied",
        denialCode: commentDenialCode(admitted.code),
        message: admitted.message,
      };
    }
    const event = toCommentEvent(admitted.event);
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: CANVAS_COMMENT_AGGREGATE_TYPE,
          aggregateId: decodeAggregateId(String(canvasId)),
        },
        expectedVersion: state.sequence,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: eventNameOf(event),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#actor,
            occurredAt: occurredAtOf(event),
            payload: event.event,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict || error instanceof DuplicateEventIdentity) {
        return {
          kind: "denied",
          denialCode: "stale-version",
          message: "Canvas comments changed on the host; reload and try again.",
        };
      }
      throw error;
    }
    const next = applyCanvasCommentEvent(state, event);
    this.#state.set(String(canvasId), next);
    return { kind: "accepted", canvasId, sequence: next.sequence };
  }

  #stateFor(canvasId: CanvasId): CanvasCommentState {
    if (!this.#replayed) this.#replay();
    return this.#state.get(String(canvasId)) ?? EMPTY_CANVAS_COMMENT_STATE;
  }

  #replay(): void {
    this.#replayed = true;
    let afterSequence = 0;
    while (true) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== CANVAS_COMMENT_AGGREGATE_TYPE) continue;
        const event = eventFromEnvelope(envelope);
        if (event === undefined) continue;
        const key = String(event.event.canvasId);
        this.#state.set(
          key,
          applyCanvasCommentEvent(this.#state.get(key) ?? EMPTY_CANVAS_COMMENT_STATE, event),
        );
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
  }
}

/**
 * The board policy shares one rejection vocabulary between comments and
 * layout; a comment command can only raise the comment half, so a layout code
 * arriving here is a policy bug reported as a malformed request.
 */
function commentDenialCode(code: CanvasBoardRejectionCode): CanvasCommentDenialCode {
  switch (code) {
    case "malformed-request":
    case "stale-version":
    case "unauthorized":
    case "oversized-payload":
    case "comment-budget-exceeded":
    case "unknown-comment":
    case "duplicate-comment":
    case "duplicate-reply":
    case "reply-budget-exceeded":
    case "unknown-reply-target":
      return code;
    case "not-a-diagram":
    case "unknown-node":
    case "missing-position":
      return "malformed-request";
  }
}

type AdmittedEvent = Extract<
  ReturnType<typeof admitCanvasCommentCommand>,
  { readonly kind: "accepted" }
>["event"];

function toCommentEvent(event: AdmittedEvent): CanvasCommentEvent {
  if ("comment" in event) return { kind: "added", event };
  if ("reply" in event) return { kind: "replied", event };
  if ("resolvedBy" in event) return { kind: "resolved", event };
  return { kind: "deleted", event };
}

function occurredAtOf(event: CanvasCommentEvent): UtcTimestamp {
  switch (event.kind) {
    case "added":
      return event.event.comment.createdAt;
    case "replied":
      return event.event.reply.createdAt;
    case "resolved":
      return event.event.resolvedAt;
    case "deleted":
      return event.event.deletedAt;
  }
}
