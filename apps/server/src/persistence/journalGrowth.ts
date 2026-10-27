import {
  decodeJournalGrowth,
  JOURNAL_GROWTH_WINDOW_DAYS,
  type JournalGrowth,
} from "@octant/contracts";
import type { SqliteConnection } from "./sqlitePort";

interface GrowthRow {
  readonly kind: string;
  readonly day: string;
  readonly events: number;
}

const DAY_MS = 86_400_000;

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** The window's UTC days as YYYY-MM-DD, oldest first, today last. */
export function journalGrowthDays(now: Date): ReadonlyArray<string> {
  return Array.from({ length: JOURNAL_GROWTH_WINDOW_DAYS }, (_, index) =>
    utcDay(now.getTime() - (JOURNAL_GROWTH_WINDOW_DAYS - 1 - index) * DAY_MS),
  );
}

/**
 * Journal events per aggregate kind per UTC day for the last
 * {@link JOURNAL_GROWTH_WINDOW_DAYS} days, today included, plus the journal head
 * sequence and the database file size.
 *
 * It runs one grouped query that the `event_journal_occurred_at` covering index
 * answers from the newest entries, so cost follows the window rather than the
 * journal. It reads kind names and counts only: no payload, identifier, or
 * thread or project name leaves the database. Call it when diagnostics are
 * opened or exported, never on a timer.
 */
export function readJournalGrowth(connection: SqliteConnection, now: Date): JournalGrowth {
  const days = journalGrowthDays(now);
  const firstDay = days[0] ?? utcDay(now.getTime());
  const rows = connection
    .prepare(
      `SELECT aggregate_type AS kind, substr(occurred_at, 1, 10) AS day, count(*) AS events
       FROM event_journal INDEXED BY event_journal_occurred_at
       WHERE occurred_at >= ?
       GROUP BY aggregate_type, day`,
    )
    .all(firstDay) as ReadonlyArray<GrowthRow>;

  const byKind = new Map<string, number[]>();
  for (const row of rows) {
    const column = days.indexOf(row.day);
    // A future-dated row (clock skew) falls outside the window.
    if (column < 0) continue;
    const counts = byKind.get(row.kind) ?? Array.from({ length: days.length }, () => 0);
    counts[column] = (counts[column] ?? 0) + row.events;
    byKind.set(row.kind, counts);
  }
  const kinds = [...byKind]
    .map(([kind, counts]) => ({
      kind,
      counts,
      total: counts.reduce((sum, count) => sum + count, 0),
    }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));

  // The head is the rowid maximum, a b-tree edge read. Counting every row would
  // scan an index that grows with all retained events, on the request path.
  const head = connection
    .prepare("SELECT max(global_sequence) AS head FROM event_journal")
    .get() as {
    readonly head: number | null;
  };
  const size = connection
    .prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()")
    .get() as { readonly bytes: number };

  return decodeJournalGrowth({
    generatedAt: now.toISOString(),
    days,
    kinds,
    journalHead: head.head ?? 0,
    databaseBytes: size.bytes,
  });
}
