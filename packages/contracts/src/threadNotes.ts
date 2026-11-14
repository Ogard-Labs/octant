import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const ThreadNoteId = Schema.UUID.pipe(Schema.brand("ThreadNoteId"));
export type ThreadNoteId = typeof ThreadNoteId.Type;

/** A note is the person's own text: long enough for a paragraph or a list, not a document. */
export const MAX_THREAD_NOTE_LENGTH = 4_000;
/** Notes a thread keeps; past it the person deletes one before adding another. */
export const MAX_THREAD_NOTES = 100;

const ThreadNoteText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_THREAD_NOTE_LENGTH));

/** One note the person keeps on a thread. It is never sent to the agent by itself. */
export const ThreadNote = Schema.Struct({
  id: ThreadNoteId,
  text: ThreadNoteText,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadNote = typeof ThreadNote.Type;

/**
 * The thread's notes are one aggregate per thread. Every payload names its
 * thread at `threadId`, so purging the thread erases the notes' journal with it.
 */
export const THREAD_NOTES_AGGREGATE_TYPE = "thread-notes";

export const THREAD_NOTE_EVENT_NAMES = {
  added: "thread.note-added@1",
  edited: "thread.note-edited@1",
  deleted: "thread.note-deleted@1",
} as const;

export const ThreadNoteAdded = Schema.Struct({
  threadId: MentionableThreadId,
  noteId: ThreadNoteId,
  text: ThreadNoteText,
  at: UtcTimestamp,
}).annotations(strict);
export type ThreadNoteAdded = typeof ThreadNoteAdded.Type;

export const ThreadNoteEdited = Schema.Struct({
  threadId: MentionableThreadId,
  noteId: ThreadNoteId,
  text: ThreadNoteText,
  at: UtcTimestamp,
}).annotations(strict);
export type ThreadNoteEdited = typeof ThreadNoteEdited.Type;

export const ThreadNoteDeleted = Schema.Struct({
  threadId: MentionableThreadId,
  noteId: ThreadNoteId,
  at: UtcTimestamp,
}).annotations(strict);
export type ThreadNoteDeleted = typeof ThreadNoteDeleted.Type;

/** The longest excerpt of one message a recap quotes. */
export const MAX_THREAD_RECAP_EXCERPT_LENGTH = 280;
const RecapExcerpt = Schema.String.pipe(Schema.maxLength(MAX_THREAD_RECAP_EXCERPT_LENGTH));

/**
 * What a thread asked, did and left open, read on request from the thread's
 * own transcript by the host. Nothing in it is written by a model, so it costs
 * nothing and goes to no provider. `throughAt` names the last message it read,
 * so a recap opened before newer turns says how far it reaches; `truncated`
 * says older messages fell outside the window it reads.
 */
export const ThreadRecap = Schema.Struct({
  threadId: MentionableThreadId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
  /** The person's messages in the window read. */
  asks: Schema.Int.pipe(Schema.nonNegative()),
  /** The agent's replies in the window read. */
  replies: Schema.Int.pipe(Schema.nonNegative()),
  /** The earliest ask in the window: the thread's first when nothing was cut. */
  firstAsk: Schema.optional(RecapExcerpt),
  latestAsk: Schema.optional(RecapExcerpt),
  latestReply: Schema.optional(RecapExcerpt),
  /** The person's newest message has no reply after it yet. */
  awaitingReply: Schema.Boolean,
  throughAt: Schema.optional(UtcTimestamp),
  truncated: Schema.Boolean,
  notes: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ThreadRecap = typeof ThreadRecap.Type;

export const ReadThreadNotesCommand = Schema.Struct({
  kind: Schema.Literal("read-thread-notes"),
  threadId: MentionableThreadId,
}).annotations(strict);

export const AddThreadNoteCommand = Schema.Struct({
  kind: Schema.Literal("add-thread-note"),
  threadId: MentionableThreadId,
  text: ThreadNoteText,
}).annotations(strict);

export const EditThreadNoteCommand = Schema.Struct({
  kind: Schema.Literal("edit-thread-note"),
  threadId: MentionableThreadId,
  noteId: ThreadNoteId,
  text: ThreadNoteText,
}).annotations(strict);

export const DeleteThreadNoteCommand = Schema.Struct({
  kind: Schema.Literal("delete-thread-note"),
  threadId: MentionableThreadId,
  noteId: ThreadNoteId,
}).annotations(strict);

export const ReadThreadRecapCommand = Schema.Struct({
  kind: Schema.Literal("read-thread-recap"),
  threadId: MentionableThreadId,
}).annotations(strict);

export const ThreadNotesCommand = Schema.Union(
  ReadThreadNotesCommand,
  AddThreadNoteCommand,
  EditThreadNoteCommand,
  DeleteThreadNoteCommand,
  ReadThreadRecapCommand,
);
export type ThreadNotesCommand = typeof ThreadNotesCommand.Type;

export const ThreadNotesRefusalReason = Schema.Literal(
  /** The window cannot open the thread now, or it no longer exists. */
  "thread-unavailable",
  /** Only the person writes notes; an agent or the host itself is refused. */
  "not-the-person",
  "note-not-found",
  "too-many-notes",
);
export type ThreadNotesRefusalReason = typeof ThreadNotesRefusalReason.Type;

export const ThreadNotesResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("thread-notes"),
    threadId: MentionableThreadId,
    notes: Schema.Array(ThreadNote).pipe(Schema.maxItems(MAX_THREAD_NOTES)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread-recap"),
    recap: ThreadRecap,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread-notes-refused"),
    reason: ThreadNotesRefusalReason,
    message: Schema.String,
  }).annotations(strict),
);
export type ThreadNotesResult = typeof ThreadNotesResult.Type;

export const decodeThreadNotesCommand = Schema.decodeUnknownSync(ThreadNotesCommand);
export const decodeThreadNotesResult = Schema.decodeUnknownSync(ThreadNotesResult);
export const decodeThreadNoteAdded = Schema.decodeUnknownSync(ThreadNoteAdded);
export const decodeThreadNoteEdited = Schema.decodeUnknownSync(ThreadNoteEdited);
export const decodeThreadNoteDeleted = Schema.decodeUnknownSync(ThreadNoteDeleted);
export const decodeThreadRecap = Schema.decodeUnknownSync(ThreadRecap);
