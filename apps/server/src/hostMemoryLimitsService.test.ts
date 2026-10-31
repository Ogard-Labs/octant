import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostMemoryLimitsService } from "./hostMemoryLimitsService";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { rebuildProjection } from "./persistence/projection";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";

const directories: Array<string> = [];
let tick = 0;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHarness() {
  const directory = mkdtempSync(join(tmpdir(), "octant-memory-limits-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-31T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  const clock = () =>
    new Date(Date.parse("2026-10-31T12:00:00.000Z") + tick++ * 1000).toISOString();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  const onChanged = vi.fn();
  const service = new HostMemoryLimitsService({
    connection,
    journal,
    clock,
    uuid: randomUUID,
    onChanged,
  });
  return { connection, journal, runtime, service, onChanged, clock };
}

const custom = (pressuredGb: number, criticalGb: number) =>
  ({ kind: "custom", pressuredGb, criticalGb }) as const;

describe("HostMemoryLimitsService", () => {
  it("starts on automatic limits", () => {
    expect(openHarness().service.read()).toEqual({ kind: "automatic" });
  });

  it("journals who changed the limits, when, and the values before and after", () => {
    const { service, journal } = openHarness();
    expect(service.set({ limits: custom(3, 6) }, "local-window")).toEqual({
      kind: "saved",
      limits: custom(3, 6),
    });
    expect(service.set({ limits: custom(4, 8) }, "local-window").kind).toBe("saved");
    expect(service.read()).toEqual(custom(4, 8));

    const events = journal.replayAggregateType({
      aggregateType: "host-memory-limits",
      afterSequence: 0,
      limit: 10,
    });
    expect(events.map((event) => event.payload)).toEqual([
      {
        kind: "memory-limits-changed",
        previous: { kind: "automatic" },
        next: custom(3, 6),
        changedBy: "local-window",
        changedAt: expect.stringMatching(/^2026-10-31T12:00:\d\d\.000Z$/),
      },
      {
        kind: "memory-limits-changed",
        previous: custom(3, 6),
        next: custom(4, 8),
        changedBy: "local-window",
        changedAt: expect.stringMatching(/^2026-10-31T12:00:\d\d\.000Z$/),
      },
    ]);
    expect(events[0]?.actor.kind).toBe("local-user");
    expect(events[0]?.aggregateVersion).toBe(1);
    expect(events[1]?.aggregateVersion).toBe(2);
  });

  it("replays to the same limits when the projection is rebuilt from the journal", () => {
    const { service, journal, runtime, connection, clock } = openHarness();
    service.set({ limits: custom(3, 6) }, "local-window");
    service.set({ limits: { kind: "automatic" } }, "local-window");
    service.set({ limits: custom(1.5, 2.5) }, "local-window");

    connection.exec("DELETE FROM host_memory_limits_projection;");
    expect(service.read()).toEqual({ kind: "automatic" });

    const projection = runtime.projections.get("host-memory-limits");
    if (projection === undefined)
      throw new Error("host-memory-limits projection must be registered");
    rebuildProjection({ connection, journal, projection, clock });
    expect(service.read()).toEqual(custom(1.5, 2.5));
  });

  it("refuses invalid limits as a value with a plain message and journals nothing", () => {
    const { service, journal, onChanged } = openHarness();
    expect(service.set({ limits: custom(8, 2) }, "local-window")).toEqual({
      kind: "refused",
      code: "critical-not-above-pressured",
      message: "The critical limit must be above the pressured limit.",
    });
    expect(service.set({ limits: custom(0.1, 2) }, "local-window")).toEqual({
      kind: "refused",
      code: "out-of-range",
      message: "Memory limits must be between 0.5 and 64 GB.",
    });
    expect(service.read()).toEqual({ kind: "automatic" });
    expect(journal.headSequence()).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("refuses a remote device and leaves the limits as they were", () => {
    const { service, journal } = openHarness();
    expect(service.set({ limits: custom(3, 6) }, "remote-device")).toMatchObject({
      kind: "refused",
      code: "unauthorized",
    });
    expect(service.read()).toEqual({ kind: "automatic" });
    expect(journal.headSequence()).toBe(0);
  });

  it("records nothing when the limits in force are saved again", () => {
    const { service, journal, onChanged } = openHarness();
    expect(service.set({ limits: { kind: "automatic" } }, "local-window")).toEqual({
      kind: "saved",
      limits: { kind: "automatic" },
    });
    service.set({ limits: custom(3, 6) }, "local-window");
    const head = journal.headSequence();
    service.set({ limits: custom(3, 6) }, "local-window");
    expect(journal.headSequence()).toBe(head);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("tells the guard after a change so the new limits apply at once", () => {
    const { service, onChanged } = openHarness();
    service.set({ limits: custom(3, 6) }, "local-window");
    expect(onChanged).toHaveBeenCalledWith(custom(3, 6));
  });
});
