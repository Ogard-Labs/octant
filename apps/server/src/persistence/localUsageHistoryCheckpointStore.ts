import { openSqlite } from "./sqlitePort";

/** Rebuildable accounting cache, separate from the authoritative event journal. */
export function createLocalUsageHistoryCheckpointStore(path: string) {
  function withDatabase<T>(run: (connection: ReturnType<typeof openSqlite>) => T): T {
    const connection = openSqlite(path);
    try {
      connection.exec(
        "CREATE TABLE IF NOT EXISTS usage_checkpoints (source TEXT PRIMARY KEY, snapshot TEXT NOT NULL)",
      );
      return run(connection);
    } finally {
      connection.close();
    }
  }
  return {
    read(source: string): string | undefined {
      return withDatabase((connection) => {
        const row = connection
          .prepare("SELECT snapshot FROM usage_checkpoints WHERE source = ?")
          .get(source);
        return typeof row === "object" &&
          row !== null &&
          "snapshot" in row &&
          typeof row.snapshot === "string"
          ? row.snapshot
          : undefined;
      });
    },
    write(source: string, snapshot: string): void {
      withDatabase((connection) => {
        connection
          .prepare(
            "INSERT INTO usage_checkpoints (source, snapshot) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET snapshot = excluded.snapshot",
          )
          .run(source, snapshot);
      });
    },
  };
}
