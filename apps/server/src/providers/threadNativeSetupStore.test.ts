import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ThreadNativeSetupProjection } from "../persistence/threadNativeSetupProjection";
import { ThreadNativeSetupStore } from "./threadNativeSetupStore";

const actorId = "70000000-0000-4000-8000-000000000001";
const threadA = "74000000-0000-4000-8000-00000000000a";
const threadB = "74000000-0000-4000-8000-00000000000b";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-native-setup-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-31T12:00:00.000Z");
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => "2026-10-31T12:00:00.000Z",
  });
  let counter = 0;
  return {
    connection,
    journal,
    store: new ThreadNativeSetupStore({
      journal,
      connection,
      uuid: () => `75000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      clock: () => "2026-10-31T12:00:00.000Z",
      actor: { kind: "local-user", actorId } as never,
    }),
  };
}

describe("a thread's own choice about its provider's native setup", () => {
  it("inherits until the person chooses, then answers per thread and clears back to inherit", () => {
    const { store } = fixture();
    expect(store.get(threadA)).toBe("inherit");
    expect(store.set(threadA, "off")).toBe("recorded");
    expect(store.set(threadB, "on")).toBe("recorded");
    expect(store.get(threadA)).toBe("off");
    expect(store.get(threadB)).toBe("on");
    expect(store.set(threadA, "inherit")).toBe("recorded");
    expect(store.get(threadA)).toBe("inherit");
  });

  it("writes nothing for a choice that already stands and refuses an id that is not a thread", () => {
    const { store, connection } = fixture();
    store.set(threadA, "on");
    const count = () =>
      (connection.prepare("SELECT count(*) AS n FROM event_journal").get() as { n: number }).n;
    const before = count();
    expect(store.set(threadA, "on")).toBe("recorded");
    expect(count()).toBe(before);
    expect(store.set("not-a-thread", "on")).toBe("refused");
  });

  it("rebuilds from the journal to the same answers", () => {
    const { store, connection, journal } = fixture();
    store.set(threadA, "off");
    store.set(threadB, "on");
    store.set(threadB, "inherit");
    rebuildProjection({
      connection,
      journal,
      projection: new ThreadNativeSetupProjection(),
      clock: () => "2026-10-31T12:00:00.000Z",
    });
    expect(store.get(threadA)).toBe("off");
    expect(store.get(threadB)).toBe("inherit");
  });
});
