import { openSqlite } from "./sqlitePort";

/**
 * The host's last completed reading of one local provider history view.
 *
 * This is a display cache in the same rebuildable accounting family as the
 * checkpoint cache beside it, never an input to an answer: a caller that asks
 * for the last read gets those totals with the earlier reading's range and
 * read time, and reads again for the current one. Without it every open of
 * Usage repaints every total while the bounded import runs, because the window
 * a surface asks for is anchored at "now" and so is never the same request
 * twice.
 */
export function createLocalUsageHistoryLastReadStore(path: string) {
  function withDatabase<T>(run: (connection: ReturnType<typeof openSqlite>) => T): T {
    const connection = openSqlite(path);
    try {
      connection.exec(
        "CREATE TABLE IF NOT EXISTS usage_last_reads (view TEXT PRIMARY KEY, response TEXT NOT NULL, complete INTEGER NOT NULL)",
      );
      return run(connection);
    } finally {
      connection.close();
    }
  }
  return {
    read(view: string): string | undefined {
      return withDatabase((connection) => {
        const row = connection
          .prepare("SELECT response FROM usage_last_reads WHERE view = ?")
          .get(view);
        return typeof row === "object" &&
          row !== null &&
          "response" in row &&
          typeof row.response === "string"
          ? row.response
          : undefined;
      });
    },
    /**
     * Keep the newest reading, except that an unfinished one never replaces a
     * finished one: a surface that opens this view should see the reading that
     * came back complete until another one does.
     */
    write(view: string, response: string, complete: boolean): void {
      withDatabase((connection) => {
        // The upsert is also the newest-reading guard: out of order is a
        // reality for an interrupted scan that finishes after a newer one
        // began, and the newer reading must not be overwritten by the older.
        // queryAt is a fixed-width UTC instant, so plain text comparison
        // orders it. A completed reading always wins; among two incomplete
        // ones the newer one does.
        connection
          .prepare(
            "INSERT INTO usage_last_reads (view, response, complete) VALUES (?, ?, ?) ON CONFLICT(view) DO UPDATE SET response = excluded.response, complete = excluded.complete WHERE (excluded.complete = 1 OR usage_last_reads.complete = 0) AND json_extract(excluded.response, '$.queryAt') >= json_extract(usage_last_reads.response, '$.queryAt')",
          )
          .run(view, response, complete ? 1 : 0);
      });
    },
  };
}

export type LocalUsageHistoryLastReadStore = ReturnType<
  typeof createLocalUsageHistoryLastReadStore
>;
