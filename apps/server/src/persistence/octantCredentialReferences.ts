import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseVersionTooNew } from "./migrationErrors";
import { applyMigrations, MIGRATIONS } from "./migrations";
import {
  admittedOctantStore,
  fail,
  ImportStopped,
  refuse,
  snapshotOctantStore,
  type OctantImportOutcome,
} from "./octantImport";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

export interface OctantCredentialReference {
  readonly namespace: string;
  readonly id: string;
}

export type OctantCredentialReferencesOutcome =
  | { readonly kind: "listed"; readonly references: ReadonlyArray<OctantCredentialReference> }
  | Exclude<OctantImportOutcome, { readonly kind: "imported" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_REFERENCE = /^\$\{OCTANT_SECRET:([0-9a-f-]{36})\}$/;
const MAX_MCP_FILE_BYTES = 1_000_000;
const MAX_MCP_FOLDERS = 1_000;

/**
 * Where each credential namespace's ids are recorded in Octant's data. Only
 * ids are read; a value is never in the store, and the credential stores hold
 * it under these ids.
 *
 * | namespace                   | id                | recorded in                                              |
 * | --------------------------- | ----------------- | -------------------------------------------------------- |
 * | provider                    | provider instance | provider_instance_projection.instance_id                 |
 * | mcp-server-credential       | secret id         | extensions/user-added/<name>/mcp.json `${OCTANT_SECRET:id}` |
 * | desktop-provider-credential | credentialRef     | project_projection.project_json $.desktopRecipe          |
 * | web-search-credential       | credentialRef     | web_search_settings_projection.settings_json backends    |
 * | ssh-key                     | server id         | shield-servers journal: servers signing in with octant-key |
 * | thread-secret-credential    | remembered id     | thread-secret-memory journal: pasted, not forgotten      |
 *
 * A source that is missing, unreadable or malformed is skipped: the list is
 * what could be named, and an item left out is only not copied.
 */
export function listCredentialReferencesFromOctant(input: {
  readonly octantDataDirectory: string;
  readonly nightlyDataDirectory: string;
  readonly clock: () => string;
}): OctantCredentialReferencesOutcome {
  const importDirectory = join(input.nightlyDataDirectory, "import", `references-${randomUUID()}`);
  try {
    const store = admittedOctantStore(input.octantDataDirectory, input.nightlyDataDirectory);
    mkdirSync(importDirectory, { recursive: true, mode: 0o700 });
    const snapshotPath = join(importDirectory, "octant.sqlite3");
    snapshotOctantStore(store, snapshotPath);
    const found = new Map<string, OctantCredentialReference>();
    const add = (namespace: string, id: unknown) => {
      if (typeof id !== "string" || !UUID.test(id)) return;
      found.set(`${namespace}\u0000${id.toLowerCase()}`, { namespace, id });
    };
    let snapshot: SqliteConnection;
    try {
      snapshot = openSqlite(snapshotPath);
    } catch {
      throw fail("snapshot");
    }
    try {
      try {
        applyMigrations(snapshot, MIGRATIONS, input.clock);
      } catch (error) {
        if (error instanceof DatabaseVersionTooNew) throw refuse("octant-newer");
        throw fail("migrate-snapshot");
      }
      readProviders(snapshot, add);
      readDesktopRecipes(snapshot, add);
      readWebSearch(snapshot, add);
      readSshKeys(snapshot, add);
      readRememberedThreadSecrets(snapshot, add);
    } finally {
      snapshot.close();
    }
    readMcpSecrets(join(input.octantDataDirectory, "extensions", "user-added"), add);
    return { kind: "listed", references: [...found.values()] };
  } catch (error) {
    if (error instanceof ImportStopped) return error.outcome;
    throw error;
  } finally {
    rmSync(importDirectory, { recursive: true, force: true });
  }
}

type Add = (namespace: string, id: unknown) => void;

const skipping = (read: () => void): void => {
  try {
    read();
  } catch {
    // An unreadable source names nothing.
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parse = (json: unknown): unknown => {
  try {
    return typeof json === "string" ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
};

function readProviders(snapshot: SqliteConnection, add: Add): void {
  skipping(() => {
    for (const row of snapshot
      .prepare("SELECT instance_id FROM provider_instance_projection")
      .all() as ReadonlyArray<{ readonly instance_id: unknown }>)
      add("provider", row.instance_id);
  });
}

function readDesktopRecipes(snapshot: SqliteConnection, add: Add): void {
  skipping(() => {
    for (const row of snapshot
      .prepare("SELECT project_json FROM project_projection WHERE project_type = 'code'")
      .all() as ReadonlyArray<{ readonly project_json: unknown }>)
      add(
        "desktop-provider-credential",
        record(record(parse(row.project_json))?.["desktopRecipe"])?.["credentialRef"],
      );
  });
}

function readWebSearch(snapshot: SqliteConnection, add: Add): void {
  skipping(() => {
    const row = snapshot
      .prepare("SELECT settings_json FROM web_search_settings_projection WHERE singleton = 1")
      .get() as { readonly settings_json: unknown } | undefined;
    const backends = record(parse(row?.settings_json))?.["backends"];
    if (Array.isArray(backends))
      for (const entry of backends as ReadonlyArray<unknown>)
        add("web-search-credential", record(entry)?.["credentialRef"]);
  });
}

/** Replays the account list and each Project's own list, as the server registry does. */
function readSshKeys(snapshot: SqliteConnection, add: Add): void {
  skipping(() => {
    const account = new Map<string, unknown>();
    const overrides = new Map<string, ReadonlyArray<unknown>>();
    const rows = snapshot
      .prepare(
        `SELECT event_name, payload_json FROM event_journal
         WHERE aggregate_type = 'shield-servers' ORDER BY global_sequence`,
      )
      .all() as ReadonlyArray<{ readonly event_name: unknown; readonly payload_json: unknown }>;
    for (const row of rows) {
      const payload = record(parse(row.payload_json));
      if (payload === undefined) continue;
      if (row.event_name === "shield-servers.server-set@1") {
        const server = record(payload["server"]);
        if (typeof server?.["serverId"] === "string") account.set(server["serverId"], server);
      } else if (row.event_name === "shield-servers.server-removed@1") {
        if (typeof payload["serverId"] === "string") account.delete(payload["serverId"]);
      } else if (row.event_name === "shield-servers.project-servers-set@1") {
        if (typeof payload["projectId"] === "string" && Array.isArray(payload["servers"]))
          overrides.set(payload["projectId"], payload["servers"] as ReadonlyArray<unknown>);
      } else if (row.event_name === "shield-servers.project-override-cleared@1") {
        if (typeof payload["projectId"] === "string") overrides.delete(payload["projectId"]);
      }
    }
    for (const server of [...account.values(), ...[...overrides.values()].flat()]) {
      const fields = record(server);
      if (fields?.["signIn"] === "octant-key") add("ssh-key", fields["serverId"]);
    }
  });
}

/** A pasted value is in the credential store under its remembered id; a linked item is only an address. */
function readRememberedThreadSecrets(snapshot: SqliteConnection, add: Add): void {
  skipping(() => {
    const remembered = new Map<string, boolean>();
    const rows = snapshot
      .prepare(
        `SELECT payload_json FROM event_journal
         WHERE aggregate_type = 'thread-secret-memory' ORDER BY global_sequence`,
      )
      .all() as ReadonlyArray<{ readonly payload_json: unknown }>;
    for (const row of rows) {
      const payload = record(parse(row.payload_json));
      const id = payload?.["id"];
      if (typeof id !== "string") continue;
      if (payload?.["name"] === "thread-secret.remembered")
        remembered.set(id, payload["source"] === "pasted");
      else if (payload?.["name"] === "thread-secret.forgotten") remembered.delete(id);
    }
    for (const [id, pasted] of remembered) if (pasted) add("thread-secret-credential", id);
  });
}

function readMcpSecrets(folder: string, add: Add): void {
  skipping(() => {
    if (!existsSync(folder) || !lstatSync(folder).isDirectory()) return;
    const visit = (value: unknown): void => {
      if (typeof value === "string")
        add("mcp-server-credential", SECRET_REFERENCE.exec(value)?.[1]);
      else if (Array.isArray(value))
        for (const entry of value as ReadonlyArray<unknown>) visit(entry);
      else if (typeof value === "object" && value !== null)
        for (const entry of Object.values(value)) visit(entry);
    };
    for (const name of readdirSync(folder).slice(0, MAX_MCP_FOLDERS)) {
      skipping(() => {
        const file = join(folder, name, "mcp.json");
        const info = lstatSync(file);
        if (!info.isFile() || info.size > MAX_MCP_FILE_BYTES) return;
        visit(parse(readFileSync(file, "utf8")));
      });
    }
  });
}
