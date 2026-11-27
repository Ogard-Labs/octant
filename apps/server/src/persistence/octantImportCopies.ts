import type { OctantImportCopy, OctantMode } from "@octant/contracts";
import { deterministicUuid } from "../deterministicUuid";
import {
  isExcludedOctantEvent,
  NEVER_COPIED_EVENT_NAMES,
  RENUMBERABLE_AGGREGATE_TYPES,
  THREAD_DELETION_EVENT_NAMES,
} from "./octantImportTables";
import type { SqliteConnection } from "./sqlitePort";
import { THREAD_AGGREGATE_TYPE_BY_MODE } from "./threadIdentity";

/**
 * A thread both apps changed since the last import arrives as a second,
 * continuable thread beside Nightly's, and a later import goes on with that
 * copy (docs/design/nightly-app.md#importing-from-octant).
 *
 * The copy is Octant's own journal for the thread, every frame of it, with
 * every id the thread owns replaced by one derived from the copy's id: the
 * thread's id, its turns, attempts, content and attachments, and the
 * aggregates that belong to it. Ids the thread only refers to (its Project,
 * provider instances, other threads) stay, so the copy points at the same
 * things. Because the ids derive from the copy's id alone, a later import
 * maps Octant's further events onto the same copy.
 *
 * The thread-move import each mode already has was not used: it needs the
 * running host, Chat carries only each turn's message and completed answers,
 * Work and Code carry the conversation as a transcript the first turn reads,
 * and none can append to the thread it made, so a later import could only
 * copy again.
 *
 * Code threads are never copied. A Code thread's file ids and checkout id
 * derive from its own id and its folder (`stableCodeFileId`,
 * `deriveManagedWorktreeCheckoutId`), and a worktree folder answers to one
 * thread, so a copy would be a second thread in Octant's checkout that its
 * own files do not recognize. Such a conflict stays held back and listed.
 */

/** Said in the copy's title so the person can tell the two threads apart. */
export const OCTANT_COPY_TITLE_SUFFIX = " (from Octant)";

/** Aggregates whose ids derive from a folder or a Code thread: a unit holding one is not copied. */
const REFUSED_COPY_AGGREGATE_PREFIXES = ["code-", "worktree-preparation"] as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Content tables keyed by a thread, and those keyed by an aggregate of it. */
const THREAD_CONTENT_TABLES = ["chat_content_store", "thread_tool_call_record_store"] as const;
const SUBJECT_CONTENT_TABLES = [
  {
    table: "context_summary_content_store",
    where: "subject_id IN (SELECT value FROM json_each(?))",
  },
  {
    table: "agent_run_content_store",
    where:
      "subject_id IN (SELECT value FROM json_each(?)) OR run_id IN (SELECT value FROM json_each(?))",
  },
] as const;

interface JournalRow {
  readonly global_sequence: number;
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_name: string;
  readonly event_version: number;
  readonly host_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly actor_json: string | null;
  readonly occurred_at: string;
  readonly payload_json: string;
}

/** The files of one copy: Octant's thread folders land under the copy's ids. */
export interface OctantImportCopyFiles {
  readonly octantThreadId: string;
  readonly copyThreadId: string;
  /** Octant id to copy id, for every id the thread owns. */
  readonly ids: ReadonlyMap<string, string>;
}

export interface OctantImportCopiesResult {
  /** The copy of each Octant thread a later import goes on with. */
  readonly copies: ReadonlyArray<OctantImportCopy>;
  /** Copies this import made. */
  readonly made: ReadonlyArray<OctantImportCopy>;
  /** Conflicting threads that got no copy: Code threads and threads whose journal cannot be copied. */
  readonly uncopied: ReadonlySet<string>;
  readonly events: number;
  readonly contentRows: number;
  /** Threads that received events: new copies and continued ones. */
  readonly threads: number;
  readonly files: ReadonlyArray<OctantImportCopyFiles>;
}

interface Span {
  readonly head: number;
}

/**
 * Makes the copies of `conflicts` and continues the copies earlier imports
 * made, in the caller's transaction with Octant's snapshot attached as
 * `octant`. A copy Nightly changed since the last import, or whose stream no
 * longer continues where Octant's next event expects it, has diverged: it
 * stays as a thread of Nightly's, and Octant's thread arrives as a new copy.
 */
export function mergeOctantCopies(input: {
  readonly connection: SqliteConnection;
  readonly importId: string;
  readonly octantMark: number;
  /** Octant's own journal head; events after it are the settling events this import added. */
  readonly octantHead: number;
  readonly nightlyMark: number;
  readonly previousCopies: ReadonlyArray<OctantImportCopy>;
  readonly conflicts: ReadonlySet<string>;
  readonly octantThreads: ReadonlyMap<string, ReadonlyArray<OctantMode>>;
  /** Every Octant aggregate key (JSON `[type, id]`) with the one thread it belongs to, if any. */
  readonly octantThreadOfKey: ReadonlyMap<string, string | undefined>;
  readonly nightlySpans: ReadonlyMap<string, Span>;
  readonly settlingTails: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly nightlyLastByThread: ReadonlyMap<string, number>;
  readonly purged: ReadonlySet<string>;
}): OctantImportCopiesResult {
  const connection = input.connection;
  const current = new Map(input.previousCopies.map((copy) => [copy.octantThreadId, copy]));
  const made: Array<OctantImportCopy> = [];
  const uncopied = new Set<string>();
  const files: Array<OctantImportCopyFiles> = [];
  let events = 0;
  let contentRows = 0;
  let threads = 0;

  const unitKeys = new Map<string, Array<string>>();
  for (const [key, thread] of input.octantThreadOfKey) {
    if (thread === undefined) continue;
    unitKeys.set(thread, [...(unitKeys.get(thread) ?? []), key]);
  }
  const work = new Set<string>([...input.conflicts, ...current.keys()]);
  if (work.size === 0) {
    return { copies: [...current.values()], made, uncopied, events, contentRows, threads, files };
  }
  const units = new Map<string, ReadonlyArray<JournalRow>>();
  for (const thread of work) units.set(thread, unitRows(connection, unitKeys.get(thread) ?? []));
  const external = externalIds(connection, input.octantThreadOfKey, units);

  const insert = connection.prepare(`
    INSERT INTO main.event_journal (
      event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
      host_id, correlation_id, causation_id, actor_kind, actor_id, actor_json, occurred_at,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const removeEvent = connection.prepare(
    "DELETE FROM main.event_journal WHERE global_sequence = ?",
  );

  for (const thread of [...work].sort()) {
    const rows = units.get(thread) ?? [];
    const modes = input.octantThreads.get(thread) ?? [];
    const mode = modes.length === 1 ? modes[0] : undefined;
    const previous = current.get(thread);
    if (mode === undefined || mode === "code" || refusesCopy(rows)) {
      if (previous === undefined) uncopied.add(thread);
      continue;
    }
    if (previous !== undefined) {
      // The person purged the copy in Nightly: it never comes back. And a
      // thread Octant did not go on with leaves its copy as it is.
      if (input.purged.has(previous.copyThreadId)) continue;
      if (
        !rows.some(
          (row) =>
            row.global_sequence > input.octantMark && row.global_sequence <= input.octantHead,
        )
      ) {
        continue;
      }
      const appended = planCopy({
        rows,
        thread,
        mode,
        copyThreadId: previous.copyThreadId,
        fromSequence: input.octantMark,
        external: external.get(thread) ?? new Set(),
        nightlySpans: input.nightlySpans,
        settlingTails: input.settlingTails,
      });
      const nightlyChanged =
        (input.nightlyLastByThread.get(previous.copyThreadId) ?? 0) > input.nightlyMark;
      if (appended !== undefined && !nightlyChanged) {
        for (const key of new Set(appended.events.map((event) => event.key))) {
          for (const sequence of input.settlingTails.get(key) ?? []) removeEvent.run(sequence);
        }
        for (const event of appended.events) insert.run(...event.values);
        events += appended.events.length;
        threads += 1;
        contentRows += copyContent(connection, {
          thread,
          copyThreadId: previous.copyThreadId,
          ids: appended.ids,
          external: external.get(thread) ?? new Set(),
          rows,
        });
        files.push({
          octantThreadId: thread,
          copyThreadId: previous.copyThreadId,
          ids: appended.ids,
        });
        continue;
      }
      // Diverged: the old copy is Nightly's thread now; Octant's comes over anew.
    }
    const copyThreadId = deterministicUuid(`octant-import-copy:${input.importId}:${thread}`);
    const copy = planCopy({
      rows,
      thread,
      mode,
      copyThreadId,
      fromSequence: 0,
      external: external.get(thread) ?? new Set(),
      nightlySpans: new Map(),
      settlingTails: new Map(),
    });
    if (copy === undefined || copy.events.length === 0) {
      if (previous === undefined) uncopied.add(thread);
      continue;
    }
    for (const event of copy.events) insert.run(...event.values);
    events += copy.events.length;
    threads += 1;
    contentRows += copyContent(connection, {
      thread,
      copyThreadId,
      ids: copy.ids,
      external: external.get(thread) ?? new Set(),
      rows,
    });
    files.push({ octantThreadId: thread, copyThreadId, ids: copy.ids });
    const entry = { mode, octantThreadId: thread, copyThreadId };
    current.set(thread, entry);
    made.push(entry);
  }
  return { copies: [...current.values()], made, uncopied, events, contentRows, threads, files };
}

function refusesCopy(rows: ReadonlyArray<JournalRow>): boolean {
  return rows.some((row) =>
    REFUSED_COPY_AGGREGATE_PREFIXES.some((prefix) => row.aggregate_type.startsWith(prefix)),
  );
}

/** Every event of a thread's unit in Octant's snapshot, in Octant's journal order. */
function unitRows(
  connection: SqliteConnection,
  keys: ReadonlyArray<string>,
): ReadonlyArray<JournalRow> {
  const select = connection.prepare(
    `SELECT global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
       event_name, event_version, host_id, correlation_id, causation_id, actor_kind, actor_id,
       actor_json, occurred_at, payload_json
     FROM octant.event_journal WHERE aggregate_type = ? AND aggregate_id = ?`,
  );
  const rows: Array<JournalRow> = [];
  for (const key of keys) {
    const [aggregateType, aggregateId] = JSON.parse(key) as [string, string];
    rows.push(...(select.all(aggregateType, aggregateId) as ReadonlyArray<JournalRow>));
  }
  return rows
    .filter((row) => !isExcludedOctantEvent(row.aggregate_type, row.event_name))
    .sort((a, b) => a.global_sequence - b.global_sequence);
}

/**
 * The ids each thread refers to but does not own: the id of any aggregate
 * outside the thread, and any id Octant's journal named outside the thread
 * before the thread first named it. An id the thread made (a turn, an
 * attachment) that something else names later still belongs to the thread.
 */
function externalIds(
  connection: SqliteConnection,
  threadOfKey: ReadonlyMap<string, string | undefined>,
  units: ReadonlyMap<string, ReadonlyArray<JournalRow>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const firstInside = new Map<string, Map<string, number>>();
  for (const [thread, rows] of units) {
    const first = new Map<string, number>();
    for (const row of rows) {
      for (const id of idsIn(row)) if (!first.has(id)) first.set(id, row.global_sequence);
    }
    firstInside.set(thread, first);
  }
  const external = new Map<string, Set<string>>();
  for (const thread of units.keys()) external.set(thread, new Set());
  for (const [key, owner] of threadOfKey) {
    const aggregateId = (JSON.parse(key) as [string, string])[1].toLowerCase();
    for (const [thread, first] of firstInside) {
      if (owner !== thread && first.has(aggregateId) && aggregateId !== thread.toLowerCase()) {
        external.get(thread)?.add(aggregateId);
      }
    }
  }
  const page = connection.prepare(
    `SELECT global_sequence, aggregate_type, aggregate_id, actor_id, actor_json, payload_json
     FROM octant.event_journal WHERE global_sequence > ? ORDER BY global_sequence LIMIT 1000`,
  );
  let after = 0;
  for (;;) {
    const rows = page.all(after) as ReadonlyArray<
      Pick<
        JournalRow,
        | "global_sequence"
        | "aggregate_type"
        | "aggregate_id"
        | "actor_id"
        | "actor_json"
        | "payload_json"
      >
    >;
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.global_sequence;
      const owner = threadOfKey.get(JSON.stringify([row.aggregate_type, row.aggregate_id]));
      const named = idsIn(row);
      for (const [thread, first] of firstInside) {
        if (owner === thread) continue;
        for (const id of named) {
          const inside = first.get(id);
          if (inside !== undefined && row.global_sequence < inside && id !== thread.toLowerCase()) {
            external.get(thread)?.add(id);
          }
        }
      }
    }
  }
  return external;
}

function idsIn(
  row: Pick<JournalRow, "aggregate_id" | "actor_id" | "actor_json" | "payload_json">,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const text of [row.aggregate_id, row.actor_id, row.actor_json ?? "", row.payload_json]) {
    for (const match of text.matchAll(UUID)) ids.add(match[0].toLowerCase());
  }
  return ids;
}

interface PlannedEvent {
  readonly key: string;
  readonly values: ReadonlyArray<string | number | null>;
}

/**
 * The copy's events for Octant's events after `fromSequence`, or undefined
 * when a stream cannot take them at the version Octant gave them: a stream
 * whose versions skip (a deletion or excluded event dropped from the middle)
 * or whose copy in Nightly ends elsewhere.
 */
function planCopy(input: {
  readonly rows: ReadonlyArray<JournalRow>;
  readonly thread: string;
  readonly mode: OctantMode;
  readonly copyThreadId: string;
  readonly fromSequence: number;
  readonly external: ReadonlySet<string>;
  readonly nightlySpans: ReadonlyMap<string, Span>;
  readonly settlingTails: ReadonlyMap<string, ReadonlyArray<number>>;
}):
  | { readonly events: ReadonlyArray<PlannedEvent>; readonly ids: ReadonlyMap<string, string> }
  | undefined {
  const ids = new Map<string, string>([[input.thread.toLowerCase(), input.copyThreadId]]);
  for (const row of input.rows) {
    for (const id of idsIn(row)) {
      if (!ids.has(id) && !input.external.has(id)) {
        ids.set(id, deterministicUuid(`octant-import-copy:${input.copyThreadId}:${id}`));
      }
    }
  }
  const remap = (text: string) => remapIds(text, ids);
  const unitEvents = new Set(input.rows.map((row) => row.event_id));
  const eventId = (id: string) =>
    deterministicUuid(`octant-import-copy:${input.copyThreadId}:event:${id}`);
  const threadType = THREAD_AGGREGATE_TYPE_BY_MODE[input.mode];
  const next = new Map<string, number>();
  const events: Array<PlannedEvent> = [];
  for (const row of input.rows) {
    if (row.global_sequence <= input.fromSequence) continue;
    if (NEVER_COPIED_EVENT_NAMES.has(row.event_name)) continue;
    // Deleting a thread in Octant never deletes the copy.
    if (THREAD_DELETION_EVENT_NAMES.has(row.event_name)) continue;
    const aggregateId = remap(row.aggregate_id);
    const key = JSON.stringify([row.aggregate_type, aggregateId]);
    const head =
      (input.nightlySpans.get(key)?.head ?? 0) - (input.settlingTails.get(key)?.length ?? 0);
    const version = next.get(key) ?? head + 1;
    if (
      !RENUMBERABLE_AGGREGATE_TYPES.has(row.aggregate_type) &&
      row.aggregate_version !== version
    ) {
      return undefined;
    }
    next.set(key, version + 1);
    let payload = remap(row.payload_json);
    if (row.aggregate_type === threadType && aggregateId === input.copyThreadId) {
      payload = titled(payload, input.copyThreadId);
    }
    events.push({
      key,
      values: [
        eventId(row.event_id),
        row.aggregate_type,
        aggregateId,
        version,
        row.event_name,
        row.event_version,
        row.host_id,
        row.correlation_id,
        // A cause inside the thread is the copy's own event; one outside stays.
        row.causation_id !== null && unitEvents.has(row.causation_id)
          ? eventId(row.causation_id)
          : row.causation_id,
        row.actor_kind,
        remap(row.actor_id),
        row.actor_json === null ? null : remap(row.actor_json),
        row.occurred_at,
        payload,
      ],
    });
  }
  return { events, ids };
}

export function remapIds(text: string, ids: ReadonlyMap<string, string>): string {
  return text.replace(UUID, (match) => ids.get(match.toLowerCase()) ?? match);
}

/** Every title the thread's own events give it says the copy came from Octant. */
function titled(payloadJson: string, copyThreadId: string): string {
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).map(([key, item]) => [key, walk(item)] as const);
    const out = Object.fromEntries(entries) as Record<string, unknown>;
    const names = record.id === copyThreadId || record.threadId === copyThreadId;
    if (
      names &&
      typeof out.title === "string" &&
      out.title.length > 0 &&
      !out.title.endsWith(OCTANT_COPY_TITLE_SUFFIX)
    ) {
      out.title = `${out.title}${OCTANT_COPY_TITLE_SUFFIX}`;
      changed = true;
    }
    return out;
  };
  const result = walk(JSON.parse(payloadJson));
  return changed ? JSON.stringify(result) : payloadJson;
}

/**
 * Copies the thread's out-of-journal content under the copy's ids, add only.
 * Bodies stay as they are; their digests are of the body.
 */
function copyContent(
  connection: SqliteConnection,
  input: {
    readonly thread: string;
    readonly copyThreadId: string;
    readonly ids: ReadonlyMap<string, string>;
    readonly external: ReadonlySet<string>;
    readonly rows: ReadonlyArray<JournalRow>;
  },
): number {
  const { thread, rows } = input;
  // A content id no event names still needs its own id in the copy, or the
  // add-only insert would keep Nightly's row of the same id instead.
  const ids = new Map(input.ids);
  const remap = (value: string) => {
    for (const match of value.matchAll(UUID)) {
      const id = match[0].toLowerCase();
      if (!ids.has(id) && !input.external.has(id)) {
        ids.set(id, deterministicUuid(`octant-import-copy:${input.copyThreadId}:${id}`));
      }
    }
    return remapIds(value, ids);
  };
  const aggregateIds = JSON.stringify([...new Set(rows.map((row) => row.aggregate_id))]);
  let copied = 0;
  const copyRows = (table: string, where: string, parameters: ReadonlyArray<string>) => {
    const columns = (
      connection.prepare(`PRAGMA octant.table_info(${table})`).all() as ReadonlyArray<{
        readonly name: string;
      }>
    ).map((column) => column.name);
    const source = connection
      .prepare(`SELECT ${columns.join(", ")} FROM octant.${table} WHERE ${where}`)
      .all(...parameters) as ReadonlyArray<Record<string, unknown>>;
    const insert = connection.prepare(
      `INSERT OR IGNORE INTO main.${table} (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of source) {
      const values = columns.map((column) => {
        const value = row[column];
        return column.endsWith("_id") && typeof value === "string" ? remap(value) : value;
      });
      copied += insert.run(...(values as Array<string | number | null>)).changes;
    }
  };
  for (const table of THREAD_CONTENT_TABLES) copyRows(table, "thread_id = ?", [thread]);
  for (const { table, where } of SUBJECT_CONTENT_TABLES) {
    copyRows(
      table,
      where,
      table === "agent_run_content_store" ? [aggregateIds, aggregateIds] : [aggregateIds],
    );
  }
  return copied;
}
