import { Schema } from "effect";
import { ChatThreadId } from "./chat";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MAX_THREAD_MENTIONS_PER_TURN, MentionableThreadId } from "./threadMentionIdentity";

export * from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Correlation id for one thread-mention command/result pair. The
 * renderer mints it; the server echoes it so a reconnect can reconcile an
 * in-flight typeahead or resolve without ambiguity.
 */
export const ThreadMentionRequestId = brandedUuid("ThreadMentionRequestId");
export type ThreadMentionRequestId = typeof ThreadMentionRequestId.Type;

/**
 * Where a mentionable thread is filed, as the server sees it. The renderer
 * shows this verbatim beside the chip and never derives it: filing is a
 * server-owned fact, and guessing it in the browser would let the chip claim a
 * Project the principal cannot actually Open.
 */
export const ThreadMentionPlacement = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("project"),
    label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("recents") }).annotations(strict),
);
export type ThreadMentionPlacement = typeof ThreadMentionPlacement.Type;

/**
 * One typeahead hit. Present only for threads the principal can already Open;
 * the server omits everything else rather than returning a disabled row, so an
 * unopenable thread never leaks its title through the picker.
 *
 * `sideChatThreadId` is present when a Side Chat sidecar already exists for
 * this thread, letting a chip reopen the sidecar instead of minting a second.
 */
export const ThreadMentionCandidate = Schema.Struct({
  threadId: MentionableThreadId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
  placement: ThreadMentionPlacement,
  updatedAt: UtcTimestamp,
  sideChatThreadId: Schema.optional(ChatThreadId),
}).annotations(strict);
export type ThreadMentionCandidate = typeof ThreadMentionCandidate.Type;

/**
 * Bounded free text carried inside a mention transcript window.
 *
 * Unlike an opaque source ref, this is conversation content the principal can
 * already Open and read verbatim on the mentioned thread, so it carries no
 * path/scheme filter: prose legitimately contains slashes and links, and
 * rejecting them would make ordinary transcripts undecodable rather than
 * safer. The bound that matters here is length, enforced per entry and again
 * across the window by the mention policy.
 */
const ThreadMentionTranscriptText = Schema.String.pipe(Schema.maxLength(4_000));

/**
 * One read-only line of a mentioned thread's recent transcript. Roles mirror
 * the Chat content roles the renderer already presents; the mention never
 * carries attempt ids, tool state, or approval affordances, because a mention
 * grants reading and nothing else.
 */
export const ThreadMentionTranscriptEntry = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: ThreadMentionTranscriptText,
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMentionTranscriptEntry = typeof ThreadMentionTranscriptEntry.Type;

/**
 * Maximum transcript entries one mention contributes to a turn. The window is
 * deliberately small: a mention is "point at that thread", not "replay it".
 * Older history stays out unless the user mentions the thread again later.
 */
export const MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES = 12;

/** Maximum total transcript characters one mention contributes to a turn. */
export const MAX_THREAD_MENTION_TRANSCRIPT_CHARACTERS = 8_000;

/** Maximum typeahead hits the server returns for one query. */
export const MAX_THREAD_MENTION_CANDIDATES = 8;

/**
 * A resolved mention: the thread's identity as the server sees it plus the
 * bounded recent transcript window. `truncated` is honest about the window
 * having dropped older turns so the renderer never implies full history.
 */
export const ResolvedThreadMention = Schema.Struct({
  threadId: MentionableThreadId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
  placement: ThreadMentionPlacement,
  transcript: Schema.Array(ThreadMentionTranscriptEntry).pipe(
    Schema.maxItems(MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ResolvedThreadMention = typeof ResolvedThreadMention.Type;

/**
 * A mention the server refused. The renderer leaves the `#text` unresolved or
 * shows "unavailable"; it never renders a title or placement for a refused
 * mention, so a fail-closed Open check leaks nothing beyond the opaque id.
 */
export const UnavailableThreadMention = Schema.Struct({
  threadId: MentionableThreadId,
  reason: Schema.Literal("unauthorized", "not-found", "unsupported-mode"),
}).annotations(strict);
export type UnavailableThreadMention = typeof UnavailableThreadMention.Type;

/**
 * Persisted Side Chat sidecar linkage. One Chat-mode sidecar per source
 * thread. The sidecar is ordinary Chat: it never inherits the source thread's
 * Work or Code filesystem, shell, Git, or worktree authority, and it is
 * hidden from Chat Recents and Project nesting so it cannot become a
 * second orchestration surface.
 */
export const SideChatSidecar = Schema.Struct({
  sourceThreadId: MentionableThreadId,
  sourceMode: OctantMode,
  sidecarThreadId: ChatThreadId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
  createdAt: UtcTimestamp,
}).annotations(strict);
export type SideChatSidecar = typeof SideChatSidecar.Type;

/**
 * Authoritative thread-mention command. `search-mentions` powers the `#`
 * typeahead, `resolve-mentions` turns chips into bounded read-only context at
 * send time, and `open-side-chat` gets-or-creates the one sidecar for a source
 * thread. No variant can steer, approve, append to, or otherwise mutate the
 * mentioned or source thread — that is denied for this surface entirely.
 */
export const ThreadMentionCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("search-mentions"),
    requestId: ThreadMentionRequestId,
    query: Schema.String.pipe(Schema.maxLength(200)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resolve-mentions"),
    requestId: ThreadMentionRequestId,
    threadIds: Schema.Array(MentionableThreadId).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("open-side-chat"),
    requestId: ThreadMentionRequestId,
    sourceThreadId: MentionableThreadId,
  }).annotations(strict),
);
export type ThreadMentionCommand = typeof ThreadMentionCommand.Type;

/**
 * Typed thread-mention result. Failures mirror the existing Work/Chat
 * failure vocabulary so the renderer reuses one typed-failure presentation.
 * `unauthorized` carries no title, mode, or placement, only the opaque id the
 * caller already had.
 */
export const ThreadMentionCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("mentions-searched"),
    requestId: ThreadMentionRequestId,
    candidates: Schema.Array(ThreadMentionCandidate).pipe(
      Schema.maxItems(MAX_THREAD_MENTION_CANDIDATES),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("mentions-resolved"),
    requestId: ThreadMentionRequestId,
    mentions: Schema.Array(ResolvedThreadMention).pipe(
      Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN),
    ),
    unavailable: Schema.Array(UnavailableThreadMention).pipe(
      Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("side-chat-opened"),
    requestId: ThreadMentionRequestId,
    sidecar: SideChatSidecar,
    created: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    requestId: ThreadMentionRequestId,
    reason: Schema.Literal("unauthorized", "not-found", "unsupported-mode", "unavailable"),
  }).annotations(strict),
);
export type ThreadMentionCommandResult = typeof ThreadMentionCommandResult.Type;

export const decodeThreadMentionRequestId = Schema.decodeUnknownSync(ThreadMentionRequestId);
export const decodeMentionableThreadId = Schema.decodeUnknownSync(MentionableThreadId);
export const decodeThreadMentionCandidate = Schema.decodeUnknownSync(ThreadMentionCandidate);
export const decodeResolvedThreadMention = Schema.decodeUnknownSync(ResolvedThreadMention);
export const decodeSideChatSidecar = Schema.decodeUnknownSync(SideChatSidecar);
export const decodeThreadMentionCommand = Schema.decodeUnknownSync(ThreadMentionCommand);
export const decodeThreadMentionCommandResult = Schema.decodeUnknownSync(
  ThreadMentionCommandResult,
);
