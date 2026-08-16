import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  purgeContextSubjectContent,
  readContextManifest,
  readContextPlan,
  readContextSummary,
  readContextSummaryContent,
  readContextUsage,
  readCurrentContextOverrides,
  readProviderCapacityReservations,
  writeContextSummaryContent,
} from "./contextProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-18T18:30:00.000Z";
const later = "2026-07-18T18:31:00.000Z";
const ids = {
  actor: "61000000-0000-4000-8000-000000000001",
  correlation: "61000000-0000-4000-8000-000000000002",
  aggregate: "61000000-0000-4000-8000-000000000003",
  provider: "61000000-0000-4000-8000-000000000004",
  entry: "61000000-0000-4000-8000-000000000005",
  manifest: "61000000-0000-4000-8000-000000000006",
  plan: "61000000-0000-4000-8000-000000000007",
  summary: "61000000-0000-4000-8000-000000000008",
  usage: "61000000-0000-4000-8000-000000000009",
  reservation: "61000000-0000-4000-8000-000000000010",
} as const;

function fixtures() {
  const subject = { aggregateType: "context-fixture", aggregateId: ids.aggregate } as const;
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
    originalSize: 120,
    includedSize: 120,
    tokens: { kind: "known", tokens: 30, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    lastUsedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "Current request" },
  } as const;
  const overrides = { pinnedEntryIds: [], excludedEntryIds: [] } as const;
  const manifest = {
    id: ids.manifest,
    subject,
    providerInstanceId: ids.provider,
    modelId: "model-a",
    entries: [entry],
    overrides,
    createdAt: now,
  } as const;
  const plan = {
    id: ids.plan,
    manifestId: ids.manifest,
    safeInputBudget: 1_000,
    plannedInputTokens: 30,
    reserves: { response: 100, reasoning: 0, framing: 10, variance: 10, safety: 10 },
    entries: [{ entryId: ids.entry, state: "included", tokens: entry.tokens, reason: "required" }],
    health: "healthy",
    blocked: false,
    remedies: [],
    createdAt: now,
  } as const;
  const summary = {
    id: ids.summary,
    sourceEntryIds: [ids.entry],
    providerInstanceId: ids.provider,
    modelId: "model-a",
    createdAt: now,
    usageCount: 0,
    summaryTokens: { kind: "known", tokens: 10, accuracy: "exact-tokenizer" },
    originalTokens: { kind: "known", tokens: 30, accuracy: "exact-tokenizer" },
    estimatedSavingsTokens: 20,
    replacedSummaryIds: [],
  } as const;
  const reconciliation = {
    id: ids.usage,
    planId: ids.plan,
    providerInstanceId: ids.provider,
    modelId: "model-a",
    requestShape: "chat-streaming",
    plannedInputTokens: 30,
    actualInputTokens: 32,
    actualOutputTokens: 8,
    varianceTokens: 2,
    observedAt: now,
  } as const;
  const reservation = {
    id: ids.reservation,
    subject,
    providerInstanceId: ids.provider,
    modelId: "model-a",
    state: "reserved",
    estimatedTokens: 40,
    requests: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
  return { subject, manifest, overrides, plan, summary, reconciliation, reservation };
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-context-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ContextProjection", () => {
  it("persists and rebuilds all six context event families without rewriting the base manifest", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const values = fixtures();
    journal.append(
      {
        aggregate: { aggregateType: "context-ledger", aggregateId: ids.aggregate },
        expectedVersion: 0,
        events: [
          pending("context.manifest-created@1", { manifest: values.manifest }),
          pending("context.overrides-updated@1", {
            manifestId: ids.manifest,
            overrides: { pinnedEntryIds: [ids.entry], excludedEntryIds: [] },
          }),
          pending("context.plan-created@1", { plan: values.plan }),
          pending("context.summary-created@1", { summary: values.summary }),
          pending("context.usage-reconciled@1", { reconciliation: values.reconciliation }),
          pending("context.capacity-reservation-updated@1", {
            reservation: values.reservation,
          }),
        ],
      },
      {
        beforeEvents: (inner) =>
          writeContextSummaryContent(inner, {
            summaryId: ids.summary as never,
            subject: values.subject as never,
            content: "Compacted earlier conversation.",
            createdAt: now,
          }),
      },
    );

    // No event carries the generated text; only the summary's identity.
    expect(
      connection
        .prepare(
          "SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE '%Compacted earlier conversation.%'",
        )
        .get(),
    ).toEqual({ count: 0 });

    expect(readContextManifest(connection, ids.manifest as never)).toEqual(values.manifest);
    expect(readCurrentContextOverrides(connection, ids.manifest as never)).toEqual({
      pinnedEntryIds: [ids.entry],
      excludedEntryIds: [],
    });
    expect(readContextPlan(connection, ids.plan as never)).toEqual(values.plan);
    expect(readContextSummary(connection, ids.summary as never)).toEqual(values.summary);
    expect(readContextUsage(connection, ids.usage as never)).toEqual(values.reconciliation);
    expect(readProviderCapacityReservations(connection, ids.provider as never)).toEqual([
      values.reservation,
    ]);
    // Summary text is subject-owned stored content, not journal payload, so a
    // rebuild has to leave it exactly as it was rather than restore it from an
    // event or wipe it along with the projections it does own.
    expect(readContextSummaryContent(connection, ids.summary as never)).toBe(
      "Compacted earlier conversation.",
    );
    const before = projectionRows(connection);
    projection.reset(connection);
    expect(projectionRows(connection).every((rows) => rows.length === 0)).toBe(true);
    rebuildProjection({ connection, journal, projection, clock: () => later });
    expect(projectionRows(connection)).toEqual(before);
    expect(readContextSummary(connection, ids.summary as never)).toEqual(values.summary);
    expect(readContextSummaryContent(connection, ids.summary as never)).toBe(
      "Compacted earlier conversation.",
    );

    // Purging the subject destroys the text for good. The summary keeps its
    // identity and provenance in the journal and the projection, and a reader
    // asking for the text is told it is gone rather than handed an empty
    // string that reads like a real summary.
    purgeContextSubjectContent(connection, values.subject as never);
    expect(readContextSummaryContent(connection, ids.summary as never)).toBeUndefined();
    expect(readContextSummary(connection, ids.summary as never)).toEqual(values.summary);
    rebuildProjection({ connection, journal, projection, clock: () => later });
    expect(readContextSummaryContent(connection, ids.summary as never)).toBeUndefined();
    connection.close();
  });

  it("rejects dangling or invalid override transitions without exposing private metadata", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    const event = (payload: unknown, sequence: number): EventEnvelope =>
      ({
        eventId: crypto.randomUUID(),
        globalSequence: sequence,
        aggregateType: "context-ledger",
        aggregateId: ids.aggregate,
        aggregateVersion: sequence,
        eventName: "context.overrides-updated@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload,
      }) as EventEnvelope;

    expect(() =>
      projection.apply(
        connection,
        event({ manifestId: ids.manifest, overrides: values.overrides }, 1),
      ),
    ).toThrow("Context projection event is inconsistent");

    projection.apply(connection, {
      ...event({}, 1),
      eventName: "context.manifest-created@1",
      payload: { manifest: values.manifest },
    } as EventEnvelope);
    let error: unknown;
    try {
      projection.apply(
        connection,
        event(
          {
            manifestId: ids.manifest,
            overrides: {
              pinnedEntryIds: ["61000000-0000-4000-8000-000000000099"],
              excludedEntryIds: [],
            },
          },
          2,
        ),
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe("Error: Context projection event is inconsistent");
    expect(String(error)).not.toContain("Current request");
    expect(String(error)).not.toContain("message-1");
    connection.close();
  });

  it("uses the manifest overrides until a newer turn-scoped override event exists", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    projection.apply(
      connection,
      directEvent("context.manifest-created@1", { manifest: values.manifest }, 1),
    );

    expect(readCurrentContextOverrides(connection, ids.manifest as never)).toEqual(
      values.overrides,
    );
    connection.close();
  });

  it("rejects every context event family outside the context ledger aggregate", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    const events = [
      directEvent("context.manifest-created@1", { manifest: values.manifest }, 1),
      directEvent(
        "context.overrides-updated@1",
        {
          manifestId: ids.manifest,
          overrides: values.overrides,
        },
        2,
      ),
      directEvent("context.plan-created@1", { plan: values.plan }, 3),
      directEvent("context.summary-created@1", { summary: values.summary }, 4),
      directEvent("context.usage-reconciled@1", { reconciliation: values.reconciliation }, 5),
      directEvent(
        "context.capacity-reservation-updated@1",
        {
          reservation: values.reservation,
        },
        6,
      ),
    ];

    for (const event of events) {
      expectRejectedWithoutMutation(connection, () =>
        projection.apply(connection, { ...event, aggregateType: "project" as never }),
      );
    }
    expect(projectionRows(connection).every((rows) => rows.length === 0)).toBe(true);
    connection.close();
  });

  it("rejects override, plan, and usage events from a different context ledger", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    const otherAggregateId = "61000000-0000-4000-8000-000000000099";
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(connection, {
        ...directEvent("context.manifest-created@1", { manifest: values.manifest }, 1),
        aggregateId: otherAggregateId as never,
      }),
    );
    projection.apply(
      connection,
      directEvent("context.manifest-created@1", { manifest: values.manifest }, 1),
    );

    expectRejectedWithoutMutation(connection, () =>
      projection.apply(connection, {
        ...directEvent(
          "context.overrides-updated@1",
          { manifestId: ids.manifest, overrides: values.overrides },
          2,
        ),
        aggregateId: otherAggregateId as never,
      }),
    );
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(connection, {
        ...directEvent("context.plan-created@1", { plan: values.plan }, 3),
        aggregateId: otherAggregateId as never,
      }),
    );

    projection.apply(connection, directEvent("context.plan-created@1", { plan: values.plan }, 4));
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(connection, {
        ...directEvent("context.usage-reconciled@1", { reconciliation: values.reconciliation }, 5),
        aggregateId: otherAggregateId as never,
      }),
    );

    expect(readCurrentContextOverrides(connection, ids.manifest as never)).toEqual(
      values.overrides,
    );
    expect(readContextPlan(connection, ids.plan as never)).toEqual(values.plan);
    expect(readContextUsage(connection, ids.usage as never)).toBeUndefined();
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(connection, {
        ...directEvent(
          "context.capacity-reservation-updated@1",
          { reservation: values.reservation },
          6,
        ),
        aggregateId: otherAggregateId as never,
      }),
    );
    expect(readProviderCapacityReservations(connection, ids.provider as never)).toEqual([]);
    connection.close();
  });

  it("rejects usage whose provider or model contradicts its persisted plan manifest", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    projection.apply(
      connection,
      directEvent("context.manifest-created@1", { manifest: values.manifest }, 1),
    );
    projection.apply(connection, directEvent("context.plan-created@1", { plan: values.plan }, 2));

    expect(() =>
      projection.apply(
        connection,
        directEvent(
          "context.usage-reconciled@1",
          {
            reconciliation: {
              ...values.reconciliation,
              providerInstanceId: "61000000-0000-4000-8000-000000000099",
            },
          },
          3,
        ),
      ),
    ).toThrow("Context projection event is inconsistent");
    connection.close();
  });

  it("rejects capacity snapshots whose update time regresses at a later sequence", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    projection.apply(
      connection,
      directEvent(
        "context.capacity-reservation-updated@1",
        { reservation: { ...values.reservation, updatedAt: later } },
        1,
      ),
    );

    expect(() =>
      projection.apply(
        connection,
        directEvent(
          "context.capacity-reservation-updated@1",
          { reservation: { ...values.reservation, state: "running", updatedAt: now } },
          2,
        ),
      ),
    ).toThrow("Context projection event is inconsistent");
    connection.close();
  });

  it("ignores stale duplicate mutable snapshots but rejects conflicting immutable identities", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    const envelope = (sequence: number, manifest = values.manifest): EventEnvelope =>
      ({
        eventId: crypto.randomUUID(),
        globalSequence: sequence,
        aggregateType: "context-ledger",
        aggregateId: ids.aggregate,
        aggregateVersion: sequence,
        eventName: "context.manifest-created@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { manifest },
      }) as EventEnvelope;
    projection.apply(connection, envelope(2));
    projection.apply(connection, envelope(1));
    expect(readContextManifest(connection, ids.manifest as never)).toEqual(values.manifest);
    expect(() =>
      projection.apply(
        connection,
        envelope(3, { ...values.manifest, modelId: "model-b" as never }),
      ),
    ).toThrow("Context projection event is inconsistent");
    connection.close();
  });

  it("rejects stale immutable snapshots with conflicting identities", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("contexts");
    if (projection === undefined) throw new Error("Context projection must be registered");
    const values = fixtures();
    projection.apply(
      connection,
      directEvent("context.manifest-created@1", { manifest: values.manifest }, 2),
    );
    projection.apply(connection, directEvent("context.plan-created@1", { plan: values.plan }, 2));
    projection.apply(
      connection,
      directEvent("context.summary-created@1", { summary: values.summary }, 2),
    );
    projection.apply(
      connection,
      directEvent("context.usage-reconciled@1", { reconciliation: values.reconciliation }, 2),
    );
    projection.apply(
      connection,
      directEvent(
        "context.capacity-reservation-updated@1",
        { reservation: { ...values.reservation, updatedAt: later } },
        2,
      ),
    );

    expectRejectedWithoutMutation(connection, () =>
      projection.apply(
        connection,
        directEvent(
          "context.manifest-created@1",
          { manifest: { ...values.manifest, modelId: "model-b" } },
          1,
        ),
      ),
    );
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(
        connection,
        directEvent(
          "context.plan-created@1",
          { plan: { ...values.plan, safeInputBudget: 1_100 } },
          1,
        ),
      ),
    );
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(
        connection,
        directEvent(
          "context.summary-created@1",
          { summary: { ...values.summary, usageCount: 1 } },
          1,
        ),
      ),
    );
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(
        connection,
        directEvent(
          "context.usage-reconciled@1",
          { reconciliation: { ...values.reconciliation, actualOutputTokens: 9 } },
          1,
        ),
      ),
    );
    expectRejectedWithoutMutation(connection, () =>
      projection.apply(
        connection,
        directEvent(
          "context.capacity-reservation-updated@1",
          {
            reservation: {
              ...values.reservation,
              providerInstanceId: "61000000-0000-4000-8000-000000000098",
            },
          },
          1,
        ),
      ),
    );

    const beforeStaleTimestamp = contextProjectionState(connection);
    projection.apply(
      connection,
      directEvent("context.capacity-reservation-updated@1", { reservation: values.reservation }, 1),
    );
    expect(contextProjectionState(connection)).toEqual(beforeStaleTimestamp);
    connection.close();
  });
});

function projectionRows(connection: SqliteConnection): ReadonlyArray<ReadonlyArray<unknown>> {
  return [
    "context_manifest_projection",
    "context_override_projection",
    "context_plan_projection",
    "context_summary_projection",
    "context_usage_projection",
    "context_capacity_projection",
  ].map((table) => connection.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

function contextProjectionState(connection: SqliteConnection) {
  return {
    rows: projectionRows(connection),
    checkpoints: connection
      .prepare("SELECT * FROM projection_checkpoints ORDER BY projection_name")
      .all(),
  };
}

function expectRejectedWithoutMutation(connection: SqliteConnection, apply: () => void): void {
  const before = contextProjectionState(connection);
  expect(apply).toThrow("Context projection event is inconsistent");
  expect(contextProjectionState(connection)).toEqual(before);
}

function directEvent(eventName: string, payload: unknown, sequence: number): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    globalSequence: sequence,
    aggregateType: "context-ledger",
    aggregateId: ids.aggregate,
    aggregateVersion: sequence,
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload,
  } as EventEnvelope;
}
