import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { listCredentialReferencesFromOctant } from "./octantCredentialReferences";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const now = "2026-11-27T12:00:00.000Z";
const id = (n: number) => `0c7a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = {
  provider: id(1),
  mcp: id(2),
  ssh: id(3),
  sshForgotten: id(4),
  thread: id(5),
  forgotten: id(6),
  web: id(7),
  desktop: id(8),
} as const;
const SECRET_VALUE = "sk-live-never-listed";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function folders() {
  const base = mkdtempSync(join(tmpdir(), "octant-references-"));
  directories.push(base);
  const octant = join(base, "Octant");
  const nightly = join(base, "Octant Nightly");
  mkdirSync(octant);
  mkdirSync(nightly);
  return { octant, nightly };
}

let sequence = 0;
function journal(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
  eventName: string,
  payload: unknown,
) {
  sequence += 1;
  connection
    .prepare(
      `INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version,
         event_name, event_version, host_id, correlation_id, actor_kind, actor_id, occurred_at,
         payload_json) VALUES (?, ?, ?, ?, ?, 1, 'local', ?, 'system', ?, ?, ?)`,
    )
    .run(
      id(1000 + sequence),
      aggregateType,
      aggregateId,
      sequence,
      eventName,
      id(2000 + sequence),
      id(9),
      now,
      JSON.stringify(payload),
    );
}

function octantStore(directory: string): void {
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  connection
    .prepare(
      `INSERT INTO provider_instance_projection (instance_id, schema_version, driver_kind, enabled,
         instance_json, aggregate_version) VALUES (?, 1, 'claude', 1, ?, 1)`,
    )
    .run(ids.provider, JSON.stringify({ value: SECRET_VALUE }));
  connection
    .prepare(
      `INSERT INTO web_search_settings_projection (singleton, settings_json, changed_at,
         aggregate_version, last_sequence) VALUES (1, ?, ?, 1, 1)`,
    )
    .run(
      JSON.stringify({ policy: "any", backends: [{ vendor: "x", credentialRef: ids.web }] }),
      now,
    );
  connection
    .prepare(
      `INSERT INTO project_projection (project_id, schema_version, project_type, lifecycle, pinned,
         project_json, aggregate_version) VALUES (?, 1, 'code', 'active', 0, ?, 1)`,
    )
    .run(id(50), JSON.stringify({ desktopRecipe: { credentialRef: ids.desktop } }));
  for (const [serverId, signIn] of [
    [ids.ssh, "octant-key"],
    [ids.sshForgotten, "octant-key"],
    [id(10), "ssh-agent"],
  ] as const)
    journal(connection, "shield-servers", id(11), "shield-servers.server-set@1", {
      server: { serverId, signIn },
    });
  journal(connection, "shield-servers", id(11), "shield-servers.server-removed@1", {
    serverId: ids.sshForgotten,
  });
  journal(connection, "thread-secret-memory", id(12), "thread-secret-memory.recorded@1", {
    name: "thread-secret.remembered",
    id: ids.thread,
    secretName: "TOKEN",
    source: "pasted",
  });
  journal(connection, "thread-secret-memory", id(12), "thread-secret-memory.recorded@1", {
    name: "thread-secret.remembered",
    id: ids.forgotten,
    secretName: "OLD",
    source: "pasted",
  });
  journal(connection, "thread-secret-memory", id(12), "thread-secret-memory.recorded@1", {
    name: "thread-secret.forgotten",
    id: ids.forgotten,
  });
  connection.close();
  const server = join(directory, "extensions", "user-added", "my-server");
  mkdirSync(server, { recursive: true });
  writeFileSync(
    join(server, "mcp.json"),
    JSON.stringify({
      mcpServers: { s: { headers: { Authorization: `\${OCTANT_SECRET:${ids.mcp}}` } } },
    }),
  );
}

function fingerprint(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!entry.name.endsWith("-shm"))
        files[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(directory);
  return files;
}

describe("listing the credentials Octant's data references", () => {
  it("names a provider key, an MCP server credential and an SSH key, and no value", () => {
    const { octant, nightly } = folders();
    octantStore(octant);
    const before = fingerprint(octant);
    const outcome = listCredentialReferencesFromOctant({
      octantDataDirectory: octant,
      nightlyDataDirectory: nightly,
      clock: () => now,
    });
    expect(outcome.kind).toBe("listed");
    if (outcome.kind !== "listed") return;
    const key = (reference: { namespace: string; id: string }) =>
      `${reference.namespace}:${reference.id}`;
    expect(outcome.references.map(key).sort()).toEqual(
      [
        `provider:${ids.provider}`,
        `mcp-server-credential:${ids.mcp}`,
        `ssh-key:${ids.ssh}`,
        `thread-secret-credential:${ids.thread}`,
        `web-search-credential:${ids.web}`,
        `desktop-provider-credential:${ids.desktop}`,
      ].sort(),
    );
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
    expect(fingerprint(octant)).toEqual(before);
    expect(readdirSync(join(nightly, "import"))).toEqual([]);
  });

  it("refuses a folder with no Octant store", () => {
    const { octant, nightly } = folders();
    expect(
      listCredentialReferencesFromOctant({
        octantDataDirectory: join(octant, "absent"),
        nightlyDataDirectory: nightly,
        clock: () => now,
      }),
    ).toEqual({ kind: "refused", reason: "octant-missing" });
    expect(
      listCredentialReferencesFromOctant({
        octantDataDirectory: octant,
        nightlyDataDirectory: nightly,
        clock: () => now,
      }),
    ).toEqual({ kind: "refused", reason: "octant-missing" });
  });
});
