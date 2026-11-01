import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBrowserThreadId,
  type CorrelationId,
  type ProviderInstanceId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { createBrowserDownloadJournal } from "./browserDownloadJournal";

const now = "2026-11-01T09:00:00.000Z";
const threadId = decodeBrowserThreadId("d0000000-0000-4000-8000-00000000000a");
const context = {
  threadId,
  origin: "https://example.com",
  providerInstanceId: "d0000000-0000-4000-8000-0000000000aa" as ProviderInstanceId,
  correlationId: "d0000000-0000-4000-8000-0000000000cc" as CorrelationId,
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), "octant-browser-download-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const recorder = createBrowserDownloadJournal({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
  });
  const rows = () =>
    connection
      .prepare(
        `SELECT aggregate_id, aggregate_version, event_name, actor_kind, payload_json
         FROM event_journal WHERE aggregate_type = 'browser-download' ORDER BY global_sequence`,
      )
      .all() as ReadonlyArray<{
      readonly aggregate_id: string;
      readonly aggregate_version: number;
      readonly event_name: string;
      readonly actor_kind: string;
      readonly payload_json: string;
    }>;
  return { recorder, rows };
}

describe("Browser download journal", () => {
  it("records a saved download with its digest and no bytes, as the agent's act", () => {
    const { recorder, rows } = open();
    recorder.saved(context, {
      path: "downloads/report.pdf",
      sizeBytes: 12,
      mediaType: "application/pdf",
      sha256: "a".repeat(64),
    });
    const [row] = rows();
    expect(row).toMatchObject({
      aggregate_id: String(threadId),
      aggregate_version: 1,
      event_name: "browser.download-saved@1",
      actor_kind: "agent",
    });
    expect(JSON.parse(row?.payload_json ?? "{}")).toEqual({
      threadId,
      origin: "https://example.com",
      path: "downloads/report.pdf",
      sizeBytes: 12,
      mediaType: "application/pdf",
      sha256: "a".repeat(64),
      savedAt: now,
    });
  });

  it("records a refused or denied download with its reason, again on the same thread", () => {
    const { recorder, rows } = open();
    recorder.refused(context, {
      name: "tool.txt",
      sizeBytes: 10,
      mediaType: "application/x-elf",
      reason: "executable",
    });
    recorder.refused(context, { name: "report.pdf", reason: "denied" });
    expect(rows().map((row) => [row.event_name, row.aggregate_version])).toEqual([
      ["browser.download-refused@1", 1],
      ["browser.download-refused@1", 2],
    ]);
    expect(JSON.parse(rows()[1]?.payload_json ?? "{}")).toEqual({
      threadId,
      origin: "https://example.com",
      name: "report.pdf",
      reason: "denied",
      refusedAt: now,
    });
  });
});
