import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CodeOperationEventFrame,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_CONVERSATION_ASSISTANT_PARTS,
  MAX_CODE_CONVERSATION_TURN_STEPS,
  MAX_CODE_FORK_MERGE_BACKS_PER_TURN,
  CorrelationId,
  EventActor,
  EventId,
  UtcTimestamp,
  decodeCodeOperationEventFrame,
  decodeCodeConversationPage,
  decodeCodeConversationWindow,
  decodeCodeConversationWindowRequest,
  decodeCodeOperationId,
  decodeCodeThreadId,
  type CodeOperationEvent,
  type EventEnvelope,
  type CodeConversationPage,
  type CodeConversationTurnUsage,
  type CodeConversationUsageTotals,
  type CodeConversationWindow,
  type CodeConversationWindowRequest,
  type CodeConversationStep,
  type CodeConversationTurn,
  type CodeConversationTurnHandoff,
  type CodeForkMergeBack,
  type CodeProviderLimit,
  type CodeOperationId,
  type CodeThreadId,
  type ProviderContextBreakdown,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@octant/contracts";
import { foldCodeTurnUsage } from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

export const CODE_OPERATION_EVENT_RECORDED = "code.operation-event-recorded@1";
export const MAX_CODE_OPERATION_REPLAY_LIMIT = 256;

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
/**
 * Ceiling on envelopes decoded for one read, counting only the requested
 * stream's own events (the thread's, or the operation's). It exists so a
 * hostile or corrupt journal cannot pin the CPU, not to ration honest history:
 * an earlier global bound counted every envelope in the journal, and a real
 * dogfooding host at ~22k events — 94% of them code-checkout observations —
 * failed every thread's history read without touching a conversation event.
 * 100k own events is far past any observed thread while still bounding a
 * hostile stream's decode work.
 */
const MAX_STREAM_SCAN_EVENTS = 100_000;
/**
 * How many decoded frames, across threads, the stores on one journal keep between history
 * reads. The board, the sidebar's pull-request join, and child observations
 * each read whole thread histories every few seconds while a window is open,
 * and decoding a 2,000-turn thread's 28,000 frames again for every read held
 * the event loop for 0.7 to 1.6 s at a time on a loaded machine. A remembered
 * frame measured about 425 bytes, so this bound (one thread at the scan
 * ceiling) holds the memory near 45 MB; past it the least recently read
 * threads are decoded afresh on their next read.
 */
const MAX_REMEMBERED_HISTORY_FRAMES = MAX_STREAM_SCAN_EVENTS;
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

type JournalPort = Pick<
  Journal,
  | "append"
  | "replayAggregate"
  | "replayAggregateTypeForThread"
  | "aggregateTypeThreadHead"
  | "replayThreadAnchoredRows"
  | "latestThreadEvents"
  | "latestThreadResults"
  | "latestThreadEventPerAggregate"
  | "firstAggregateEvent"
>;

export class CodeOperationEventStoreError extends Error {
  override readonly name = "CodeOperationEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CodeOperationEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface CodeOperationEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendCodeOperationEventInput {
  readonly threadId: CodeThreadId;
  readonly operationId: CodeOperationId;
  readonly expectedCursor: number;
  readonly event: CodeOperationEvent;
}

export interface ReplayCodeOperationEventsInput {
  readonly threadId: CodeThreadId;
  readonly operationId: CodeOperationId;
  readonly afterCursor: number;
  readonly limit: number;
}

/** One read's worth of fork merges; a thread with more is refused, not truncated. */
const MAX_FORK_CONTEXT_MERGE_RECORDS = 1_000;
/** One read's worth of session records; a thread with more is refused, not truncated. */
const MAX_SESSION_READY_RECORDS = 1_000;

export interface ReadCodeConversationInput {
  readonly threadId: CodeThreadId;
  readonly afterCursor: number;
  readonly limit: number;
  /**
   * The provider the thread is bound to now, supplied by the caller that can
   * read the thread projection. Only limits this provider reported are current;
   * without it the page falls back to the newest turn's provider, which is all
   * a replay-only caller can know.
   */
  readonly providerInstanceId?: ProviderInstanceId;
}

export interface ReadCodeConversationWindowInput {
  readonly threadId: CodeThreadId;
  readonly limit: number;
  readonly before?: CodeOperationId;
  readonly through?: CodeOperationId;
  /** As on the forward page: the provider the thread is bound to now. */
  readonly providerInstanceId?: ProviderInstanceId;
}

/** A window, or the refusal of an anchor that is not a turn of this thread. */
export type CodeConversationWindowRead =
  | { readonly status: "ok"; readonly window: CodeConversationWindow }
  | { readonly status: "anchor-not-found" };

/**
 * How many bytes of encoded turns one window may carry before it stops adding
 * turns. A turn carries references rather than text, but up to 256 reply parts
 * and 64 summarized steps, so a full page of 100 could otherwise near the
 * 8 MiB a paired device's response is cut at.
 */
export const CODE_CONVERSATION_WINDOW_BYTES = 2 * 1024 * 1024;
/** The newest usage-limit reports the newest window reads for the current provider's limits. */
const MAX_WINDOW_LIMIT_REPORTS = 256;
/** Restore results read per batch while looking for the newest one that ran. */
const MAX_RESTORE_RESULTS_PER_READ = 64;

export type CodeOperationEventReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<typeof CodeOperationEventFrame.Type>;
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

/** A thread's decoded history as of its newest row, and how many rows it read. */
interface RememberedHistory {
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly frames: ReadonlyArray<typeof CodeOperationEventFrame.Type>;
}

/**
 * The remembered histories of one journal, shared by every store built on it:
 * the host builds one store for the board and another inside the Code runtime,
 * and each keeping its own copy would double the frame bound. Least recently
 * read first.
 */
interface RememberedHistories {
  readonly byThread: Map<string, RememberedHistory>;
  frames: number;
}
const rememberedHistoriesByJournal = new WeakMap<JournalPort, RememberedHistories>();

function rememberedHistoriesFor(journal: JournalPort): RememberedHistories {
  let remembered = rememberedHistoriesByJournal.get(journal);
  if (remembered === undefined) {
    remembered = { byThread: new Map(), frames: 0 };
    rememberedHistoriesByJournal.set(journal, remembered);
  }
  return remembered;
}

export class CodeOperationEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #histories: RememberedHistories;

  constructor(options: CodeOperationEventStoreOptions) {
    this.#journal = options.journal;
    this.#histories = rememberedHistoriesFor(options.journal);
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event actor is invalid.");
    }
  }

  append(input: AppendCodeOperationEventInput): typeof CodeOperationEventFrame.Type {
    let frame: typeof CodeOperationEventFrame.Type;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const operationId = decodeCodeOperationId(input.operationId);
      const threadId = decodeCodeThreadId(input.threadId);
      expectedVersion = decodeAggregateVersion(input.expectedCursor);
      aggregateId = decodeAggregateId(operationId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeCodeOperationEventFrame({
        threadId,
        operationId,
        cursor: input.expectedCursor + 1,
        occurredAt: decodeTimestamp(this.#clock()),
        event: input.event,
      });
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event append is invalid.");
    }

    const committed = this.#journal.append({
      aggregate: { aggregateType: "code-operation", aggregateId },
      expectedVersion,
      events: [
        {
          eventId,
          eventName: CODE_OPERATION_EVENT_RECORDED,
          eventVersion: 1,
          correlationId,
          actor: this.#actor,
          occurredAt: frame.occurredAt,
          payload: frame,
        },
      ],
    });
    const envelope = committed.events[0];
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "code-operation" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== frame.cursor ||
      envelope.eventName !== CODE_OPERATION_EVENT_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new CodeOperationEventStoreError(
        "journal-mismatch",
        "Committed Code operation event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayCodeOperationEventsInput): CodeOperationEventReplay {
    let threadId: CodeThreadId;
    let operationId: CodeOperationId;
    try {
      threadId = decodeCodeThreadId(input.threadId);
      operationId = decodeCodeOperationId(input.operationId);
      if (
        !Number.isSafeInteger(input.afterCursor) ||
        input.afterCursor < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_CODE_OPERATION_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code operation event replay is invalid.");
    }

    const frames: Array<typeof CodeOperationEventFrame.Type> = [];
    let expectedCursor = 1;
    let afterVersion = 0;
    let scannedEvents = 0;

    while (frames.length < input.limit) {
      const batch = this.#journal.replayAggregate({
        aggregateType: "code-operation",
        aggregateId: String(operationId),
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        scannedEvents += 1;
        if (scannedEvents > MAX_STREAM_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.operationId !== operationId || frame.threadId !== threadId) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        if (frame.cursor !== expectedCursor || envelope.aggregateVersion !== frame.cursor) {
          return { status: "snapshot-required", reason: "gap" };
        }
        expectedCursor += 1;
        if (frame.cursor > input.afterCursor) frames.push(frame);
        if (frames.length === input.limit) break;
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    if (input.afterCursor >= expectedCursor) {
      return { status: "snapshot-required", reason: "cursor-ahead" };
    }
    return {
      status: "ok",
      frames,
      nextCursor: frames.at(-1)?.cursor ?? input.afterCursor,
    };
  }

  /** Indexed journal reads decode at most eleven frames, regardless of transcript size. */
  /**
   * The provider conversation each turn of a thread ran on, by operation: the
   * resume cursor value its `provider-session-ready` recorded. A turn the
   * provider never acquired a session for is absent. Undefined when the
   * thread holds more of those records than one read returns, or a record
   * does not decode, because a partial map would place a turn wrongly.
   */
  providerConversationsOfTurns(threadId: CodeThreadId): ReadonlyMap<string, string> | undefined {
    try {
      const envelopes = this.#journal.latestThreadEvents({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "provider-session-ready",
        limit: MAX_SESSION_READY_RECORDS,
      });
      if (envelopes.length >= MAX_SESSION_READY_RECORDS) return undefined;
      const conversations = new Map<string, string>();
      for (const envelope of envelopes) {
        if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1)
          return undefined;
        const frame = decodeCodeOperationEventFrame(envelope.payload);
        if (String(frame.threadId) !== String(threadId)) return undefined;
        if (frame.event.kind !== "provider-session-ready") continue;
        const cursor = frame.event.resumeCursor;
        if (cursor !== undefined) conversations.set(String(frame.operationId), cursor.value);
      }
      return conversations;
    } catch {
      return undefined;
    }
  }

  /**
   * How full a provider session's window was at the thread's latest usage
   * report: the occupancy the provider reported, or else the input its last
   * request carried, which is what the window held then. Undefined when that
   * report came from a turn on another session (a switch, or a fresh session
   * whose turns reported nothing yet), when no turn reported usage, or when a
   * record does not decode.
   */
  latestWindowOccupancy(
    threadId: CodeThreadId,
    sessionId: ProviderSessionId,
  ): { readonly tokens: number; readonly observedAt: string } | undefined {
    try {
      const envelope = this.#journal.latestThreadEvents({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "usage",
        limit: 1,
      })[0];
      if (
        envelope === undefined ||
        envelope.eventName !== CODE_OPERATION_EVENT_RECORDED ||
        envelope.eventVersion !== 1
      )
        return undefined;
      const frame = decodeCodeOperationEventFrame(envelope.payload);
      if (String(frame.threadId) !== String(threadId) || frame.event.kind !== "usage")
        return undefined;
      const sessionReady = this.#journal
        .latestThreadEvents({
          aggregateType: "code-operation",
          threadId: String(threadId),
          kind: "provider-session-ready",
          limit: MAX_SESSION_READY_RECORDS,
        })
        .map((ready) => decodeCodeOperationEventFrame(ready.payload))
        .find((ready) => String(ready.operationId) === String(frame.operationId));
      if (
        sessionReady?.event.kind !== "provider-session-ready" ||
        String(sessionReady.event.sessionId) !== String(sessionId)
      )
        return undefined;
      return {
        tokens: frame.event.contextTokens ?? frame.event.inputTokens,
        observedAt: frame.occurredAt,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * The newest fork conversations merged back into a thread, oldest first, and
   * the merge its turns last carried. Merges are carried in the order they were
   * made, so every merge after that one is still waiting for a turn. The read
   * covers the newest merges only; `complete` says whether it holds them all.
   * Undefined when a record does not decode or the waiting merges are not all
   * within the read, because a partial list would deliver a merge twice or
   * never. A merge is refused while too many wait, so the waiting ones always
   * fit.
   */
  forkContextMerges(threadId: CodeThreadId):
    | {
        readonly merges: ReadonlyArray<{
          readonly operationId: CodeOperationId;
          readonly event: Extract<CodeOperationEvent, { readonly kind: "fork-context-merged" }>;
        }>;
        readonly lastDeliveredOperationId?: CodeOperationId;
        readonly complete: boolean;
      }
    | undefined {
    try {
      const read = (kind: string, limit: number) =>
        this.#journal
          .latestThreadEvents({
            aggregateType: "code-operation",
            threadId: String(threadId),
            kind,
            limit,
          })
          .map((envelope) => {
            if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1)
              throw new Error("unknown record");
            const frame = decodeCodeOperationEventFrame(envelope.payload);
            if (
              String(frame.threadId) !== String(threadId) ||
              String(frame.operationId) !== String(envelope.aggregateId)
            )
              throw new Error("foreign record");
            return frame;
          });
      const merged = read("fork-context-merged", MAX_FORK_CONTEXT_MERGE_RECORDS);
      const complete = merged.length < MAX_FORK_CONTEXT_MERGE_RECORDS;
      const merges = merged
        .flatMap((frame) =>
          frame.event.kind === "fork-context-merged"
            ? [{ operationId: frame.operationId, event: frame.event }]
            : [],
        )
        .reverse();
      const delivered = read("fork-context-delivered", 1)[0]?.event;
      if (delivered?.kind !== "fork-context-delivered")
        return complete ? { merges, complete } : undefined;
      if (!merges.some((merge) => String(merge.operationId) === String(delivered.mergeOperationId)))
        return undefined;
      return { merges, lastDeliveredOperationId: delivered.mergeOperationId, complete };
    } catch {
      return undefined;
    }
  }

  providerSessionForThread(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
  ):
    | {
        readonly status: "ok";
        readonly priorTurn: boolean;
        readonly priorTurnSettled: boolean;
        readonly session?: Extract<CodeOperationEvent, { readonly kind: "provider-session-ready" }>;
        /**
         * What fills the window, from the last usage report of the prior turn.
         * Absent when that turn reported none or the report said nothing of it.
         */
        readonly priorTurnBreakdown?: ProviderContextBreakdown;
        /**
         * Where that report sits in the journal; present with the breakdown.
         * A compaction journaled after it is ordered by this, not by clocks.
         */
        readonly priorTurnReportSequence?: number;
      }
    | { readonly status: "rebuild-required" } {
    try {
      const recorded = (kind: string, limit: number) =>
        this.#journal
          .latestThreadEvents({
            aggregateType: "code-operation",
            threadId: String(threadId),
            kind,
            limit,
          })
          .map((envelope) => {
            if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1)
              throw new CodeOperationEventStoreError(
                "journal-mismatch",
                "Session event schema is unavailable.",
              );
            const frame = decodeCodeOperationEventFrame(envelope.payload);
            if (
              String(frame.threadId) !== String(threadId) ||
              String(frame.operationId) !== String(envelope.aggregateId)
            )
              throw new CodeOperationEventStoreError(
                "journal-mismatch",
                "Session event ownership differs.",
              );
            return { frame, globalSequence: envelope.globalSequence };
          });
      const read = (kind: string, limit: number) =>
        recorded(kind, limit).map((entry) => entry.frame);
      const session = read("provider-session-ready", 1)[0]?.event;
      const priorStart = read("conversation-turn-started", 2).find(
        (frame) => String(frame.operationId) !== String(operationId),
      );
      // A prior turn counts as settled once its own operation-result left a
      // terminal state; a `running` (or absent) record means it never reached
      // its provider launch, so a different operation cannot start fresh
      // without losing that turn's journaled prompt.
      const priorTurnSettled =
        priorStart !== undefined &&
        read("operation-result", 8).some(
          (frame) =>
            String(frame.operationId) === String(priorStart.operationId) &&
            frame.event.kind === "operation-result" &&
            (frame.event.result.kind !== "provider-turn-state" ||
              (frame.event.result.state !== "running" && frame.event.result.state !== "waiting")),
        );
      const priorUsageRecord = recorded("usage", 1)[0];
      const priorUsage = priorUsageRecord?.frame;
      const priorTurnBreakdown =
        priorStart !== undefined &&
        priorUsage !== undefined &&
        String(priorUsage.operationId) === String(priorStart.operationId) &&
        priorUsage.event.kind === "usage"
          ? priorUsage.event.contextBreakdown
          : undefined;
      return {
        status: "ok",
        priorTurn: priorStart !== undefined,
        priorTurnSettled,
        ...(session?.kind === "provider-session-ready" ? { session } : {}),
        ...(priorTurnBreakdown === undefined || priorUsageRecord === undefined
          ? {}
          : { priorTurnBreakdown, priorTurnReportSequence: priorUsageRecord.globalSequence }),
      };
    } catch {
      return { status: "rebuild-required" };
    }
  }

  /**
   * Collect every Code operation event frame for one thread in journal order.
   * Used by the Code Thread Board metadata projection (#12B/#12C). A scan-limit
   * or invalid frame forces `rebuild-required` so the board never fabricates a
   * Done status from a truncated history.
   */
  historyForThread(threadIdInput: CodeThreadId):
    | {
        readonly status: "ok";
        readonly frames: ReadonlyArray<typeof CodeOperationEventFrame.Type>;
      }
    | {
        readonly status: "rebuild-required";
      } {
    let threadId: CodeThreadId;
    try {
      threadId = decodeCodeThreadId(threadIdInput);
    } catch {
      return { status: "rebuild-required" };
    }

    // A thread's rows are only ever appended, until a purge removes them. So
    // a remembered history is current while the slice's size and newest row
    // match it, is extended by reading only the rows after it while it is
    // still a whole prefix of the slice, and is read afresh otherwise.
    const key = String(threadId);
    const head = this.#journal.aggregateTypeThreadHead({
      aggregateType: "code-operation",
      threadId: key,
    });
    if (head.eventCount > MAX_STREAM_SCAN_EVENTS) {
      this.#forget(key);
      return { status: "rebuild-required" };
    }
    const remembered = this.#histories.byThread.get(key);
    if (
      remembered !== undefined &&
      remembered.lastSequence === head.lastSequence &&
      remembered.eventCount === head.eventCount
    ) {
      this.#remember(key, remembered);
      return { status: "ok", frames: remembered.frames };
    }
    let read =
      remembered !== undefined && remembered.lastSequence < head.lastSequence
        ? this.#readHistory(threadId, remembered)
        : undefined;
    if (read === undefined || (read.status === "ok" && read.eventCount !== head.eventCount)) {
      read = this.#readHistory(threadId, undefined);
    }
    if (read.status !== "ok") {
      this.#forget(key);
      return read;
    }
    this.#remember(key, read);
    return { status: "ok", frames: read.frames };
  }

  #readHistory(
    threadId: CodeThreadId,
    from: RememberedHistory | undefined,
  ): ({ readonly status: "ok" } & RememberedHistory) | { readonly status: "rebuild-required" } {
    const frames: Array<typeof CodeOperationEventFrame.Type> = [...(from?.frames ?? [])];
    let afterSequence = from?.lastSequence ?? 0;
    let scannedEvents = from?.eventCount ?? 0;

    for (;;) {
      const batch = this.#journal.replayAggregateTypeForThread({
        aggregateType: "code-operation",
        threadId: String(threadId),
        afterSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_STREAM_SCAN_EVENTS) {
          return { status: "rebuild-required" };
        }
        if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1) {
          continue;
        }
        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          return { status: "rebuild-required" };
        }
        if (
          String(frame.operationId) !== String(envelope.aggregateId) ||
          frame.cursor !== envelope.aggregateVersion
        ) {
          return { status: "rebuild-required" };
        }
        if (frame.threadId === threadId) {
          frames.push(frame);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    return { status: "ok", lastSequence: afterSequence, eventCount: scannedEvents, frames };
  }

  #remember(key: string, history: RememberedHistory): void {
    this.#forget(key);
    const histories = this.#histories;
    histories.byThread.set(key, history);
    histories.frames += history.frames.length;
    for (const [oldestKey, oldest] of histories.byThread) {
      if (histories.frames <= MAX_REMEMBERED_HISTORY_FRAMES || oldestKey === key) break;
      histories.byThread.delete(oldestKey);
      histories.frames -= oldest.frames.length;
    }
  }

  #forget(key: string): void {
    const remembered = this.#histories.byThread.get(key);
    if (remembered === undefined) return;
    this.#histories.byThread.delete(key);
    this.#histories.frames -= remembered.frames.length;
  }

  conversation(input: ReadCodeConversationInput): CodeConversationPage {
    let threadId: CodeThreadId;
    try {
      threadId = decodeCodeThreadId(input.threadId);
      if (
        !Number.isSafeInteger(input.afterCursor) ||
        input.afterCursor < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_CODE_CONVERSATION_PAGE_SIZE
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code conversation request is invalid.");
    }

    const turns: Array<CodeConversationBuilder> = [];
    const byOperation = new Map<string, CodeConversationBuilder>();
    const limits = new Map<
      string,
      { readonly providerInstanceId: string; readonly limit: CodeProviderLimit }
    >();
    let afterSequence = 0;
    let scannedEvents = 0;
    let hasMore = false;
    // The way back from this thread's last restore. A restore is its own
    // operation with no conversation turn of its own, so it is read straight
    // from the journal rather than folded into a turn.
    let restoreUndo: CodeConversationPage["restoreUndo"];

    for (;;) {
      // The page folds only turn operations and restores, so SQL hands back
      // just those: every event of an operation that started a turn (any of
      // them moves the turn's `updatedAt`) and every restore result. Terminal
      // attaches, test runs, and other operations never reach the decoder. The
      // scan bound below therefore counts decoded rows, as it always meant to:
      // it guards decode work, and rows SQL leaves out cost none, so counting
      // them would fail an honest thread's read on traffic it never uses.
      const batch = this.#journal.replayThreadAnchoredRows({
        aggregateType: "code-operation",
        threadId: String(threadId),
        anchorKind: "conversation-turn-started",
        resultKind: "git-mutation-state",
        afterSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_STREAM_SCAN_EVENTS) {
          throw new CodeOperationEventStoreError(
            "invalid",
            "Code conversation exceeds the bounded replay window.",
          );
        }
        if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1) {
          continue;
        }
        let frame: typeof CodeOperationEventFrame.Type;
        try {
          frame = decodeCodeOperationEventFrame(envelope.payload);
        } catch {
          continue;
        }
        if (
          String(frame.operationId) !== String(envelope.aggregateId) ||
          frame.cursor !== envelope.aggregateVersion
        ) {
          continue;
        }
        const key = String(frame.operationId);
        if (
          frame.threadId === threadId &&
          frame.event.kind === "conversation-turn-started" &&
          envelope.globalSequence > input.afterCursor
        ) {
          if (turns.length === input.limit) {
            hasMore = true;
            continue;
          }
          const builder = startTurn(envelope.globalSequence, {
            ...frame,
            event: frame.event,
          });
          turns.push(builder);
          byOperation.set(key, builder);
          continue;
        }
        if (
          frame.threadId === threadId &&
          frame.event.kind === "operation-result" &&
          frame.event.result.kind === "git-mutation-state" &&
          frame.event.result.mutation === "restore-checkpoint"
        ) {
          // Only the newest restore is undoable: undoing is itself a restore,
          // and its own undo point is what one more step back means. A restore
          // that replaced nothing carries none, which retracts the offer rather
          // than leaving an older one pointing at a state that has since moved.
          // A rejected restore is refused before the checkout is touched, so
          // the way back from the last restore that did run is still valid and
          // still points at a state the checkout actually left. Only a restore
          // that ran replaces it — completed, or failed after it may already
          // have moved files.
          if (frame.event.result.state !== "rejected") {
            restoreUndo = frame.event.result.undo;
          }
        }
        const builder = byOperation.get(key);
        if (builder === undefined || frame.threadId !== threadId) continue;
        const limit = foldTurnFrame(builder, frame);
        if (limit !== undefined) {
          // Window names are the provider's own, so two providers routinely
          // report the same one. Keying by name alone lets a thread that
          // changed providers show the previous account's remaining quota as
          // the current one's, decided by nothing but journal order.
          limits.set(`${limit.providerInstanceId}\n${limit.limit.window}`, limit);
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    // Only the provider the thread is on now can speak for the account the page
    // reports. A limit an earlier provider left behind is history, not a
    // remaining quota, so it is dropped rather than relabelled. The thread's
    // selection decides that, not the newest turn: a thread whose provider was
    // just changed has not run a turn on the new one yet, and following the
    // turn would report the account the user already left.
    const currentProviderInstanceId = String(
      input.providerInstanceId ?? turns.at(-1)?.providerInstanceId ?? "",
    );
    const currentLimits = [...limits.values()]
      .filter((entry) => entry.providerInstanceId === currentProviderInstanceId)
      .map((entry) => entry.limit);

    return decodeCodeConversationPage({
      version: 3,
      threadId,
      turns: turns.map(finishTurn),
      nextCursor: turns.at(-1)?.startCursor ?? input.afterCursor,
      hasMore,
      ...(currentLimits.length === 0 ? {} : { limits: currentLimits.slice(0, 8) }),
      ...(restoreUndo === undefined ? {} : { restoreUndo }),
    });
  }

  /**
   * One page of a thread's own turns for a client that opens on its newest
   * turns: the newest `limit`, or those just `before` a turn, or the page that
   * ends `through` one. It never scans the thread from its start. The turn
   * starts are read newest first from the thread-kind index, each page turn's
   * own frames are read through its operation's index, and the usage of every
   * older turn is folded from one read of each turn's last report. That read
   * walks every usage report of the thread through the thread-kind index and
   * decodes one per older turn that reported any, so a page costs its own
   * turns plus that walk and those decodes. The
   * newest page adds the current provider's limits from the thread's newest
   * limit reports and the way back from its newest restore that ran.
   */
  conversationWindow(input: ReadCodeConversationWindowInput): CodeConversationWindowRead {
    let threadId: CodeThreadId;
    let request: CodeConversationWindowRequest;
    try {
      threadId = decodeCodeThreadId(input.threadId);
      request = decodeCodeConversationWindowRequest({
        limit: input.limit,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.through === undefined ? {} : { through: input.through }),
      });
    } catch {
      throw new CodeOperationEventStoreError("invalid", "Code conversation request is invalid.");
    }
    const budget = { decoded: 0 };
    const decode = (envelope: EventEnvelope) => {
      budget.decoded += 1;
      if (budget.decoded > MAX_STREAM_SCAN_EVENTS) {
        throw new CodeOperationEventStoreError(
          "invalid",
          "Code conversation exceeds the bounded replay window.",
        );
      }
      return ownFrame(envelope, threadId);
    };

    const anchorId = request.before ?? request.through;
    let below: number | undefined;
    let anchorSequence: number | undefined;
    if (anchorId !== undefined) {
      const anchor = this.#journal.firstAggregateEvent({
        aggregateType: "code-operation",
        aggregateId: String(anchorId),
        kind: "conversation-turn-started",
      });
      const frame = anchor === undefined ? undefined : decode(anchor);
      if (anchor === undefined || frame?.event.kind !== "conversation-turn-started") {
        return { status: "anchor-not-found" };
      }
      anchorSequence = anchor.globalSequence;
      below = request.before !== undefined ? anchorSequence : anchorSequence + 1;
    }

    // Newest first, one more than the page so the read knows whether the
    // thread holds a turn before it.
    const starts: Array<{
      readonly envelope: EventEnvelope;
      readonly builder: CodeConversationBuilder;
    }> = [];
    let cursor = below;
    for (;;) {
      const wanted = request.limit + 1 - starts.length;
      if (wanted <= 0) break;
      const batch = this.#journal.latestThreadEvents({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "conversation-turn-started",
        limit: wanted,
        ...(cursor === undefined ? {} : { beforeSequence: cursor }),
      });
      for (const envelope of batch) {
        cursor = envelope.globalSequence;
        const frame = decode(envelope);
        if (frame?.event.kind !== "conversation-turn-started") continue;
        starts.push({
          envelope,
          builder: startTurn(envelope.globalSequence, { ...frame, event: frame.event }),
        });
      }
      if (batch.length < wanted) break;
    }

    // A page stops short of its limit rather than pass the byte budget, but
    // always holds the newest turn it reached.
    const turns: Array<CodeConversationTurn> = [];
    let bytes = 0;
    let included = 0;
    for (const { envelope, builder } of starts.slice(0, request.limit)) {
      this.#foldTurn(envelope, builder, decode);
      const turn = finishTurn(builder);
      const size = Buffer.byteLength(JSON.stringify(turn), "utf8");
      if (included > 0 && bytes + size > CODE_CONVERSATION_WINDOW_BYTES) break;
      bytes += size;
      included += 1;
      turns.unshift(turn);
    }
    const hasEarlier = starts.length > included;
    const firstStart = starts[included - 1]?.envelope.globalSequence;

    let hasLater = false;
    if (request.before !== undefined) hasLater = true;
    else if (anchorSequence !== undefined) {
      const newest = this.#journal.latestThreadEvents({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "conversation-turn-started",
        limit: 1,
      })[0];
      hasLater = newest !== undefined && newest.globalSequence > anchorSequence;
    }

    const earlierUsage =
      hasEarlier && firstStart !== undefined
        ? this.#earlierUsage(threadId, firstStart, decode)
        : undefined;

    let limits: ReadonlyArray<CodeProviderLimit> = [];
    let restoreUndo: CodeConversationPage["restoreUndo"];
    if (anchorId === undefined) {
      // As on the forward page, the thread's selection decides whose limits
      // are current; without it, the newest turn's provider.
      const current = String(input.providerInstanceId ?? turns.at(-1)?.providerInstanceId ?? "");
      limits = this.#currentLimits(threadId, current, starts, decode);
      restoreUndo = this.#newestRestoreUndo(threadId, decode);
    }

    return {
      status: "ok",
      window: decodeCodeConversationWindow({
        version: 1,
        threadId,
        turns,
        hasEarlier,
        hasLater,
        ...(earlierUsage === undefined ? {} : { earlierUsage }),
        ...(limits.length === 0 ? {} : { limits: limits.slice(0, 8) }),
        ...(restoreUndo === undefined ? {} : { restoreUndo }),
      }),
    };
  }

  /**
   * Fold a turn's own frames after its start, read through its operation's
   * index. A second start in the same operation ends the turn, because the
   * forward page gives every later frame to that newer start.
   */
  #foldTurn(
    start: EventEnvelope,
    builder: CodeConversationBuilder,
    decode: (envelope: EventEnvelope) => typeof CodeOperationEventFrame.Type | undefined,
  ): void {
    let afterVersion = start.aggregateVersion;
    for (;;) {
      const batch = this.#journal.replayAggregate({
        aggregateType: "code-operation",
        aggregateId: start.aggregateId,
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        const frame = decode(envelope);
        if (frame === undefined) continue;
        if (frame.event.kind === "conversation-turn-started") return;
        // Limits are thread state the newest page reads on its own.
        foldTurnFrame(builder, frame);
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) return;
    }
  }

  /**
   * The usage of every turn that started before `firstStart`, folded as the
   * client totals it: each turn's last report once, in the order the turns
   * started.
   */
  #earlierUsage(
    threadId: CodeThreadId,
    firstStart: number,
    decode: (envelope: EventEnvelope) => typeof CodeOperationEventFrame.Type | undefined,
  ): CodeConversationUsageTotals | undefined {
    const usages: Array<CodeConversationTurnUsage> = [];
    let afterAnchorSequence = 0;
    for (;;) {
      // In turn order, so the window figures are the newest older turn's
      // even when its report landed before an older turn's last one.
      const batch = this.#journal.latestThreadEventPerAggregate({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "usage",
        anchorKind: "conversation-turn-started",
        anchorBeforeSequence: firstStart,
        afterAnchorSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      for (const { anchorSequence, event } of batch) {
        afterAnchorSequence = anchorSequence;
        const frame = decode(event);
        if (frame?.event.kind !== "usage") continue;
        usages.push(turnUsage(frame.event));
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return foldCodeTurnUsage(undefined, usages);
  }

  /**
   * The newest report per usage window from the thread's newest limit
   * reports, kept only where the turn that reported it ran on the current
   * provider, in the order the windows were first reported. A turn the page
   * already folded names its provider; any other is read from its start.
   */
  #currentLimits(
    threadId: CodeThreadId,
    currentProviderInstanceId: string,
    starts: ReadonlyArray<{ readonly builder: CodeConversationBuilder }>,
    decode: (envelope: EventEnvelope) => typeof CodeOperationEventFrame.Type | undefined,
  ): ReadonlyArray<CodeProviderLimit> {
    const providerOf = new Map<string, string>(
      starts.map(({ builder }) => [
        String(builder.operationId),
        String(builder.providerInstanceId),
      ]),
    );
    const reports = this.#journal
      .latestThreadEvents({
        aggregateType: "code-operation",
        threadId: String(threadId),
        kind: "provider-limit",
        limit: MAX_WINDOW_LIMIT_REPORTS,
      })
      .toReversed();
    const limits = new Map<string, CodeProviderLimit>();
    for (const envelope of reports) {
      const frame = decode(envelope);
      if (frame?.event.kind !== "provider-limit") continue;
      const operation = String(frame.operationId);
      let provider = providerOf.get(operation);
      if (provider === undefined) {
        const start = this.#journal.firstAggregateEvent({
          aggregateType: "code-operation",
          aggregateId: operation,
          kind: "conversation-turn-started",
        });
        const started = start === undefined ? undefined : decode(start);
        // A report from an operation that never started a turn of this
        // thread belongs to no turn, and the forward page never shows it.
        provider =
          started?.event.kind === "conversation-turn-started" &&
          start !== undefined &&
          start.globalSequence < envelope.globalSequence
            ? String(started.event.providerInstanceId)
            : "";
        providerOf.set(operation, provider);
      }
      if (provider !== currentProviderInstanceId || provider === "") continue;
      limits.set(frame.event.window, {
        window: frame.event.window,
        status: frame.event.status,
        ...(frame.event.utilization === undefined ? {} : { utilization: frame.event.utilization }),
        ...(frame.event.resetsAt === undefined ? {} : { resetsAt: frame.event.resetsAt }),
      });
    }
    return [...limits.values()];
  }

  /**
   * The way back from the thread's newest restore that ran. A rejected
   * restore never touched the checkout, so the read walks past it to the one
   * before; a restore that ran and carried no way back retracts the offer.
   * Only restore results are read, so a thread full of commits and pushes and
   * no restore costs an index walk, not a decode of each of them.
   */
  #newestRestoreUndo(
    threadId: CodeThreadId,
    decode: (envelope: EventEnvelope) => typeof CodeOperationEventFrame.Type | undefined,
  ): CodeConversationPage["restoreUndo"] {
    let beforeSequence: number | undefined;
    for (;;) {
      const batch = this.#journal.latestThreadResults({
        aggregateType: "code-operation",
        threadId: String(threadId),
        resultKind: "git-mutation-state",
        mutation: "restore-checkpoint",
        limit: MAX_RESTORE_RESULTS_PER_READ,
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      });
      for (const envelope of batch) {
        beforeSequence = envelope.globalSequence;
        const frame = decode(envelope);
        if (
          frame?.event.kind === "operation-result" &&
          frame.event.result.kind === "git-mutation-state" &&
          frame.event.result.mutation === "restore-checkpoint" &&
          frame.event.result.state !== "rejected"
        ) {
          return frame.event.result.undo;
        }
      }
      if (batch.length < MAX_RESTORE_RESULTS_PER_READ) return undefined;
    }
  }
}

/** A usage window a turn reported, under the provider the turn ran on. */
interface TurnProviderLimit {
  readonly providerInstanceId: string;
  readonly limit: CodeProviderLimit;
}

/**
 * Fold one of a turn's own frames, after its start, into the turn. The
 * forward page and the window both fold through here, which is what keeps a
 * turn the same whichever read returns it. A usage-window report is account
 * state rather than turn state, so it is handed back to the caller instead.
 */
function foldTurnFrame(
  builder: CodeConversationBuilder,
  frame: typeof CodeOperationEventFrame.Type,
): TurnProviderLimit | undefined {
  builder.updatedAt = frame.occurredAt;
  if (frame.event.kind === "provider-content" && frame.event.channel === "message") {
    if (builder.assistant.length < MAX_CODE_CONVERSATION_ASSISTANT_PARTS) {
      builder.assistant.push(frame.event.content);
    }
  } else if (frame.event.kind === "provider-content") {
    appendStep(builder, { kind: "reasoning", content: frame.event.content });
  } else if (frame.event.kind === "tool-activity") {
    // One row per tool call: a later state for the same call replaces the
    // earlier one instead of adding a step, exactly as the live
    // transcript folds it.
    const toolCallId = String(frame.event.toolCallId);
    const existing = builder.steps.findIndex(
      (step) => step.kind === "tool" && String(step.toolCallId) === toolCallId,
    );
    const step = {
      kind: "tool" as const,
      toolCallId: frame.event.toolCallId,
      toolName: frame.event.toolName,
      state: frame.event.state,
      ...(frame.event.summary === undefined ? {} : { summary: frame.event.summary }),
    };
    if (existing === -1) appendStep(builder, step);
    else builder.steps[existing] = step;
  } else if (frame.event.kind === "usage") {
    // A provider may report usage more than once in a turn; the last
    // report is the turn's own figure, not a running sum to add to.
    builder.usage = turnUsage(frame.event);
  } else if (frame.event.kind === "provider-limit") {
    return {
      providerInstanceId: String(builder.providerInstanceId),
      limit: {
        window: frame.event.window,
        status: frame.event.status,
        ...(frame.event.utilization === undefined ? {} : { utilization: frame.event.utilization }),
        ...(frame.event.resetsAt === undefined ? {} : { resetsAt: frame.event.resetsAt }),
      },
    };
  } else if (frame.event.kind === "context-handoff-attached") {
    builder.handoff = conversationHandoff(frame.event);
  } else if (frame.event.kind === "fork-context-delivered") {
    const { kind: _kind, mergeOperationId: _merge, ...mergeBack } = frame.event;
    if (builder.forkMergeBacks.length < MAX_CODE_FORK_MERGE_BACKS_PER_TURN)
      builder.forkMergeBacks.push(mergeBack);
  } else if (frame.event.kind === "conversation-turn-changed-files") {
    builder.changedFiles = frame.event.changedFiles;
  } else if (frame.event.kind === "operation-state") {
    builder.status = conversationStatus(frame.event.state);
    if (frame.event.failure !== undefined) builder.failure = frame.event.failure;
  } else if (frame.event.kind === "operation-result") {
    if (frame.event.result.kind === "provider-turn-state") {
      builder.status = conversationStatus(frame.event.result.state);
    } else if (frame.event.result.kind === "operation-failed") {
      builder.status = "failed";
      builder.failure = frame.event.result.failure;
    }
  }
  return undefined;
}

/** A usage report as the turn's own figure. */
function turnUsage(
  event: Extract<CodeOperationEvent, { readonly kind: "usage" }>,
): CodeConversationTurnUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
    ...(event.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: event.cacheReadInputTokens }),
    ...(event.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
    ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
    ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
    ...(event.autoCompactThreshold === undefined
      ? {}
      : { autoCompactThreshold: event.autoCompactThreshold }),
    ...(event.contextBreakdown === undefined ? {} : { contextBreakdown: event.contextBreakdown }),
  };
}

/** A turn's builder from its start frame, before any of its later frames. */
function startTurn(
  startSequence: number,
  frame: typeof CodeOperationEventFrame.Type & {
    readonly event: Extract<CodeOperationEvent, { readonly kind: "conversation-turn-started" }>;
  },
): CodeConversationBuilder {
  return {
    startCursor: startSequence,
    operationId: frame.operationId,
    providerInstanceId: frame.event.providerInstanceId,
    modelId: frame.event.modelId,
    sessionId: frame.event.sessionId,
    prompt: frame.event.prompt,
    ...(frame.event.checkpoint === undefined ? {} : { checkpoint: frame.event.checkpoint }),
    ...(frame.event.executionPolicy === undefined
      ? {}
      : { executionPolicy: frame.event.executionPolicy }),
    assistant: [],
    forkMergeBacks: [],
    steps: [],
    stepsTruncated: false,
    status: "incomplete",
    startedAt: frame.occurredAt,
    updatedAt: frame.occurredAt,
  };
}

/** The turn as a page or a window carries it. */
function finishTurn({
  startCursor: _startCursor,
  steps,
  stepsTruncated,
  forkMergeBacks,
  ...turn
}: CodeConversationBuilder): CodeConversationTurn {
  return {
    ...turn,
    ...(forkMergeBacks.length === 0 ? {} : { forkMergeBacks }),
    ...(steps.length === 0 ? {} : { steps }),
    ...(stepsTruncated ? { stepsTruncated: true } : {}),
  };
}

/**
 * The Code operation frame a journal row holds, when it is one this thread's
 * reads may fold: a known record whose frame names the row's own operation
 * and version and this thread. Any other row is left out, as the forward page
 * has always left it out.
 */
function ownFrame(
  envelope: EventEnvelope,
  threadId: CodeThreadId,
): typeof CodeOperationEventFrame.Type | undefined {
  if (envelope.eventName !== CODE_OPERATION_EVENT_RECORDED || envelope.eventVersion !== 1) {
    return undefined;
  }
  let frame: typeof CodeOperationEventFrame.Type;
  try {
    frame = decodeCodeOperationEventFrame(envelope.payload);
  } catch {
    return undefined;
  }
  if (
    String(frame.operationId) !== String(envelope.aggregateId) ||
    frame.cursor !== envelope.aggregateVersion ||
    frame.threadId !== threadId
  ) {
    return undefined;
  }
  return frame;
}

/** The part of a journaled handoff the conversation page shows; the text stays in the content store. */
function conversationHandoff(
  event: Extract<CodeOperationEvent, { readonly kind: "context-handoff-attached" }>,
): CodeConversationTurnHandoff {
  switch (event.reason) {
    case "provider-switch":
      return {
        reason: event.reason,
        previousProviderInstanceId: event.previousProviderInstanceId,
        previousModelId: event.previousModelId,
        messages: event.messages,
        omissions: event.omissions,
        externalContentIngested: event.externalContentIngested,
        ...(event.inherited === undefined ? {} : { inherited: event.inherited }),
      };
    case "fork":
      return {
        reason: event.reason,
        forkedFrom: event.forkedFrom,
        messages: event.messages,
        omissions: event.omissions,
        externalContentIngested: event.externalContentIngested,
      };
    case "fork-native-session":
      return { reason: event.reason, forkedFrom: event.forkedFrom };
  }
}

type CodeConversationBuilder = {
  startCursor: number;
  operationId: CodeConversationTurn["operationId"];
  providerInstanceId: CodeConversationTurn["providerInstanceId"];
  modelId: CodeConversationTurn["modelId"];
  sessionId: CodeConversationTurn["sessionId"];
  prompt: CodeConversationTurn["prompt"];
  checkpoint?: CodeConversationTurn["checkpoint"];
  executionPolicy?: CodeConversationTurn["executionPolicy"];
  usage?: CodeConversationTurn["usage"];
  handoff?: CodeConversationTurn["handoff"];
  forkMergeBacks: Array<CodeForkMergeBack>;
  assistant: Array<CodeConversationTurn["assistant"][number]>;
  steps: Array<CodeConversationStep>;
  stepsTruncated: boolean;
  status: CodeConversationTurn["status"];
  failure?: CodeConversationTurn["failure"];
  changedFiles?: CodeConversationTurn["changedFiles"];
  startedAt: CodeConversationTurn["startedAt"];
  updatedAt: CodeConversationTurn["updatedAt"];
};

function appendStep(builder: CodeConversationBuilder, step: CodeConversationStep): void {
  if (builder.steps.length >= MAX_CODE_CONVERSATION_TURN_STEPS) {
    builder.stepsTruncated = true;
    return;
  }
  builder.steps.push(step);
}

function conversationStatus(
  state: "running" | "waiting" | "completed" | "interrupted" | "failed",
): CodeConversationTurn["status"] {
  return state === "running" ? "incomplete" : state;
}

function sameFrame(left: unknown, right: typeof CodeOperationEventFrame.Type): boolean {
  try {
    return JSON.stringify(decodeCodeOperationEventFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
