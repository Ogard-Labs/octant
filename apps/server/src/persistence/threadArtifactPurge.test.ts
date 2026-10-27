import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_MIRROR_EVENT_NAMES } from "@octant/contracts/artifact-mirror";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { removeMirrorFiles } from "./threadArtifactPurge";

/**
 * Runs just before a path is removed, so a test can swap a folder then. A
 * removal from a held folder names the entry by its final component only, so
 * tests match on that.
 */
const removing = vi.hoisted(() => ({
  before: (_path: string): void => undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      removing.before(String(args[0]));
      return await actual.rm(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      removing.before(String(args[0]));
      return await actual.unlink(...args);
    },
  };
});
// macOS removes a name through a child process working in the proven folder.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      argv: ReadonlyArray<string>,
      options: { readonly cwd?: string },
      callback: (error: Error | null) => void,
    ) => {
      removing.before(`${options.cwd ?? ""}/${argv[argv.length - 1] ?? ""}`);
      return actual.execFile(file, argv, options, callback);
    },
  };
});

const now = "2026-10-27T12:00:00.000Z";
const canvasId = "c7460000-0000-4000-8000-000000000001";
const projectId = "c7460000-0000-4000-8000-000000000002";
const names = ["plan-c7460000.octant.json", "plan-c7460000.md", "plan-c7460000.svg"] as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  removing.before = () => undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type DestinationKind = "project-repository" | "global-folder";

/**
 * A Canvas mirrored into a destination root, with the receipt and re-import
 * events a purge reads, and a host folder holding files with the same names,
 * so a removal that follows the mirrored folder swapped for a link to it
 * deletes host files rather than finding nothing.
 */
function mirroredCanvas(kind: DestinationKind) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mirror-purge-")));
  const root = join(base, kind === "project-repository" ? "checkout" : "mirrors");
  const folder = kind === "project-repository" ? "docs/artifacts" : "launch-project";
  const outside = join(base, "outside");
  const paths = names.map((name) => `${folder}/${name}`);
  mkdirSync(join(root, folder), { recursive: true });
  mkdirSync(outside);
  for (const path of paths) writeFileSync(join(root, path), "mirrored");
  for (const name of names) writeFileSync(join(outside, name), "host file");

  const connection = openSqlite(join(base, "events.sqlite3"));
  cleanups.push(() => {
    connection.close();
    rmSync(base, { recursive: true, force: true });
  });
  applyMigrations(connection, MIGRATIONS, () => now);
  connection
    .prepare(
      `INSERT INTO project_projection (
        project_id, schema_version, project_type, lifecycle, pinned, project_json, aggregate_version
      ) VALUES (?, 1, 'code', 'active', 0, ?, 1)`,
    )
    .run(projectId, JSON.stringify({ id: projectId, binding: { canonicalRoot: root } }));
  insertEvent(connection, 1, ARTIFACT_MIRROR_EVENT_NAMES.written, {
    receipt: {
      canvasId,
      projectId,
      destination:
        kind === "project-repository"
          ? { kind, relativeDirectory: folder }
          : { kind, canonicalRoot: root },
      paths,
      outcome: "written",
    },
  });
  insertEvent(connection, 2, ARTIFACT_MIRROR_EVENT_NAMES.reimported, {
    canvasId,
    versionId: randomUUID(),
    path: join(root, paths[0] ?? ""),
  });

  return {
    connection,
    /** The mirrored files still on disk. */
    remaining: () => paths.filter((path) => existsSync(join(root, path))),
    /** Every name and byte under the host folder, to prove nothing there changed. */
    host: () => snapshot(outside),
    toLink: () => {
      renameSync(join(root, folder), join(root, `${folder}-real`));
      symlinkSync(outside, join(root, folder));
    },
  };
}

function insertEvent(
  connection: SqliteConnection,
  version: number,
  eventName: string,
  payload: unknown,
): void {
  connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
        correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
      ) VALUES (?, 'artifact-mirror', ?, ?, ?, 1, ?, 'system', 'system', ?, ?, 'local')`,
    )
    .run(randomUUID(), canvasId, version, eventName, randomUUID(), now, JSON.stringify(payload));
}

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    entries[name] = readFileSync(join(directory, name), "utf8");
  }
  return entries;
}

describe("purging a Canvas's mirrored files", () => {
  // A repository receipt's paths already start with the destination folder.
  // Joining the folder onto the root a second time named files that never
  // existed, so a purged thread's sidecars stayed in the checkout.
  it.each(["project-repository", "global-folder"] as const)(
    "removes every file the Canvas mirrored into a %s",
    async (kind) => {
      const canvas = mirroredCanvas(kind);

      await removeMirrorFiles(canvas.connection, [canvasId]);

      expect(canvas.remaining()).toEqual([]);
    },
  );

  // An agent in the destination can rename the mirrored folder and leave a
  // link to a host folder holding the same names. A path removal followed it
  // and the purge deleted the host files.
  it.each(["project-repository", "global-folder"] as const)(
    "deletes nothing in a host folder linked in place of the %s's mirrored folder, and still completes",
    async (kind) => {
      const canvas = mirroredCanvas(kind);
      canvas.toLink();
      const before = canvas.host();

      await expect(removeMirrorFiles(canvas.connection, [canvasId])).resolves.toBeUndefined();

      expect(canvas.host()).toEqual(before);
    },
  );

  it.each(["project-repository", "global-folder"] as const)(
    "deletes nothing in a host folder swapped in for the %s's mirrored folder during a removal",
    async (kind) => {
      const canvas = mirroredCanvas(kind);
      const before = canvas.host();
      let swapped = false;
      removing.before = (path) => {
        if (swapped || !names.some((name) => path.endsWith(`/${name}`))) return;
        swapped = true;
        canvas.toLink();
      };

      await expect(removeMirrorFiles(canvas.connection, [canvasId])).resolves.toBeUndefined();

      expect(swapped).toBe(true);
      expect(canvas.host()).toEqual(before);
    },
  );
});
