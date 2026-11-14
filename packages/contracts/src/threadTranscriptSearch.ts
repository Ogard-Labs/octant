import { Schema } from "effect";
import {
  ChatThreadId,
  ChatTranscriptSearchMatchRange,
  ChatTurnId,
  MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH,
} from "./chat";
import { CodeThreadId } from "./code";
import { CodeOperationId } from "./codeOperations";
import { ProjectId } from "./projects";
import { WorkThreadId } from "./workThreads";
import { WorkTurnId } from "./workTurns";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Work and Code message search answer with the same bounds as Chat's, so one
 * Search overlay and one phone list read all three modes alike: the query,
 * the hit count, and the snippet are capped by the Chat constants.
 */
const TranscriptSearchHitFields = {
  title: Schema.NonEmptyTrimmedString,
  /**
   * Where the thread is listed: `archived` under Archived, `active` with the
   * live threads. A Code thread that is waiting or interrupted is listed with
   * the live threads, so it reads `active`.
   */
  lifecycle: Schema.Literal("active", "archived"),
  projectId: ProjectId,
  snippet: Schema.String.pipe(Schema.maxLength(MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH)),
  matchRanges: Schema.optional(
    Schema.Array(ChatTranscriptSearchMatchRange).pipe(Schema.maxItems(8)),
  ),
};

/** One Work message match: the turn whose prompt or reply holds the text. */
export const WorkTranscriptSearchHit = Schema.Struct({
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  ...TranscriptSearchHitFields,
}).annotations(strict);
export type WorkTranscriptSearchHit = typeof WorkTranscriptSearchHit.Type;

export const WorkTranscriptSearch = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  hits: Schema.Array(WorkTranscriptSearchHit).pipe(
    Schema.maxItems(MAX_CHAT_TRANSCRIPT_SEARCH_HITS),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type WorkTranscriptSearch = typeof WorkTranscriptSearch.Type;

/**
 * One Code message match: the provider turn, named by its operation, whose
 * prompt or reply holds the text.
 */
export const CodeTranscriptSearchHit = Schema.Struct({
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  ...TranscriptSearchHitFields,
}).annotations(strict);
export type CodeTranscriptSearchHit = typeof CodeTranscriptSearchHit.Type;

export const CodeTranscriptSearch = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  hits: Schema.Array(CodeTranscriptSearchHit).pipe(
    Schema.maxItems(MAX_CHAT_TRANSCRIPT_SEARCH_HITS),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type CodeTranscriptSearch = typeof CodeTranscriptSearch.Type;

export const decodeWorkTranscriptSearch = Schema.decodeUnknownSync(WorkTranscriptSearch);
export const decodeCodeTranscriptSearch = Schema.decodeUnknownSync(CodeTranscriptSearch);

/**
 * Search across every mode: one host read that matches thread titles, the
 * person's prompts, the replies, and what tools did (a step's summary, the
 * files it wrote, a terminal's output) in Chat, Work and Code at once.
 */
export const THREAD_SEARCH_SCOPES = ["all", "chat", "work", "code"] as const;
export const ThreadSearchScope = Schema.Literal(...THREAD_SEARCH_SCOPES);
export type ThreadSearchScope = typeof ThreadSearchScope.Type;

/**
 * Where in the thread the text matched. A title hit names no turn; every other
 * field names the turn that holds it.
 */
export const ThreadSearchField = Schema.Literal("title", "prompt", "reply", "tool");
export type ThreadSearchField = typeof ThreadSearchField.Type;

const ThreadSearchHitFields = {
  ...TranscriptSearchHitFields,
  field: ThreadSearchField,
  /** When the thread last changed, so a client can order or label hits. */
  updatedAt: Schema.String,
};

export const ChatThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("chat"),
  threadId: ChatThreadId,
  turnId: Schema.optional(ChatTurnId),
  ...ThreadSearchHitFields,
  // A Chat thread may sit in no Project.
  projectId: Schema.optional(ProjectId),
}).annotations(strict);

export const WorkThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("work"),
  threadId: WorkThreadId,
  turnId: Schema.optional(WorkTurnId),
  ...ThreadSearchHitFields,
}).annotations(strict);

export const CodeThreadSearchHit = Schema.Struct({
  mode: Schema.Literal("code"),
  threadId: CodeThreadId,
  operationId: Schema.optional(CodeOperationId),
  ...ThreadSearchHitFields,
}).annotations(strict);

export const ThreadSearchHit = Schema.Union(
  ChatThreadSearchHit,
  WorkThreadSearchHit,
  CodeThreadSearchHit,
);
export type ThreadSearchHit = typeof ThreadSearchHit.Type;

export const ThreadSearch = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH)),
  scope: ThreadSearchScope,
  hits: Schema.Array(ThreadSearchHit).pipe(Schema.maxItems(MAX_CHAT_TRANSCRIPT_SEARCH_HITS)),
  truncated: Schema.Boolean,
  /** Modes the host could not search for this caller; their threads are not in `hits`. */
  unavailable: Schema.Array(Schema.Literal("chat", "work", "code")),
}).annotations(strict);
export type ThreadSearch = typeof ThreadSearch.Type;

export const decodeThreadSearch = Schema.decodeUnknownSync(ThreadSearch);
