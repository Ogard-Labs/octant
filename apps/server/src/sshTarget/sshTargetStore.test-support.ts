import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { SshTargetStore } from "./sshTargetStore";

/**
 * A journal-backed SSH target store in `directory`, migrated and projected as
 * the host's own is, for tests that need targets to persist and replay. Pin
 * files go under `dataDirectory`.
 */
export function openSshTargetTestStore(
  directory: string,
  dataDirectory = join(directory, "data"),
): {
  readonly store: SshTargetStore;
  readonly journal: Journal;
  readonly connection: SqliteConnection;
} {
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  const clock = () => new Date().toISOString();
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  const store = new SshTargetStore({
    journal,
    connection,
    dataDirectory,
    uuid: randomUUID,
    clock,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  return { store, journal, connection };
}
