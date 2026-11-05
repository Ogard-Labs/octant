import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HubMemberId, ThreadRetentionThreadId } from "@octant/contracts";
import {
  decodeOwnerBrowserControlId,
  decodeOwnerBrowserTarget,
  OWNER_BROWSER_AUDIT_AGGREGATE,
  decodeOwnerBrowserAuditRecord,
} from "@octant/contracts/owner-browser";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { createOwnerBrowserJournal } from "./ownerBrowserJournal";

describe("owner Browser audit", () => {
  it("replays the authenticated owner petitioner without persisting page content and erases the thread's audit on purge", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-owner-browser-audit-"));
    const database = join(directory, "events.sqlite3");
    const clock = () => "2026-11-04T12:00:00.000Z";
    let connection = openSqlite(database);
    try {
      applyMigrations(connection, MIGRATIONS, clock);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock,
      });
      const record = createOwnerBrowserJournal({
        journal,
        connection,
        localActorId: randomUUID(),
        uuid: randomUUID,
        clock,
      });
      const memberId = Schema.decodeUnknownSync(HubMemberId)(randomUUID());
      const target = decodeOwnerBrowserTarget({
        hostMemberId: memberId,
        threadId: randomUUID(),
        contextId: randomUUID(),
        targetVersion: "a".repeat(64),
        documentRevision: 1,
        origin: "https://synthetic-private.invalid",
        profile: "private",
      });
      record({
        principal: { kind: "owner-unlock", memberId },
        controlId: decodeOwnerBrowserControlId(randomUUID()),
        target,
        operation: "input",
        phase: "completed",
        inputKind: "type",
      });
      connection.close();
      connection = openSqlite(database);
      const replayRuntime = createPhase1RuntimeRegistries();
      const replay = new Journal({
        connection,
        registry: replayRuntime.events,
        projections: replayRuntime.projections,
        clock,
      });
      const cursor = {
        aggregateType: OWNER_BROWSER_AUDIT_AGGREGATE,
        aggregateId: String(target.threadId),
        afterVersion: 0,
        limit: 10,
      };
      const events = replay.replayAggregate(cursor);
      expect(events).toHaveLength(1);
      expect(events[0]?.actor.kind).toBe("system");
      const payload = decodeOwnerBrowserAuditRecord(events[0]?.payload);
      expect(payload.actingPrincipal).toEqual({ kind: "owner-unlock", memberId });
      expect(payload.inputKind).toBe("type");
      expect(JSON.stringify(payload)).not.toContain("synthetic-private");
      expect(() =>
        decodeOwnerBrowserAuditRecord({
          ...payload,
          text: "synthetic-text",
          dataUrl: "synthetic-frame",
        }),
      ).toThrow();
      erasePurgedThread({
        connection,
        mode: "code",
        threadId: Schema.decodeUnknownSync(ThreadRetentionThreadId)(target.threadId),
      });
      expect(replay.replayAggregate(cursor)).toHaveLength(0);
    } finally {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
