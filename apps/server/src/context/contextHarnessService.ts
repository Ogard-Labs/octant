import {
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeContextCommand,
  decodeContextCommandResult,
  decodeContextEntry,
  decodeContextInspectorSnapshot,
  decodeContextManifest,
  decodeContextPlan,
  decodeContextSummaryContent,
  decodeContextSummaryId,
  decodeUsageReconciliation,
  decodeUsageReconciliationId,
  type ContextCapabilityCounts,
  type ContextCommandResult,
  type ContextEntry,
  type ContextEntryId,
  type ContextInspectorSnapshot,
  type ContextReserveBreakdown,
  type ContextSubjectRef,
  type ContextSummary,
  type ContextSummaryId,
  type ContextPlanId,
  type ModelContextLimits,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderServiceLimits,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  ContextCompactionRejected,
  reconcileContextVariance,
} from "@octant/domain/context-compaction";
import {
  ContextPolicyRejected,
  applyContextOverrides,
  calculateSafeInputBudget,
  evaluateContextHealth,
  reduceContextToBudget,
  resolveEffectiveModelLimits,
} from "@octant/domain/context-policy";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  readContextSubjectProjection,
  readContextSummary,
  readContextSummaryContent,
  writeContextSummaryContent,
} from "../persistence/contextProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { Schema } from "effect";
import {
  selectCapabilities,
  type CapabilityCatalog,
  type CapabilitySelectionRequest,
} from "./capabilityCatalog";
import { composeCapabilityContextEntries } from "./capabilityComposition";
import type {
  ContextMaintenanceMaterial,
  ContextMaintenancePort,
  GenerateContextSummaryRequest,
  GeneratedContextSummary,
} from "./contextMaintenancePort";
import type { ContextMaintenanceResult } from "./contextMaintenanceService";
import {
  makeContextMaintenanceService,
  CONTEXT_SUMMARY_EXPECTED_RETAINED_SHARE,
  CONTEXT_SUMMARY_EXPECTED_REUSE_TURNS,
} from "./contextRuntime";

const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

interface ContextHarnessPersistence {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly status: () => { readonly state: string; readonly integrity: string };
}

export interface ContextHarnessServiceOptions {
  readonly persistence: ContextHarnessPersistence;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export interface PlanContextTurnInput {
  readonly subject: ContextSubjectRef;
  readonly displayLabel: string;
  readonly requestShape: string;
  readonly modelLimitObservations: ReadonlyArray<ModelContextLimits>;
  readonly serviceLimits: ProviderServiceLimits;
  readonly entries: ReadonlyArray<ContextEntry>;
  readonly reserves: ContextReserveBreakdown;
  readonly watchHeadroomTokens: number;
  readonly capabilityCatalog: CapabilityCatalog;
  readonly capabilityRequest: CapabilitySelectionRequest;
}

export interface ReconcileContextUsageInput {
  readonly subject: ContextSubjectRef;
  readonly planId: ContextPlanId;
  readonly requestShape: string;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
  readonly currentVarianceReserve: number;
  readonly maxAdjustmentTokens: number;
}

export interface RestoreContextSubjectInput {
  readonly subject: ContextSubjectRef;
  readonly displayLabel: string;
  readonly modelLimits: ModelContextLimits;
  readonly serviceLimits: ProviderServiceLimits;
  readonly capabilities: ContextCapabilityCounts;
  readonly requestShape: string;
  readonly watchHeadroomTokens: number;
}

export interface MaintainContextTurnInput {
  readonly subject: ContextSubjectRef;
  /**
   * Canonical text for the entries the caller can supply material for. Only
   * entries this subject's own manifest already carries are considered, so
   * maintenance can never widen what the subject may see.
   */
  readonly materials: ReadonlyArray<{
    readonly entryId: ContextEntryId;
    readonly content: string;
  }>;
  readonly generateSummary: (
    request: GenerateContextSummaryRequest,
    signal: AbortSignal,
  ) => Promise<GeneratedContextSummary>;
  readonly maintenanceProviderInstanceId?: ProviderInstanceId;
  readonly maintenanceModelId?: ProviderModelId;
  readonly crossVendorOptIn?: boolean;
  readonly signal: AbortSignal;
}

export type MaintainContextTurnResult =
  | {
      readonly kind: "summary-created";
      readonly summary: ContextSummary;
      readonly content: string;
      readonly snapshot: ContextInspectorSnapshot;
    }
  | { readonly kind: "not-needed" }
  | Exclude<ContextMaintenanceResult, { readonly kind: "summary-created" }>;

export class ContextHarnessError extends Error {
  override readonly name = "ContextHarnessError";

  constructor(
    readonly category: "stale" | "invalid" | "unavailable" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

export class ContextHarnessService {
  readonly #persistence: ContextHarnessPersistence;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #snapshots = new Map<string, ContextInspectorSnapshot>();
  readonly #planningFactsBySubject = new Map<
    string,
    { readonly requestShape: string; readonly watchHeadroomTokens: number }
  >();

  constructor(options: ContextHarnessServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  planTurn(input: PlanContextTurnInput): ContextInspectorSnapshot {
    this.#assertReady();
    const modelLimits = resolveEffectiveModelLimits(input.modelLimitObservations);
    if (
      input.serviceLimits.providerInstanceId !== modelLimits.providerInstanceId ||
      input.capabilityRequest.providerInstanceId !== modelLimits.providerInstanceId
    ) {
      throw new ContextHarnessError(
        "invalid",
        "Context facts must describe one provider instance.",
      );
    }
    const selection = selectCapabilities(input.capabilityCatalog, input.capabilityRequest);
    if (selection.status !== "selected") {
      throw new ContextHarnessError("blocked", "Capability selection is blocked.");
    }
    const capabilityEntries = composeCapabilityContextEntries(selection, {
      turn: 1,
      redactedPreview: true,
    });
    const timestamp = decodeTimestamp(this.#clock());
    const manifest = applyContextOverrides(
      decodeContextManifest({
        id: this.#uuid(),
        subject: input.subject,
        providerInstanceId: modelLimits.providerInstanceId,
        modelId: modelLimits.modelId,
        entries: [...input.entries, ...capabilityEntries],
        overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
        createdAt: timestamp,
      }),
      { pinnedEntryIds: [], excludedEntryIds: [] },
    );
    const plan = this.#plan(manifest, {
      modelLimits,
      serviceLimits: input.serviceLimits,
      reserves: input.reserves,
      watchHeadroomTokens: input.watchHeadroomTokens,
      timestamp,
    });
    const committed = this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: input.subject.aggregateId },
      expectedVersion: this.#aggregateVersion(input.subject.aggregateId),
      events: [
        this.#pending("context.manifest-created@1", { manifest }),
        this.#pending("context.plan-created@1", { plan }),
      ],
    });
    const snapshot = decodeContextInspectorSnapshot({
      subject: input.subject,
      sequence: committed.lastSequence,
      displayLabel: input.displayLabel,
      snapshotAt: timestamp,
      modelLimits,
      serviceLimits: input.serviceLimits,
      next: { manifest, plan },
      summaries: [],
      capabilities: capabilityCounts(input.capabilityCatalog, selection.selected),
    });
    const key = subjectKey(input.subject);
    this.#snapshots.set(key, snapshot);
    this.#planningFactsBySubject.set(key, {
      requestShape: input.requestShape,
      watchHeadroomTokens: input.watchHeadroomTokens,
    });
    return snapshot;
  }

  execute(input: unknown): ContextCommandResult {
    this.#assertReady();
    let command;
    try {
      command = decodeContextCommand(input);
    } catch {
      throw new ContextHarnessError("invalid", "Context command is invalid.");
    }
    const key = subjectKey(command.subject);
    const current = this.#snapshots.get(key);
    if (current === undefined) {
      throw new ContextHarnessError("unavailable", "Context is unavailable.");
    }
    if (command.expectedManifestId !== current.next.manifest.id) {
      throw new ContextHarnessError("stale", "Reload context before applying this command.");
    }
    const timestamp = decodeTimestamp(this.#clock());
    let manifest: ReturnType<typeof decodeContextManifest>;
    let plan: ReturnType<typeof decodeContextPlan>;
    try {
      manifest =
        command.kind === "update-context-overrides"
          ? applyContextOverrides(current.next.manifest, command.overrides)
          : current.next.manifest;
      plan = this.#plan(manifest, {
        modelLimits: current.modelLimits,
        serviceLimits: current.serviceLimits,
        reserves: current.next.plan.reserves,
        watchHeadroomTokens: this.#planningFactsBySubject.get(key)?.watchHeadroomTokens ?? 0,
        timestamp,
      });
    } catch (error) {
      throw harnessPolicyError(error);
    }
    const events =
      command.kind === "update-context-overrides"
        ? [
            this.#pending("context.overrides-updated@1", {
              manifestId: manifest.id,
              overrides: manifest.overrides,
            }),
            this.#pending("context.plan-created@1", { plan }),
          ]
        : [this.#pending("context.plan-created@1", { plan })];
    const committed = this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: command.subject.aggregateId },
      expectedVersion: this.#aggregateVersion(command.subject.aggregateId),
      events,
    });
    const snapshot = decodeContextInspectorSnapshot({
      ...current,
      sequence: committed.lastSequence,
      snapshotAt: timestamp,
      next: { manifest, plan },
    });
    this.#snapshots.set(key, snapshot);
    return decodeContextCommandResult({
      kind: command.kind === "update-context-overrides" ? "context-updated" : "context-rebuilt",
      snapshot,
    });
  }

  reconcileUsage(input: ReconcileContextUsageInput) {
    this.#assertReady();
    const key = subjectKey(input.subject);
    const current = this.#snapshots.get(key);
    if (current === undefined) {
      throw new ContextHarnessError("unavailable", "Context is unavailable.");
    }
    if (input.planId !== current.next.plan.id) {
      throw new ContextHarnessError("stale", "Usage must reconcile the current context plan.");
    }
    const expectedRequestShape = this.#planningFactsBySubject.get(key)?.requestShape;
    if (expectedRequestShape === undefined) {
      throw new ContextHarnessError("unavailable", "Context planning facts are unavailable.");
    }
    let variance;
    try {
      variance = reconcileContextVariance({
        requestShape: input.requestShape,
        expectedRequestShape,
        plannedInputTokens: current.next.plan.plannedInputTokens,
        actualInputTokens: input.actualInputTokens,
        currentVarianceReserve: input.currentVarianceReserve,
        maxAdjustmentTokens: input.maxAdjustmentTokens,
      });
    } catch (error) {
      throw harnessPolicyError(error);
    }
    const timestamp = decodeTimestamp(this.#clock());
    const reconciliation = decodeUsageReconciliation({
      id: this.#uuid(),
      planId: current.next.plan.id,
      providerInstanceId: current.modelLimits.providerInstanceId,
      modelId: current.modelLimits.modelId,
      requestShape: input.requestShape,
      plannedInputTokens: current.next.plan.plannedInputTokens,
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
      ...(input.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: input.cacheReadInputTokens }),
      ...(input.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
      ...(input.providerExecutionDurationMs === undefined
        ? {}
        : { providerExecutionDurationMs: input.providerExecutionDurationMs }),
      varianceTokens: variance.varianceTokens,
      observedAt: timestamp,
    });
    const committed = this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: input.subject.aggregateId },
      expectedVersion: this.#aggregateVersion(input.subject.aggregateId),
      events: [
        this.#pending("context.usage-reconciled@1", {
          reconciliation,
        }),
      ],
    });
    const snapshot = decodeContextInspectorSnapshot({
      ...current,
      sequence: committed.lastSequence,
      snapshotAt: timestamp,
      latestSent: current.next,
      latestUsage: reconciliation,
    });
    this.#snapshots.set(key, snapshot);
    return { variance, snapshot } as const;
  }

  /**
   * Replaces the conversation material the current plan had to drop with one
   * journaled summary.
   *
   * The planner already reduces to fit, but a reduced turn simply stops seeing
   * the dropped material and says nothing about it. Maintenance turns that
   * silent loss into a recorded compaction: the dropped entries stay in the
   * manifest as `summarized` with the summary that now stands for them, and the
   * summary itself is journaled so a later turn — and a restart — rebuilds it.
   */
  async maintainContext(input: MaintainContextTurnInput): Promise<MaintainContextTurnResult> {
    this.#assertReady();
    const key = subjectKey(input.subject);
    const current = this.#snapshots.get(key);
    if (current === undefined) {
      throw new ContextHarnessError("unavailable", "Context is unavailable.");
    }
    const contentByEntryId = new Map(
      input.materials.map((material) => [String(material.entryId), material.content]),
    );
    const droppedEntryIds = new Set(
      current.next.plan.entries.flatMap((entry) =>
        entry.state === "omitted" && entry.reason === "omitted-to-fit"
          ? [String(entry.entryId)]
          : [],
      ),
    );
    const compactable = current.next.manifest.entries.filter(
      (entry) =>
        droppedEntryIds.has(String(entry.id)) &&
        contentByEntryId.has(String(entry.id)) &&
        entry.category === "conversation" &&
        entry.eligibility.status === "eligible" &&
        entry.tokens.kind === "known",
    );
    if (compactable.length === 0) return { kind: "not-needed" };

    const boundedMaterialTokens = compactable.reduce(
      (total, entry) => total + (entry.tokens.kind === "known" ? entry.tokens.tokens : 0),
      0,
    );
    const retainedTokens = Math.ceil(
      boundedMaterialTokens * CONTEXT_SUMMARY_EXPECTED_RETAINED_SHARE,
    );
    const captured: Array<{ readonly summary: ContextSummary; readonly content: string }> = [];
    const port: ContextMaintenancePort = {
      loadMaterials: (entryIds) =>
        entryIds.flatMap((entryId): ReadonlyArray<ContextMaintenanceMaterial> => {
          const entry = compactable.find((candidate) => candidate.id === entryId);
          const content = contentByEntryId.get(String(entryId));
          return entry === undefined || content === undefined || entry.tokens.kind !== "known"
            ? []
            : [{ entryId, content, sizeTokens: entry.tokens.tokens }];
        }),
      generateSummary: input.generateSummary,
      writeSummary: (stored) => {
        captured.push({ summary: stored.summary, content: stored.content });
      },
      // The harness owns the summary half of context maintenance. Usage
      // reconciliation has its own journaled path (`reconcileUsage`), and the
      // dispatch/rebuild half needs a provider context-length rejection that no
      // adapter reports yet, so neither is reachable through this port.
      writeUsage: () => {
        throw new ContextHarnessError("invalid", "Context maintenance does not reconcile usage.");
      },
      rebuildContextPlan: () => {
        throw new ContextHarnessError("invalid", "Context maintenance does not dispatch turns.");
      },
      dispatch: () =>
        Promise.reject(
          new ContextHarnessError("invalid", "Context maintenance does not dispatch turns."),
        ),
    };

    let result: ContextMaintenanceResult;
    try {
      result = await makeContextMaintenanceService({
        port,
        identity: {
          summaryId: () => decodeContextSummaryId(this.#uuid()),
          usageId: () => decodeUsageReconciliationId(this.#uuid()),
          timestamp: () => decodeTimestamp(this.#clock()),
        },
      }).maintain(
        {
          activeProviderInstanceId: current.next.manifest.providerInstanceId,
          activeModelId: current.next.manifest.modelId,
          ...(input.maintenanceProviderInstanceId === undefined
            ? {}
            : { maintenanceProviderInstanceId: input.maintenanceProviderInstanceId }),
          ...(input.maintenanceModelId === undefined
            ? {}
            : { maintenanceModelId: input.maintenanceModelId }),
          crossVendorOptIn: input.crossVendorOptIn ?? false,
          expectedReuseCount: CONTEXT_SUMMARY_EXPECTED_REUSE_TURNS,
          expectedSavingsPerReuseTokens: Math.max(0, boundedMaterialTokens - retainedTokens),
          maintenanceCostTokens: boundedMaterialTokens,
          materials: compactable.map((entry) => ({
            entryId: entry.id,
            sizeTokens: entry.tokens.kind === "known" ? entry.tokens.tokens : 0,
            eligible: true,
            providerInstanceId: current.next.manifest.providerInstanceId,
            modelId: current.next.manifest.modelId,
          })),
          // The maintenance request has to fit one safe request of its own.
          maxMaterialTokens: current.next.plan.safeInputBudget,
          replacedSummaryIds: current.summaries
            .filter((summary) =>
              summary.sourceEntryIds.every((entryId) => droppedEntryIds.has(String(entryId))),
            )
            .map((summary) => summary.id),
          // The planner already reduced this turn to fit, so deterministic
          // reduction is the standing fallback rather than a user decision.
          deterministicFallbackAvailable: true,
        },
        input.signal,
      );
    } catch (error) {
      throw harnessPolicyError(error);
    }
    if (result.kind !== "summary-created") return result;
    const produced = captured.at(-1);
    if (produced === undefined) {
      throw new ContextHarnessError("unavailable", "Context maintenance produced no summary.");
    }
    return this.#commitSummary(current, produced.summary, produced.content);
  }

  /**
   * Reports which of a subject's conversation sources a previous turn already
   * compacted, and the summaries that stand for them.
   *
   * A caller rebuilds its manifest from canonical content every turn, so
   * without this it would re-send the material a summary already replaced and
   * pay for a fresh maintenance request each time. Reading it from the
   * projection is what makes an existing summary reusable across turns and
   * across a restart.
   */
  compactedConversation(subject: ContextSubjectRef): {
    readonly summarizedSourceKeys: ReadonlyMap<string, ContextSummaryId>;
    readonly summaries: ReadonlyArray<{
      readonly id: ContextSummaryId;
      readonly content: string;
      readonly tokens: number;
    }>;
  } {
    this.#assertReady();
    const projection = readContextSubjectProjection(this.#persistence.connection, subject);
    const summarizedSourceKeys = new Map<string, ContextSummaryId>();
    const summaryIds: Array<ContextSummaryId> = [];
    for (const entry of projection?.next.manifest.entries ?? []) {
      if (entry.state !== "summarized" || entry.summaryId === undefined) continue;
      summarizedSourceKeys.set(contextSourceKey(entry.source), entry.summaryId);
      if (!summaryIds.includes(entry.summaryId)) summaryIds.push(entry.summaryId);
    }
    const summaries = summaryIds.flatMap((summaryId) => {
      const supersededKey = `summary\u0000${summaryId}`;
      const summary = readContextSummary(this.#persistence.connection, summaryId);
      const content = readContextSummaryContent(this.#persistence.connection, summaryId);
      if (summary === undefined || content === undefined || content.length === 0) {
        // The text is gone — purged with the subject that produced it.
        // Reporting its sources as still compacted would drop that
        // conversation from every later turn behind a summary nothing can
        // produce, so the material is reported as uncompacted instead and the
        // caller sends the real messages again.
        for (const [sourceKey, id] of [...summarizedSourceKeys]) {
          if (id === summaryId) summarizedSourceKeys.delete(sourceKey);
        }
        return [];
      }
      // A summary that was itself compacted into a newer one is history, not
      // context: sending both would restate the same conversation twice.
      if (summarizedSourceKeys.has(supersededKey)) return [];
      return [{ id: summary.id, content, tokens: summary.summaryTokens.tokens }];
    });
    return { summarizedSourceKeys, summaries };
  }

  /** Returns the generated text a journaled summary stands for. */
  summaryContent(summaryId: ContextSummaryId): string | undefined {
    this.#assertReady();
    return readContextSummaryContent(this.#persistence.connection, summaryId);
  }

  #commitSummary(
    current: ContextInspectorSnapshot,
    summary: ContextSummary,
    content: string,
  ): MaintainContextTurnResult {
    const summarized = new Set(summary.sourceEntryIds.map((entryId) => String(entryId)));
    const timestamp = decodeTimestamp(this.#clock());
    const summarizedEntries = current.next.manifest.entries.map((entry) =>
      summarized.has(String(entry.id))
        ? decodeContextEntry({
            ...entry,
            state: "summarized",
            includedSize: 0,
            // The canonical original size stays; the entry now costs this turn
            // nothing because the summary below carries it.
            tokens: { kind: "known", tokens: 0, accuracy: "conservative-heuristic" },
            summaryId: summary.id,
          })
        : entry,
    );
    const summaryEntry = decodeContextEntry({
      id: this.#uuid(),
      source: { kind: "summary", referenceId: String(summary.id) },
      category: "conversation",
      label: "Compacted earlier conversation",
      eligibility: {
        providerInstanceId: current.next.manifest.providerInstanceId,
        status: "eligible",
        reason: "selected-provider",
      },
      posture: "compressible",
      retention: "active",
      priority: 0,
      originalSize: summary.originalTokens.tokens,
      includedSize: summary.summaryTokens.tokens,
      tokens: summary.summaryTokens,
      state: "included",
      introducedAtTurn: 1,
      reuseCount: 0,
      preview: { redacted: true, label: "Compacted conversation hidden" },
      summaryId: summary.id,
    });
    const manifest = decodeContextManifest({
      ...current.next.manifest,
      id: this.#uuid(),
      entries: [...summarizedEntries, summaryEntry],
      createdAt: timestamp,
    });
    let plan;
    try {
      plan = this.#plan(manifest, {
        modelLimits: current.modelLimits,
        serviceLimits: current.serviceLimits,
        reserves: current.next.plan.reserves,
        watchHeadroomTokens:
          this.#planningFactsBySubject.get(subjectKey(current.subject))?.watchHeadroomTokens ?? 0,
        timestamp,
      });
    } catch (error) {
      throw harnessPolicyError(error);
    }
    const committed = this.#persistence.journal.append(
      {
        aggregate: { aggregateType: "context-ledger", aggregateId: current.subject.aggregateId },
        expectedVersion: this.#aggregateVersion(current.subject.aggregateId),
        events: [
          this.#pending("context.manifest-created@1", { manifest }),
          this.#pending("context.summary-created@1", { summary }),
          this.#pending("context.plan-created@1", { plan }),
        ],
      },
      {
        // The summary was generated from this subject's own conversation, so
        // its text is subject content: it is stored against the subject where
        // a deletion purge can reach it, and the journal keeps only the
        // summary's identity and provenance. Writing it here commits the text
        // and the event together or not at all.
        beforeEvents: (connection) =>
          writeContextSummaryContent(connection, {
            summaryId: summary.id,
            subject: current.subject,
            content: decodeContextSummaryContent(content),
            createdAt: timestamp,
          }),
      },
    );
    const snapshot = decodeContextInspectorSnapshot({
      ...current,
      sequence: committed.lastSequence,
      snapshotAt: timestamp,
      next: { manifest, plan },
      summaries: [...current.summaries, summary],
    });
    this.#snapshots.set(subjectKey(current.subject), snapshot);
    return { kind: "summary-created", summary, content, snapshot };
  }

  restoreSubject(input: RestoreContextSubjectInput): ContextInspectorSnapshot {
    this.#assertReady();
    const projection = readContextSubjectProjection(this.#persistence.connection, input.subject);
    if (projection === undefined) {
      throw new ContextHarnessError("unavailable", "Context is unavailable.");
    }
    const snapshot = decodeContextInspectorSnapshot({
      subject: input.subject,
      sequence: projection.sequence,
      displayLabel: input.displayLabel,
      snapshotAt: decodeTimestamp(this.#clock()),
      modelLimits: input.modelLimits,
      serviceLimits: input.serviceLimits,
      next: projection.next,
      ...(projection.latestSent === undefined ? {} : { latestSent: projection.latestSent }),
      summaries: projection.summaries,
      ...(projection.latestUsage === undefined ? {} : { latestUsage: projection.latestUsage }),
      ...(projection.capacity === undefined ? {} : { capacity: projection.capacity }),
      capabilities: input.capabilities,
    });
    this.#snapshots.set(subjectKey(input.subject), snapshot);
    this.#planningFactsBySubject.set(subjectKey(input.subject), {
      requestShape: input.requestShape,
      watchHeadroomTokens: input.watchHeadroomTokens,
    });
    return snapshot;
  }

  inspect(subject: ContextSubjectRef, afterSequence?: number): ContextInspectorSnapshot {
    this.#assertReady();
    const snapshot = this.#snapshots.get(subjectKey(subject));
    if (snapshot === undefined) {
      throw new ContextHarnessError("unavailable", "Context is unavailable.");
    }
    if (afterSequence !== undefined && snapshot.sequence < afterSequence) {
      throw new ContextHarnessError("stale", "Context projection has not reached that sequence.");
    }
    return snapshot;
  }

  #plan(
    manifest: ReturnType<typeof decodeContextManifest>,
    input: {
      readonly modelLimits: ModelContextLimits;
      readonly serviceLimits: ProviderServiceLimits;
      readonly reserves: ContextReserveBreakdown;
      readonly watchHeadroomTokens: number;
      readonly timestamp: ReturnType<typeof decodeTimestamp>;
    },
  ) {
    const budget = calculateSafeInputBudget(input.modelLimits, input.reserves);
    const reduction = reduceContextToBudget(manifest, budget.safeInputBudget);
    const included = new Set(reduction.includedEntryIds);
    const reduced = new Map(reduction.reduced.map((entry) => [entry.entryId, entry.reason]));
    const blocked = budget.blocked || reduction.blocked;
    return decodeContextPlan({
      id: this.#uuid(),
      manifestId: manifest.id,
      safeInputBudget: budget.safeInputBudget,
      plannedInputTokens: reduction.plannedInputTokens,
      reserves: input.reserves,
      entries: manifest.entries.map((entry) => {
        const reason = reduced.get(entry.id);
        if (entry.state === "omitted") {
          return {
            entryId: entry.id,
            state: "omitted",
            tokens: entry.tokens,
            reason: entry.eligibility.status === "ineligible" ? "ineligible" : "omitted-to-fit",
          } as const;
        }
        if (included.has(entry.id)) {
          return {
            entryId: entry.id,
            state: entry.state,
            tokens: entry.tokens,
            reason:
              // Compacted material stays visible in the plan as summarized
              // rather than disappearing into "selected" or "omitted-to-fit".
              entry.state === "summarized"
                ? "summarized"
                : entry.posture === "required" || entry.posture === "reserved"
                  ? "required"
                  : manifest.overrides.pinnedEntryIds.includes(entry.id)
                    ? "pinned"
                    : "selected",
          } as const;
        }
        return {
          entryId: entry.id,
          state: "omitted",
          tokens: entry.tokens,
          reason:
            reason === "duplicate" || reason === "superseded" || reason === "stale"
              ? reason
              : reason === "unknown-optional-size"
                ? "unknown-size"
                : "omitted-to-fit",
        } as const;
      }),
      health: evaluateContextHealth({
        safeInputBudget: budget.safeInputBudget,
        plannedInputTokens: reduction.plannedInputTokens,
        watchHeadroomTokens: input.watchHeadroomTokens,
        blocked,
        actionNeeded: false,
        optimizing: reduction.reduced.length > 0,
        rateLimited: input.serviceLimits.retry.status === "active",
      }),
      blocked,
      remedies: blocked ? reduction.remedies : [],
      createdAt: input.timestamp,
    });
  }

  #aggregateVersion(aggregateId: string): number {
    const row = this.#persistence.connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get("context-ledger", aggregateId) as { readonly aggregate_version: number } | undefined;
    return row?.aggregate_version ?? 0;
  }

  #pending(eventName: string, payload: unknown) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      hostId: LOCAL_HOST_ID,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "system" as const, actorId: OCTANT_LOCAL_ACTOR_ID },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw new ContextHarnessError("unavailable", "Context storage is unavailable.");
    }
  }
}

/** Stable identity for the canonical thing a context entry stands for. */
export function contextSourceKey(source: ContextEntry["source"]): string {
  return `${source.kind}\u0000${source.referenceId}`;
}

function subjectKey(subject: ContextSubjectRef): string {
  return `${subject.aggregateType}\u0000${subject.aggregateId}`;
}

function harnessPolicyError(error: unknown): ContextHarnessError {
  if (error instanceof ContextPolicyRejected) {
    return new ContextHarnessError(
      error.code === "protected-entry" || error.code === "unsafe-arithmetic"
        ? "blocked"
        : "invalid",
      "Context policy rejected the requested operation.",
    );
  }
  if (error instanceof ContextCompactionRejected) {
    return new ContextHarnessError("invalid", "Context usage cannot be reconciled.");
  }
  return error instanceof ContextHarnessError
    ? error
    : new ContextHarnessError("unavailable", "Context service is unavailable.");
}

function capabilityCounts(
  catalog: CapabilityCatalog,
  selected: ReadonlyArray<CapabilityCatalog["entries"][number]>,
): ContextCapabilityCounts {
  const isMcp = (kind: CapabilityCatalog["entries"][number]["componentKind"]) =>
    kind === "mcp-tool" || kind === "mcp-prompt" || kind === "mcp-resource";
  const isTool = (kind: CapabilityCatalog["entries"][number]["componentKind"]) =>
    kind === "octant-tool";
  return {
    loadedTools: selected.filter((entry) => isTool(entry.componentKind)).length,
    availableTools: catalog.entries.filter((entry) => isTool(entry.componentKind)).length,
    loadedMcp: selected.filter((entry) => isMcp(entry.componentKind)).length,
    availableMcp: catalog.entries.filter((entry) => isMcp(entry.componentKind)).length,
  };
}
