import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  ChatThreadId,
  ChatTranscriptSearchMatchRange,
  ChatTurnId,
  MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
} from "./chat";
import { CanvasId } from "./canvasIdentity";
import { CodeThreadId } from "./code";
import { CodeOperationId } from "./codeOperations";
import { ProjectId } from "./projects";
import { WorkThreadId } from "./workThreads";
import { WorkTurnId } from "./workTurns";

/**
 * Work and Code message search answer with the same bounds as Chat's, so one
 * Search overlay and one phone list read all three modes alike: the query,
 * the hit count, and the snippet are capped by the Chat constants.
 */
const TranscriptSearchHitFields = {
  title: NonEmptyTrimmedString,
  /**
   * Where the thread is listed: `archived` under Archived, `active` with the
   * live threads. A Code thread that is waiting or interrupted is listed with
   * the live threads, so it reads `active`.
   */
  lifecycle: Schema.Literals(["active", "archived"]),
  projectId: ProjectId,
  snippet: Schema.String.check(Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH)),
  matchRanges: Schema.optional(
    Schema.Array(ChatTranscriptSearchMatchRange).check(Schema.isMaxLength(8)),
  ),
};

/** One Work message match: the turn whose prompt or reply holds the text. */
export const WorkTranscriptSearchHit = Schema.Struct({
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  ...TranscriptSearchHitFields,
});
export type WorkTranscriptSearchHit = typeof WorkTranscriptSearchHit.Type;

export const WorkTranscriptSearch = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  hits: Schema.Array(WorkTranscriptSearchHit).check(
    Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_HITS),
  ),
  truncated: Schema.Boolean,
});
export type WorkTranscriptSearch = typeof WorkTranscriptSearch.Type;

/**
 * One Code message match: the provider turn, named by its operation, whose
 * prompt or reply holds the text.
 */
export const CodeTranscriptSearchHit = Schema.Struct({
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  ...TranscriptSearchHitFields,
});
export type CodeTranscriptSearchHit = typeof CodeTranscriptSearchHit.Type;

export const CodeTranscriptSearch = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  hits: Schema.Array(CodeTranscriptSearchHit).check(
    Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_HITS),
  ),
  truncated: Schema.Boolean,
});
export type CodeTranscriptSearch = typeof CodeTranscriptSearch.Type;

export const decodeWorkTranscriptSearch = Schema.decodeUnknownSync(
  WorkTranscriptSearch,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeTranscriptSearch = Schema.decodeUnknownSync(
  CodeTranscriptSearch,
  STRICT_DECODE_OPTIONS,
);

/**
 * Search across every mode: one host read that matches thread titles, the
 * person's prompts, the replies, and what tools did (a step's summary, the
 * files it wrote, a terminal's output) in Chat, Work and Code at once.
 */
export const THREAD_SEARCH_SCOPES = ["all", "chat", "work", "code"] as const;
export const ThreadSearchScope = Schema.Literals(THREAD_SEARCH_SCOPES);
export type ThreadSearchScope = typeof ThreadSearchScope.Type;

/**
 * Where in the thread the text matched. A title or Canvas hit names no turn
 * (a Canvas hit names its Canvas); every other field names the turn that
 * holds it.
 */
export const ThreadSearchField = Schema.Literals(["title", "prompt", "reply", "tool", "canvas"]);
export type ThreadSearchField = typeof ThreadSearchField.Type;

const ThreadSearchHitFields = {
  ...TranscriptSearchHitFields,
  field: ThreadSearchField,
  /** The Canvas whose title or blocks matched, on a `canvas` hit. */
  canvasId: Schema.optional(CanvasId),
  /** That Canvas's own title, so a client can open it by name. */
  canvasTitle: Schema.optional(NonEmptyTrimmedString),
  /** When the thread last changed, so a client can order or label hits. */
  updatedAt: Schema.String,
  /**
   * The match is in the earlier conversation of a provider session the thread
   * was started from, imported when it was adopted, not in one of its turns.
   */
  imported: Schema.optional(Schema.Literal(true)),
};

export const ChatThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("chat"),
  threadId: ChatThreadId,
  turnId: Schema.optional(ChatTurnId),
  ...ThreadSearchHitFields,
  // A Chat thread may sit in no Project.
  projectId: Schema.optional(ProjectId),
});

export const WorkThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("work"),
  threadId: WorkThreadId,
  turnId: Schema.optional(WorkTurnId),
  ...ThreadSearchHitFields,
});

export const CodeThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("code"),
  threadId: CodeThreadId,
  operationId: Schema.optional(CodeOperationId),
  ...ThreadSearchHitFields,
});

export const ThreadSearchHit = Schema.Union([
  ChatThreadSearchHit,
  WorkThreadSearchHit,
  CodeThreadSearchHit,
]);
export type ThreadSearchHit = typeof ThreadSearchHit.Type;

export const ThreadSearch = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  scope: ThreadSearchScope,
  hits: Schema.Array(ThreadSearchHit).check(Schema.isMaxLength(MAX_CHAT_TRANSCRIPT_SEARCH_HITS)),
  truncated: Schema.Boolean,
  /** Modes the host could not search for this caller; their threads are not in `hits`. */
  unavailable: Schema.Array(Schema.Literals(["chat", "work", "code"])),
});
export type ThreadSearch = typeof ThreadSearch.Type;

export const decodeThreadSearch = Schema.decodeUnknownSync(ThreadSearch, STRICT_DECODE_OPTIONS);
