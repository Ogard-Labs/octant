import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CanvasVersion } from "@octant/contracts";
import { ARTIFACT_MIRROR_AGGREGATE_TYPE } from "@octant/contracts/artifact-mirror";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ArtifactMirrorEventStore } from "./artifactMirrorEventStore";
import { ArtifactMirrorService } from "./artifactMirrorService";

const now = "2026-08-18T10:00:00.000Z" as never;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const canvasId = "1a2b3c4d-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";

function version(sequence: number, versionId: string) {
  return {
    schemaVersion: 1,
    canvasId,
    versionId,
    sequence,
    definition: {
      schemaVersion: 1,
      title: "Launch plan",
      provenance: {
        hostId: "host-1",
        projectId,
        actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
        providerInstanceId: "60000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        createdAt: "2026-08-18T09:00:00.000Z",
        mode: "work",
        threadId: "70000000-0000-4000-8000-000000000001",
      },
      sourceManifest: { sources: [] },
      blocks: [{ blockId: "t1", schemaVersion: 1, kind: "rich-text", text: "Ship it." }],
    },
    createdBy: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
    createdAt: "2026-08-18T09:00:00.000Z",
  } as unknown as CanvasVersion;
}

function setup(
  options: {
    readonly journalAppend?: Journal["append"];
    readonly receiptNotJournaled?: (failure: unknown) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-mirror-journal-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const files = new Map<string, string>();
  const makeService = () =>
    new ArtifactMirrorService({
      files: {
        write: async (path, contents) => void files.set(path, contents),
        read: async (path) => files.get(path),
        remove: async (path) => void files.delete(path),
        resolveRoot: async (path) => path,
      },
      currentVersion: () => undefined,
      projects: { read: () => ({ name: "Storefront" }) },
      defaultFallback: () => ({ kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" }),
      outsideRootApproved: () => true,
      planMode: () => false,
      appendVersionFromBundle: () => ({ kind: "denied", message: "unused" }),
      ...(options.receiptNotJournaled === undefined
        ? {}
        : { receiptNotJournaled: options.receiptNotJournaled }),
      journal: new ArtifactMirrorEventStore({
        journal: { append: options.journalAppend ?? ((input) => journal.append(input)) },
        uuid: randomUUID,
        clock: () => now,
        actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" },
      }),
      clock: () => now,
    });
  const receipts = () =>
    journal
      .replayAggregate({
        aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
        aggregateId: canvasId,
        afterVersion: 0,
        limit: 100,
      })
      .filter((event) => event.eventName === "artifact.mirror-written@1");
  return { service: makeService(), restart: makeService, receipts };
}

describe("journaling mirror receipts", () => {
  it("journals a receipt for every committed version of one artifact", async () => {
    const h = setup();

    const first = await h.service.materialize(version(1, "30000000-0000-4000-8000-000000000001"));
    await h.service.materialize(version(2, "30000000-0000-4000-8000-000000000002"));

    expect(first.outcome).toBe("written");
    expect(h.receipts()).toHaveLength(2);
  });

  it("journals a settings change", async () => {
    const h = setup();

    const result = await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
    });

    expect(result.kind).toBe("mirror-settings");
  });

  it("names the failure when a receipt cannot be journaled, without unwinding the write", async () => {
    const failures: unknown[] = [];
    const h = setup({
      journalAppend: () => {
        throw Object.assign(new Error("secret /Users/me/Artifacts"), {
          _tag: "JournalWriteFailed",
        });
      },
      receiptNotJournaled: (failure) => failures.push(failure),
    });

    const receipt = await h.service.materialize(version(1, "30000000-0000-4000-8000-000000000001"));

    expect(receipt.outcome).toBe("written");
    expect(failures).toEqual([
      {
        reason: "receipt-not-journaled",
        canvasId,
        versionId: "30000000-0000-4000-8000-000000000001",
        error: "JournalWriteFailed",
      },
    ]);
  });

  it("journals successive settings changes and refuses one made from a stale version", async () => {
    const h = setup();
    const folder = (canonicalRoot: string) => ({ kind: "global-folder", canonicalRoot }) as const;

    await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: folder("/Users/me/A"),
    });
    const second = await h.service.execute({
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 1,
      destination: folder("/Users/me/B"),
    });

    expect(second.kind).toBe("mirror-settings");
    // A restarted host that has not replayed settings must not append over them.
    await expect(
      h.restart().execute({
        kind: "set-artifact-mirror-fallback",
        expectedVersion: 0,
        destination: folder("/Users/me/C"),
      }),
    ).rejects.toMatchObject({ _tag: "ConcurrencyConflict" });
  });
});
