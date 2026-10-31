import {
  ActorId,
  CorrelationId,
  EventId,
  HOST_MEMORY_LIMITS_AGGREGATE_TYPE,
  HOST_MEMORY_LIMITS_EVENT_NAME,
  LOCAL_HOST_ID,
  UtcTimestamp,
  type HostMemoryLimits,
  type SetHostMemoryLimitsOutcome,
  type SetHostMemoryLimitsRequest,
} from "@octant/contracts";
import { decideHostMemoryLimits, type PrincipalKind } from "@octant/domain";
import { Schema } from "effect";
import { readAggregateVersion } from "./persistence/chatProjection";
import {
  HOST_MEMORY_LIMITS_AGGREGATE_ID,
  readHostMemoryLimits,
} from "./persistence/hostMemoryLimitsProjection";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

function sameLimits(left: HostMemoryLimits, right: HostMemoryLimits): boolean {
  if (left.kind === "automatic" || right.kind === "automatic") return left.kind === right.kind;
  return left.pressuredGb === right.pressuredGb && left.criticalGb === right.criticalGb;
}

export interface HostMemoryLimitsServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** Called after a change is journaled, so the guard can take a reading at once. */
  readonly onChanged?: (limits: HostMemoryLimits) => void;
}

/**
 * The host's memory limits as a journaled setting. Each change appends one
 * event with who made it, when, and the values before and after; the
 * projection is rebuilt from those events, so a replay lands on the same
 * limits. Saving the values already in force records nothing.
 */
export class HostMemoryLimitsService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #onChanged: HostMemoryLimitsServiceOptions["onChanged"];

  constructor(options: HostMemoryLimitsServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#onChanged = options.onChanged;
  }

  read(): HostMemoryLimits {
    return readHostMemoryLimits(this.#connection);
  }

  set(
    request: SetHostMemoryLimitsRequest,
    principalKind: PrincipalKind,
  ): SetHostMemoryLimitsOutcome {
    const decision = decideHostMemoryLimits({ principalKind, limits: request.limits });
    if (decision.kind === "refused") {
      return { kind: "refused", code: decision.code, message: decision.message };
    }
    const previous = this.read();
    if (sameLimits(previous, decision.limits)) {
      return { kind: "saved", limits: previous };
    }
    const changedAt = decodeTimestamp(this.#clock());
    this.#journal.append({
      aggregate: {
        aggregateType: HOST_MEMORY_LIMITS_AGGREGATE_TYPE,
        aggregateId: HOST_MEMORY_LIMITS_AGGREGATE_ID,
      },
      expectedVersion: readAggregateVersion(
        this.#connection,
        HOST_MEMORY_LIMITS_AGGREGATE_TYPE,
        HOST_MEMORY_LIMITS_AGGREGATE_ID,
      ),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: HOST_MEMORY_LIMITS_EVENT_NAME,
          eventVersion: 1,
          hostId: LOCAL_HOST_ID,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user" as const, actorId: decodeActorId(LOCAL_ACTOR_ID) },
          occurredAt: changedAt,
          payload: {
            kind: "memory-limits-changed",
            previous,
            next: decision.limits,
            changedBy: "local-window",
            changedAt,
          },
        },
      ],
    });
    this.#onChanged?.(decision.limits);
    return { kind: "saved", limits: decision.limits };
  }
}
