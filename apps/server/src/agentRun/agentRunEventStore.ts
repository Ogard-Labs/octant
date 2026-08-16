import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeAgentRun,
  decodeAgentRunId,
  decodeAgentRunResultAcknowledged,
  decodeAgentRunStatusChanged,
  type AgentRun,
  type AgentRunAdmittedContext,
  type AgentRunId,
  type AgentRunLifecycleStatus,
  type AgentRunResult,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  writeAgentRunAdmittedContext,
  writeAgentRunResultText,
} from "../persistence/agentRunContentStore";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const AGENT_RUN_AGGREGATE_TYPE = "agent-run";
export const AGENT_RUN_REQUESTED = "agent.run-requested@1";
export const AGENT_RUN_STATUS_CHANGED = "agent.run-status-changed@1";
export const AGENT_RUN_RESULT_ACKNOWLEDGED = "agent.run-result-acknowledged@1";
export const MAX_AGENT_RUN_REPLAY_LIMIT = 256;
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class AgentRunEventStoreError extends Error {
  override readonly name = "AgentRunEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: AgentRunEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AgentRunEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendAgentRunStatusChangedInput {
  readonly runId: AgentRunId;
  readonly fromStatus: AgentRunLifecycleStatus;
  readonly toStatus: AgentRunLifecycleStatus;
  readonly version: number;
  readonly expectedVersion: number;
  readonly occurredAt: UtcTimestamp;
  readonly recoveryReason?: string;
  /**
   * The reply a completion carries. It is committed by this one append, so a
   * journal can never hold a Completed status change whose result is missing.
   */
  readonly result?: AgentRunResult;
  /**
   * The reply text stored under `result.reference`. Required whenever `result`
   * is, and written by the same transaction as the event that names it.
   */
  readonly resultText?: string;
  /** The run this status change belongs to; owns the stored reply text. */
  readonly run?: AgentRun;
}

export interface AppendAgentRunResultAcknowledgedInput {
  readonly runId: AgentRunId;
  readonly version: number;
  readonly expectedVersion: number;
  readonly acknowledgedAt: UtcTimestamp;
}

export interface ReplayAgentRunInput {
  readonly runId: AgentRunId;
  readonly afterVersion: number;
  readonly limit: number;
}

export type AgentRunReplay =
  | {
      readonly status: "ok";
      readonly events: ReadonlyArray<EventEnvelope>;
      readonly nextCursor: number;
    }
  | {
      readonly status: "snapshot-required";
      readonly reason:
        | "gap"
        | "identity-mismatch"
        | "invalid-frame"
        | "cursor-ahead"
        | "scan-limit";
    };

/**
 * Server-authoritative AgentRun event store. Appends AgentRun lifecycle events
 * to the journal with optimistic concurrency on the run aggregate version.
 * Replay rebuilds run history for projection catch-up after reconnect/restart.
 */
export class AgentRunEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: AgentRunEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new AgentRunEventStoreError("invalid", "AgentRun event actor is invalid.");
    }
  }

  /**
   * Appends the admission and, in the same transaction, stores the
   * parent-thread selection it was admitted with.
   *
   * The blocks are the parent thread's own conversation, so the event records
   * only the snapshot id and the block count; the text is written to the
   * subject-owned content store under that same id, where a thread deletion can
   * destroy it. Writing it here commits the selection and the receipt that
   * names it together or not at all.
   */
  appendRequested(runInput: AgentRun, admittedContext?: AgentRunAdmittedContext): EventEnvelope {
    let run: AgentRun;
    let aggregateId: typeof AggregateId.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      run = decodeAgentRun(JSON.parse(JSON.stringify(decodeAgentRun(runInput))));
      if (run.version !== 1) {
        throw new Error("requested run must start at version 1");
      }
      aggregateId = decodeAggregateId(run.id);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
    } catch {
      throw new AgentRunEventStoreError("invalid", "AgentRun requested append is invalid.");
    }

    const admissionRun = run;
    let committed;
    try {
      committed = this.#journal.append(
        {
          aggregate: { aggregateType: AGENT_RUN_AGGREGATE_TYPE, aggregateId },
          expectedVersion: 0,
          events: [
            {
              eventId,
              eventName: AGENT_RUN_REQUESTED,
              eventVersion: 1,
              correlationId,
              actor: this.#actor,
              occurredAt: run.createdAt,
              payload: { run },
            },
          ],
        },
        admittedContext === undefined
          ? {}
          : {
              beforeEvents: (connection) =>
                writeAgentRunAdmittedContext(connection, {
                  run: admissionRun,
                  blocks: admittedContext,
                  createdAt: admissionRun.createdAt,
                }),
            },
      );
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AgentRunEventStoreError(
          "invalid",
          "AgentRun expected version does not match the current head.",
        );
      }
      throw error;
    }

    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      1,
      AGENT_RUN_REQUESTED,
      "AgentRun requested",
    );
  }

  appendStatusChanged(input: AppendAgentRunStatusChangedInput): EventEnvelope {
    let runId: AgentRunId;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    let payload: ReturnType<typeof decodeAgentRunStatusChanged>;
    try {
      runId = decodeAgentRunId(input.runId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(runId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      payload = decodeAgentRunStatusChanged({
        runId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        version: input.version,
        ...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
        ...(input.result === undefined ? {} : { result: input.result }),
      });
      if (payload.version !== expectedVersion + 1) {
        throw new Error("status version must be one greater than expected head");
      }
    } catch {
      throw new AgentRunEventStoreError("invalid", "AgentRun status change append is invalid.");
    }

    const completion =
      input.result === undefined || input.resultText === undefined || input.run === undefined
        ? undefined
        : { run: input.run, reference: input.result.reference, text: input.resultText };
    if (input.result !== undefined && completion === undefined) {
      throw new AgentRunEventStoreError(
        "invalid",
        "AgentRun completion requires the reply text and the run that owns it.",
      );
    }

    let committed;
    try {
      committed = this.#journal.append(
        {
          aggregate: { aggregateType: AGENT_RUN_AGGREGATE_TYPE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId,
              eventName: AGENT_RUN_STATUS_CHANGED,
              eventVersion: 1,
              correlationId,
              actor: this.#actor,
              occurredAt: input.occurredAt,
              payload,
            },
          ],
        },
        completion === undefined
          ? {}
          : {
              // The reply is the parent thread's content, so it is stored
              // rather than journaled — by this same transaction, so a journal
              // can never record Completed without the reply behind it.
              beforeEvents: (connection) =>
                writeAgentRunResultText(connection, {
                  run: completion.run,
                  reference: completion.reference,
                  text: completion.text,
                  createdAt: input.occurredAt,
                }),
            },
      );
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AgentRunEventStoreError(
          "invalid",
          "AgentRun expected version does not match the current head.",
        );
      }
      throw error;
    }

    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      payload.version,
      AGENT_RUN_STATUS_CHANGED,
      "AgentRun status change",
    );
  }

  appendResultAcknowledged(input: AppendAgentRunResultAcknowledgedInput): EventEnvelope {
    let runId: AgentRunId;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    let payload: ReturnType<typeof decodeAgentRunResultAcknowledged>;
    try {
      runId = decodeAgentRunId(input.runId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(runId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      payload = decodeAgentRunResultAcknowledged({
        runId,
        version: input.version,
        acknowledgedAt: input.acknowledgedAt,
      });
      if (payload.version !== expectedVersion + 1) {
        throw new Error("ack version must be one greater than expected head");
      }
    } catch {
      throw new AgentRunEventStoreError(
        "invalid",
        "AgentRun result acknowledgement append is invalid.",
      );
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: AGENT_RUN_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: AGENT_RUN_RESULT_ACKNOWLEDGED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.acknowledgedAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new AgentRunEventStoreError(
          "invalid",
          "AgentRun expected version does not match the current head.",
        );
      }
      throw error;
    }

    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      payload.version,
      AGENT_RUN_RESULT_ACKNOWLEDGED,
      "AgentRun result acknowledgement",
    );
  }

  replayRun(input: ReplayAgentRunInput): AgentRunReplay {
    let runId: AgentRunId;
    try {
      runId = decodeAgentRunId(input.runId);
      if (
        !Number.isSafeInteger(input.afterVersion) ||
        input.afterVersion < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_AGENT_RUN_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new AgentRunEventStoreError("invalid", "AgentRun replay is invalid.");
    }

    const events: EventEnvelope[] = [];
    let expectedVersion = 1;
    let afterSequence = 0;
    let scannedEvents = 0;

    while (events.length < input.limit) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        afterSequence = envelope.globalSequence;
        if (!isRequestedAggregate(envelope, runId)) continue;
        if (envelope.aggregateVersion <= input.afterVersion) continue;
        if (envelope.aggregateVersion < expectedVersion) {
          return { status: "snapshot-required", reason: "gap" };
        }
        if (envelope.aggregateVersion > expectedVersion) {
          // allow starting mid-stream only when afterVersion advanced expectedVersion
          if (expectedVersion === 1 && input.afterVersion + 1 === envelope.aggregateVersion) {
            expectedVersion = envelope.aggregateVersion;
          } else if (envelope.aggregateVersion !== expectedVersion) {
            return { status: "snapshot-required", reason: "gap" };
          }
        }
        events.push(envelope);
        expectedVersion = envelope.aggregateVersion + 1;
        if (events.length >= input.limit) break;
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    return {
      status: "ok",
      events,
      nextCursor:
        events.length === 0 ? input.afterVersion : events[events.length - 1]!.aggregateVersion,
    };
  }

  replayAll(limit = MAX_AGENT_RUN_REPLAY_LIMIT): AgentRunReplay {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_RUN_REPLAY_LIMIT) {
      throw new AgentRunEventStoreError("invalid", "AgentRun replay is invalid.");
    }
    const events: EventEnvelope[] = [];
    let afterSequence = 0;
    let scannedEvents = 0;
    while (events.length < limit) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== AGENT_RUN_AGGREGATE_TYPE) continue;
        events.push(envelope);
        if (events.length >= limit) break;
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return {
      status: "ok",
      events,
      nextCursor: events.length === 0 ? 0 : events[events.length - 1]!.aggregateVersion,
    };
  }

  #assertCommitted(
    envelope: EventEnvelope | undefined,
    aggregateId: typeof AggregateId.Type,
    aggregateVersion: number,
    eventName: string,
    label: string,
  ): EventEnvelope {
    if (
      envelope === undefined ||
      envelope.aggregateType !== AGENT_RUN_AGGREGATE_TYPE ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== aggregateVersion ||
      envelope.eventName !== eventName ||
      envelope.eventVersion !== 1
    ) {
      throw new AgentRunEventStoreError(
        "journal-mismatch",
        `Committed ${label} event does not match its append.`,
      );
    }
    return envelope;
  }
}

function isRequestedAggregate(envelope: EventEnvelope, runId: AgentRunId): boolean {
  return (
    envelope.aggregateType === AGENT_RUN_AGGREGATE_TYPE &&
    String(envelope.aggregateId) === String(runId)
  );
}
