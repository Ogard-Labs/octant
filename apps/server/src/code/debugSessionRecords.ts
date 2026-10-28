import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  CODE_DEBUG_EVENT_NAMES,
  CODE_DEBUG_SESSION_AGGREGATE,
  CodeDebugSessionEndReason,
  decodeCodeDebugSessionEnded,
  decodeCodeDebugSessionStarted,
  type CodeDebugSessionEnded,
  type CodeDebugSessionStarted,
} from "@octant/contracts/code-debug";
import { decodeDiagnosticDebugSessions, type DiagnosticDebugSessions } from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * The journaled lifecycle of debug sessions. Canonical:
 * docs/design/language-services.md § Debugger data and privacy.
 *
 * Each session is an aggregate of its own holding its start and its end,
 * which name the Project, thread, checkout, configuration digest, network,
 * and end reason, and nothing the session showed. A start that cannot be
 * appended means the session does not run. A host that stopped without
 * ending a session ends it at its next start, so no record stays open.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 1_000;
const isEndReason = Schema.is(CodeDebugSessionEndReason);

export interface DebugSessionRecordsOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  /** Speaks for the person at a local window, whose Start began the session. */
  readonly personActor: EventActorValue;
  /** Speaks for the host, which ends a session for every reason but the person's Stop. */
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class DebugSessionRecords {
  readonly #journal: DebugSessionRecordsOptions["journal"];
  readonly #personActor: EventActorValue;
  readonly #hostActor: EventActorValue;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: DebugSessionRecordsOptions) {
    this.#journal = options.journal;
    this.#personActor = decodeActor(options.personActor);
    this.#hostActor = decodeActor(options.hostActor);
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  started(payload: CodeDebugSessionStarted): "recorded" | "not-recorded" {
    return this.#append(payload.sessionId, 0, CODE_DEBUG_EVENT_NAMES.sessionStarted, payload, {
      actor: this.#personActor,
      decode: decodeCodeDebugSessionStarted,
    });
  }

  ended(payload: CodeDebugSessionEnded): "recorded" | "not-recorded" {
    return this.#append(payload.sessionId, 1, CODE_DEBUG_EVENT_NAMES.sessionEnded, payload, {
      actor: payload.endReason === "stopped" ? this.#personActor : this.#hostActor,
      decode: decodeCodeDebugSessionEnded,
    });
  }

  /**
   * Ends every session a previous run of this host started and never ended,
   * as `host-restarted`. Run at startup, before any session starts.
   */
  endLeftOpen(): number {
    const open = new Map<string, CodeDebugSessionStarted>();
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: CODE_DEBUG_SESSION_AGGREGATE,
        afterSequence,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        const key = String(envelope.aggregateId);
        if (envelope.eventName === CODE_DEBUG_EVENT_NAMES.sessionEnded) {
          open.delete(key);
        } else if (envelope.eventName === CODE_DEBUG_EVENT_NAMES.sessionStarted) {
          try {
            open.set(key, decodeCodeDebugSessionStarted(envelope.payload));
          } catch {
            // Unreadable: there is nothing to name in its end.
          }
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    let ended = 0;
    for (const started of open.values()) {
      const recorded = this.ended({
        sessionId: started.sessionId,
        projectId: started.projectId,
        threadId: started.threadId,
        configurationDigest: started.configurationDigest,
        endReason: "host-restarted",
      });
      if (recorded === "recorded") ended += 1;
    }
    return ended;
  }

  #append<T>(
    sessionId: string,
    expectedVersion: number,
    eventName: string,
    payload: T,
    options: { readonly actor: EventActorValue; readonly decode: (value: unknown) => T },
  ): "recorded" | "not-recorded" {
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: CODE_DEBUG_SESSION_AGGREGATE,
          aggregateId: decodeAggregateId(sessionId),
        },
        expectedVersion: decodeAggregateVersion(expectedVersion),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: options.actor,
            occurredAt: decodeTimestamp(this.#clock()),
            payload: options.decode(payload),
          },
        ],
      });
      return "recorded";
    } catch {
      return "not-recorded";
    }
  }
}

/**
 * Sessions started, and ended by reason, from the first UTC day `since` on,
 * for a diagnostics export: counts and the closed end reasons only. Undefined
 * when none started or ended then, so a host that never debugged exports no
 * section. One grouped query over the `event_journal_occurred_at` index reads
 * only this aggregate's rows in the window.
 */
export function readDebugSessionCounts(
  connection: SqliteConnection,
  since: string,
): DiagnosticDebugSessions | undefined {
  const rows = connection
    .prepare(
      `SELECT event_name AS name, json_extract(payload_json, '$.endReason') AS reason,
         count(*) AS events
       FROM event_journal INDEXED BY event_journal_occurred_at
       WHERE occurred_at >= ? AND aggregate_type = ?
       GROUP BY name, reason`,
    )
    .all(since, CODE_DEBUG_SESSION_AGGREGATE) as ReadonlyArray<{
    readonly name: string;
    readonly reason: unknown;
    readonly events: number;
  }>;
  let started = 0;
  const ended: Array<{ readonly endReason: CodeDebugSessionEndReason; readonly count: number }> =
    [];
  for (const row of rows) {
    if (row.name === CODE_DEBUG_EVENT_NAMES.sessionStarted) started += row.events;
    else if (row.name === CODE_DEBUG_EVENT_NAMES.sessionEnded && isEndReason(row.reason)) {
      ended.push({ endReason: row.reason, count: row.events });
    }
  }
  if (started === 0 && ended.length === 0) return undefined;
  ended.sort(
    (left, right) => right.count - left.count || left.endReason.localeCompare(right.endReason),
  );
  return decodeDiagnosticDebugSessions({ since, started, ended });
}
