import {
  ProductFeedbackCaptured,
  ProductFeedbackDelivered,
  ProductFeedbackDiscarded,
  decodeProductFeedbackNote,
  type EventEnvelope,
  type ProductFeedbackNote,
  type ProductFeedbackNoteId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const PRODUCT_FEEDBACK_AGGREGATE = "product-feedback-note";
export const PRODUCT_FEEDBACK_CAPTURED = "feedback.note-captured@1";
export const PRODUCT_FEEDBACK_DISCARDED = "feedback.note-discarded@1";
export const PRODUCT_FEEDBACK_DELIVERED = "feedback.note-delivered@1";

const decodeCaptured = Schema.decodeUnknownSync(ProductFeedbackCaptured);
const decodeDiscarded = Schema.decodeUnknownSync(ProductFeedbackDiscarded);
const decodeDelivered = Schema.decodeUnknownSync(ProductFeedbackDelivered);

interface ProductFeedbackRow {
  readonly note_json: string;
  readonly aggregate_version: number;
}

/**
 * The read model behind a thread's waiting notes.
 *
 * Every event carries the whole note as the host settled it, so the projection
 * writes rather than merges and a replay lands on the same row however many
 * times it runs. `lifecycle` is stored beside the record because the only
 * question this projection is asked in the hot path — "what is still waiting on
 * this thread" — should not read every note the thread ever had.
 */
export class ProductFeedbackProjection implements Projection {
  readonly name = "product-feedback";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM product_feedback_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const note =
      event.eventName === PRODUCT_FEEDBACK_CAPTURED
        ? decodeCaptured(event.payload).note
        : event.eventName === PRODUCT_FEEDBACK_DISCARDED
          ? decodeDiscarded(event.payload).note
          : event.eventName === PRODUCT_FEEDBACK_DELIVERED
            ? decodeDelivered(event.payload).note
            : undefined;
    if (note === undefined) return;

    connection
      .prepare(
        `
      INSERT OR REPLACE INTO product_feedback_projection (
        note_id,
        thread_id,
        lifecycle,
        note_json,
        aggregate_version,
        last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        String(note.id),
        String(note.threadId),
        note.lifecycle,
        JSON.stringify(note),
        event.aggregateVersion,
        event.globalSequence,
      );
  }

  createTable(connection: SqliteConnection): void {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS product_feedback_projection (
        note_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        note_json TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);
  }
}

export function readProductFeedbackNote(
  connection: SqliteConnection,
  noteId: ProductFeedbackNoteId,
): ProductFeedbackNote | undefined {
  const row = connection
    .prepare(
      `SELECT note_json, aggregate_version FROM product_feedback_projection WHERE note_id = ?`,
    )
    .get(String(noteId)) as ProductFeedbackRow | undefined;
  return row === undefined ? undefined : decodeRow(row);
}

/**
 * A thread's notes, oldest first, including the ones already carried. A
 * delivered note stays readable so the transcript can still show what the user
 * pointed at when they asked.
 */
export function readProductFeedbackNotes(
  connection: SqliteConnection,
  threadId: string,
): ReadonlyArray<ProductFeedbackNote> {
  const rows = connection
    .prepare(
      `SELECT note_json, aggregate_version FROM product_feedback_projection
       WHERE thread_id = ? ORDER BY last_sequence ASC`,
    )
    .all(String(threadId)) as ReadonlyArray<ProductFeedbackRow>;
  return rows.map(decodeRow);
}

function decodeRow(row: ProductFeedbackRow): ProductFeedbackNote {
  const stored = decodeProductFeedbackNote(JSON.parse(row.note_json));
  return stored.version === row.aggregate_version
    ? stored
    : decodeProductFeedbackNote({ ...stored, version: row.aggregate_version });
}
