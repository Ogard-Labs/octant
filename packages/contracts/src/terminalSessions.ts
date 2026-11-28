/**
 * Terminal sessions: conversations a person had with a provider's own
 * command-line tool on this Mac, which a new Work or Code thread can start
 * from. The host reads them from the provider's own folder, never uploads
 * them, and treats every word of them as outside content.
 */

import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import { UtcTimestamp } from "./events";

/** The command-line tools whose sessions the host can read. */
export const TerminalSessionProvider = Schema.Literals(["claude", "codex"]);
export type TerminalSessionProvider = typeof TerminalSessionProvider.Type;

/** The tool's own session id: a file name, so it never carries a path. */
export const TerminalSessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/)),
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

const TerminalSessionTitle = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TERMINAL_SESSION_TITLE_LENGTH),
);

export const TerminalSessionContinuity = Schema.Struct({
  kind: Schema.Literal("text-handoff"),
  native: Schema.Literal("unavailable"),
  reason: Schema.Literal("account-binding-unavailable"),
});
export type TerminalSessionContinuity = typeof TerminalSessionContinuity.Type;
const TerminalSessionWorkingDirectory = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4096),
);

/** One session in a Project's folder, as the picker lists it. */
export const TerminalSessionSummary = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
  title: TerminalSessionTitle,
  workingDirectory: Schema.optional(TerminalSessionWorkingDirectory),
  continuity: Schema.optional(TerminalSessionContinuity),
  updatedAt: UtcTimestamp,
});
export type TerminalSessionSummary = typeof TerminalSessionSummary.Type;

export const TerminalSessionListRequest = Schema.Struct({
  projectId: ProjectId,
});
export type TerminalSessionListRequest = typeof TerminalSessionListRequest.Type;

export const TerminalSessionListResponse = Schema.Struct({
  sessions: Schema.Array(TerminalSessionSummary).check(
    Schema.isMaxLength(MAX_TERMINAL_SESSIONS_LISTED),
  ),
});
export type TerminalSessionListResponse = typeof TerminalSessionListResponse.Type;

/** What a create command names to start the new thread from a session. */
export const TerminalSessionImportRequest = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
  continuation: Schema.optional(Schema.Literals(["native", "text-handoff"])),
});
export type TerminalSessionImportRequest = typeof TerminalSessionImportRequest.Type;

export const ImportedTerminalEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_IMPORTED_TERMINAL_ENTRY_LENGTH)),
});
export type ImportedTerminalEntry = typeof ImportedTerminalEntry.Type;

/**
 * The read-only history a thread started from. `truncated` says older
 * messages, or the end of a long message, were left out to stay in bounds.
 */
export const ImportedTerminalSession = Schema.Struct({
  provider: TerminalSessionProvider,
  sessionId: TerminalSessionId,
  title: TerminalSessionTitle,
  workingDirectory: Schema.optional(TerminalSessionWorkingDirectory),
  continuity: Schema.optional(TerminalSessionContinuity),
  updatedAt: UtcTimestamp,
  importedAt: UtcTimestamp,
  entries: Schema.Array(ImportedTerminalEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_IMPORTED_TERMINAL_ENTRIES),
  ),
  truncated: Schema.Boolean,
});
export type ImportedTerminalSession = typeof ImportedTerminalSession.Type;

export const TerminalSessionHistoryRequest = Schema.Struct({
  threadId: GuidString,
});
export type TerminalSessionHistoryRequest = typeof TerminalSessionHistoryRequest.Type;

export const TerminalSessionHistoryResponse = Schema.Struct({
  imported: Schema.optional(ImportedTerminalSession),
});
export type TerminalSessionHistoryResponse = typeof TerminalSessionHistoryResponse.Type;

/** Journaled on the thread's own import aggregate (aggregate id = thread id). */
export const THREAD_TERMINAL_SESSION_AGGREGATE = "thread-terminal-session";
export const THREAD_TERMINAL_SESSION_EVENT_NAMES = {
  imported: "thread.terminal-session-imported@1",
  delivered: "thread.terminal-session-delivered@1",
} as const;

export const TerminalSessionImportedPayload = Schema.Struct({
  threadId: GuidString,
  imported: ImportedTerminalSession,
});
export type TerminalSessionImportedPayload = typeof TerminalSessionImportedPayload.Type;

/** The first turn that carried the history to the model was admitted. */
export const TerminalSessionDeliveredPayload = Schema.Struct({
  threadId: GuidString,
});
export type TerminalSessionDeliveredPayload = typeof TerminalSessionDeliveredPayload.Type;

export const decodeTerminalSessionListRequest = Schema.decodeUnknownSync(
  TerminalSessionListRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeTerminalSessionListResponse = Schema.decodeUnknownSync(
  TerminalSessionListResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeTerminalSessionHistoryRequest = Schema.decodeUnknownSync(
  TerminalSessionHistoryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeTerminalSessionHistoryResponse = Schema.decodeUnknownSync(
  TerminalSessionHistoryResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeImportedTerminalSession = Schema.decodeUnknownSync(
  ImportedTerminalSession,
  STRICT_DECODE_OPTIONS,
);
export const decodeTerminalSessionImportedPayload = Schema.decodeUnknownSync(
  TerminalSessionImportedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeTerminalSessionId = Schema.decodeUnknownSync(
  TerminalSessionId,
  STRICT_DECODE_OPTIONS,
);
