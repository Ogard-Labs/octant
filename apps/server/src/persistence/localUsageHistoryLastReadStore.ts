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
        "CREATE TABLE IF NOT EXISTS usage_last_reads (view TEXT PRIMARY KEY, response TEXT NOT NULL)",
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
    write(view: string, response: string): void {
      withDatabase((connection) => {
        connection
          .prepare(
            "INSERT INTO usage_last_reads (view, response) VALUES (?, ?) ON CONFLICT(view) DO UPDATE SET response = excluded.response",
          )
          .run(view, response);
      });
    },
  };
}

export type LocalUsageHistoryLastReadStore = ReturnType<
  typeof createLocalUsageHistoryLastReadStore
>;
