import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeWorkflowFrame,
  decodeWorkflowId,
  type WorkflowFrame,
  type WorkflowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const WORK_WORKFLOW_RECORDED = "work.workflow-recorded@1";
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class WorkflowEventStoreError extends Error {
  override readonly name = "WorkflowEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: WorkflowEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface WorkflowEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendWorkflowInput {
  readonly workflowId: WorkflowId;
  readonly expectedVersion: number;
  readonly frame: WorkflowFrame;
}

export type WorkflowReplayAll =
  | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkflowFrame> }
  | {
      readonly status: "snapshot-required";
      readonly reason: "identity-mismatch" | "invalid-frame" | "scan-limit";
    };

/**
 * Server-authoritative Work workflow event store. Appends one
 * `work.workflow-recorded@1` event per workflow transition; the aggregate
 * is the workflow and the aggregate version is the workflow's own `version`,
 * backing optimistic concurrency on `expectedVersion`. Unlike best-effort
 * hydration elsewhere in Work, `replayAll` fails closed on any malformed,
 * out-of-order, or misattributed frame instead of skipping it, so a
 * reconnect/restart rebuild never silently serves a partially rebuilt
 * workflow projection.
 */
export class WorkflowEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: WorkflowEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new WorkflowEventStoreError("invalid", "Work workflow event actor is invalid.");
    }
  }

  append(input: AppendWorkflowInput): WorkflowFrame {
    let frame: WorkflowFrame;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const workflowId = decodeWorkflowId(input.workflowId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(workflowId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeWorkflowFrame(input.frame);
      if (frame.workflow.workflowId !== workflowId) {
        throw new Error("frame workflow id does not match the append request");
      }
      if (frame.workflow.version !== expectedVersion + 1) {
        throw new Error("frame version must be one greater than the expected head");
      }
    } catch {
      throw new WorkflowEventStoreError("invalid", "Work workflow append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: "work-workflow", aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: WORK_WORKFLOW_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: frame.workflow.updatedAt,
            payload: frame,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new WorkflowEventStoreError(
          "invalid",
          "Work workflow expected version does not match the current workflow head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    const expectedAggregateVersion = expectedVersion + 1;
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "work-workflow" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedAggregateVersion ||
      envelope.eventName !== WORK_WORKFLOW_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new WorkflowEventStoreError(
        "journal-mismatch",
        "Committed Work workflow event does not match its append.",
      );
    }
    return frame;
  }

  /**
   * Replays all journaled workflow frames across every workflow, grouped by
   * workflow id and ordered by version within each group. Fails closed with
   * `snapshot-required` the moment any frame is malformed, out of sequence,
   * or attributed to the wrong aggregate, so a caller never rebuilds the
   * projection from a partially valid frame stream.
   */
  replayAll(): WorkflowReplayAll {
    const byWorkflow = new Map<WorkflowId, Array<WorkflowFrame>>();
    let afterSequence = 0;
    let scannedEvents = 0;

    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.aggregateType !== "work-workflow") continue;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        if (envelope.eventName !== WORK_WORKFLOW_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: WorkflowFrame;
        try {
          frame = decodeWorkflowFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (
          String(frame.workflow.workflowId) !== String(envelope.aggregateId) ||
          frame.workflow.version !== envelope.aggregateVersion
        ) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }

        const workflowId = frame.workflow.workflowId;
        let list = byWorkflow.get(workflowId);
        if (list === undefined) {
          list = [];
          byWorkflow.set(workflowId, list);
        }
        list.push(frame);
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    const all: Array<WorkflowFrame> = [];
    for (const list of byWorkflow.values()) {
      const historyResult = validateHistory(list);
      if (historyResult !== undefined) return historyResult;
      for (const frame of list) all.push(frame);
    }
    return { status: "ok", frames: all };
  }
}

function validateHistory(
  frames: ReadonlyArray<WorkflowFrame>,
):
  | { readonly status: "snapshot-required"; readonly reason: "identity-mismatch" | "invalid-frame" }
  | undefined {
  let previous: WorkflowFrame | undefined;
  for (const [index, frame] of frames.entries()) {
    if (frame.workflow.version !== index + 1) {
      return { status: "snapshot-required", reason: "identity-mismatch" };
    }
    if (previous !== undefined) {
      if (
        String(frame.workflow.projectId) !== String(previous.workflow.projectId) ||
        String(frame.workflow.relatedThreadId) !== String(previous.workflow.relatedThreadId) ||
        frame.workflow.label !== previous.workflow.label ||
        frame.workflow.startedAt !== previous.workflow.startedAt ||
        previous.workflow.lifecycle !== "active"
      ) {
        return { status: "snapshot-required", reason: "identity-mismatch" };
      }
    }
    previous = frame;
  }
  return undefined;
}

function sameFrame(left: unknown, right: WorkflowFrame): boolean {
  try {
    return JSON.stringify(decodeWorkflowFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
