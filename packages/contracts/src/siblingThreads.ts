import { Schema } from "effect";
import { AggregateId, CorrelationId, UtcTimestamp } from "./events";
import {
  MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES,
  ThreadMentionTranscriptEntry,
} from "./threadMention";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The threads tool: a Work or Code turn's view of the other open threads of
 * its own Project, and in Code its messaging channel and the planner's board.
 * `list` names the threads, `read` returns the bounded window a `#thread`
 * mention resolves, `wait` blocks until one stops working, `send` leaves one a
 * message its next turn reads as data, `acknowledge` and `receipts` report on
 * delivered and sent messages, and `board` reads the Project board for its
 * designated planner. No operation creates, steers, completes, archives, or
 * stops a thread; the host decides the reachable set from the caller's own
 * thread on every call, and the model supplies no Project, path, or window.
 */
export const SIBLING_THREADS_TOOL_NAME = "octant_threads";

/**
 * What a turn may ask of the threads tool. A turn is offered only the
 * operations its mode, access posture, profile, and planner designation allow,
 * and the enum it sees lists only those.
 */
export const ThreadsToolOperation = Schema.Literal(
  "help",
  "list",
  "read",
  "wait",
  "send",
  "acknowledge",
  "receipts",
  "board",
  "start",
);
export type ThreadsToolOperation = typeof ThreadsToolOperation.Type;

/** The read-only operations that journal or bound per turn. */
export const SiblingThreadAction = Schema.Literal("list", "read", "wait");
export type SiblingThreadAction = typeof SiblingThreadAction.Type;

/**
 * The profile allowlist entries for the threads tool's operation groups. A
 * non-empty allowlist names `octant_threads` for `list`, `read`, and `wait`,
 * `octant_threads.send` for `send`, `acknowledge`, and `receipts`, and
 * `octant_threads.board` for the planner's `board`; an empty allowlist permits
 * all of them. They are separate entries because messaging and the board were
 * separate tools a profile could leave out, and folding them into one tool
 * must not hand an existing allowlist an operation it did not name.
 */
export const THREADS_TOOL_SEND_ALLOWLIST_ENTRY = "octant_threads.send";
export const THREADS_TOOL_BOARD_ALLOWLIST_ENTRY = "octant_threads.board";

/**
 * What a sibling is doing, as a closed set: a turn running, a turn stopped on
 * a question, approval, or limit only a person can clear, or nothing running.
 * `wait` returns only this, so it carries no text another thread wrote.
 */
export const SiblingThreadState = Schema.Literal("working", "waiting-for-person", "idle");
export type SiblingThreadState = typeof SiblingThreadState.Type;

/** A Work or Code thread the threads tool names; a Project holds threads of one mode. */
export const SiblingThreadId = Schema.UUID.pipe(Schema.brand("SiblingThreadId"));
export type SiblingThreadId = typeof SiblingThreadId.Type;

const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * How every operation names a thread: `<thread id>@<project id>`, as `list`
 * hands it back. It names the thread, so a stale reference can never resolve
 * to a different one, and the Project the thread was listed in, so the same
 * text cannot be read as a thread of another Project and a thread that has
 * left that Project refuses. It grants nothing: the host re-decides the
 * reachable set on every call, and a well-formed reference to a thread outside
 * it refuses exactly as a malformed one does.
 */
export const SiblingThreadReference = Schema.String.pipe(
  Schema.pattern(new RegExp(`^${uuidPattern}@${uuidPattern}$`)),
  Schema.brand("SiblingThreadReference"),
);
export type SiblingThreadReference = typeof SiblingThreadReference.Type;

/** Rows one `list` returns, most recently changed first. */
export const MAX_SIBLING_THREAD_LIST_ROWS = 32;
/** `read` calls one turn may make before the tool refuses `rate-limited`. */
export const MAX_SIBLING_THREAD_READS_PER_TURN = 8;
/** `wait` calls one turn may make before the tool refuses `rate-limited`. */
export const MAX_SIBLING_THREAD_WAITS_PER_TURN = 4;
/** How long `wait` blocks when the caller names no timeout; the child-run `wait` default. */
export const DEFAULT_SIBLING_THREAD_WAIT_MS = 30_000;
/** The longest one `wait` blocks: the same bound a child-run `wait` has. */
export const MAX_SIBLING_THREAD_WAIT_MS = 120_000;

const SiblingThreadTitle = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400));

export const SiblingThreadsToolInput = Schema.Union(
  Schema.Struct({ operation: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("read"),
    reference: Schema.String.pipe(Schema.maxLength(128)),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("wait"),
    reference: Schema.String.pipe(Schema.maxLength(128)),
    timeoutMs: Schema.optional(Schema.Int.pipe(Schema.between(0, MAX_SIBLING_THREAD_WAIT_MS))),
  }).annotations(strict),
);
export type SiblingThreadsToolInput = typeof SiblingThreadsToolInput.Type;

/**
 * Why a call was refused. `unauthorized` covers every reference outside the
 * readable set in one sentence, including reference text that does not parse
 * as `<thread id>@<project id>`; `rate-limited` is a spent per-turn bound;
 * `unavailable` is a call the host could not complete (mark as outside
 * content, journal, or read its own facts for), so it returned nothing;
 * `policy` is a call whose input fails
 * `SiblingThreadsToolInput` (an unknown operation, an extra field, a timeout out
 * of range, a reference over 128 characters), a cancelled turn, a profile
 * that does not permit the tool, or a caller that is not an open thread the
 * host knows. No `policy` case depends on another thread, so it confirms nothing
 * about one.
 */
export const SiblingThreadRefuseReason = Schema.Literal(
  "unauthorized",
  "rate-limited",
  "unavailable",
  "policy",
);
export type SiblingThreadRefuseReason = typeof SiblingThreadRefuseReason.Type;

export const SiblingThreadRow = Schema.Struct({
  reference: SiblingThreadReference,
  title: SiblingThreadTitle,
  state: SiblingThreadState,
  stateChangedAt: UtcTimestamp,
}).annotations(strict);
export type SiblingThreadRow = typeof SiblingThreadRow.Type;

export const SiblingThreadsToolResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("listed"),
    threads: Schema.Array(SiblingThreadRow).pipe(Schema.maxItems(MAX_SIBLING_THREAD_LIST_ROWS)),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("read"),
    reference: SiblingThreadReference,
    title: SiblingThreadTitle,
    state: SiblingThreadState,
    transcript: Schema.Array(ThreadMentionTranscriptEntry).pipe(
      Schema.maxItems(MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES),
    ),
    truncated: Schema.Boolean,
  }).annotations(strict),
  /** `working` here means the bound ran out before the thread stopped. */
  Schema.Struct({
    status: Schema.Literal("waited"),
    reference: SiblingThreadReference,
    state: SiblingThreadState,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: SiblingThreadRefuseReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type SiblingThreadsToolResult = typeof SiblingThreadsToolResult.Type;

/**
 * The journal record of one answered `read` or `wait`, on the reader's own
 * stream: the `sibling-thread-observation` aggregate keyed by the reader's
 * thread id. It names the reader, the target, the action, and how many bytes
 * the answer carried, never the text, so a person can see what a thread looked
 * at without the journal holding another conversation. `threadId` is the
 * reader, so purging the reader takes its records with it. `list` is not
 * journaled: it reads no transcript, and its taint mark is its record.
 */
export const SIBLING_THREAD_OBSERVATION_AGGREGATE = "sibling-thread-observation";
export const SIBLING_THREAD_EVENT_NAMES = {
  observed: "thread.sibling-observed@1",
} as const;

export const SiblingThreadObserved = Schema.Struct({
  kind: Schema.Literal("sibling-observed"),
  threadId: AggregateId,
  targetThreadId: AggregateId,
  action: Schema.Literal("read", "wait"),
  correlationId: CorrelationId,
  returnedBytes: Schema.Int.pipe(Schema.nonNegative()),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type SiblingThreadObserved = typeof SiblingThreadObserved.Type;

export const decodeSiblingThreadObserved = Schema.decodeUnknownSync(SiblingThreadObserved);
export const decodeSiblingThreadId = Schema.decodeUnknownSync(SiblingThreadId);
export const decodeSiblingThreadReference = Schema.decodeUnknownSync(SiblingThreadReference);
export const decodeSiblingThreadsToolInput = Schema.decodeUnknownSync(SiblingThreadsToolInput);
export const decodeSiblingThreadsToolResult = Schema.decodeUnknownSync(SiblingThreadsToolResult);
