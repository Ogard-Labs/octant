import {
  AgentRunConversationEntry,
  MAX_AGENT_RUN_CONVERSATION_BYTES,
  MAX_AGENT_RUN_CONVERSATION_ENTRIES,
  ProviderResumeCursor,
  ProviderSessionId,
  type AgentRun,
  type AgentRunId,
} from "@octant/contracts";
import { Schema } from "effect";
import { agentRunContentSubject } from "../persistence/agentRunContentStore";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { AgentRunLiveConversationPersistence } from "./agentRunLiveConversationStore";

const MAX_SESSION_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const SessionRecord = Schema.Struct({
  binding: Schema.NonEmptyString.pipe(Schema.maxLength(16 * 1024)),
  sessionId: ProviderSessionId,
  resumeCursor: Schema.optional(ProviderResumeCursor),
});
const decodeSessionRecord = Schema.decodeUnknownSync(SessionRecord);
const ConversationRecord = Schema.Struct({
  status: Schema.Literal("live", "complete", "stale"),
  entries: Schema.Array(AgentRunConversationEntry).pipe(
    Schema.maxItems(MAX_AGENT_RUN_CONVERSATION_ENTRIES),
  ),
  truncated: Schema.Boolean,
  staleReason: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
});
const decodeConversationRecord = Schema.decodeUnknownSync(ConversationRecord);
const decodeContentRow = Schema.decodeUnknownSync(Schema.Struct({ body_text: Schema.String }));

/** Private continuation state. It is not a client contract or a grant of authority. */
export type AgentRunSessionRecord = typeof SessionRecord.Type;
export interface AgentRunSessionStatePort {
  readonly read: (run: AgentRun) => AgentRunSessionRecord | undefined;
  readonly write: (run: AgentRun, record: AgentRunSessionRecord) => boolean;
}

/**
 * Provider state and bounded display history belong to the journaled run's
 * parent. Reuse its purgeable content store so deletion also erases opaque
 * provider cursors. Rebuilding projections does not invent or discard them.
 */
export class AgentRunSessionStore {
  readonly #connection: SqliteConnection;
  readonly #getById: (runId: AgentRunId) => AgentRun | undefined;
  readonly sessions: AgentRunSessionStatePort;
  readonly conversations: AgentRunLiveConversationPersistence;

  constructor(options: {
    readonly connection: SqliteConnection;
    readonly getById: (runId: AgentRunId) => AgentRun | undefined;
  }) {
    this.#connection = options.connection;
    this.#getById = options.getById;
    this.sessions = {
      read: (run) => {
        const current = this.#current(run.id);
        if (
          current === undefined ||
          String(current.parentThreadId) !== String(run.parentThreadId) ||
          current.routingReceipt.mode !== run.routingReceipt.mode
        )
          return undefined;
        const text = this.#read(run.id, "managed-session");
        if (text === undefined || encoder.encode(text).byteLength > MAX_SESSION_BYTES)
          return undefined;
        try {
          return decodeSessionRecord(JSON.parse(text));
        } catch {
          return undefined;
        }
      },
      write: (run, record) => {
        const current = this.#current(run.id);
        if (
          current === undefined ||
          String(current.parentThreadId) !== String(run.parentThreadId) ||
          current.routingReceipt.mode !== run.routingReceipt.mode
        )
          return false;
        const text = JSON.stringify(decodeSessionRecord(record));
        if (encoder.encode(text).byteLength > MAX_SESSION_BYTES) return false;
        return this.#write(current, "managed-session", text);
      },
    };
    this.conversations = {
      read: (runId) => {
        const text = this.#read(runId, "managed-conversation");
        if (
          text === undefined ||
          encoder.encode(text).byteLength > MAX_AGENT_RUN_CONVERSATION_BYTES + 2048
        )
          return undefined;
        try {
          const record = decodeConversationRecord(JSON.parse(text));
          if (
            encoder.encode(JSON.stringify(record.entries)).byteLength >
            MAX_AGENT_RUN_CONVERSATION_BYTES
          )
            return undefined;
          return {
            status: record.status,
            entries: record.entries,
            truncated: record.truncated,
            ...(record.staleReason === undefined ? {} : { staleReason: record.staleReason }),
          };
        } catch {
          return undefined;
        }
      },
      write: (runId, snapshot) => {
        const current = this.#current(runId);
        if (current === undefined) return;
        const record = decodeConversationRecord(snapshot);
        if (
          encoder.encode(JSON.stringify(record.entries)).byteLength >
          MAX_AGENT_RUN_CONVERSATION_BYTES
        )
          return;
        this.#write(current, "managed-conversation", JSON.stringify(record));
      },
      clear: (runId) => {
        this.#connection
          .prepare(
            "DELETE FROM agent_run_content_store WHERE content_id = ? AND run_id = ? AND content_kind = ?",
          )
          .run(`managed-conversation:${String(runId)}`, String(runId), "managed-conversation");
      },
    };
  }

  #current(runId: AgentRunId): AgentRun | undefined {
    const run = this.#getById(runId);
    if (run === undefined || String(run.id) !== String(runId)) return undefined;
    const purged = this.#connection
      .prepare("SELECT 1 FROM thread_purge_tombstone WHERE mode = ? AND thread_id = ?")
      .get(run.routingReceipt.mode, String(run.parentThreadId));
    return purged === undefined ? run : undefined;
  }

  #read(runId: AgentRunId, kind: string): string | undefined {
    const run = this.#current(runId);
    if (run === undefined) return undefined;
    const subject = agentRunContentSubject(run);
    const row = this.#connection
      .prepare(
        "SELECT body_text FROM agent_run_content_store WHERE content_id = ? AND run_id = ? AND content_kind = ? AND subject_type = ? AND subject_id = ?",
      )
      .get(
        `${kind}:${String(runId)}`,
        String(runId),
        kind,
        subject.aggregateType,
        subject.aggregateId,
      );
    return row === undefined ? undefined : decodeContentRow(row).body_text;
  }

  #write(run: AgentRun, kind: string, body: string): boolean {
    const subject = agentRunContentSubject(run);
    const result = this.#connection
      .prepare(`INSERT INTO agent_run_content_store
      (content_id, run_id, subject_type, subject_id, content_kind, body_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_id) DO UPDATE SET body_text = excluded.body_text, created_at = excluded.created_at
      WHERE run_id = excluded.run_id AND subject_type = excluded.subject_type AND subject_id = excluded.subject_id AND content_kind = excluded.content_kind`)
      .run(
        `${kind}:${String(run.id)}`,
        String(run.id),
        subject.aggregateType,
        subject.aggregateId,
        kind,
        body,
        run.updatedAt,
      );
    return result.changes === 1;
  }
}
