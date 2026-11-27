import {
  OCTANT_IMPORT_AGGREGATE_ID,
  OCTANT_IMPORT_AGGREGATE_TYPE,
  OCTANT_IMPORT_RECORDED,
  decodeOctantImportRecorded,
  type OctantImportConflict,
  type OctantImportCopy,
  type OctantImportCounts,
  type OctantImportHeldBack,
  type OctantMode,
} from "@octant/contracts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import type { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { mergeOctantCopies, type OctantImportCopyFiles } from "./octantImportCopies";
import {
  isExcludedOctantEvent,
  NEVER_COPIED_EVENT_NAMES,
  RECORD_REMOVAL_EVENT_NAMES,
  RENUMBERABLE_AGGREGATE_TYPES,
  REPLACED_SETTINGS_AGGREGATE_TYPES,
  SELF_OBSERVED_AGGREGATE_TYPES,
  THREAD_DELETION_EVENT_NAMES,
} from "./octantImportTables";
import { ProjectionRegistry } from "./projection";
import type { SqliteConnection } from "./sqlitePort";
import { threadModeOfAggregateType } from "./threadIdentity";

/** A non-thread aggregate both apps changed since the last import: Nightly's stays. */
export type OctantImportKept = OctantImportHeldBack;

export interface OctantImportMergeResult {
  readonly counts: OctantImportCounts;
  readonly conflicts: ReadonlyArray<OctantImportConflict>;
  readonly kept: ReadonlyArray<OctantImportKept>;
  /** Octant threads that came over: the only ones whose files may follow. */
  readonly threads: ReadonlySet<string>;
  /** Every aggregate id that came over, for content keyed by a Project or other record. */
  readonly aggregates: ReadonlySet<string>;
  /** Ids of the images the image jobs that came over name, for the library's files. */
  readonly imageArtifacts: ReadonlySet<string>;
  /** Copies of conflicting threads this import made. */
  readonly copies: ReadonlyArray<OctantImportCopy>;
  /** The files each copy made or continued brings, under the copy's ids. */
  readonly copyFiles: ReadonlyArray<OctantImportCopyFiles>;
}

interface CandidateRow {
  readonly global_sequence: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_name: string;
  /** 1 for a Canvas mirror setting that names a folder of the host's choosing. */
  readonly names_host_folder: number;
}

interface AggregateSpan {
  readonly head: number;
  /** Nightly's newest change to the stream; a purge record is not one. */
  readonly lastChange: number;
  /** The one thread the stream's payloads name at their top level, if exactly one. */
  readonly namedThread: string | undefined;
}

/**
 * Merges the migrated, settled snapshot of Octant's store (attached as
 * `octant`) into a copy of Nightly's store, in the caller's transaction
 * (docs/design/nightly-app.md#importing-from-octant). It decides by journal
 * positions and event ids, never by aggregate version:
 *
 * - An Octant thread (its own aggregate plus every aggregate whose id is the
 *   thread's or whose payloads name it, and only it, as `threadId`) with
 *   events since the last import comes over when Nightly has not touched it
 *   since then. Nightly changed it too, or a previous import already held it
 *   back: it is a conflict and Nightly's thread stays as it is. A thread
 *   Nightly purged never comes back. A whole stream belongs to one side, so
 *   a stream that names its thread on only some events never splits.
 * - Any other aggregate comes over when Nightly has not changed it since the
 *   last import. On the first import a settings stream both stores hold is
 *   replaced by Octant's (REPLACED_SETTINGS_AGGREGATE_TYPES); otherwise
 *   Nightly's stays and is listed.
 * - A stream is appended only at the version Octant's next event expects, so
 *   payloads that carry their own version stay true (see
 *   RENUMBERABLE_AGGREGATE_TYPES). A stream whose versions diverged counts as
 *   changed on both sides.
 * - Settling events an import adds ride along with the aggregate they settle,
 *   and never alone make it count as changed. Once in Nightly they stay on
 *   Octant's line: when Octant goes on with a stream whose Nightly end is
 *   only such events, they are dropped for Octant's own, and the snapshot's
 *   fresh settling events follow if the work is still in flight.
 * - A conflicting thread arrives as a copy beside Nightly's, and a thread an
 *   earlier import copied goes on in its copy, never in Nightly's thread
 *   (octantImportCopies.ts). With `makeCopies` false, the conflicts stay
 *   held back and the copies are not continued.
 */
export function mergeOctantSnapshot(input: {
  readonly connection: SqliteConnection;
  readonly registry: EventRegistry;
  /** Octant's own journal head, before the import added settling events. */
  readonly octantHead: number;
  readonly settled: number;
  readonly importId: string;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly makeCopies: boolean;
}): OctantImportMergeResult {
  const connection = input.connection;
  const records = readImports(connection);
  const previous = records.at(-1);
  const firstImport = previous === undefined;
  const octantMark = previous?.octantMark ?? 0;
  const nightlyMark = previous?.nightlyMark ?? 0;
  const previousCopies = previous?.copies ?? [];
  const copiedThreads = new Set(previousCopies.map((copy) => copy.octantThreadId));

  const octantThreads = octantThreadModes(connection);
  const octantSpans = aggregateSpans(connection, "octant");
  const nightlySpans = aggregateSpans(connection, "main");
  const nightlyLastByThread = lastChangeByThread(nightlySpans);
  const settlingTails = settlingEventTails(
    connection,
    records.map((record) => record.importId),
    nightlySpans,
  );
  const octantFirst = octantFirstSequences(connection);
  const earlierHeldBack = new Set(previous?.heldBack.map(aggregateKey));
  const purged = new Set(
    (
      connection
        .prepare("SELECT DISTINCT thread_id FROM main.thread_purge_tombstone")
        .all() as ReadonlyArray<{ readonly thread_id: string }>
    ).map((row) => row.thread_id),
  );

  const candidates = (
    connection
      .prepare(
        `SELECT source.global_sequence, source.aggregate_type, source.aggregate_id,
           source.aggregate_version, source.event_name,
           CASE WHEN source.event_name = 'artifact.mirror-setting-changed@1' THEN
             coalesce(json_extract(source.payload_json, '$.settings.fallback.kind') = 'global-folder', 0)
             OR EXISTS (SELECT 1 FROM json_each(source.payload_json, '$.settings.overrides') AS override
               WHERE json_extract(override.value, '$.destination.kind') = 'global-folder')
           ELSE 0 END AS names_host_folder
         FROM octant.event_journal AS source
         WHERE source.global_sequence > ?
           AND NOT EXISTS (SELECT 1 FROM main.event_journal AS own WHERE own.event_id = source.event_id)
         ORDER BY source.global_sequence`,
      )
      .all(octantMark) as ReadonlyArray<CandidateRow>
  ).filter((row) => !isExcludedOctantEvent(row.aggregate_type, row.event_name));

  const threadOf = (row: CandidateRow): string | undefined => {
    if (octantThreads.has(row.aggregate_id)) return row.aggregate_id;
    const named = octantSpans.get(aggregateKey(row))?.namedThread;
    return named !== undefined && octantThreads.has(named) ? named : undefined;
  };
  const isReal = (row: CandidateRow) => row.global_sequence <= input.octantHead;
  /** Nightly's head with any trailing settling events counted as Octant's. */
  const nightlyHead = (key: string) =>
    (nightlySpans.get(key)?.head ?? 0) - (settlingTails.get(key)?.length ?? 0);

  // Which threads and aggregates Octant really advanced since the last import.
  const advancedThreads = new Set<string>();
  const advancedAggregates = new Set<string>();
  for (const row of candidates) {
    if (!isReal(row)) continue;
    const thread = threadOf(row);
    if (thread === undefined) advancedAggregates.add(aggregateKey(row));
    else advancedThreads.add(thread);
  }

  const conflicts = new Set<string>(previous?.conflicts.map((entry) => entry.octantThreadId));
  for (const thread of advancedThreads) {
    if (purged.has(thread) || copiedThreads.has(thread)) continue;
    const nightlyLast = nightlyLastByThread.get(thread);
    if (nightlyLast !== undefined && (firstImport || nightlyLast > nightlyMark)) {
      conflicts.add(thread);
    }
  }

  // Every non-thread aggregate held back keeps all of Nightly's stream.
  const held = new Map<string, OctantImportHeldBack>();
  const hold = (row: CandidateRow) =>
    held.set(aggregateKey(row), {
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
    });
  const replaced = new Set<string>();
  const aggregateDecision = (row: CandidateRow): "append" | "replace" | "hold" | "skip" => {
    const key = aggregateKey(row);
    if (!advancedAggregates.has(key)) return "skip";
    const nightly = nightlySpans.get(key);
    // Deletions are never mirrored: Octant removing a record Nightly holds
    // leaves Nightly's record, and the whole stream with it.
    if (nightly !== undefined && RECORD_REMOVAL_EVENT_NAMES.has(row.event_name)) return "hold";
    // Nightly never writes into a folder Octant writes to, as with worktrees
    // and share links. One setting event carries the default and every
    // Project's choice, so one naming a chosen folder anywhere stays behind
    // whole rather than being rewritten; the stream is listed as kept.
    if (row.names_host_folder === 1) return "hold";
    if (nightly === undefined) {
      if (earlierHeldBack.has(key)) return "hold";
      // Octant had it before the last import and Nightly no longer does:
      // Nightly deleted it, and deletions are never mirrored.
      const first = octantFirst.get(key) ?? 0;
      return !firstImport && first <= octantMark ? "skip" : "append";
    }
    if (firstImport) {
      if (REPLACED_SETTINGS_AGGREGATE_TYPES.has(row.aggregate_type)) return "replace";
      // The retention stream also holds Nightly's purge records: Octant's
      // window lands after them and, applied last, takes effect.
      if (row.aggregate_type === "thread-retention") return "append";
      return "hold";
    }
    return nightly.lastChange > nightlyMark ? "hold" : "append";
  };

  // Assign each accepted event its Nightly version. A thread whose stream
  // cannot continue at Nightly's head becomes a conflict, which withholds
  // more events, so the pass repeats until nothing new is held back.
  let accepted: ReadonlyArray<{ readonly row: CandidateRow; readonly version: number }> = [];
  for (;;) {
    const blockedThreads = new Set<string>();
    const next: Array<{ readonly row: CandidateRow; readonly version: number }> = [];
    const nextVersion = new Map<string, number>();
    const blockedAggregates = new Set<string>();
    for (const row of candidates) {
      const key = aggregateKey(row);
      const thread = threadOf(row);
      let take: boolean;
      if (thread !== undefined) {
        take =
          advancedThreads.has(thread) &&
          !conflicts.has(thread) &&
          !copiedThreads.has(thread) &&
          !purged.has(thread) &&
          !NEVER_COPIED_EVENT_NAMES.has(row.event_name) &&
          !(THREAD_DELETION_EVENT_NAMES.has(row.event_name) && nightlyLastByThread.has(thread));
      } else {
        const decision = aggregateDecision(row);
        if (decision === "replace") replaced.add(key);
        if (decision === "hold") hold(row);
        take =
          (decision === "append" || decision === "replace") &&
          !NEVER_COPIED_EVENT_NAMES.has(row.event_name);
      }
      const renumberable = RENUMBERABLE_AGGREGATE_TYPES.has(row.aggregate_type);
      if (!take) {
        if (!renumberable && nextVersion.has(key)) blockedAggregates.add(key);
        continue;
      }
      if (blockedAggregates.has(key)) {
        if (thread === undefined) hold(row);
        else blockedThreads.add(thread);
        continue;
      }
      const head = replaced.has(key) ? 0 : nightlyHead(key);
      const version = nextVersion.get(key) ?? head + 1;
      if (!renumberable && row.aggregate_version !== version) {
        blockedAggregates.add(key);
        if (thread === undefined) hold(row);
        else blockedThreads.add(thread);
        continue;
      }
      nextVersion.set(key, version + 1);
      next.push({ row, version });
    }
    const newlyBlocked = [...blockedThreads].filter((thread) => !conflicts.has(thread));
    if (newlyBlocked.length === 0) {
      accepted = next.filter((event) => !held.has(aggregateKey(event.row)));
      break;
    }
    for (const thread of newlyBlocked) conflicts.add(thread);
  }

  const receiving = new Set(accepted.map((event) => aggregateKey(event.row)));
  const removeStream = connection.prepare(
    "DELETE FROM main.event_journal WHERE aggregate_type = ? AND aggregate_id = ?",
  );
  for (const key of replaced) {
    if (!receiving.has(key)) continue;
    const [aggregateType, aggregateId] = JSON.parse(key) as [string, string];
    removeStream.run(aggregateType, aggregateId);
  }
  const removeEvent = connection.prepare(
    "DELETE FROM main.event_journal WHERE global_sequence = ?",
  );
  for (const [key, sequences] of settlingTails) {
    if (!receiving.has(key) || replaced.has(key)) continue;
    for (const sequence of sequences) removeEvent.run(sequence);
  }

  const insert = connection.prepare(`
    INSERT INTO main.event_journal (
      event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
      host_id, correlation_id, causation_id, actor_kind, actor_id, actor_json, occurred_at,
      payload_json
    )
    SELECT event_id, aggregate_type, aggregate_id, ?, event_name, event_version,
      host_id, correlation_id, causation_id, actor_kind, actor_id, actor_json, occurred_at,
      payload_json
    FROM octant.event_journal WHERE global_sequence = ?
  `);
  const importedThreads = new Set<string>();
  const importedIds = new Set<string>();
  for (const { row, version } of accepted) {
    insert.run(version, row.global_sequence);
    importedIds.add(row.aggregate_id);
    const thread = threadOf(row);
    if (thread !== undefined) importedThreads.add(thread);
  }

  const imageArtifacts = new Set<string>();
  for (const { row } of accepted) {
    if (row.aggregate_type === "image-job") collectAttachmentIds(connection, row, imageArtifacts);
  }
  const contentRows = copyContent(connection, importedThreads, importedIds);

  const octantThreadOfKey = new Map<string, string | undefined>();
  for (const [key, span] of octantSpans) {
    const [, aggregateId] = JSON.parse(key) as [string, string];
    const named = span.namedThread;
    octantThreadOfKey.set(
      key,
      octantThreads.has(aggregateId)
        ? aggregateId
        : named !== undefined && octantThreads.has(named)
          ? named
          : undefined,
    );
  }
  const copied = input.makeCopies
    ? mergeOctantCopies({
        connection,
        importId: input.importId,
        octantMark,
        octantHead: input.octantHead,
        nightlyMark,
        previousCopies,
        conflicts,
        octantThreads,
        octantThreadOfKey,
        nightlySpans,
        settlingTails,
        nightlyLastByThread,
        purged,
      })
    : {
        copies: previousCopies,
        made: [],
        uncopied: conflicts,
        events: 0,
        contentRows: 0,
        threads: 0,
        files: [],
      };
  const conflictList: ReadonlyArray<OctantImportConflict> = [...copied.uncopied]
    .sort()
    .flatMap((thread) =>
      (octantThreads.get(thread) ?? []).map((mode) => ({ mode, octantThreadId: thread })),
    );
  const counts: OctantImportCounts = {
    events: accepted.length + copied.events,
    threads: importedThreads.size + copied.threads,
    contentRows: contentRows + copied.contentRows,
    settled: input.settled,
  };
  const heldBack = [...held.entries()]
    .filter(([key]) => !nightlySpans.has(key))
    .map(([, entry]) => entry);
  // Copies are never Code threads, so only threads appended under their own ids are listed.
  const codeThreadIds = [...importedThreads]
    .filter((thread) => octantThreads.get(thread)?.includes("code") === true)
    .sort();
  appendImportRecord(input, {
    octantMark: input.octantHead,
    copies: copied.copies,
    conflicts: conflictList,
    heldBack,
    counts,
    codeThreadIds,
  });
  // The next start verifies the merged journal whole, not from a watermark
  // that described Nightly's journal before the merge.
  connection.exec("DELETE FROM main.journal_verification_watermark");
  const kept = [...held.values()].filter(
    (entry) => !SELF_OBSERVED_AGGREGATE_TYPES.has(entry.aggregateType),
  );
  return {
    counts,
    conflicts: conflictList,
    kept,
    threads: importedThreads,
    aggregates: importedIds,
    imageArtifacts,
    copies: copied.made,
    copyFiles: copied.files,
  };
}

/** The `attachmentId` of every image an imported job event names, however deep. */
function collectAttachmentIds(
  connection: SqliteConnection,
  row: CandidateRow,
  into: Set<string>,
): void {
  const event = connection
    .prepare("SELECT payload_json FROM octant.event_journal WHERE global_sequence = ?")
    .get(row.global_sequence) as { readonly payload_json: string };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key === "attachmentId" && typeof item === "string") into.add(item);
        else walk(item);
      }
    }
  };
  walk(JSON.parse(event.payload_json));
}

function aggregateKey(
  row:
    | { readonly aggregateType: string; readonly aggregateId: string }
    | {
        readonly aggregate_type: string;
        readonly aggregate_id: string;
      },
): string {
  return "aggregateType" in row
    ? JSON.stringify([row.aggregateType, row.aggregateId])
    : JSON.stringify([row.aggregate_type, row.aggregate_id]);
}

interface ImportRecordRow {
  readonly importId: string;
  readonly nightlyMark: number;
  readonly octantMark: number;
  readonly copies: ReadonlyArray<OctantImportCopy>;
  readonly conflicts: ReadonlyArray<OctantImportConflict>;
  readonly heldBack: ReadonlyArray<OctantImportHeldBack>;
}

/** Every import record, oldest first; the newest says where the last import stood. */
function readImports(connection: SqliteConnection): ReadonlyArray<ImportRecordRow> {
  const rows = connection
    .prepare(
      `SELECT global_sequence, payload_json FROM main.event_journal
       WHERE aggregate_type = ? AND event_name = ? ORDER BY global_sequence`,
    )
    .all(OCTANT_IMPORT_AGGREGATE_TYPE, OCTANT_IMPORT_RECORDED) as ReadonlyArray<{
    readonly global_sequence: number;
    readonly payload_json: string;
  }>;
  return rows.map((row) => {
    const record = decodeOctantImportRecorded(JSON.parse(row.payload_json));
    return {
      importId: record.importId,
      nightlyMark: row.global_sequence,
      octantMark: record.octantMark,
      copies: record.copies,
      conflicts: record.conflicts,
      heldBack: record.heldBack,
    };
  });
}

/**
 * The settling events an import added (correlated by the import's id) that
 * end each Nightly stream, newest first: those after the stream's last event
 * of any other origin.
 */
function settlingEventTails(
  connection: SqliteConnection,
  importIds: ReadonlyArray<string>,
  nightlySpans: ReadonlyMap<string, AggregateSpan>,
): ReadonlyMap<string, ReadonlyArray<number>> {
  if (importIds.length === 0) return new Map();
  const rows = connection
    .prepare(
      `SELECT aggregate_type, aggregate_id, aggregate_version, global_sequence
       FROM main.event_journal
       WHERE correlation_id IN (SELECT value FROM json_each(?)) AND aggregate_type <> ?`,
    )
    .all(JSON.stringify(importIds), OCTANT_IMPORT_AGGREGATE_TYPE) as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly aggregate_version: number;
    readonly global_sequence: number;
  }>;
  const byStream = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const key = aggregateKey(row);
    const versions = byStream.get(key) ?? new Map<number, number>();
    versions.set(row.aggregate_version, row.global_sequence);
    byStream.set(key, versions);
  }
  const tails = new Map<string, ReadonlyArray<number>>();
  for (const [key, versions] of byStream) {
    const tail: Array<number> = [];
    for (let version = nightlySpans.get(key)?.head ?? 0; versions.has(version); version -= 1) {
      tail.push(versions.get(version) ?? 0);
    }
    if (tail.length > 0) tails.set(key, tail);
  }
  return tails;
}

function octantThreadModes(
  connection: SqliteConnection,
): ReadonlyMap<string, ReadonlyArray<OctantMode>> {
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_type, aggregate_id FROM octant.event_journal
       WHERE aggregate_type IN ('chat-thread', 'work-thread', 'code-thread')`,
    )
    .all() as ReadonlyArray<{ readonly aggregate_type: string; readonly aggregate_id: string }>;
  const modes = new Map<string, Array<OctantMode>>();
  for (const row of rows) {
    const mode = threadModeOfAggregateType(row.aggregate_type);
    if (mode === undefined) continue;
    modes.set(row.aggregate_id, [...(modes.get(row.aggregate_id) ?? []), mode]);
  }
  return modes;
}

/** Nightly's newest change naming each id: as an aggregate's own id, or as its one named thread. */
function lastChangeByThread(
  spans: ReadonlyMap<string, AggregateSpan>,
): ReadonlyMap<string, number> {
  const last = new Map<string, number>();
  const note = (key: string, sequence: number) =>
    last.set(key, Math.max(last.get(key) ?? 0, sequence));
  for (const [key, span] of spans) {
    const [, aggregateId] = JSON.parse(key) as [string, string];
    note(aggregateId, span.lastChange);
    if (span.namedThread !== undefined) note(span.namedThread, span.lastChange);
  }
  return last;
}

function aggregateSpans(
  connection: SqliteConnection,
  schema: "main" | "octant",
): ReadonlyMap<string, AggregateSpan> {
  const rows = connection
    .prepare(
      `SELECT aggregate_type, aggregate_id, max(aggregate_version) AS head,
         coalesce(max(CASE WHEN event_name NOT IN (SELECT value FROM json_each(?))
           THEN global_sequence END), 0) AS last_change,
         count(DISTINCT thread_id) AS threads, min(thread_id) AS thread_id
       FROM (
         SELECT aggregate_type, aggregate_id, aggregate_version, event_name, global_sequence,
           CASE WHEN json_valid(payload_json) AND json_type(payload_json, '$.threadId') = 'text'
             THEN json_extract(payload_json, '$.threadId') END AS thread_id
         FROM ${schema}.event_journal
       ) GROUP BY aggregate_type, aggregate_id`,
    )
    .all(JSON.stringify([...NEVER_COPIED_EVENT_NAMES])) as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly head: number;
    readonly last_change: number;
    readonly threads: number;
    readonly thread_id: string | null;
  }>;
  return new Map(
    rows.map((row) => [
      aggregateKey(row),
      {
        head: row.head,
        lastChange: row.last_change,
        namedThread: row.threads === 1 && row.thread_id !== null ? row.thread_id : undefined,
      },
    ]),
  );
}

function octantFirstSequences(connection: SqliteConnection): ReadonlyMap<string, number> {
  const rows = connection
    .prepare(
      `SELECT aggregate_type, aggregate_id, min(global_sequence) AS first
       FROM octant.event_journal GROUP BY aggregate_type, aggregate_id`,
    )
    .all() as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly first: number;
  }>;
  return new Map(rows.map((row) => [aggregateKey(row), row.first]));
}

/**
 * Copies the out-of-journal content of what came over, add only: a row
 * Nightly already holds keeps Nightly's value. Thread-keyed content follows
 * the threads that came over, subject-keyed content the aggregates that
 * did, and Code evidence the files Octant's Code projection lists for those
 * threads. Content of a held-back or purged thread never comes over.
 */
function copyContent(
  connection: SqliteConnection,
  threads: ReadonlySet<string>,
  aggregateIds: ReadonlySet<string>,
): number {
  connection.exec(`
    CREATE TEMP TABLE octant_import_thread (id TEXT PRIMARY KEY) STRICT;
    CREATE TEMP TABLE octant_import_aggregate (id TEXT PRIMARY KEY) STRICT;
  `);
  try {
    const addThread = connection.prepare("INSERT INTO temp.octant_import_thread (id) VALUES (?)");
    for (const thread of threads) addThread.run(thread);
    const addAggregate = connection.prepare(
      "INSERT INTO temp.octant_import_aggregate (id) VALUES (?)",
    );
    for (const id of aggregateIds) addAggregate.run(id);
    const statements = [
      `INSERT OR IGNORE INTO main.chat_content_store SELECT * FROM octant.chat_content_store
       WHERE thread_id IN (SELECT id FROM temp.octant_import_thread)`,
      `INSERT OR IGNORE INTO main.thread_tool_call_record_store
       SELECT * FROM octant.thread_tool_call_record_store
       WHERE thread_id IN (SELECT id FROM temp.octant_import_thread)`,
      `INSERT OR IGNORE INTO main.context_summary_content_store
       SELECT * FROM octant.context_summary_content_store
       WHERE subject_id IN (SELECT id FROM temp.octant_import_aggregate)`,
      `INSERT OR IGNORE INTO main.agent_run_content_store SELECT * FROM octant.agent_run_content_store
       WHERE subject_id IN (SELECT id FROM temp.octant_import_aggregate)
          OR run_id IN (SELECT id FROM temp.octant_import_aggregate)`,
      `INSERT OR IGNORE INTO main.code_evidence_content_store
       SELECT * FROM octant.code_evidence_content_store
       WHERE content_id IN (
         SELECT content_id FROM octant.code_file_projection
         WHERE content_id IS NOT NULL
           AND thread_id IN (SELECT id FROM temp.octant_import_thread))`,
      `INSERT OR IGNORE INTO main.usage_reasoning_outside_output
       SELECT * FROM octant.usage_reasoning_outside_output`,
      `INSERT OR IGNORE INTO main.usage_unreported_guarded_turn
       SELECT * FROM octant.usage_unreported_guarded_turn`,
    ];
    let copied = 0;
    for (const [index, sql] of statements.entries()) {
      const changes = connection.prepare(sql).run().changes;
      // The usage markers are bookkeeping, not content a person brought over.
      if (index < 5) copied += changes;
    }
    return copied;
  } finally {
    connection.exec(
      "DROP TABLE temp.octant_import_thread; DROP TABLE temp.octant_import_aggregate;",
    );
  }
}

function appendImportRecord(
  input: {
    readonly connection: SqliteConnection;
    readonly registry: EventRegistry;
    readonly importId: string;
    readonly clock: () => string;
    readonly uuid: () => string;
  },
  record: {
    readonly octantMark: number;
    readonly copies: ReadonlyArray<OctantImportCopy>;
    readonly conflicts: ReadonlyArray<OctantImportConflict>;
    readonly heldBack: ReadonlyArray<OctantImportHeldBack>;
    readonly counts: OctantImportCounts;
    /** The Code threads this import appended events for; a reader unions every record's. */
    readonly codeThreadIds: ReadonlyArray<string>;
  },
): void {
  // Appended through the journal so the registry validates it; only the
  // aggregate heads are kept, since the whole store is rebuilt next.
  const journal = new Journal({
    connection: input.connection,
    registry: input.registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: input.clock,
  });
  const head = input.connection
    .prepare(
      `SELECT coalesce(max(aggregate_version), 0) AS head FROM main.event_journal
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .get(OCTANT_IMPORT_AGGREGATE_TYPE, OCTANT_IMPORT_AGGREGATE_ID) as { readonly head: number };
  journal.append({
    aggregate: {
      aggregateType: OCTANT_IMPORT_AGGREGATE_TYPE,
      aggregateId: OCTANT_IMPORT_AGGREGATE_ID,
    },
    expectedVersion: head.head,
    events: [
      {
        eventId: input.uuid(),
        eventName: OCTANT_IMPORT_RECORDED,
        eventVersion: 1,
        correlationId: input.uuid(),
        actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: input.clock(),
        payload: { importId: input.importId, ...record },
      },
    ],
  });
}
