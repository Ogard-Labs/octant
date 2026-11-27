import { Schema } from "effect";
import { OctantMode } from "./modes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const ThreadIdText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));

/**
 * The record Octant Nightly keeps of each import of Octant's data
 * (docs/design/nightly-app.md#importing-from-octant). One aggregate holds
 * every import, so the newest record says how far the last import read.
 */
export const OCTANT_IMPORT_AGGREGATE_TYPE = "octant-import" as const;
export const OCTANT_IMPORT_AGGREGATE_ID = "0c7a0000-0000-4000-8000-000000000001";
export const OCTANT_IMPORT_RECORDED = "data.octant-import-recorded@1" as const;

/** An Octant thread both apps changed since the last import. */
export const OctantImportConflict = Schema.Struct({
  mode: OctantMode,
  octantThreadId: ThreadIdText,
}).annotations(strict);
export type OctantImportConflict = typeof OctantImportConflict.Type;

/** The Nightly copy a conflicting Octant thread arrived as. */
export const OctantImportCopy = Schema.Struct({
  mode: OctantMode,
  octantThreadId: ThreadIdText,
  copyThreadId: ThreadIdText,
}).annotations(strict);
export type OctantImportCopy = typeof OctantImportCopy.Type;

/** A record the import held back: Nightly's stream stays, or it has none yet. */
export const OctantImportHeldBack = Schema.Struct({
  aggregateType: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  aggregateId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
}).annotations(strict);
export type OctantImportHeldBack = typeof OctantImportHeldBack.Type;

export const OctantImportCounts = Schema.Struct({
  /** Octant events appended to Nightly's journal, settling events included. */
  events: NonNegativeInt,
  threads: NonNegativeInt,
  contentRows: NonNegativeInt,
  /** In-flight work that arrived settled or paused. */
  settled: NonNegativeInt,
}).annotations(strict);
export type OctantImportCounts = typeof OctantImportCounts.Type;

/**
 * What an import reports to the person: the recorded counts plus the files in
 * the data folder that came with them. The files are copied after the record
 * is written, so the record itself does not carry that count.
 */
export const OctantImportOutcomeCounts = Schema.Struct({
  ...OctantImportCounts.fields,
  /** Side files copied into Nightly's folder: attachments, images, icons, receipts. */
  files: NonNegativeInt,
}).annotations(strict);
export type OctantImportOutcomeCounts = typeof OctantImportOutcomeCounts.Type;

/**
 * `octantMark` is the newest journal position of Octant's this import read;
 * where Nightly's journal stood is the record's own journal position. Both
 * are global sequences, never aggregate versions, because compaction
 * renumbers versions. `conflicts` carries every conflicting thread that has
 * no copy yet, so a later import keeps holding it back instead of appending
 * Octant's newer events onto a stream that skipped some. `heldBack` carries
 * every held-back record Nightly has no stream for, so a later import lists
 * it again instead of taking its absence for a deletion in Nightly.
 */
export const OctantImportRecorded = Schema.Struct({
  importId: Schema.UUID,
  octantMark: NonNegativeInt,
  copies: Schema.Array(OctantImportCopy),
  conflicts: Schema.Array(OctantImportConflict),
  heldBack: Schema.Array(OctantImportHeldBack),
  counts: OctantImportCounts,
  /**
   * The Code threads this import brought from Octant, by id. A Code thread
   * may sit on a checkout both apps can reach (the Project's own folder), so
   * its first turn in Nightly moves it onto a worktree of Nightly's own; this
   * is how Nightly knows the thread came from Octant when no receipt says so.
   * Absent in a record written before the field existed.
   */
  codeThreadIds: Schema.optional(Schema.Array(ThreadIdText)),
}).annotations(strict);
export type OctantImportRecorded = typeof OctantImportRecorded.Type;
export const decodeOctantImportRecorded = Schema.decodeUnknownSync(OctantImportRecorded);
