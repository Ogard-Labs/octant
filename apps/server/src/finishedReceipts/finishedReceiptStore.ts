import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  FinishedReceiptRecorded,
  MAX_FINISHED_RECEIPTS_PER_THREAD,
  THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE,
  THREAD_FINISHED_RECEIPT_EVENT_NAMES,
  TOOL_EFFECT_AGGREGATE_TYPE,
  TOOL_EFFECT_EVENT_NAMES,
  decodeFinishedReceiptRecorded,
  type EventEnvelope,
  type ThreadBoardFinishedMark,
  type ThreadFinishedReceipt,
} from "@octant/contracts";
import {
  finishedBoardMarkFromReceipts,
  projectThreadFinishedReceipts,
  type FinishedReceiptFileChangeSignal,
  type SequencedFinishedReceipt,
} from "@octant/domain/finished-receipt-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

const CODE_MUTATING_GIT_ACTIONS = new Set<string>([
  "reverse-hunks",
  "discard",
  "commit",
  "revert",
  "restore-checkpoint",
  "merge-run",
]);

const FILE_WRITE_TOOL_NAMES = new Set<string>([
  "edit",
  "write",
  "Edit",
  "Write",
  "NotebookEdit",
  "apply_patch",
]);

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export function registerFinishedReceiptEvents(registry: EventRegistry): EventRegistry {
  return registry.register(
    THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded,
    1,
    FinishedReceiptRecorded,
  );
}

interface ThreadReceiptRecord {
  readonly receipts: SequencedFinishedReceipt[];
  readonly receiptIds: Set<string>;
  readonly fileChanges: FinishedReceiptFileChangeSignal[];
  version: number;
}

interface PendingWriteCall {
  readonly threadId: string;
}

/**
 * Journal-backed store of host-built finished receipts across Work and Code
 * threads. Ordering and staleness come strictly from journal event sequence
 * numbers: both startup replay and live journal commits feed the exact same
 * event classifier and domain policy.
 */
export class ThreadFinishedReceiptStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #threads = new Map<string, ThreadReceiptRecord>();
  /** Work thread ids indexed by projectId so project-scoped artifact mutations mark them stale. */
  readonly #workThreadsByProject = new Map<string, Set<string>>();
  /** In-flight file-writing tool calls keyed by `${threadId}:${toolCallId}` until settled. */
  readonly #pendingWriteCalls = new Map<string, PendingWriteCall>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly actor: typeof EventActor.Type;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#hydrate();
  }

  /**
   * Append a newly verified finished receipt to the journal and return its
   * projected state. Only called after every check has passed (no failed items).
   */
  record(input: FinishedReceiptRecorded): ThreadFinishedReceipt {
    const receipt = decodeFinishedReceiptRecorded(input);
    const thread = this.#ensureThread(receipt.threadId);
    const committed = this.#journal.append({
      aggregate: {
        aggregateType: THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(receipt.threadId),
      },
      expectedVersion: decodeAggregateVersion(thread.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload: receipt,
        },
      ],
    });
    const envelope = committed.events[0];
    if (envelope !== undefined) {
      this.#applyEnvelope(envelope);
    }
    const projected = this.read(receipt.threadId).find(
      (candidate) => String(candidate.receipt.receiptId) === String(receipt.receiptId),
    );
    if (projected !== undefined) return projected;
    return {
      receipt,
      status: "claimed",
      stale: false,
      provenCount: 0,
      claimedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
    };
  }

  /** Apply newly committed journal envelopes live so staleness updates immediately. */
  onCommittedEvents(events: ReadonlyArray<EventEnvelope>): void {
    for (const envelope of events) {
      this.#applyEnvelope(envelope);
    }
  }

  /** Every recorded finished receipt for one thread, oldest first, capped to the contract ceiling. */
  read(threadId: string): ReadonlyArray<ThreadFinishedReceipt> {
    const thread = this.#threads.get(threadId);
    if (thread === undefined || thread.receipts.length === 0) return [];
    const projected = projectThreadFinishedReceipts({
      receipts: thread.receipts,
      fileChanges: thread.fileChanges,
    });
    return projected.length <= MAX_FINISHED_RECEIPTS_PER_THREAD
      ? projected
      : projected.slice(-MAX_FINISHED_RECEIPTS_PER_THREAD);
  }

  /** The newest finished receipt for a thread, whether fresh or stale. */
  latest(threadId: string): ThreadFinishedReceipt | undefined {
    const all = this.read(threadId);
    return all.at(-1);
  }

  /**
   * Compact board mark for a thread card: present only when the latest receipt
   * exists and is still fresh. Disappears automatically when a later file-change
   * journal event marks the receipt stale.
   */
  boardMark(threadId: string): ThreadBoardFinishedMark | undefined {
    return finishedBoardMarkFromReceipts(this.read(threadId));
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE,
      "code-operation",
      "work-turn",
      "work-artifact",
      TOOL_EFFECT_AGGREGATE_TYPE,
    ])) {
      this.#applyEnvelope(envelope);
    }
  }

  #ensureThread(threadId: string): ThreadReceiptRecord {
    const existing = this.#threads.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadReceiptRecord = {
      receipts: [],
      receiptIds: new Set<string>(),
      fileChanges: [],
      version: 0,
    };
    this.#threads.set(threadId, created);
    return created;
  }

  #recordFileChange(threadId: string, signal: FinishedReceiptFileChangeSignal): void {
    const thread = this.#threads.get(threadId);
    if (thread === undefined || thread.receipts.length === 0) return;
    thread.fileChanges.push(signal);
  }

  #applyEnvelope(envelope: EventEnvelope): void {
    if (
      envelope.aggregateType === THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE &&
      envelope.eventName === THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded &&
      envelope.eventVersion === 1
    ) {
      let receipt: FinishedReceiptRecorded;
      try {
        receipt = decodeFinishedReceiptRecorded(envelope.payload);
      } catch {
        return;
      }
      const thread = this.#ensureThread(receipt.threadId);
      const idKey = String(receipt.receiptId);
      if (thread.receiptIds.has(idKey)) return;
      thread.receiptIds.add(idKey);
      thread.receipts.push({ sequence: envelope.globalSequence, receipt });
      thread.version = Math.max(thread.version, envelope.aggregateVersion);
      if (receipt.mode === "work") {
        const projectKey = String(receipt.projectId);
        const set = this.#workThreadsByProject.get(projectKey) ?? new Set<string>();
        set.add(receipt.threadId);
        this.#workThreadsByProject.set(projectKey, set);
      }
      return;
    }

    if (
      envelope.aggregateType === "code-operation" &&
      envelope.eventName === "code.operation-event-recorded@1" &&
      envelope.eventVersion === 1
    ) {
      const classified = classifyCodeOperationEvent(envelope.payload);
      if (classified !== undefined) {
        this.#recordFileChange(classified.threadId, {
          sequence: envelope.globalSequence,
          ...(classified.turnId === undefined ? {} : { turnId: classified.turnId }),
        });
      }
      return;
    }

    if (envelope.aggregateType === "work-turn" && envelope.eventVersion === 1) {
      if (envelope.eventName === "work.turn-updated@1") {
        const classified = classifyWorkTurnUpdated(envelope.payload);
        if (classified !== undefined) {
          this.#recordFileChange(classified.threadId, {
            sequence: envelope.globalSequence,
            ...(classified.turnId === undefined ? {} : { turnId: classified.turnId }),
          });
        }
        return;
      }
      if (envelope.eventName === "work.thread-rewound@1") {
        const threadId = readStringField(envelope.payload, "threadId");
        if (threadId !== undefined) {
          this.#recordFileChange(threadId, { sequence: envelope.globalSequence });
        }
        return;
      }
      return;
    }

    if (
      envelope.aggregateType === "work-artifact" &&
      envelope.eventName === "work.artifact-mutation-recorded@1" &&
      envelope.eventVersion === 1
    ) {
      const projectId = readStringField(envelope.payload, "projectId");
      if (projectId !== undefined) {
        const affected = this.#workThreadsByProject.get(projectId);
        if (affected !== undefined) {
          for (const threadId of affected) {
            this.#recordFileChange(threadId, { sequence: envelope.globalSequence });
          }
        }
      }
      return;
    }

    if (envelope.aggregateType === TOOL_EFFECT_AGGREGATE_TYPE && envelope.eventVersion === 1) {
      if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.intended) {
        const threadId = readStringField(envelope.payload, "threadId");
        const toolCallId = readStringField(envelope.payload, "toolCallId");
        const toolName = readStringField(envelope.payload, "toolName");
        if (
          threadId !== undefined &&
          toolCallId !== undefined &&
          toolName !== undefined &&
          FILE_WRITE_TOOL_NAMES.has(toolName)
        ) {
          this.#pendingWriteCalls.set(`${threadId}:${toolCallId}`, { threadId });
        }
        return;
      }
      if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.settled) {
        const threadId = readStringField(envelope.payload, "threadId");
        const toolCallId = readStringField(envelope.payload, "toolCallId");
        const outcome = readStringField(envelope.payload, "outcome");
        if (threadId !== undefined && toolCallId !== undefined) {
          const key = `${threadId}:${toolCallId}`;
          const pending = this.#pendingWriteCalls.get(key);
          this.#pendingWriteCalls.delete(key);
          if (pending !== undefined && outcome === "succeeded") {
            this.#recordFileChange(pending.threadId, { sequence: envelope.globalSequence });
          }
        }
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value);
  const candidate = record?.[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function classifyCodeOperationEvent(
  payload: unknown,
): { readonly threadId: string; readonly turnId?: string } | undefined {
  const frame = asRecord(payload);
  if (frame === undefined) return undefined;
  const threadId = readStringField(frame, "threadId");
  const operationId = readStringField(frame, "operationId");
  const event = asRecord(frame.event);
  if (threadId === undefined || event === undefined) return undefined;
  const kind = event.kind;
  if (kind === "file-change" || kind === "diff") {
    return { threadId };
  }
  if (kind === "conversation-turn-changed-files") {
    const changed = asRecord(event.changedFiles);
    const total = typeof changed?.total === "number" ? changed.total : 0;
    const truncated = changed?.truncated === true;
    if (total > 0 || truncated) {
      return operationId === undefined ? { threadId } : { threadId, turnId: operationId };
    }
    return undefined;
  }
  if (kind === "result") {
    const result = asRecord(event.result);
    if (result === undefined) return undefined;
    if (
      result.kind === "git-mutation-state" &&
      result.state === "completed" &&
      typeof result.mutation === "string" &&
      CODE_MUTATING_GIT_ACTIONS.has(result.mutation)
    ) {
      return { threadId };
    }
    if (result.kind === "thread-rewound" && result.files === "restored") {
      return { threadId };
    }
    if (result.kind === "review-correction-result") {
      return { threadId };
    }
  }
  return undefined;
}

function classifyWorkTurnUpdated(
  payload: unknown,
): { readonly threadId: string; readonly turnId?: string } | undefined {
  const updated = asRecord(payload);
  if (updated === undefined) return undefined;
  const threadId = readStringField(updated, "threadId");
  const turnId = readStringField(updated, "turnId");
  const wroteFiles = asRecord(updated.wroteFiles);
  if (threadId === undefined || wroteFiles === undefined) return undefined;
  const paths = Array.isArray(wroteFiles.paths) ? wroteFiles.paths : [];
  const truncated = wroteFiles.truncated === true;
  if (paths.length === 0 && !truncated) return undefined;
  return turnId === undefined ? { threadId } : { threadId, turnId };
}
