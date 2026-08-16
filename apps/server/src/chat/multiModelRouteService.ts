import {
  ActorId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  type ChatThreadId,
  type ChatTurnId,
  type ChatTurnRouteDecision,
} from "@octant/contracts";
import type { HostId } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type {
  MultiModelPoolCandidate,
  MultiModelRouteSelectionRequest,
  MultiModelRoutingVendorId,
} from "@octant/contracts/multi-model-pool";
import {
  resolveMultiModelRoute,
  type MultiModelCandidateRuntimeFacts,
} from "@octant/domain/multi-model-pool-policy";
import { Schema } from "effect";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import {
  CHAT_TURN_ROUTE_AGGREGATE_TYPE,
  readChatTurnRouteDecision,
} from "../persistence/chatProjection";
import type { PersistenceService } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface MultiModelRouteServiceOptions {
  readonly persistence: PersistenceService;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export interface ResolveTurnRouteInput {
  readonly threadId: ChatThreadId;
  readonly turnId: ChatTurnId;
  readonly request: MultiModelRouteSelectionRequest;
  readonly activeHostId: HostId;
  readonly mode: OctantMode;
  readonly parentRoutingVendorId: MultiModelRoutingVendorId;
  readonly parentCandidate: MultiModelPoolCandidate;
  readonly runtimeFacts: ReadonlyArray<MultiModelCandidateRuntimeFacts>;
}

/**
 * Server-authoritative resolution and durable, idempotent persistence of one
 * multi-model route decision per parent chat turn. Wraps the pure
 * eligibility policy (`resolveMultiModelRoute`) with a journal/projection
 * write keyed by turnId, so:
 *
 * - Exactly one route decision is ever accepted for a given turnId.
 * - A retried resolution (same turnId) never re-derives or overwrites an
 *   already-persisted decision, even under a concurrent race.
 * - A "waiting" decision (no eligible candidate) is durably recorded with
 *   its actionable reason, with no provider execution implied.
 * - A "selected" decision is committed by the caller only when its parent
 *   turn is accepted, so no immutable receipt references an unaccepted turn.
 */
export class MultiModelRouteService {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: MultiModelRouteServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  /** Reads an already-persisted decision for a turn without computing one. */
  readDecision(turnId: ChatTurnId): ChatTurnRouteDecision | undefined {
    return readChatTurnRouteDecision(this.#persistence.connection, String(turnId));
  }

  /**
   * Computes the route for a turn without persisting it. Returns an
   * already-persisted decision for the turn when one exists, so retries never
   * re-derive or overwrite an accepted receipt.
   */
  async computeTurnRoute(input: ResolveTurnRouteInput): Promise<ChatTurnRouteDecision> {
    const existing = this.readDecision(input.turnId);
    if (existing !== undefined) return existing;

    const decision = resolveMultiModelRoute({
      request: input.request,
      activeHostId: input.activeHostId,
      mode: input.mode,
      parentRoutingVendorId: input.parentRoutingVendorId,
      parentCandidate: input.parentCandidate,
      runtimeFacts: input.runtimeFacts,
    });
    return {
      threadId: input.threadId,
      turnId: input.turnId,
      decision,
      decidedAt: decodeTimestamp(this.#clock()),
    };
  }

  /**
   * Durably persists a computed decision, honoring an already-persisted
   * decision for the same turn. Callers commit a "selected" decision only
   * when its parent turn is accepted, so no immutable receipt ever references
   * a turn that was not created.
   */
  async persistTurnRoute(decision: ChatTurnRouteDecision): Promise<ChatTurnRouteDecision> {
    const existing = this.readDecision(decision.turnId);
    if (existing !== undefined) return existing;

    try {
      this.#persistence.journal.append({
        aggregate: { aggregateType: CHAT_TURN_ROUTE_AGGREGATE_TYPE, aggregateId: decision.turnId },
        expectedVersion: 0,
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: "chat.turn-route-decided@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: { kind: "system" as const, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: decodeTimestamp(this.#clock()),
            payload: { kind: "turn-route-decided", decision },
          },
        ],
      });
      return decision;
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        // Another concurrent resolution for the same turnId already won;
        // the persisted decision is authoritative and must not be replaced.
        const raced = this.readDecision(decision.turnId);
        if (raced !== undefined) return raced;
      }
      throw error;
    }
  }

  /** Computes and durably persists a route decision for a turn. */
  async resolveTurnRoute(input: ResolveTurnRouteInput): Promise<ChatTurnRouteDecision> {
    return await this.persistTurnRoute(await this.computeTurnRoute(input));
  }
}
