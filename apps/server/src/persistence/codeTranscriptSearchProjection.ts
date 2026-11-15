import {
  decodeCodeOperationEventFrame,
  decodeCodeOperationId,
  decodeCodeThreadId,
  MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  MAX_CODE_CONVERSATION_ASSISTANT_PARTS,
  type CodeEvidenceReference,
  type CodeOperationId,
  type CodeThreadId,
  type EventEnvelope,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";
import {
  clipTranscriptSearchSnippet,
  escapeLikePattern,
  normalizeSearchText,
} from "./transcriptSearchText";

const CODE_OPERATION_EVENT_RECORDED = "code.operation-event-recorded@1";

interface Statements {
  readonly evidence: SqliteStatement;
  readonly startTurn: SqliteStatement;
  readonly appendReply: SqliteStatement;
  readonly rewind: SqliteStatement;
}

/**
 * Per-turn Code message text for message search: one row for the prompt and
 * one for the reply of every provider turn, keyed by the turn's operation.
 *
 * The text itself lives in the evidence store, one row per streamed burst, so
 * a word can straddle two rows. The reply row therefore keeps the bursts
 * joined, in arrival order and up to the parts the conversation shows, which
 * is what lets a search match across a burst boundary. Rebuildable from the
 * operation journal: every event names the evidence it carries, and evidence
 * rows outlive a projection reset.
 *
 * Derived: nothing but message search reads it, so a failing apply holds this
 * view back instead of rolling back the turn that journaled the event.
 */
export class CodeTranscriptSearchProjection implements Projection {
  readonly name = "code-transcript-search";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  readonly derived = true as const;
  #statements = new WeakMap<SqliteConnection, Statements>();

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM code_transcript_search_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventName !== CODE_OPERATION_EVENT_RECORDED || event.eventVersion !== 1) return;
    let frame: ReturnType<typeof decodeCodeOperationEventFrame>;
    try {
      frame = decodeCodeOperationEventFrame(event.payload);
    } catch {
      // The conversation read skips a frame that no longer decodes; search
      // matches what that read shows.
      return;
    }
    if (String(frame.operationId) !== String(event.aggregateId)) return;
    const statements = this.#statementsFor(connection);
    const operationId = String(frame.operationId);
    const threadId = String(frame.threadId);
    const sequence = event.globalSequence;
    if (frame.event.kind === "conversation-turn-started") {
      const prompt = readEvidence(statements, frame.event.prompt);
      statements.startTurn.run(
        operationId,
        "user",
        threadId,
        sequence,
        prompt,
        prompt.toLowerCase(),
        sequence,
      );
      statements.startTurn.run(operationId, "assistant", threadId, sequence, "", "", sequence);
      return;
    }
    if (frame.event.kind === "provider-content" && frame.event.channel === "message") {
      const part = readEvidence(statements, frame.event.content);
      statements.appendReply.run(
        part,
        part.toLowerCase(),
        sequence,
        operationId,
        threadId,
        sequence,
        MAX_CODE_CONVERSATION_ASSISTANT_PARTS,
      );
      return;
    }
    if (
      frame.event.kind === "operation-result" &&
      frame.event.result.kind === "thread-rewound" &&
      frame.event.result.scope !== "files"
    ) {
      // As the conversation read does: a rewind removes the turns that
      // started from its first removed turn up to the rewind itself. Turns
      // sent after it are the thread's own again.
      statements.rewind.run(
        threadId,
        String(frame.event.result.fromOperationId),
        threadId,
        sequence,
      );
    }
  }

  #statementsFor(connection: SqliteConnection): Statements {
    const cached = this.#statements.get(connection);
    if (cached !== undefined) return cached;
    const statements: Statements = {
      evidence: connection.prepare(`
        SELECT body_text, digest, byte_length
        FROM code_evidence_content_store
        WHERE content_id = ?
      `),
      startTurn: connection.prepare(`
        INSERT INTO code_transcript_search_projection (
          operation_id, content_role, thread_id, start_sequence, part_count, rewound,
          body_text, search_text, last_sequence
        ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)
        ON CONFLICT (operation_id, content_role) DO NOTHING
      `),
      // `last_sequence < ?` keeps a replayed event from joining its text twice.
      appendReply: connection.prepare(`
        UPDATE code_transcript_search_projection
        SET body_text = body_text || ?,
            search_text = search_text || ?,
            part_count = part_count + 1,
            last_sequence = ?
        WHERE operation_id = ?
          AND content_role = 'assistant'
          AND thread_id = ?
          AND last_sequence < ?
          AND part_count < ?
      `),
      rewind: connection.prepare(`
        UPDATE code_transcript_search_projection
        SET rewound = 1
        WHERE thread_id = ?
          AND start_sequence >= (
            SELECT start_sequence FROM code_transcript_search_projection
            WHERE operation_id = ? AND content_role = 'user' AND thread_id = ?
          )
          AND start_sequence < ?
      `),
    };
    this.#statements.set(connection, statements);
    return statements;
  }
}

/**
 * The evidence text a reference names, or nothing when the row is gone or no
 * longer matches the reference: the conversation read shows no text then.
 */
function readEvidence(statements: Statements, reference: CodeEvidenceReference): string {
  const row = statements.evidence.get(reference.contentId) as
    | { readonly body_text: string; readonly digest: string; readonly byte_length: number }
    | undefined;
  if (row === undefined) return "";
  if (row.digest !== reference.digest || row.byte_length !== reference.byteLength) return "";
  return row.body_text;
}

export interface CodeTranscriptSearchMatch {
  readonly threadId: CodeThreadId;
  readonly operationId: CodeOperationId;
  readonly snippet: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

export interface CodeTranscriptSearchRows {
  readonly matches: ReadonlyArray<CodeTranscriptSearchMatch>;
  readonly truncated: boolean;
}

/**
 * One match per provider turn whose prompt or reply holds the needle, among
 * the threads the caller may list, newest thread first and oldest turn first
 * within it. Listing authority is applied in the query, before the cap, so
 * `truncated` counts only matches the caller may see.
 */
export function searchCodeTranscript(
  connection: SqliteConnection,
  query: string,
  visibleThreadIds: ReadonlySet<string>,
  limit: number = MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
): CodeTranscriptSearchRows {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0 || limit <= 0 || visibleThreadIds.size === 0) {
    return { matches: [], truncated: false };
  }
  const pattern = escapeLikePattern(normalized);
  const rows = connection
    .prepare(`
      SELECT search.thread_id, search.operation_id, search.body_text
      FROM code_transcript_search_projection AS search
      INNER JOIN code_thread_projection AS thread
        ON thread.thread_id = search.thread_id
      WHERE search.rewound = 0
        AND search.search_text LIKE '%' || ? || '%' ESCAPE '\\'
        AND search.thread_id IN (SELECT value FROM json_each(?))
        AND NOT (
          search.content_role = 'assistant'
          AND EXISTS (
            SELECT 1 FROM code_transcript_search_projection AS prompt
            WHERE prompt.operation_id = search.operation_id
              AND prompt.content_role = 'user'
              AND prompt.search_text LIKE '%' || ? || '%' ESCAPE '\\'
          )
        )
      ORDER BY thread.updated_at DESC, thread.thread_id ASC, search.start_sequence ASC
      LIMIT ?
    `)
    .all(pattern, JSON.stringify([...visibleThreadIds]), pattern, limit + 1) as ReadonlyArray<{
    readonly thread_id: string;
    readonly operation_id: string;
    readonly body_text: string;
  }>;
  return {
    truncated: rows.length > limit,
    matches: rows.slice(0, limit).map((row) => {
      const clipped = clipTranscriptSearchSnippet(row.body_text, normalized);
      return {
        threadId: decodeCodeThreadId(row.thread_id),
        operationId: decodeCodeOperationId(row.operation_id),
        snippet: clipped.snippet,
        matchRanges: clipped.matchRanges,
      };
    }),
  };
}
