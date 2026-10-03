import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { decodeCanvasId, decodeCanvasVersionId, type CanvasBlock } from "@octant/contracts/canvas";
import {
  CanvasExportApprovalId,
  decodeCanvasExportContribution,
  decodeCanvasExportPrepareRequest,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import { EventActor, decodeUtcTimestamp } from "@octant/contracts";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasExportEventStore, registerCanvasExportEvents } from "./canvasExportEventStore";
import { CanvasExportService, type CanvasExportDocument } from "./canvasExportService";

const directories: string[] = [];
const now = "2026-08-01T21:00:00.000Z";
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const versionId = decodeCanvasVersionId("22222222-2222-4222-8222-222222222222");
const decodeApprovalId = Schema.decodeUnknownSync(CanvasExportApprovalId);

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-export-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function document(): CanvasExportDocument {
  return {
    canvasId,
    versionId,
    sequence: 1,
    title: "Launch plan",
    blocks: [
      {
        blockId: "heading-1",
        schemaVersion: 1,
        kind: "heading",
        level: 1,
        text: "Scope",
      },
    ] as unknown as ReadonlyArray<CanvasBlock>,
  };
}

function harness() {
  const calls: CanvasExportRenderedOutput[] = [];
  const target: CanvasExportTarget = {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: "reading-copy",
      label: "Reading copy",
      formats: ["markdown", "html"],
    }),
    exportDocument: async (output) => {
      calls.push(output);
      return { kind: "receipt", receipt: { kind: "remote-id", remoteId: "copy-1" } };
    },
  };
  let n = 0;
  const nextId = () => {
    n += 1;
    return `55555555-5555-4555-8555-${n.toString(16).padStart(12, "0")}`;
  };
  const connection = openConnection();
  const eventStore = new CanvasExportEventStore({
    journal: new Journal({
      connection,
      registry: registerCanvasExportEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid: nextId,
    actor: Schema.decodeUnknownSync(EventActor)({
      kind: "local-user",
      actorId: "99999999-9999-4999-8999-999999999999",
    }),
  });
  const service = new CanvasExportService({
    load: () => document(),
    targets: () => [
      {
        facts: {
          installed: true,
          trusted: true,
          desiredEnabled: true,
          effectiveState: { kind: "effective" },
          connected: true,
        },
        target,
      },
    ],
    eventStore,
    uuid: nextId,
    clock: () => decodeUtcTimestamp(now),
  });
  return { calls, service, eventStore, connection };
}

function prepareRequest() {
  return decodeCanvasExportPrepareRequest({
    schemaVersion: 1,
    kind: "canvas-export-prepare",
    canvasId,
    versionId,
    expectedSequence: 1,
    targetId: "reading-copy",
    format: "markdown",
  });
}

describe("canvas export service", () => {
  it("does not call a destination or journal an export without approval", async () => {
    const { calls, service, eventStore, connection } = harness();

    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    expect(calls).toHaveLength(0);
    expect(eventStore.replay()).toEqual([]);

    const missing = await service.decide({
      canvasId,
      approvalId: decodeApprovalId("44444444-4444-4444-8444-000000000099"),
      decision: "approved",
      permitted: true,
    });
    expect(missing).toMatchObject({ kind: "refused", code: "approval-required" });
    expect(calls).toHaveLength(0);

    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const denied = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "denied",
      permitted: true,
    });
    expect(denied.kind).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(eventStore.replay()).toEqual([]);
    connection.close();
  });

  it("calls the destination only after approval and journals the receipt", async () => {
    const { calls, service, eventStore, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
    });

    expect(calls).toHaveLength(1);
    expect(exported.kind).toBe("exported");
    expect(eventStore.replay()[0]?.outcome).toEqual({
      kind: "receipt",
      receipt: { kind: "remote-id", remoteId: "copy-1" },
    });
    connection.close();
  });

  it("refuses a format this host does not render without calling the destination", () => {
    const { calls, service, connection } = harness();
    const refused = service.prepare(
      decodeCanvasExportPrepareRequest({
        schemaVersion: 1,
        kind: "canvas-export-prepare",
        canvasId,
        versionId,
        expectedSequence: 1,
        targetId: "reading-copy",
        format: "pdf",
      }),
      true,
    );

    expect(refused).toMatchObject({ kind: "refused", code: "unsupported-format" });
    expect(calls).toHaveLength(0);
    connection.close();
  });
});
