import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ExtensionProjectPinProjection } from "../persistence/extensionProjectPinProjection";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ExtensionProjectPinStore } from "./extensionProjectPinStore";

const actorId = "70000000-0000-4000-8000-000000000001";
const docs = "71000000-0000-4000-8000-000000000001";
const tracker = "71000000-0000-4000-8000-000000000002";
const projectA = "72000000-0000-4000-8000-00000000000a";
const projectB = "72000000-0000-4000-8000-00000000000b";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function store() {
  const directory = mkdtempSync(join(tmpdir(), "octant-project-pins-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-20T12:00:00.000Z");
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => "2026-10-20T12:00:00.000Z",
  });
  let counter = 0;
  return {
    connection,
    journal,
    pins: new ExtensionProjectPinStore({
      journal,
      connection,
      uuid: () => `73000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      clock: () => "2026-10-20T12:00:00.000Z",
      actor: { kind: "local-user", actorId } as never,
    }),
  };
}

describe("plugins pinned to a Project", () => {
  it("records a pin per Project, lists it, and takes it back", () => {
    const { pins } = store();
    expect(pins.set(projectA, docs, true)).toBe("recorded");
    expect(pins.set(projectA, tracker, true)).toBe("recorded");
    expect(pins.set(projectB, docs, true)).toBe("recorded");
    expect(pins.list(projectA)).toEqual([docs, tracker]);
    expect(pins.list(projectB)).toEqual([docs]);
    expect(pins.set(projectA, docs, false)).toBe("recorded");
    expect(pins.list(projectA)).toEqual([tracker]);
    expect(pins.listAll()).toEqual([
      { projectId: projectA, extensionId: tracker },
      { projectId: projectB, extensionId: docs },
    ]);
  });

  it("does nothing for a pin that already stands, and refuses an id that is not one", () => {
    const { pins, connection } = store();
    expect(pins.set(projectA, docs, true)).toBe("recorded");
    const before = (
      connection.prepare("SELECT count(*) AS n FROM event_journal").get() as { n: number }
    ).n;
    expect(pins.set(projectA, docs, true)).toBe("recorded");
    expect(
      (connection.prepare("SELECT count(*) AS n FROM event_journal").get() as { n: number }).n,
    ).toBe(before);
    expect(pins.set(projectA, "not-a-plugin", true)).toBe("refused");
  });

  it("forgets a plugin everywhere once it is gone, and the projection rebuilds to the same answer", () => {
    const { pins, connection, journal } = store();
    pins.set(projectA, docs, true);
    pins.set(projectB, docs, true);
    pins.set(projectB, tracker, true);
    pins.forgetExtension(docs);
    expect(pins.listAll()).toEqual([{ projectId: projectB, extensionId: tracker }]);
    rebuildProjection({
      connection,
      journal,
      projection: new ExtensionProjectPinProjection(),
      clock: () => "2026-10-20T12:00:00.000Z",
    });
    expect(pins.listAll()).toEqual([{ projectId: projectB, extensionId: tracker }]);
  });
});
