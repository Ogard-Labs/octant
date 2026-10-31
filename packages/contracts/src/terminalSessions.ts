/**
 * Terminal sessions: conversations a person had with a provider's own
 * command-line tool on this Mac, which a new Work or Code thread can start
 * from. The host reads them from the provider's own folder, never uploads
 * them, and treats every word of them as outside content.
 */

import { Schema } from "effect";
import { ProjectId } from "./projects";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The command-line tools whose sessions the host can read. */
export const TerminalSessionProvider = Schema.Literal("claude", "codex");
export type TerminalSessionProvider = typeof TerminalSessionProvider.Type;

/** The tool's own session id: a file name, so it never carries a path. */
export const TerminalSessionId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/),
  Schema.brand("TerminalSessionId"),
);
export type TerminalSessionId = typeof TerminalSessionId.Type;

export const MAX_TERMINAL_SESSION_TITLE_LENGTH = 160;
export const MAX_TERMINAL_SESSIONS_LISTED = 30;
export const MAX_IMPORTED_TERMINAL_ENTRIES = 200;
export const MAX_IMPORTED_TERMINAL_ENTRY_LENGTH = 8_000;
/**
 * The whole import, about 15,000 tokens: enough for the recent part of a long
 * session, and small enough that the first turn still fits a small model's
 * context next to the Project's own instructions.
 */
export const MAX_IMPORTED_TERMINAL_TEXT_LENGTH = 60_000;

const TerminalSessionTitle = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TERMINAL_SESSION_TITLE_LENGTH),
);

/** One session in a Project's folder, as the picker lists it. */
export const TerminalSessionSummary = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
  title: TerminalSessionTitle,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type TerminalSessionSummary = typeof TerminalSessionSummary.Type;

export const TerminalSessionListRequest = Schema.Struct({
  projectId: ProjectId,
}).annotations(strict);
export type TerminalSessionListRequest = typeof TerminalSessionListRequest.Type;

export const TerminalSessionListResponse = Schema.Struct({
  sessions: Schema.Array(TerminalSessionSummary).pipe(
    Schema.maxItems(MAX_TERMINAL_SESSIONS_LISTED),
  ),
}).annotations(strict);
export type TerminalSessionListResponse = typeof TerminalSessionListResponse.Type;

/** What a create command names to start the new thread from a session. */
export const TerminalSessionImportRequest = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
}).annotations(strict);
export type TerminalSessionImportRequest = typeof TerminalSessionImportRequest.Type;

export const ImportedTerminalEntry = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: Schema.NonEmptyString.pipe(Schema.maxLength(MAX_IMPORTED_TERMINAL_ENTRY_LENGTH)),
}).annotations(strict);
export type ImportedTerminalEntry = typeof ImportedTerminalEntry.Type;

/**
 * The read-only history a thread started from. `truncated` says older
 * messages, or the end of a long message, were left out to stay in bounds.
 */
export const ImportedTerminalSession = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
  title: TerminalSessionTitle,
  updatedAt: UtcTimestamp,
  importedAt: UtcTimestamp,
  entries: Schema.Array(ImportedTerminalEntry).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_IMPORTED_TERMINAL_ENTRIES),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ImportedTerminalSession = typeof ImportedTerminalSession.Type;

export const TerminalSessionHistoryRequest = Schema.Struct({
  threadId: Schema.UUID,
}).annotations(strict);
export type TerminalSessionHistoryRequest = typeof TerminalSessionHistoryRequest.Type;

export const TerminalSessionHistoryResponse = Schema.Struct({
  imported: Schema.optional(ImportedTerminalSession),
}).annotations(strict);
export type TerminalSessionHistoryResponse = typeof TerminalSessionHistoryResponse.Type;

/** Journaled on the thread's own import aggregate (aggregate id = thread id). */
export const THREAD_TERMINAL_SESSION_AGGREGATE = "thread-terminal-session";
export const THREAD_TERMINAL_SESSION_EVENT_NAMES = {
  imported: "thread.terminal-session-imported@1",
  delivered: "thread.terminal-session-delivered@1",
} as const;

export const TerminalSessionImportedPayload = Schema.Struct({
  threadId: Schema.UUID,
  imported: ImportedTerminalSession,
}).annotations(strict);
export type TerminalSessionImportedPayload = typeof TerminalSessionImportedPayload.Type;

/** The first turn that carried the history to the model was admitted. */
export const TerminalSessionDeliveredPayload = Schema.Struct({
  threadId: Schema.UUID,
}).annotations(strict);
export type TerminalSessionDeliveredPayload = typeof TerminalSessionDeliveredPayload.Type;

export const decodeTerminalSessionListRequest = Schema.decodeUnknownSync(
  TerminalSessionListRequest,
);
export const decodeTerminalSessionListResponse = Schema.decodeUnknownSync(
  TerminalSessionListResponse,
);
export const decodeTerminalSessionHistoryRequest = Schema.decodeUnknownSync(
  TerminalSessionHistoryRequest,
);
export const decodeTerminalSessionHistoryResponse = Schema.decodeUnknownSync(
  TerminalSessionHistoryResponse,
);
export const decodeImportedTerminalSession = Schema.decodeUnknownSync(ImportedTerminalSession);
export const decodeTerminalSessionImportedPayload = Schema.decodeUnknownSync(
  TerminalSessionImportedPayload,
);
export const decodeTerminalSessionId = Schema.decodeUnknownSync(TerminalSessionId);
