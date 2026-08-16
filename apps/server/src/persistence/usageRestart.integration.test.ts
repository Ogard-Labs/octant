import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUsageRecord, readAllUsageRecords } from "./usageProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { catchUpProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-24T12:00:00.000Z";
const ids = {
  actor: "64000000-0000-4000-8000-000000000001",
  correlation: "64000000-0000-4000-8000-000000000002",
  aggregate: "64000000-0000-4000-8000-000000000003",
  provider: "64000000-0000-4000-8000-000000000004",
  entry: "64000000-0000-4000-8000-000000000005",
  manifest: "64000000-0000-4000-8000-000000000006",
  plan: "64000000-0000-4000-8000-000000000007",
  usage: "64000000-0000-4000-8000-000000000008",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pending(eventName: string, payload: unknown) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload,
  };
}

describe("usage persistence restart", () => {
  it("restores usage records after server restart via catch-up replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-usage-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");

    // First boot: write events
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });

    firstJournal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: ids.aggregate },
      expectedVersion: 0,
      events: [
        pending("context.manifest-created@1", {
          manifest: {
            id: ids.manifest,
            subject: { aggregateType: "chat-thread", aggregateId: ids.aggregate },
            providerInstanceId: ids.provider,
            modelId: "gpt-4o",
            entries: [
              {
                id: ids.entry,
                source: { kind: "message", referenceId: "msg-1" },
                category: "conversation",
                label: "History",
                eligibility: {
                  providerInstanceId: ids.provider,
                  status: "eligible",
                  reason: "selected-provider",
                },
                posture: "required",
                retention: "active",
                priority: 100,
                originalSize: 200,
                includedSize: 200,
                tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
                state: "included",
                introducedAtTurn: 1,
                lastUsedAtTurn: 1,
                reuseCount: 0,
                preview: { redacted: true, label: "History" },
              },
            ],
            overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
            createdAt: now,
          },
        }),
        pending("context.plan-created@1", {
          plan: {
            id: ids.plan,
            manifestId: ids.manifest,
            safeInputBudget: 100_000,
            plannedInputTokens: 50,
            reserves: { response: 4_096, reasoning: 0, framing: 1_000, variance: 500, safety: 0 },
            entries: [
              {
                entryId: ids.entry,
                state: "included",
                tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
                reason: "required",
              },
            ],
            health: "healthy",
            blocked: false,
            remedies: [],
            createdAt: now,
          },
        }),
        pending("context.usage-reconciled@1", {
          reconciliation: {
            id: ids.usage,
            planId: ids.plan,
            providerInstanceId: ids.provider,
            modelId: "gpt-4o",
            requestShape: "chat-turn",
            plannedInputTokens: 50,
            actualInputTokens: 50,
            actualOutputTokens: 25,
            reasoningTokens: 11,
            cacheReadInputTokens: 7,
            cacheWriteInputTokens: 2,
            providerExecutionDurationMs: 840,
            varianceTokens: 0,
            observedAt: now,
          },
        }),
      ],
    });
    first.close();

    // Second boot: reopen and catch up
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

    const record = readUsageRecord(reopened, ids.usage);
    expect(record).toBeDefined();
    expect(record!.reconciliationId).toBe(ids.usage);
    expect(record!.quality).toBe("exact");
    expect(record!.inputTokens).toBe(50);
    expect(record!.outputTokens).toBe(25);
    expect(record!.reasoningTokens).toBe(11);
    expect(record!.cacheReadInputTokens).toBe(7);
    expect(record!.cacheWriteInputTokens).toBe(2);
    expect(record!.providerExecutionDurationMs).toBe(840);
    expect(record!.attribution).toHaveLength(1);
    expect(record!.attribution[0]!.category).toBe("conversation");

    const allRecords = readAllUsageRecords(reopened);
    expect(allRecords).toHaveLength(1);

    reopened.close();
  });
});
