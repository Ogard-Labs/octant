import {
  decodeContextSubjectRef,
  decodeThreadToolCallRecord,
  MAX_THREAD_TOOL_STEPS_PER_TURN,
  MAX_TOOL_CALL_RECORD_INPUT_BYTES,
  MAX_TOOL_CALL_RECORD_OUTPUT_BYTES,
  MAX_TOOL_CALL_RECORD_THREAD_BYTES,
  type ThreadExportToolCall,
  type ThreadToolCallRecord,
  type ThreadToolCallRecordMode,
} from "@octant/contracts";
import { isDeletingOrPurgedSubject } from "./agentRunContentStore";
import type { SqliteConnection } from "./sqlitePort";
import { THREAD_AGGREGATE_TYPE_BY_MODE } from "./threadIdentity";

/**
 * What Chat and Work tool calls were given and what they returned, owned by
 * the thread that made them.
 *
 * It is a store rather than a projection, and never the journal: the text is
 * thread content a purge has to destroy, no event carries it, and a rebuild
 * must not clear what no replay can restore. Chat journals a turn's whole
 * step list on every tool event, so anything kept on the step itself would be
 * written once per later event; here each call is written once. The table
 * carries `thread_id`, so the thread purge's sweep of thread-keyed rows takes
 * it without a rule of its own.
 */
export interface ThreadToolCallPartInput {
  readonly mode: ThreadToolCallRecordMode;
  readonly threadId: string;
  /** A Chat attempt id or a Work turn's request id. */
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly part: "input" | "output";
  readonly text: string;
  /** The text was already cut before it reached the store. */
  readonly truncated?: boolean;
  readonly recordedAt: string;
  /** Applied before anything is stored; the store never holds the text it was handed. */
  readonly redact: (text: string) => string;
  /** Whether a call's input names a protected secret file. */
  readonly namesProtectedPath: (text: string) => boolean;
  /** Test seam. Production uses the contract's bounds. */
  readonly limits?: {
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly threadBytes: number;
  };
}

export type ThreadToolCallPartOutcome =
  | { readonly status: "kept" }
  /** The call's input named a protected secret file, so its output is not kept. */
  | { readonly status: "withheld" }
  | { readonly status: "refused"; readonly reason: "thread-gone" | "turn-full" | "empty" };

interface Row {
  readonly turn_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly input_text: string | null;
  readonly input_truncated: number;
  readonly output_text: string | null;
  readonly output_truncated: number;
  readonly output_withheld: number;
  readonly recorded_at: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_IDENTIFIER_BYTES = 255;

function byteLength(text: string | null): number {
  return text === null ? 0 : encoder.encode(text).byteLength;
}

/** The head of `text` that fits `maximumBytes`, never ending inside a character. */
function head(
  text: string,
  maximumBytes: number,
): { readonly text: string; readonly cut: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maximumBytes) return { text, cut: false };
  // Slicing bytes can split a multi-byte character, which decodes to a
  // replacement character wider than the bytes it stands for.
  return {
    text: decoder.decode(bytes.slice(0, maximumBytes)).replace(/�+$/, ""),
    cut: true,
  };
}

/** Cut the way a tool step's id and name are, so a record and its step share one key. */
function identifier(text: string): string {
  return head(text.trim(), MAX_IDENTIFIER_BYTES).text.trimEnd();
}

export function writeThreadToolCallPart(
  connection: SqliteConnection,
  input: ThreadToolCallPartInput,
): ThreadToolCallPartOutcome {
  const subject = decodeContextSubjectRef({
    aggregateType: THREAD_AGGREGATE_TYPE_BY_MODE[input.mode],
    aggregateId: input.threadId,
  });
  // A late tool event must not bring content back while a deletion runs or
  // after a purge finished.
  if (isDeletingOrPurgedSubject(connection, subject)) {
    return { status: "refused", reason: "thread-gone" };
  }
  const toolCallId = identifier(input.toolCallId);
  const turnId = identifier(input.turnId);
  if (toolCallId === "" || turnId === "" || input.text === "") {
    return { status: "refused", reason: "empty" };
  }
  const limits = input.limits ?? {
    inputBytes: MAX_TOOL_CALL_RECORD_INPUT_BYTES,
    outputBytes: MAX_TOOL_CALL_RECORD_OUTPUT_BYTES,
    threadBytes: MAX_TOOL_CALL_RECORD_THREAD_BYTES,
  };
  return connection.transaction((): ThreadToolCallPartOutcome => {
    const existing = connection
      .prepare(
        `SELECT input_text, output_text, output_withheld FROM thread_tool_call_record_store
         WHERE mode = ? AND thread_id = ? AND turn_id = ? AND tool_call_id = ?`,
      )
      .get(input.mode, input.threadId, turnId, toolCallId) as
      | Pick<Row, "input_text" | "output_text" | "output_withheld">
      | undefined;
    if (existing === undefined) {
      const held = connection
        .prepare(
          `SELECT count(*) AS calls FROM thread_tool_call_record_store
           WHERE mode = ? AND thread_id = ? AND turn_id = ?`,
        )
        .get(input.mode, input.threadId, turnId) as { readonly calls: number };
      // A call past the turn's step limit has no row to open, so its record
      // would be unreachable.
      if (held.calls >= MAX_THREAD_TOOL_STEPS_PER_TURN) {
        return { status: "refused", reason: "turn-full" };
      }
    }
    // Judged on the text as handed over: redaction or the cut must not hide
    // the path from the rule that withholds the output.
    const withheld =
      existing?.output_withheld === 1 ||
      (input.part === "input" && input.namesProtectedPath(input.text));
    const kept =
      input.part === "output" && withheld
        ? undefined
        : head(
            input.redact(input.text),
            input.part === "input" ? limits.inputBytes : limits.outputBytes,
          );
    const inputText =
      input.part === "input" ? (kept?.text ?? null) : (existing?.input_text ?? null);
    const outputText = withheld
      ? null
      : input.part === "output"
        ? (kept?.text ?? null)
        : (existing?.output_text ?? null);
    const truncated = kept !== undefined && (kept.cut || input.truncated === true) ? 1 : 0;
    const storedBytes = byteLength(inputText) + byteLength(outputText);
    const toolName = identifier(input.toolName ?? "");
    connection
      .prepare(
        `INSERT INTO thread_tool_call_record_store (
          mode, thread_id, turn_id, tool_call_id, tool_name, input_text, input_truncated,
          output_text, output_truncated, output_withheld, stored_bytes, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mode, thread_id, turn_id, tool_call_id) DO UPDATE SET
          tool_name = CASE WHEN excluded.tool_name = 'Tool' THEN tool_name ELSE excluded.tool_name END,
          input_text = excluded.input_text,
          input_truncated = CASE WHEN ? = 'input' THEN excluded.input_truncated ELSE input_truncated END,
          output_text = excluded.output_text,
          output_truncated = CASE WHEN ? = 'output' THEN excluded.output_truncated ELSE output_truncated END,
          output_withheld = excluded.output_withheld,
          stored_bytes = excluded.stored_bytes`,
      )
      .run(
        input.mode,
        input.threadId,
        turnId,
        toolCallId,
        toolName === "" ? "Tool" : toolName,
        inputText,
        input.part === "input" ? truncated : 0,
        outputText,
        input.part === "output" ? truncated : 0,
        withheld ? 1 : 0,
        storedBytes,
        input.recordedAt,
        input.part,
        input.part,
      );
    dropOldestPastTotal(connection, input.mode, input.threadId, limits.threadBytes, {
      turnId,
      toolCallId,
    });
    return input.part === "output" && withheld ? { status: "withheld" } : { status: "kept" };
  })();
}

function dropOldestPastTotal(
  connection: SqliteConnection,
  mode: ThreadToolCallRecordMode,
  threadId: string,
  maximumBytes: number,
  current: { readonly turnId: string; readonly toolCallId: string },
): void {
  const total = () =>
    (
      connection
        .prepare(
          `SELECT coalesce(sum(stored_bytes), 0) AS bytes FROM thread_tool_call_record_store
           WHERE mode = ? AND thread_id = ?`,
        )
        .get(mode, threadId) as { readonly bytes: number }
    ).bytes;
  const oldest = connection.prepare(
    `SELECT rowid AS row_id FROM thread_tool_call_record_store
     WHERE mode = ? AND thread_id = ? AND NOT (turn_id = ? AND tool_call_id = ?)
     ORDER BY rowid LIMIT 1`,
  );
  const drop = connection.prepare("DELETE FROM thread_tool_call_record_store WHERE rowid = ?");
  while (total() > maximumBytes) {
    const row = oldest.get(mode, threadId, current.turnId, current.toolCallId) as
      | { readonly row_id: number }
      | undefined;
    // The call being written is the newest; it is never dropped for itself.
    if (row === undefined) return;
    drop.run(row.row_id);
  }
}

const COLUMNS = `turn_id, tool_call_id, tool_name, input_text, input_truncated, output_text,
  output_truncated, output_withheld, recorded_at`;

function recordOf(row: Row): ThreadToolCallRecord {
  return decodeThreadToolCallRecord({
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    ...(row.input_text === null
      ? {}
      : { input: { text: row.input_text, truncated: row.input_truncated === 1 } }),
    ...(row.output_text === null
      ? {}
      : { output: { text: row.output_text, truncated: row.output_truncated === 1 } }),
    ...(row.output_withheld === 1 ? { outputWithheld: "protected-path" } : {}),
    recordedAt: row.recorded_at,
  });
}

/** One turn's records in the order its calls were first recorded. */
export function readThreadToolCallRecords(
  connection: SqliteConnection,
  input: {
    readonly mode: ThreadToolCallRecordMode;
    readonly threadId: string;
    readonly turnId: string;
  },
): ReadonlyArray<ThreadToolCallRecord> {
  const rows = connection
    .prepare(
      `SELECT ${COLUMNS} FROM thread_tool_call_record_store
       WHERE mode = ? AND thread_id = ? AND turn_id = ? ORDER BY rowid`,
    )
    .all(input.mode, input.threadId, input.turnId) as ReadonlyArray<Row>;
  return rows.map(recordOf);
}

/** Every record a thread holds, oldest first, as a thread export carries them. */
export function listThreadToolCallRecords(
  connection: SqliteConnection,
  input: { readonly mode: ThreadToolCallRecordMode; readonly threadId: string },
): ReadonlyArray<ThreadExportToolCall> {
  const rows = connection
    .prepare(
      `SELECT ${COLUMNS} FROM thread_tool_call_record_store
       WHERE mode = ? AND thread_id = ? ORDER BY rowid`,
    )
    .all(input.mode, input.threadId) as ReadonlyArray<Row>;
  return rows.map((row) => ({ turnId: row.turn_id, ...recordOf(row) }));
}

/** Removes every record one thread holds. */
export function purgeThreadToolCallRecords(
  connection: SqliteConnection,
  mode: ThreadToolCallRecordMode,
  threadId: string,
): void {
  connection
    .prepare("DELETE FROM thread_tool_call_record_store WHERE mode = ? AND thread_id = ?")
    .run(mode, threadId);
}
