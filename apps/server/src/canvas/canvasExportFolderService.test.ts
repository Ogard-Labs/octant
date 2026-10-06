import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventActor, type UtcTimestamp } from "@octant/contracts";
import { decodeCanvasExportFolderSettings } from "@octant/contracts/canvas-export-folder";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createCanvasExportFilePort } from "./canvasExportFilePort";
import { registerCanvasExportFolderEvents } from "./canvasExportFolderEventStore";
import { CanvasExportFolderService } from "./canvasExportFolderService";

const directories: string[] = [];
const now = "2026-08-01T21:00:00.000Z";
const projectId = "77777777-7777-4777-8777-777777777777";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A home on this machine nobody else can read, holding one writable folder. */
function homeWithFolder(): { readonly home: string; readonly folder: string } {
  const home = join(tmpdir(), `octant-export-home-${randomUUID()}`);
  mkdirSync(home, { mode: 0o700 });
  directories.push(home);
  const folder = join(home, "Exports");
  mkdirSync(folder, { mode: 0o700 });
  return { home, folder };
}

function connection(): SqliteConnection {
  const directory = join(tmpdir(), `octant-export-folder-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  directories.push(directory);
  const opened = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(opened, MIGRATIONS, () => now);
  return opened;
}

function serviceOver(
  openConnection: SqliteConnection,
  home: string,
): { readonly service: CanvasExportFolderService; readonly journal: Journal } {
  const journal = new Journal({
    connection: openConnection,
    registry: registerCanvasExportFolderEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const service = new CanvasExportFolderService({
    journal,
    uuid: randomUUID,
    actor,
    clock: () => now as UtcTimestamp,
    files: createCanvasExportFilePort(),
    home,
    standingOutsideApproval: false,
  });
  return { service, journal };
}

describe("canvas export folders", () => {
  it("remembers a Project's folder and finds it again after a restart", () => {
    const { home, folder } = homeWithFolder();
    const open = connection();
    const first = serviceOver(open, home);

    const chosen = first.service.choose({
      scope: "project",
      projectId,
      folder,
      expectedVersion: 0,
    });
    expect(chosen).toMatchObject({ kind: "canvas-export-folder-settings" });
    expect(first.service.folderFor(projectId)).toBe(folder);

    // A restart: a new service replays the journal rather than being told.
    const restarted = serviceOver(open, home);
    expect(restarted.service.folderFor(projectId)).toBe(folder);
    expect(restarted.service.settings().version).toBe(1);
    open.close();
  });

  it("keeps the host folder for a thread filed nowhere, beside a Project's own", () => {
    const { home, folder } = homeWithFolder();
    const other = join(home, "Handovers");
    mkdirSync(other, { mode: 0o700 });
    const open = connection();
    const { service } = serviceOver(open, home);

    service.choose({ scope: "host", folder, expectedVersion: 0 });
    service.choose({ scope: "project", projectId, folder: other, expectedVersion: 1 });

    expect(service.folderFor(undefined)).toBe(folder);
    expect(service.folderFor(projectId)).toBe(other);
    expect(service.folderFor(otherProjectId)).toBe(folder);
    open.close();
  });

  it("refuses a folder outside home while no standing approval exists", () => {
    const { home } = homeWithFolder();
    const outside = join(tmpdir(), `octant-outside-${randomUUID()}`);
    mkdirSync(outside, { mode: 0o700 });
    directories.push(outside);
    const open = connection();
    const { service } = serviceOver(open, home);

    const refused = service.choose({
      scope: "project",
      projectId,
      folder: outside,
      expectedVersion: 0,
    });

    expect(refused).toMatchObject({ kind: "canvas-export-folder-refused", reason: "outside-home" });
    expect(service.folderFor(projectId)).toBeUndefined();
    open.close();
  });

  it("refuses a folder that cannot be written", () => {
    const { home } = homeWithFolder();
    const open = connection();
    const { service } = serviceOver(open, home);
    const notAFolder = join(home, "a-file");
    writeFileSync(notAFolder, "not a folder", "utf8");

    const refused = service.choose({
      scope: "project",
      projectId,
      folder: notAFolder,
      expectedVersion: 0,
    });

    expect(refused).toMatchObject({
      kind: "canvas-export-folder-refused",
      reason: "folder-unavailable",
    });
    expect(service.folderFor(projectId)).toBeUndefined();
    open.close();
  });

  it("refuses a choice made against a version the person has not seen", () => {
    const { home, folder } = homeWithFolder();
    const open = connection();
    const { service } = serviceOver(open, home);
    service.choose({ scope: "project", projectId, folder, expectedVersion: 0 });

    const stale = service.choose({
      scope: "project",
      projectId: otherProjectId,
      folder,
      expectedVersion: 0,
    });

    expect(stale).toMatchObject({
      kind: "canvas-export-folder-refused",
      reason: "stale-version",
    });
    open.close();
  });

  it("starts with no folder chosen at all", () => {
    const { home } = homeWithFolder();
    const open = connection();
    const { service } = serviceOver(open, home);

    expect(service.settings()).toEqual(
      decodeCanvasExportFolderSettings({
        kind: "canvas-export-folder-settings",
        overrides: [],
        version: 0,
        updatedAt: now,
      }),
    );
    expect(service.folderFor(projectId)).toBeUndefined();
    open.close();
  });
});
