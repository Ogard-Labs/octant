import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  EventName,
  ThreadRetentionThreadId,
  UtcTimestamp,
  decodeBrowserContextId,
  decodeBrowserThreadId,
} from "@octant/contracts";
import {
  LEGACY_OWNER_BROWSER_AUDIT_EVENT,
  LegacyOwnerBrowserAuditRecord,
  PAIRED_BROWSER_HOLD_AGGREGATE,
  PAIRED_BROWSER_HOLD_ENDED_EVENT,
  PAIRED_BROWSER_HOLD_STARTED_EVENT,
  decodePairedBrowserLeaseId,
} from "@octant/contracts/paired-browser-control";
import { describe, expect, it } from "vitest";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { ProjectionRegistry } from "../persistence/projection";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { createPairedBrowserJournal } from "./pairedBrowserJournal";

describe("paired browser hold journal", () => {
  it("records start and end metadata with remote-device actor and removes records on thread purge", () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-paired-hold-journal-"));
    const clock = () => "2026-11-20T10:00:00.000Z";
    const connection = openSqlite(join(dir, "octant.db"));
    try {
      applyMigrations(connection, MIGRATIONS, clock);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock,
      });
      const record = createPairedBrowserJournal({
        journal,
        connection,
        uuid: randomUUID,
        clock,
      });
      const threadId = decodeBrowserThreadId("11111111-1111-4111-8111-111111111111");
      const contextId = decodeBrowserContextId("22222222-2222-4222-8222-222222222222");
      const leaseId = decodePairedBrowserLeaseId("33333333-3333-4333-8333-333333333333");
      const deviceId = "44444444-4444-4444-8444-444444444444";

      record({
        kind: "started",
        deviceId,
        threadId,
        contextId,
        tabId: "tab-1",
        profileKind: "personal",
        origin: "https://example.com",
        leaseId,
      });
      record({
        kind: "ended",
        deviceId,
        threadId,
        contextId,
        tabId: "tab-1",
        profileKind: "personal",
        origin: "https://example.com",
        leaseId,
        endReason: "handed-back",
        eventCount: 14,
        frameCount: 25,
      });

      const cursor = {
        aggregateType: PAIRED_BROWSER_HOLD_AGGREGATE,
        aggregateId: String(threadId),
        afterVersion: 0,
        limit: 10,
      };
      const events = journal.replayAggregate(cursor);
      expect(events).toHaveLength(2);
      expect(events[0]?.eventName).toBe(PAIRED_BROWSER_HOLD_STARTED_EVENT);
      expect(events[0]?.actor).toEqual({
        kind: "remote-device",
        actorId: deviceId,
        deviceId,
      });
      expect(events[0]?.payload).toEqual({
        threadId,
        contextId,
        tabId: "tab-1",
        profileKind: "personal",
        origin: "https://example.com",
        leaseId,
      });
      expect(events[1]?.eventName).toBe(PAIRED_BROWSER_HOLD_ENDED_EVENT);
      expect(events[1]?.payload).toMatchObject({
        endReason: "handed-back",
        eventCount: 14,
        frameCount: 25,
      });

      erasePurgedThread({
        connection,
        mode: "code",
        threadId: Schema.decodeUnknownSync(ThreadRetentionThreadId)(String(threadId)),
      });

      expect(journal.replayAggregate(cursor)).toEqual([]);
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still opens and replays upgraded journals containing historical browser.owner-control-recorded@1 records", () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-legacy-owner-browser-journal-"));
    const clock = () => "2026-11-20T10:00:00.000Z";
    const dbPath = join(dir, "octant.db");
    const priorDb = openSqlite(dbPath);
    const aggregateId = Schema.decodeUnknownSync(AggregateId)(
      "11111111-1111-4111-8111-111111111111",
    );
    const legacyPayload = Schema.decodeUnknownSync(LegacyOwnerBrowserAuditRecord)({
      actingPrincipal: {
        kind: "owner-unlock",
        memberId: "66666666-6666-4666-8666-666666666666",
      },
      hostMemberId: "88888888-8888-4888-8888-888888888888",
      threadId: "11111111-1111-4111-8111-111111111111",
      contextId: "22222222-2222-4222-8222-222222222222",
      controlId: "33333333-3333-4333-8333-333333333333",
      targetVersion: "a".repeat(64),
      documentRevision: 1,
      operation: "take-over",
      phase: "completed",
    });
    try {
      applyMigrations(priorDb, MIGRATIONS, clock);
      const priorEvents = new EventRegistry().register(
        LEGACY_OWNER_BROWSER_AUDIT_EVENT,
        1,
        LegacyOwnerBrowserAuditRecord,
      );
      const priorJournal = new Journal({
        connection: priorDb,
        registry: priorEvents,
        projections: new ProjectionRegistry(),
        clock,
      });
      priorJournal.append({
        aggregate: { aggregateType: "owner-browser-control", aggregateId },
        expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(0),
        events: [
          {
            eventId: Schema.decodeUnknownSync(EventId)(randomUUID()),
            eventName: Schema.decodeUnknownSync(EventName)(LEGACY_OWNER_BROWSER_AUDIT_EVENT),
            eventVersion: 1,
            correlationId: Schema.decodeUnknownSync(CorrelationId)(randomUUID()),
            actor: {
              kind: "system",
              actorId: Schema.decodeUnknownSync(ActorId)("44444444-4444-4444-8444-444444444444"),
            },
            occurredAt: Schema.decodeUnknownSync(UtcTimestamp)(clock()),
            payload: legacyPayload,
          },
        ],
      });
    } finally {
      priorDb.close();
    }

    const upgradedDb = openSqlite(dbPath);
    try {
      const runtime = createPhase1RuntimeRegistries();
      const upgradedJournal = new Journal({
        connection: upgradedDb,
        registry: runtime.events,
        projections: runtime.projections,
        clock,
      });
      const replayed = upgradedJournal.replayAggregate({
        aggregateType: "owner-browser-control",
        aggregateId,
        afterVersion: 0,
        limit: 10,
      });
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.eventName).toBe(LEGACY_OWNER_BROWSER_AUDIT_EVENT);
      expect(replayed[0]?.payload).toEqual(legacyPayload);
    } finally {
      upgradedDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
