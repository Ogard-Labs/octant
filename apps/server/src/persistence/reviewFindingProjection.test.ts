import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCodeReviewFindingId, decodeCodeThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readCodeReviewFinding, readCodeReviewFindings } from "./codeProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-21T00:00:00.000Z";
const ids = {
  actor: "83000000-0000-4000-8000-000000000001",
  correlation: "83000000-0000-4000-8000-000000000002",
  thread: "83000000-0000-4000-8000-000000000003",
  checkout: "83000000-0000-4000-8000-000000000004",
  file: "83000000-0000-4000-8000-000000000005",
  finding: "83000000-0000-4000-8000-000000000006",
  event: "83000000-0000-4000-8000-000000000007",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Code review finding projection", () => {
  it("projects immutable provenance and rebuilds the latest finding state idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-review-finding-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("code");
    if (projection === undefined) throw new Error("Code projection must be registered");
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const finding = {
      id: ids.finding,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      fileId: ids.file,
      path: "src/code.ts",
      fileDigest: "a".repeat(64),
      location: { kind: "line", line: 4 },
      severity: "warning",
      author: { kind: "local-user", actorId: "local-user" },
      provenance: { kind: "manual" },
      summary: "Handle interruption explicitly.",
      state: "open",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;

    try {
      journal.append({
        aggregate: { aggregateType: "code-review-finding", aggregateId: ids.finding },
        expectedVersion: 0,
        events: [
          {
            eventId: ids.event,
            eventName: "code.review-finding-updated@1",
            eventVersion: 1,
            correlationId: ids.correlation,
            actor: { kind: "local-user", actorId: ids.actor },
            occurredAt: now,
            payload: { kind: "review-finding-updated", finding },
          },
        ],
      });

      expect(readCodeReviewFinding(connection, decodeCodeReviewFindingId(ids.finding))).toEqual(
        finding,
      );
      expect(readCodeReviewFindings(connection, decodeCodeThreadId(ids.thread))).toEqual([finding]);

      const expected = connection.prepare("SELECT * FROM code_review_projection").all();
      rebuildProjection({ connection, journal, projection, clock: () => now });
      expect(connection.prepare("SELECT * FROM code_review_projection").all()).toEqual(expected);
      rebuildProjection({ connection, journal, projection, clock: () => now });
      expect(connection.prepare("SELECT * FROM code_review_projection").all()).toEqual(expected);
    } finally {
      connection.close();
    }
  });
});
