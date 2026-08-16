import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeDiagnosticsExportReceipt } from "@octant/contracts";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import {
  DiagnosticsExportProjection,
  DIAGNOSTICS_EXPORT_RECEIPT_RECORDED,
  DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1,
  readDiagnosticsFailureIncident,
  readDiagnosticsExportReceipt,
} from "./diagnosticsExportProjection";
import { Journal } from "./journal";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { readonly connection: SqliteConnection; readonly journal: Journal } {
  const directory = mkdtempSync(join(tmpdir(), "octant-diagnostics-export-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-08-10T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-08-10T12:00:00.000Z",
    }),
  };
}

const receipt = decodeDiagnosticsExportReceipt({
  packetId: "00000000-0000-4000-8000-0000000000aa",
  domain: "provider",
  failureCode: "provider-support-export",
  redactions: ["credential"],
  contentDigest: "a".repeat(64),
  generatedAt: "2026-08-10T12:00:00.000Z",
  createdAt: "2026-08-10T12:00:01.000Z",
});

describe("diagnostics export receipt projection", () => {
  function appendReceipt(
    store: { readonly journal: Journal },
    eventId = "00000000-0000-4000-8000-0000000000fe",
  ) {
    return store.journal.append({
      aggregate: { aggregateType: "diagnostics-export", aggregateId: receipt.packetId },
      expectedVersion: 0,
      events: [
        {
          eventId,
          eventName: DIAGNOSTICS_EXPORT_RECEIPT_RECORDED,
          eventVersion: 1,
          correlationId: "00000000-0000-4000-8000-000000000001",
          actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" },
          occurredAt: receipt.createdAt,
          payload: { receipt },
        },
      ],
    });
  }

  it("persists and reads back only the bounded receipt fields", () => {
    const store = setup();
    try {
      appendReceipt(store);
      const stored = readDiagnosticsExportReceipt(store.connection, receipt.packetId);
      expect(stored).toEqual(receipt);
    } finally {
      store.connection.close();
    }
  });

  it("returns undefined for an unknown packet id", () => {
    const store = setup();
    try {
      expect(readDiagnosticsExportReceipt(store.connection, "does-not-exist")).toBeUndefined();
    } finally {
      store.connection.close();
    }
  });

  it("is idempotent for the same packet id", () => {
    const store = setup();
    try {
      const committed = appendReceipt(store);
      new DiagnosticsExportProjection().apply(store.connection, committed.events[0]!);
      const rows = store.connection
        .prepare("SELECT COUNT(*) AS count FROM diagnostics_export_receipt_projection")
        .get() as { readonly count: number };
      expect(rows.count).toBe(1);
    } finally {
      store.connection.close();
    }
  });

  it("rebuilds receipt rows from the authoritative journal", () => {
    const store = setup();
    try {
      appendReceipt(store);
      store.connection.exec("DELETE FROM diagnostics_export_receipt_projection");
      expect(readDiagnosticsExportReceipt(store.connection, receipt.packetId)).toBeUndefined();

      rebuildProjection({
        connection: store.connection,
        journal: store.journal,
        projection: new DiagnosticsExportProjection(),
        clock: () => "2026-08-10T12:00:00.000Z",
      });

      expect(readDiagnosticsExportReceipt(store.connection, receipt.packetId)).toEqual(receipt);
    } finally {
      store.connection.close();
    }
  });

  it("never persists a column capable of holding free text", () => {
    const store = setup();
    try {
      appendReceipt(store);
      const columns = store.connection
        .prepare("PRAGMA table_info(diagnostics_export_receipt_projection)")
        .all() as ReadonlyArray<{ readonly name: string }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toEqual([
        "packet_id",
        "domain",
        "failure_code",
        "redactions_json",
        "content_digest",
        "generated_at",
        "created_at",
      ]);
    } finally {
      store.connection.close();
    }
  });
});

describe("diagnostics failure incident projection", () => {
  it("rebuilds v1 incident evidence with an explicit legacy failure code", () => {
    const store = setup();
    const correlationId = "00000000-0000-4000-8000-0000000000ab";
    try {
      store.journal.append({
        aggregate: { aggregateType: "diagnostics-incident", aggregateId: correlationId },
        expectedVersion: 0,
        events: [
          {
            eventId: "00000000-0000-4000-8000-0000000000fc",
            eventName: DIAGNOSTICS_FAILURE_INCIDENT_RECORDED_V1,
            eventVersion: 1,
            correlationId,
            actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000001" },
            occurredAt: "2026-08-10T12:00:00.000Z",
            payload: { domain: "provider", outcome: "failed" },
          },
        ],
      });

      expect(readDiagnosticsFailureIncident(store.connection, correlationId)).toEqual({
        correlationId,
        domain: "provider",
        failureCode: "legacy-unknown",
        outcome: "failed",
        observedAt: "2026-08-10T12:00:00.000Z",
      });
    } finally {
      store.connection.close();
    }
  });
});
