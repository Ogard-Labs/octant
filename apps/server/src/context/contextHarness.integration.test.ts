import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeContextEntry,
  decodeContextSubjectRef,
  decodeModelContextLimits,
  decodeProviderInstanceId,
  decodeProviderServiceLimits,
} from "@octant/contracts";
import { deriveCatalogEpoch, type CapabilityCatalogEntry } from "./capabilityCatalog";
import { ContextHarnessService } from "./contextHarnessService";
import { purgeContextSubjectContent } from "../persistence/contextProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";

const now = "2026-07-18T21:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("81000000-0000-4000-8000-000000000001");
const subject = decodeContextSubjectRef({
  aggregateType: "project",
  aggregateId: "81000000-0000-4000-8000-000000000002",
});
const activeScope = {
  mode: { referenceId: "mode:code", revision: 1 },
  project: { referenceId: `project:${subject.aggregateId}`, revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: "model:model-a", revision: 1 },
} as const;
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ContextHarnessService integration", () => {
  it.each([
    { mode: "Chat", modeTokens: 48, reviewedBudget: 224 },
    { mode: "Work", modeTokens: 80, reviewedBudget: 256 },
    { mode: "Code", modeTokens: 112, reviewedBudget: 288 },
  ] as const)(
    "keeps the $mode empty-thread harness fixture within its reviewed budget",
    ({ mode, modeTokens, reviewedBudget }) => {
      const fixture = createFixture();
      const snapshot = fixture.service.planTurn({
        subject,
        displayLabel: `${mode} Project`,
        requestShape: "code-turn",
        modelLimitObservations: [modelLimits()],
        serviceLimits: serviceLimits(),
        entries: [
          harnessEntry("301", "provider-framing", "Provider framing", 64),
          harnessEntry("302", "octant-policy", "Core safety policy", 96),
          harnessEntry("303", "octant-policy", `${mode} mode policy`, modeTokens),
        ],
        reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
        watchHeadroomTokens: 100,
        capabilityCatalog: catalog([]),
        capabilityRequest: {
          providerInstanceId,
          activeScope,
          nativeToolSearch: "supported",
          taskKeywords: [],
          explicitSelections: [],
        },
      });

      expect(snapshot.next.plan.plannedInputTokens).toBe(160 + modeTokens);
      expect(snapshot.next.plan.plannedInputTokens).toBeLessThanOrEqual(reviewedBudget);
      expect(snapshot.next.plan.entries.every((entry) => entry.state === "included")).toBe(true);
      fixture.connection.close();
    },
  );

  it("plans, reduces, journals, and inspects an attributed turn without loading disabled capabilities", () => {
    const fixture = createFixture();
    const service = fixture.service;

    const snapshot = service.planTurn({
      subject,
      displayLabel: "Code Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [requiredEntry(300), optionalEntry(700)],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([disabledCapability()]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "unsupported",
        taskKeywords: ["repository"],
        explicitSelections: [],
      },
    });

    expect(snapshot.next.plan.safeInputBudget).toBe(600);
    expect(snapshot.next.plan.plannedInputTokens).toBe(300);
    expect(snapshot.next.plan.blocked).toBe(false);
    expect(snapshot.next.plan.entries).toEqual([
      expect.objectContaining({ entryId: requiredEntry(300).id, state: "included" }),
      expect.objectContaining({ entryId: optionalEntry(700).id, state: "omitted" }),
    ]);
    expect(snapshot.capabilities).toEqual({
      loadedTools: 0,
      availableTools: 1,
      loadedMcp: 0,
      availableMcp: 0,
    });
    expect(service.inspect(subject)).toEqual(snapshot);
    expect(fixture.journal.headSequence()).toBe(2);
    fixture.connection.close();
  });

  it("blocks required overflow with remedies and keeps canonical originals in the manifest", () => {
    const fixture = createFixture();
    const required = requiredEntry(700);
    const snapshot = fixture.service.planTurn({
      subject,
      displayLabel: "Work Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [required],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: [],
        explicitSelections: [],
      },
    });

    expect(snapshot.next.plan.blocked).toBe(true);
    expect(snapshot.next.plan.health).toBe("blocked");
    expect(snapshot.next.plan.remedies).toEqual([
      { kind: "unpin-context" },
      { kind: "reduce-output-reserve" },
      { kind: "switch-model" },
    ]);
    expect(snapshot.next.manifest.entries).toEqual([required]);
    fixture.connection.close();
  });

  it("applies turn-scoped overrides, rebuilds authoritatively, and rejects stale commands", () => {
    const fixture = createFixture();
    const initial = fixture.service.planTurn({
      subject,
      displayLabel: "Chat Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [requiredEntry(100), optionalEntry(100)],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: [],
        explicitSelections: [],
      },
    });

    const updated = fixture.service.execute({
      kind: "update-context-overrides",
      subject,
      expectedManifestId: initial.next.manifest.id,
      overrides: {
        pinnedEntryIds: [],
        excludedEntryIds: [optionalEntry(100).id],
      },
    });
    expect(updated.kind).toBe("context-updated");
    expect(updated.snapshot.next.manifest.overrides.excludedEntryIds).toEqual([
      optionalEntry(100).id,
    ]);
    expect(updated.snapshot.next.plan.entries[1]).toMatchObject({
      state: "omitted",
      reason: "omitted-to-fit",
    });
    expect(updated.snapshot.sequence).toBe(4);

    expect(() =>
      fixture.service.execute({
        kind: "update-context-overrides",
        subject,
        expectedManifestId: updated.snapshot.next.manifest.id,
        overrides: {
          pinnedEntryIds: [],
          excludedEntryIds: [requiredEntry(100).id],
        },
      }),
    ).toThrowError(expect.objectContaining({ category: "blocked" }));

    expect(() =>
      fixture.service.execute({
        kind: "rebuild-context-plan",
        subject,
        expectedManifestId: "81000000-0000-4000-8000-000000009999" as never,
      }),
    ).toThrowError(expect.objectContaining({ category: "stale" }));
    fixture.connection.close();
  });

  it("reconciles actual provider usage against the sent plan and persists visible variance", () => {
    const fixture = createFixture();
    const planned = fixture.service.planTurn({
      subject,
      displayLabel: "Code Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [requiredEntry(100)],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 20, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: [],
        explicitSelections: [],
      },
    });

    const reconciled = fixture.service.reconcileUsage({
      subject,
      planId: planned.next.plan.id,
      requestShape: "code-turn",
      actualInputTokens: 140,
      actualOutputTokens: 25,
      currentVarianceReserve: 20,
      maxAdjustmentTokens: 50,
    });
    expect(reconciled.variance).toEqual({
      requestShape: "code-turn",
      varianceTokens: 40,
      reserveAdjustmentTokens: 40,
      nextVarianceReserve: 60,
    });
    expect(reconciled.snapshot.latestSent).toEqual(planned.next);
    expect(reconciled.snapshot.latestUsage).toMatchObject({
      planId: planned.next.plan.id,
      plannedInputTokens: 100,
      actualInputTokens: 140,
      actualOutputTokens: 25,
      varianceTokens: 40,
    });
    expect(reconciled.snapshot.sequence).toBe(3);

    expect(() =>
      fixture.service.reconcileUsage({
        subject,
        planId: planned.next.plan.id,
        requestShape: "different-turn-shape",
        actualInputTokens: 140,
        actualOutputTokens: 25,
        currentVarianceReserve: 20,
        maxAdjustmentTokens: 50,
      }),
    ).toThrowError(expect.objectContaining({ category: "invalid" }));
    fixture.connection.close();
  });

  it("summarizes the conversation material the plan dropped and survives a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-context-harness-compaction-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = createFixture(path);
    const dropped = optionalEntry(500);
    const planned = first.service.planTurn({
      subject,
      displayLabel: "Code Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [requiredEntry(300), dropped],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 50, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: [],
        explicitSelections: [],
      },
    });
    // The planner drops the earlier conversation to fit; nothing about that
    // reaches the model or the journal until maintenance runs.
    expect(planned.next.plan.entries).toContainEqual(
      expect.objectContaining({ entryId: dropped.id, state: "omitted", reason: "omitted-to-fit" }),
    );

    const maintained = await first.service.maintainContext({
      subject,
      materials: [{ entryId: dropped.id, content: "Earlier conversation transcript." }],
      generateSummary: async () => ({
        content: "The user asked about deployment; Octant explained the release gates.",
        summaryTokens: { kind: "known", tokens: 120, accuracy: "conservative-heuristic" },
      }),
      signal: new AbortController().signal,
    });

    expect(maintained.kind).toBe("summary-created");
    if (maintained.kind !== "summary-created") throw new Error("expected a summary");
    expect(maintained.summary.sourceEntryIds).toEqual([dropped.id]);
    expect(maintained.content).toContain("deployment");
    // The compacted material is reported as summarized with its provenance,
    // never as material that silently fell out of the plan.
    expect(maintained.snapshot.next.plan.entries).toContainEqual(
      expect.objectContaining({ entryId: dropped.id, state: "summarized", reason: "summarized" }),
    );
    expect(
      maintained.snapshot.next.manifest.entries.find((entry) => entry.id === dropped.id)?.summaryId,
    ).toBe(maintained.summary.id);
    expect(maintained.snapshot.summaries.map((summary) => summary.id)).toContain(
      maintained.summary.id,
    );
    first.connection.close();

    const restarted = createFixture(path);
    const restored = restarted.service.restoreSubject({
      subject,
      displayLabel: "Code Project",
      modelLimits: modelLimits(),
      serviceLimits: serviceLimits(),
      capabilities: { loadedTools: 0, availableTools: 0, loadedMcp: 0, availableMcp: 0 },
      requestShape: "code-turn",
      watchHeadroomTokens: 100,
    });
    expect(restored.summaries.map((summary) => summary.id)).toContain(maintained.summary.id);
    expect(restarted.service.summaryContent(maintained.summary.id)).toBe(maintained.content);
    expect(restored.next.manifest.entries.find((entry) => entry.id === dropped.id)?.summaryId).toBe(
      maintained.summary.id,
    );
    // A caller rebuilding its manifest after restart learns which sources are
    // already compacted straight from the projection, so the next turn reuses
    // the summary instead of re-sending the material and paying again.
    const reusable = restarted.service.compactedConversation(subject);
    expect([...reusable.summarizedSourceKeys]).toEqual([
      [`${dropped.source.kind}\u0000${dropped.source.referenceId}`, maintained.summary.id],
    ]);
    expect(reusable.summaries).toEqual([
      { id: maintained.summary.id, content: maintained.content, tokens: 120 },
    ]);

    // Deleting the subject destroys the generated text. The summary keeps its
    // identity and provenance, so replay still rebuilds the projection, but a
    // reader is told the text is gone instead of being handed an empty summary
    // — and the material it stood for is reported as no longer compacted, so
    // the next turn sends the real conversation rather than silently losing it
    // behind a summary nothing can produce.
    purgeContextSubjectContent(restarted.connection, subject);
    expect(restarted.service.summaryContent(maintained.summary.id)).toBeUndefined();
    const afterPurge = restarted.service.compactedConversation(subject);
    expect(afterPurge.summaries).toEqual([]);
    expect([...afterPurge.summarizedSourceKeys]).toEqual([]);
    expect(
      restarted.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE '%release gates%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    restarted.connection.close();
  });

  it("restores the durable manifest, plan, overrides, and usage projection after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-context-harness-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = createFixture(path);
    const planned = first.service.planTurn({
      subject,
      displayLabel: "Code Project",
      requestShape: "code-turn",
      modelLimitObservations: [modelLimits()],
      serviceLimits: serviceLimits(),
      entries: [requiredEntry(100)],
      reserves: { response: 200, reasoning: 50, framing: 50, variance: 20, safety: 50 },
      watchHeadroomTokens: 100,
      capabilityCatalog: catalog([]),
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: [],
        explicitSelections: [],
      },
    });
    first.service.reconcileUsage({
      subject,
      planId: planned.next.plan.id,
      requestShape: "code-turn",
      actualInputTokens: 110,
      actualOutputTokens: 20,
      currentVarianceReserve: 20,
      maxAdjustmentTokens: 50,
    });
    first.connection.close();

    const restarted = createFixture(path);
    const restored = restarted.service.restoreSubject({
      subject,
      displayLabel: "Code Project",
      modelLimits: modelLimits(),
      serviceLimits: serviceLimits(),
      capabilities: { loadedTools: 0, availableTools: 0, loadedMcp: 0, availableMcp: 0 },
      requestShape: "code-turn",
      watchHeadroomTokens: 100,
    });
    expect(restored.next.manifest.id).toBe(planned.next.manifest.id);
    expect(restored.next.plan.id).toBe(planned.next.plan.id);
    expect(restored.latestSent?.plan.id).toBe(planned.next.plan.id);
    expect(restored.latestUsage).toMatchObject({ actualInputTokens: 110, varianceTokens: 10 });
    expect(restored.sequence).toBe(3);
    restarted.connection.close();
  });
});

function createFixture(existingPath?: string) {
  const path =
    existingPath ??
    (() => {
      const directory = mkdtempSync(join(tmpdir(), "octant-context-harness-"));
      directories.push(directory);
      return join(directory, "octant.sqlite3");
    })();
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let counter = 10;
  const service = new ContextHarnessService({
    persistence: {
      connection,
      journal,
      status: () => ({ state: "current", integrity: "ok" }) as const,
    },
    uuid: () => `81000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`,
    clock: () => now,
  });
  return { connection, journal, service };
}

function modelLimits() {
  return decodeModelContextLimits({
    providerInstanceId,
    modelId: "model-a",
    contextWindow: 1_000,
    maxOutput: 200,
    extendedContext: { kind: "unavailable" },
    reasoning: "included",
    compaction: "manual",
    tokenizer: { kind: "exact", id: "fixture" },
    source: "runtime-reported",
    confidence: "high",
    conflicts: [],
    verifiedAt: now,
  });
}

function serviceLimits() {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "available", limit: 2, remaining: 2 },
    retry: { status: "inactive" },
    quota: "unknown",
    source: "runtime-reported",
    confidence: "medium",
    updatedAt: now,
  });
}

function requiredEntry(tokens: number) {
  return decodeContextEntry({
    id: "81000000-0000-4000-8000-000000000101",
    source: { kind: "message", referenceId: "canonical-request" },
    category: "current-request",
    label: "Current request",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: tokens,
    includedSize: tokens,
    tokens: { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "Request hidden" },
  });
}

function optionalEntry(tokens: number) {
  return decodeContextEntry({
    id: "81000000-0000-4000-8000-000000000102",
    source: { kind: "message", referenceId: "canonical-history" },
    category: "conversation",
    label: "Earlier conversation",
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "compressible",
    retention: "active",
    priority: 10,
    originalSize: tokens,
    includedSize: tokens,
    tokens: { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: "History hidden" },
  });
}

function harnessEntry(
  idSuffix: string,
  category: "provider-framing" | "octant-policy",
  label: string,
  tokens: number,
) {
  return decodeContextEntry({
    id: `81000000-0000-4000-8000-000000000${idSuffix}`,
    source: {
      kind: category === "provider-framing" ? "provider" : "instruction",
      referenceId: label,
    },
    category,
    label,
    eligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    posture: "required",
    retention: "active",
    priority: 100,
    originalSize: tokens,
    includedSize: tokens,
    tokens: { kind: "known", tokens, accuracy: "exact-tokenizer" },
    state: "included",
    introducedAtTurn: 1,
    reuseCount: 0,
    preview: { redacted: true, label: `${label} hidden` },
  });
}

function disabledCapability(): CapabilityCatalogEntry {
  return {
    id: "81000000-0000-4000-8000-000000000201",
    source: { kind: "octant-tool", referenceId: "repo-search", componentId: "repo-search" },
    componentKind: "octant-tool",
    label: "Repository search",
    schemaCost: { kind: "known", tokens: 120, accuracy: "exact-tokenizer" },
    availability: "available",
    trust: "trusted",
    enablement: "disabled",
    policy: "allowed",
    providerEligibility: { providerInstanceId, status: "eligible", reason: "selected-provider" },
    scopeEligibility: {
      mode: { ...activeScope.mode, status: "eligible" },
      project: { ...activeScope.project, status: "eligible" },
      host: { ...activeScope.host, status: "eligible" },
      model: { ...activeScope.model, status: "eligible" },
    },
    posture: "essential",
    selectionMode: "automatic",
    taskKeywords: ["repository"],
    epoch: 1,
    invalidationFacts: [{ kind: "explicit-refresh" }],
  };
}

function catalog(entries: ReadonlyArray<CapabilityCatalogEntry>) {
  return {
    entries,
    epoch: deriveCatalogEpoch({
      entries,
      activeFacts: { providerInstanceId, activeScope },
      invalidationFacts: [],
    }),
  };
}
