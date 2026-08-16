import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConservativeRestartReservations, readContextManifest } from "./contextProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { catchUpProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-18T18:30:00.000Z";
const ids = {
  actor: "62000000-0000-4000-8000-000000000001",
  correlation: "62000000-0000-4000-8000-000000000002",
  aggregate: "62000000-0000-4000-8000-000000000003",
  provider: "62000000-0000-4000-8000-000000000004",
  manifest: "62000000-0000-4000-8000-000000000005",
  entry: "62000000-0000-4000-8000-000000000006",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("context persistence restart", () => {
  it("restores manifests and treats every in-flight capacity reservation as ambiguous", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-context-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });
    const manifest = contextManifest();
    firstJournal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: ids.aggregate },
      expectedVersion: 0,
      events: [
        pending("context.manifest-created@1", { manifest }),
        ...(
          ["requested", "reserved", "running", "ambiguous", "reconciled", "released"] as const
        ).map((state, index) =>
          pending("context.capacity-reservation-updated@1", {
            reservation: capacityReservation(state, index),
          }),
        ),
      ],
    });
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    expect(readContextManifest(reopened, ids.manifest as never)).toEqual(manifest);
    const restartReservations = readConservativeRestartReservations(
      reopened,
      ids.provider as never,
    );
    expect(restartReservations.map(({ state }) => state)).toEqual([
      "ambiguous",
      "ambiguous",
      "ambiguous",
      "ambiguous",
    ]);
    expect(restartReservations.map(({ estimatedTokens }) => estimatedTokens)).toEqual([
      100, 101, 102, 103,
    ]);
    expect(
      reopened
        .prepare("SELECT state FROM context_capacity_projection ORDER BY reservation_id")
        .all(),
    ).toEqual([
      { state: "requested" },
      { state: "reserved" },
      { state: "running" },
      { state: "ambiguous" },
      { state: "reconciled" },
      { state: "released" },
    ]);
    reopened.close();
  });
});

function contextManifest() {
  const entry = {
    id: ids.entry,
    source: { kind: "message", referenceId: "message-1" },
    category: "current-request",
    label: "Current request",
    eligibility: {
      providerInstanceId: ids.provider,
      status: "eligible",
      reason: "selected-provider",
    },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: 100,
    includedSize: 100,
    tokens: { kind: "known", tokens: 25, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true },
  } as const;
  return {
    id: ids.manifest,
    subject: { aggregateType: "context-fixture", aggregateId: ids.aggregate },
    providerInstanceId: ids.provider,
    modelId: "model-a",
    entries: [entry],
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: now,
  } as const;
}

function capacityReservation(
  state: "requested" | "reserved" | "running" | "ambiguous" | "reconciled" | "released",
  index: number,
) {
  return {
    id: `62000000-0000-4000-8000-${String(10 + index).padStart(12, "0")}`,
    subject: { aggregateType: "context-fixture", aggregateId: ids.aggregate },
    providerInstanceId: ids.provider,
    modelId: "model-a",
    state,
    estimatedTokens: 100 + index,
    ...(state === "reconciled" ? { actualTokens: 99 } : {}),
    requests: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
}

function pending(eventName: string, payload: unknown) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload,
  } as const;
}
