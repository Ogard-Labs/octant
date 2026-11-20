import {
  MAX_REPLAYABLE_RUN_CASES,
  THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE,
  THREAD_FINISHED_RECEIPT_EVENT_NAMES,
  THREAD_RETENTION_EVENT_NAMES,
  decodeFinishedReceiptRecorded,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeThreadRetentionThreadPurged,
  type EventEnvelope,
  type FinishedReceiptRecorded,
  type ReplayableRunCase,
  type ReplayableRunCaseModel,
} from "@octant/contracts";
import {
  PERSON_MEMORY_THREAD_UNTRACED,
  PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
  PersonMemoryThreadUntraced,
} from "@octant/contracts/person-memory";
import {
  isReceiptStaleAfterJournalEvents,
  type FinishedReceiptFileChangeSignal,
} from "@octant/domain/finished-receipt-policy";
import {
  projectReplayableRunCases,
  type ReplayableRunCaseCandidate,
  type ReplayableRunCaseThreadRef,
} from "@octant/domain/replayable-run-case-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import {
  openReadOnlySqlite,
  type ReadOnlySqliteConnection,
  type SqliteConnection,
} from "../persistence/sqlitePort";

const decodeThreadUntraced = Schema.decodeUnknownSync(PersonMemoryThreadUntraced);

export const REPLAYABLE_RUN_CASE_AGGREGATE_TYPES = [
  "project",
  "work-thread",
  "work-turn",
  "code-thread",
  "code-operation",
  PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
  THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE,
] as const;

export interface CodePromptEvidenceReference {
  readonly contentId: string;
  readonly digest: string;
  readonly byteLength: number;
}

export type CodeEvidenceReader = (reference: CodePromptEvidenceReference) => string | undefined;

export interface ReplayableRunCaseStoreOptions {
  readonly journal: Pick<Journal, "replayAggregateType">;
  /** Optional SQLite connection used to resolve Code prompt evidence references. */
  readonly connection?: SqliteConnection | undefined;
  /** Optional custom reader for Code prompt evidence; overrides `connection` when supplied. */
  readonly readCodeEvidence?: CodeEvidenceReader | undefined;
  readonly maxCases?: number | undefined;
}

interface WorkTurnFact {
  readonly sequence: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly isDelivery: boolean;
  readonly model?: ReplayableRunCaseModel | undefined;
}

interface CodeTurnFact {
  readonly sequence: number;
  readonly operationId: string;
  readonly promptRef?: CodePromptEvidenceReference | undefined;
  readonly inlinePrompt?: string | undefined;
  readonly model?: ReplayableRunCaseModel | undefined;
  rewound: boolean;
}

interface RecordedReceiptFact {
  readonly sequence: number;
  readonly receipt: FinishedReceiptRecorded;
  readonly leavesNoTraceAtRecord: boolean;
  readonly modelAtRecord?: ReplayableRunCaseModel | undefined;
}

interface MinimalEnvelope {
  readonly globalSequence: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly eventVersion: number;
  readonly payload: unknown;
}

/**
 * Accumulates journal events across Projects, Work/Code threads, Leave no trace
 * marks, and finished receipts, then projects replayable run cases through the
 * pure domain policy. Shared by the live journal store and the read-only SQLite
 * database reader so both produce identical results.
 */
class ReplayableRunCaseAccumulator {
  readonly #projects = new Map<string, string>();
  readonly #workThreadModels = new Map<string, ReplayableRunCaseModel>();
  readonly #codeThreadModels = new Map<string, ReplayableRunCaseModel>();
  readonly #workTurns = new Map<string, WorkTurnFact[]>();
  readonly #codeTurns = new Map<string, CodeTurnFact[]>();
  readonly #untraced = new Map<string, ReplayableRunCaseThreadRef>();
  readonly #purged = new Map<string, ReplayableRunCaseThreadRef>();
  readonly #receipts: RecordedReceiptFact[] = [];
  readonly #seenReceiptIds = new Set<string>();

  apply(envelope: MinimalEnvelope): void {
    if (envelope.eventVersion !== 1) return;

    if (envelope.aggregateType === "project") {
      const project = asRecord(asRecord(envelope.payload)?.project);
      const id = readStringField(project, "id") ?? envelope.aggregateId;
      const name = readStringField(project, "name");
      if (id.length > 0 && name !== undefined) {
        this.#projects.set(id, name);
      }
      return;
    }

    if (
      envelope.aggregateType === "work-thread" &&
      (envelope.eventName === "work.thread-created@1" ||
        envelope.eventName === "work.thread-updated@1")
    ) {
      const thread = asRecord(asRecord(envelope.payload)?.thread);
      const threadId = readStringField(thread, "id") ?? envelope.aggregateId;
      const model = extractModel(thread);
      if (threadId.length > 0 && model !== undefined) {
        this.#workThreadModels.set(threadId, model);
      }
      return;
    }

    if (envelope.aggregateType === "work-turn") {
      if (envelope.eventName === "work.turn-accepted@1") {
        const payload = asRecord(envelope.payload);
        const threadId = readStringField(payload, "threadId");
        const turnId = readStringField(payload, "turnId");
        const requestId = readStringField(payload, "requestId") ?? turnId ?? envelope.aggregateId;
        const prompt = readStringField(payload, "prompt");
        if (threadId !== undefined && turnId !== undefined && prompt !== undefined) {
          const authority = asRecord(payload?.authority);
          const model = extractModel(authority) ?? extractModel(payload);
          const isDelivery = payload?.delivery !== undefined;
          const list = this.#workTurns.get(threadId) ?? [];
          list.push({
            sequence: envelope.globalSequence,
            requestId,
            turnId,
            prompt,
            isDelivery,
            ...(model === undefined ? {} : { model }),
          });
          this.#workTurns.set(threadId, list);
        }
        return;
      }
      if (envelope.eventName === "work.thread-rewound@1") {
        const payload = asRecord(envelope.payload);
        const threadId = readStringField(payload, "threadId");
        const removed = Array.isArray(payload?.removedRequestIds)
          ? new Set(
              payload.removedRequestIds.filter((item): item is string => typeof item === "string"),
            )
          : undefined;
        if (threadId !== undefined && removed !== undefined && removed.size > 0) {
          const existing = this.#workTurns.get(threadId);
          if (existing !== undefined) {
            this.#workTurns.set(
              threadId,
              existing.filter((turn) => !removed.has(turn.requestId)),
            );
          }
        }
        return;
      }
      return;
    }

    if (
      envelope.aggregateType === "code-thread" &&
      (envelope.eventName === "code.thread-created@1" ||
        envelope.eventName === "code.thread-updated@1")
    ) {
      const thread = asRecord(asRecord(envelope.payload)?.thread);
      const threadId = readStringField(thread, "id") ?? envelope.aggregateId;
      const model = extractModel(thread);
      if (threadId.length > 0 && model !== undefined) {
        this.#codeThreadModels.set(threadId, model);
      }
      return;
    }

    if (
      envelope.aggregateType === "code-operation" &&
      envelope.eventName === "code.operation-event-recorded@1"
    ) {
      const frame = asRecord(envelope.payload);
      const threadId = readStringField(frame, "threadId");
      const operationId = readStringField(frame, "operationId") ?? envelope.aggregateId;
      const event = asRecord(frame?.event);
      if (threadId === undefined || event === undefined) return;
      if (event.kind === "conversation-turn-started") {
        const model = extractModel(event);
        const promptRef = extractCodeEvidenceReference(event.prompt);
        const inlinePrompt = typeof event.prompt === "string" ? event.prompt : undefined;
        const list = this.#codeTurns.get(threadId) ?? [];
        list.push({
          sequence: envelope.globalSequence,
          operationId,
          ...(promptRef === undefined ? {} : { promptRef }),
          ...(inlinePrompt === undefined ? {} : { inlinePrompt }),
          ...(model === undefined ? {} : { model }),
          rewound: false,
        });
        this.#codeTurns.set(threadId, list);
        return;
      }
      if (event.kind === "operation-result") {
        const result = asRecord(event.result);
        if (result?.kind === "thread-rewound" && result.scope !== "files") {
          const fromOperationId = readStringField(result, "fromOperationId");
          const list = this.#codeTurns.get(threadId);
          if (fromOperationId !== undefined && list !== undefined) {
            const anchor = list.find((turn) => turn.operationId === fromOperationId);
            if (anchor !== undefined) {
              for (const turn of list) {
                if (turn.sequence >= anchor.sequence && turn.sequence < envelope.globalSequence) {
                  turn.rewound = true;
                }
              }
            }
          }
        }
      }
      return;
    }

    if (
      envelope.aggregateType === PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE &&
      envelope.eventName === PERSON_MEMORY_THREAD_UNTRACED
    ) {
      let mark: typeof PersonMemoryThreadUntraced.Type;
      try {
        mark = decodeThreadUntraced(envelope.payload);
      } catch {
        return;
      }
      if (mark.mode !== "work" && mark.mode !== "code") return;
      const key = `${mark.mode}:${String(mark.threadId)}`;
      if (mark.leavesNoTrace) {
        this.#untraced.set(key, { mode: mark.mode, threadId: String(mark.threadId) });
      } else {
        this.#untraced.delete(key);
      }
      return;
    }

    if (envelope.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      try {
        const purged = decodeThreadRetentionThreadPurged(envelope.payload);
        if (purged.mode === "work" || purged.mode === "code") {
          const ref: ReplayableRunCaseThreadRef = {
            mode: purged.mode,
            threadId: String(purged.threadId),
          };
          this.#purged.set(`${ref.mode}:${ref.threadId}`, ref);
        }
      } catch {
        // Ignore malformed retention payloads.
      }
      return;
    }

    if (
      envelope.aggregateType === THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE &&
      envelope.eventName === THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded
    ) {
      let receipt: FinishedReceiptRecorded;
      try {
        receipt = decodeFinishedReceiptRecorded(envelope.payload);
      } catch {
        return;
      }
      const idKey = String(receipt.receiptId);
      if (this.#seenReceiptIds.has(idKey)) return;
      this.#seenReceiptIds.add(idKey);
      const leavesNoTraceAtRecord = this.#untraced.has(`${receipt.mode}:${receipt.threadId}`);
      const modelAtRecord = this.#resolveModelAtRecord(receipt, envelope.globalSequence);
      this.#receipts.push({
        sequence: envelope.globalSequence,
        receipt,
        leavesNoTraceAtRecord,
        ...(modelAtRecord === undefined ? {} : { modelAtRecord }),
      });
    }
  }

  referencedCodeEvidenceIds(): ReadonlyArray<string> {
    const ids = new Set<string>();
    for (const turns of this.#codeTurns.values()) {
      for (const turn of turns) {
        if (turn.promptRef !== undefined) {
          ids.add(turn.promptRef.contentId);
        }
      }
    }
    return [...ids];
  }

  project(options: {
    readonly readCodeEvidence?: CodeEvidenceReader | undefined;
    readonly maxCases?: number | undefined;
  }): ReadonlyArray<ReplayableRunCase> {
    const candidates: ReplayableRunCaseCandidate[] = this.#receipts.map((entry) => {
      const request = this.#resolveInitialRequest(entry.receipt, options.readCodeEvidence);
      const projectName = this.#projects.get(String(entry.receipt.projectId));
      const model =
        entry.modelAtRecord ?? this.#resolveModelAtRecord(entry.receipt, entry.sequence);
      return {
        sequence: entry.sequence,
        receipt: entry.receipt,
        ...(request === undefined ? {} : { request }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(model === undefined ? {} : { model }),
        leavesNoTraceAtRecord: entry.leavesNoTraceAtRecord,
      };
    });

    return projectReplayableRunCases({
      candidates,
      untracedThreads: [...this.#untraced.values()],
      purgedThreads: [...this.#purged.values()],
      maxCases: options.maxCases ?? MAX_REPLAYABLE_RUN_CASES,
    });
  }

  #resolveInitialRequest(
    receipt: FinishedReceiptRecorded,
    readCodeEvidence: CodeEvidenceReader | undefined,
  ): string | undefined {
    if (receipt.mode === "work") {
      const turns = this.#workTurns.get(receipt.threadId);
      if (turns === undefined || turns.length === 0) return undefined;
      const firstUserTurn = turns.find((turn) => !turn.isDelivery) ?? turns[0];
      return firstUserTurn?.prompt;
    }

    const turns = this.#codeTurns.get(receipt.threadId);
    if (turns === undefined || turns.length === 0) return undefined;
    const firstSurviving = turns.find((turn) => !turn.rewound);
    if (firstSurviving === undefined) return undefined;
    if (firstSurviving.inlinePrompt !== undefined) return firstSurviving.inlinePrompt;
    if (firstSurviving.promptRef !== undefined && readCodeEvidence !== undefined) {
      return readCodeEvidence(firstSurviving.promptRef);
    }
    return undefined;
  }

  #resolveModelAtRecord(
    receipt: FinishedReceiptRecorded,
    receiptSequence: number,
  ): ReplayableRunCaseModel | undefined {
    if (receipt.mode === "work") {
      const turns = this.#workTurns.get(receipt.threadId) ?? [];
      if (receipt.turnId !== undefined) {
        const matched = turns.find(
          (turn) => turn.turnId === receipt.turnId && turn.model !== undefined,
        );
        if (matched?.model !== undefined) return matched.model;
      }
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (turn !== undefined && turn.sequence <= receiptSequence && turn.model !== undefined) {
          return turn.model;
        }
      }
      return this.#workThreadModels.get(receipt.threadId);
    }

    const turns = this.#codeTurns.get(receipt.threadId) ?? [];
    if (receipt.turnId !== undefined) {
      const matched = turns.find(
        (turn) => turn.operationId === receipt.turnId && turn.model !== undefined,
      );
      if (matched?.model !== undefined) return matched.model;
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn !== undefined && turn.sequence <= receiptSequence && turn.model !== undefined) {
        return turn.model;
      }
    }
    return this.#codeThreadModels.get(receipt.threadId);
  }
}

/**
 * Rebuildable journal projection of replayable run cases across Work and Code
 * threads. Keeps at most the newest 200 eligible cases, excludes Leave no trace
 * threads, and drops purged threads automatically on rebuild.
 */
export class ReplayableRunCaseStore {
  readonly #journal: Pick<Journal, "replayAggregateType">;
  readonly #readCodeEvidence: CodeEvidenceReader | undefined;
  readonly #maxCases: number | undefined;
  #accumulator = new ReplayableRunCaseAccumulator();

  constructor(options: ReplayableRunCaseStoreOptions) {
    this.#journal = options.journal;
    this.#readCodeEvidence =
      options.readCodeEvidence ??
      (options.connection === undefined
        ? undefined
        : createSqliteCodeEvidenceReader(options.connection));
    this.#maxCases = options.maxCases;
    this.rebuild();
  }

  /** Clear in-memory state and replay the journal idempotently from scratch. */
  rebuild(): void {
    const next = new ReplayableRunCaseAccumulator();
    for (const envelope of replayAggregateTypesInOrder(
      this.#journal,
      REPLAYABLE_RUN_CASE_AGGREGATE_TYPES,
    )) {
      next.apply(envelope);
    }
    this.#accumulator = next;
  }

  /** Apply newly committed journal events live without a full rebuild. */
  onCommittedEvents(events: ReadonlyArray<EventEnvelope>): void {
    for (const envelope of events) {
      this.#accumulator.apply(envelope);
    }
  }

  /** Return at most the newest 200 replayable run cases, ordered newest first. */
  list(): ReadonlyArray<ReplayableRunCase> {
    return this.#accumulator.project({
      readCodeEvidence: this.#readCodeEvidence,
      maxCases: this.#maxCases,
    });
  }
}

interface RawJournalRow {
  readonly global_sequence: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_name: string;
  readonly event_version: number;
  readonly payload_json: string;
}

interface RawCodeEvidenceRow {
  readonly content_id: string;
  readonly body_text: string;
  readonly digest: string;
  readonly byte_length: number;
}

/**
 * Read replayable run cases directly from a host SQLite journal file in
 * read-only mode so running the maintainer replay script never mutates or
 * takes a write lock on a running Octant host's database.
 */
export function readReplayableRunCasesFromDatabase(
  databasePath: string,
  options?: { readonly maxCases?: number | undefined },
): ReadonlyArray<ReplayableRunCase> {
  const connection = openReadOnlySqlite(databasePath);
  try {
    return readReplayableRunCasesFromReadOnlySqlite(connection, options);
  } finally {
    connection.close();
  }
}

function readReplayableRunCasesFromReadOnlySqlite(
  connection: ReadOnlySqliteConnection,
  options?: { readonly maxCases?: number | undefined },
): ReadonlyArray<ReplayableRunCase> {
  const aggregateList = REPLAYABLE_RUN_CASE_AGGREGATE_TYPES.map((type) => `'${type}'`).join(", ");
  const rows = connection.all(
    `SELECT global_sequence, aggregate_type, aggregate_id, event_name, event_version, payload_json
     FROM event_journal
     WHERE aggregate_type IN (${aggregateList})
     ORDER BY global_sequence ASC`,
  ) as ReadonlyArray<RawJournalRow>;

  const accumulator = new ReplayableRunCaseAccumulator();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    accumulator.apply({
      globalSequence: row.global_sequence,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventName: row.event_name,
      eventVersion: row.event_version,
      payload,
    });
  }

  const evidenceIds = accumulator.referencedCodeEvidenceIds();
  const evidenceById = loadReadOnlyCodeEvidenceMap(connection, evidenceIds);
  return accumulator.project({
    readCodeEvidence: (reference) => {
      const row = evidenceById.get(reference.contentId);
      if (row === undefined) return undefined;
      if (row.digest !== reference.digest || row.byte_length !== reference.byteLength) {
        return undefined;
      }
      return row.body_text;
    },
    maxCases: options?.maxCases,
  });
}

/**
 * Read the latest host-recorded finished receipt (and its staleness) for one
 * thread from a SQLite journal in read-only mode. Used by the maintainer replay
 * script to inspect the outcome of a replayed run.
 */
export function readLatestFinishedReceiptFromDatabase(
  databasePath: string,
  threadId: string,
): { readonly receipt: FinishedReceiptRecorded; readonly stale: boolean } | undefined {
  const connection = openReadOnlySqlite(databasePath);
  try {
    const rows = connection.all(
      `SELECT global_sequence, aggregate_type, aggregate_id, event_name, event_version, payload_json
       FROM event_journal
       WHERE aggregate_type IN ('${THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE}', 'code-operation', 'code-file', 'work-turn')
       ORDER BY global_sequence ASC`,
    ) as ReadonlyArray<RawJournalRow>;

    let latest:
      | { readonly sequence: number; readonly receipt: FinishedReceiptRecorded }
      | undefined;
    const fileChanges: FinishedReceiptFileChangeSignal[] = [];

    for (const row of rows) {
      if (row.event_version !== 1) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (
        row.aggregate_type === THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE &&
        row.event_name === THREAD_FINISHED_RECEIPT_EVENT_NAMES.recorded &&
        row.aggregate_id === threadId
      ) {
        try {
          const receipt = decodeFinishedReceiptRecorded(payload);
          latest = { sequence: row.global_sequence, receipt };
        } catch {
          continue;
        }
        continue;
      }

      if (latest === undefined) continue;
      const change = classifyThreadFileChange(
        row.aggregate_type,
        row.event_name,
        payload,
        threadId,
      );
      if (change !== undefined) {
        fileChanges.push({
          sequence: row.global_sequence,
          ...(change.turnId === undefined ? {} : { turnId: change.turnId }),
        });
      }
    }

    if (latest === undefined) return undefined;
    const stale = isReceiptStaleAfterJournalEvents({
      receiptSequence: latest.sequence,
      receiptTurnId: latest.receipt.turnId,
      fileChanges,
    });
    return { receipt: latest.receipt, stale };
  } finally {
    connection.close();
  }
}

function classifyThreadFileChange(
  aggregateType: string,
  eventName: string,
  payload: unknown,
  threadId: string,
): { readonly turnId?: string } | undefined {
  if (aggregateType === "code-operation" && eventName === "code.operation-event-recorded@1") {
    const frame = asRecord(payload);
    if (readStringField(frame, "threadId") !== threadId) return undefined;
    const event = asRecord(frame?.event);
    if (event === undefined) return undefined;
    if (event.kind === "file-change" || event.kind === "diff") return {};
    if (event.kind === "conversation-turn-changed-files") {
      const changed = asRecord(event.changedFiles);
      const total = typeof changed?.total === "number" ? changed.total : 0;
      if (total > 0 || changed?.truncated === true) {
        const operationId = readStringField(frame, "operationId");
        return operationId === undefined ? {} : { turnId: operationId };
      }
    }
    return undefined;
  }
  if (aggregateType === "code-file" && eventName === "code.file-reference-updated@1") {
    const frame = asRecord(payload);
    const file = asRecord(frame?.file);
    if (
      frame?.kind === "file-reference-updated" &&
      file?.state === "completed" &&
      readStringField(file, "threadId") === threadId
    ) {
      return {};
    }
    return undefined;
  }
  if (aggregateType === "work-turn" && eventName === "work.turn-updated@1") {
    const updated = asRecord(payload);
    if (readStringField(updated, "threadId") !== threadId) return undefined;
    const wroteFiles = asRecord(updated?.wroteFiles);
    const paths = Array.isArray(wroteFiles?.paths) ? wroteFiles.paths : [];
    if (paths.length > 0 || wroteFiles?.truncated === true) {
      const turnId = readStringField(updated, "turnId");
      return turnId === undefined ? {} : { turnId };
    }
    return undefined;
  }
  return undefined;
}

function createSqliteCodeEvidenceReader(connection: SqliteConnection): CodeEvidenceReader {
  let statement: ReturnType<SqliteConnection["prepare"]> | undefined;
  return (reference) => {
    try {
      statement ??= connection.prepare(
        `SELECT body_text, digest, byte_length
         FROM code_evidence_content_store
         WHERE content_id = ?`,
      );
      const row = statement.get(reference.contentId) as
        | { readonly body_text: string; readonly digest: string; readonly byte_length: number }
        | undefined;
      if (row === undefined) return undefined;
      if (row.digest !== reference.digest || row.byte_length !== reference.byteLength) {
        return undefined;
      }
      return row.body_text;
    } catch {
      return undefined;
    }
  };
}

const SAFE_CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function loadReadOnlyCodeEvidenceMap(
  connection: ReadOnlySqliteConnection,
  contentIds: ReadonlyArray<string>,
): ReadonlyMap<string, RawCodeEvidenceRow> {
  const safeIds = contentIds.filter((id) => SAFE_CONTENT_ID_PATTERN.test(id));
  if (safeIds.length === 0) return new Map();
  const map = new Map<string, RawCodeEvidenceRow>();
  const batchSize = 200;
  try {
    for (let offset = 0; offset < safeIds.length; offset += batchSize) {
      const batch = safeIds.slice(offset, offset + batchSize);
      const inClause = batch.map((id) => `'${id}'`).join(", ");
      const rows = connection.all(
        `SELECT content_id, body_text, digest, byte_length
         FROM code_evidence_content_store
         WHERE content_id IN (${inClause})`,
      ) as ReadonlyArray<RawCodeEvidenceRow>;
      for (const row of rows) {
        map.set(row.content_id, row);
      }
    }
  } catch {
    // Older or minimal test databases may not have code_evidence_content_store.
  }
  return map;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value);
  const candidate = record?.[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractModel(
  record: Record<string, unknown> | undefined,
): ReplayableRunCaseModel | undefined {
  const providerRaw = readStringField(record, "providerInstanceId");
  const modelRaw = readStringField(record, "modelId");
  if (providerRaw === undefined || modelRaw === undefined) return undefined;
  try {
    return {
      providerInstanceId: decodeProviderInstanceId(providerRaw),
      modelId: decodeProviderModelId(modelRaw),
    };
  } catch {
    return undefined;
  }
}

function extractCodeEvidenceReference(value: unknown): CodePromptEvidenceReference | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const contentId = readStringField(record, "contentId");
  const digest = readStringField(record, "digest");
  const byteLength = typeof record.byteLength === "number" ? record.byteLength : undefined;
  if (
    contentId === undefined ||
    digest === undefined ||
    byteLength === undefined ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return undefined;
  }
  return { contentId, digest, byteLength };
}
