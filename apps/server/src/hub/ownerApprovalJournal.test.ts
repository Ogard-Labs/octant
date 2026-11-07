import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadRetentionThreadId } from "@octant/contracts";
import {
  OWNER_APPROVAL_AUDIT_AGGREGATE,
  decodeOwnerApprovalAuditRecord,
} from "@octant/contracts/owner-approvals";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import { createOwnerApprovalJournal } from "./ownerApprovalJournal";

describe("owner approval delivery journal", () => {
  it("replays the real owner and digests, refuses a second claim after restart, and purges with its thread", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-owner-approval-journal-"));
    const database = join(directory, "events.sqlite3"),
      clock = () => "2026-11-07T12:00:00.000Z";
    let connection = openSqlite(database);
    const makeJournal = () => {
      const registries = createPhase1RuntimeRegistries();
      return new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock,
      });
    };
    try {
      applyMigrations(connection, MIGRATIONS, clock);
      const memberId = randomUUID();
      const fact = decodeOwnerApprovalAuditRecord({
        ownerMemberId: memberId,
        hostMemberId: randomUUID(),
        mode: "work",
        threadId: randomUUID(),
        projectId: randomUUID(),
        requestId: randomUUID(),
        targetVersion: "a".repeat(64),
        actionDigest: "b".repeat(64),
        approved: true,
        actingPrincipal: { kind: "owner-unlock", memberId },
        phase: "admitted",
      });
      let journal = makeJournal();
      const input = () => ({
        journal,
        connection,
        localActorId: randomUUID(),
        uuid: randomUUID,
        clock,
      });
      createOwnerApprovalJournal(input())(fact);
      connection.close();
      connection = openSqlite(database);
      journal = makeJournal();
      const replay = () =>
        journal.replayAggregate({
          aggregateType: OWNER_APPROVAL_AUDIT_AGGREGATE,
          aggregateId: String(fact.requestId),
          afterVersion: 0,
          limit: 10,
        });
      expect(decodeOwnerApprovalAuditRecord(replay()[0]?.payload)).toEqual(fact);
      expect(() => createOwnerApprovalJournal(input())(fact)).toThrow();
      expect(() =>
        decodeOwnerApprovalAuditRecord({ ...fact, action: { input: "private content" } }),
      ).toThrow();
      createOwnerApprovalJournal(input())({ ...fact, phase: "uncertain" });
      expect(replay()).toHaveLength(2);
      erasePurgedThread({
        connection,
        mode: "work",
        threadId: Schema.decodeUnknownSync(ThreadRetentionThreadId)(fact.threadId),
      });
      expect(replay()).toHaveLength(0);
    } finally {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
