import {
  CONTEXT_COMPACTION_EVENT_NAMES,
  CONTEXT_COMPACTION_REQUEST_SHAPE,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeContextCommand,
  decodeContextCompactionReceipt,
  decodeContextCompactionRecord,
  decodeContextEntry,
  decodeContextInspectorSnapshot,
  decodeContextManifest,
  decodeContextPlan,
  decodeContextSummary,
  decodeContextSummaryContent,
  decodeContextSummaryId,
  decodeUsageReconciliation,
  decodeUsageReconciliationId,
  type ContextCapabilityCounts,
  type ContextCommandResult,
  type ContextCompactionExecutor,
  type ContextCompactionFailureReason,
  type ContextCompactionId,
  type ContextCompactionRecord,
  type ContextCompactionUsage,
  type ContextEntry,
  type ContextEntryId,
  type ContextInspectorSnapshot,
  type ContextReserveBreakdown,
  type ContextSourceRef,
  type ContextSubjectRef,
  type ContextSummary,
  type ContextSummaryId,
  type ContextPlanId,
  type ContextPlanInspection,
  type KnownTokenMeasurement,
  type ModelContextLimits,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderServiceLimits,
  type UsageReconciliation,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  ContextCompactionRejected,
  reconcileContextVariance,
  selectSessionCompaction,
  type SessionCompactionItem,
} from "@octant/domain/context-compaction";
import {
  ContextPolicyRejected,
  applyContextOverrides,
  calculateSafeInputBudget,
  evaluateContextHealth,
  reduceContextToBudget,
  resolveEffectiveModelLimits,
} from "@octant/domain/context-policy";
import { ledgerUsageCost } from "@octant/domain/turn-metrics-display";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  listRunningContextCompactions,
  readContextCompaction,
  readContextCompactions,
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
import { SUMMARY_PROMPT_FRAMING } from "./contextSummaryGenerator";
import { automaticCompactionId, type AutomaticCompactionSighting } from "./automaticCompaction";
import {
  makeContextMaintenanceService,
  CONTEXT_SUMMARY_EXPECTED_RETAINED_SHARE,
  CONTEXT_SUMMARY_EXPECTED_REUSE_TURNS,
} from "./contextRuntime";

const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

interface PendingContextEvent {
  readonly eventId: ReturnType<typeof decodeEventId>;
  readonly eventName: string;
  readonly eventVersion: 1;
  readonly hostId: typeof LOCAL_HOST_ID;
  readonly correlationId: ReturnType<typeof decodeCorrelationId>;
  readonly actor: { readonly kind: "system"; readonly actorId: typeof OCTANT_LOCAL_ACTOR_ID };
  readonly occurredAt: ReturnType<typeof decodeTimestamp>;
  readonly payload: unknown;
}

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
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
  readonly currentVarianceReserve: number;
  readonly maxAdjustmentTokens: number;
  readonly providerReported?: boolean;
  /** The provider's own figure for the request, in US dollars. */
  readonly costUsd?: number;
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
  // A pin, an exclusion, or a new plan changed the subject's context while the
  // summary was being written. The summary was planned from the earlier state,
  // so it is discarded and nothing is committed.
  | { readonly kind: "context-changed" }
  | Exclude<ContextMaintenanceResult, { readonly kind: "summary-created" }>;

/** One message of a thread's conversation, as its own turn builder sources it. */
export interface SessionConversationMessage {
  /** The source the thread gives this message's context entry. */
  readonly source: ContextSourceRef;
  readonly role: "user" | "assistant";
  /** The turn the message belongs to; a receipt names the last one summarized. */
  readonly exchangeKey: string;
  readonly content: string;
}

export type SessionCompactionPreview =
  | { readonly kind: "no-session" }
  | { readonly kind: "nothing-to-compact" }
  | { readonly kind: "summarize"; readonly executor: ContextCompactionExecutor };

export interface ReportedCompactionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type CompactionSummaryOutcome =
  | { readonly kind: "generated"; readonly summary: GeneratedContextSummary }
  | { readonly kind: "failed"; readonly reason: "summary-failed" | "timed-out" };

export interface CompactSessionInput {
  readonly subject: ContextSubjectRef;
  readonly compactionId: ContextCompactionId;
  /** The conversation as it stood when the request was journaled. */
  readonly conversation: ReadonlyArray<SessionConversationMessage>;
  /**
   * The ledger version {@link ContextHarnessService.requestCompaction} returned.
   * The commit expects it, so anything journaled after the request, however
   * soon, fails the compaction instead of being undone by it.
   */
  readonly plannedVersion: number;
  readonly generateSummary: (
    request: GenerateContextSummaryRequest,
  ) => Promise<CompactionSummaryOutcome>;
  /** What the provider reported spending on the summary request, once it ends. */
  readonly reportedUsage: () => ReportedCompactionUsage | undefined;
  /**
   * Read again once the summary returns. The thread may have gone, its mode
   * may have been disabled, or it may have moved to another provider or model,
   * which is journaled on the thread rather than on this ledger.
   */
  readonly subjectAvailability: () => "available" | "mode-disabled" | "deleted" | "context-changed";
}

/** How a runtime's own compaction of a requested session ended. */
export type RuntimeCompactionOutcome =
  | {
      readonly kind: "compacted";
      /** The window's occupancy before, with how it is known. */
      readonly tokensBefore: KnownTokenMeasurement;
      /** The occupancy the runtime reported after; absent until the next usage report. */
      readonly tokensAfter?: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: ContextCompactionFailureReason;
      readonly sessionMayHaveChanged: boolean;
    };

export type CompactSessionResult =
  | {
      readonly kind: "settled";
      readonly record: ContextCompactionRecord;
      readonly snapshot?: ContextInspectorSnapshot;
    }
  // The thread was purged while the summary was written. The purge erased
  // the request, so no outcome is journaled for it.
  | { readonly kind: "discarded" };

export class ContextHarnessError extends Error {
  override readonly name = "ContextHarnessError";

  constructor(
    readonly category: "stale" | "invalid" | "unavailable" | "blocked" | "not-planned",
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
    let modelLimits = resolveEffectiveModelLimits(input.modelLimitObservations);
    const previousUsage = readContextSubjectProjection(
      this.#persistence.connection,
      input.subject,
    )?.latestUsage;
    const matchingUsage =
      previousUsage !== undefined &&
      String(previousUsage.providerInstanceId) === String(modelLimits.providerInstanceId) &&
      String(previousUsage.modelId) === String(modelLimits.modelId) &&
      previousUsage.requestShape === input.requestShape;
    const reserves =
      matchingUsage && previousUsage.nextVarianceReserve !== undefined
        ? {
            ...input.reserves,
            variance: Math.max(input.reserves.variance, previousUsage.nextVarianceReserve),
          }
        : input.reserves;
    if (
      // A window a person set wins over every automatic source, including a
      // runtime report: they set it because what the provider says is wrong.
      modelLimits.source !== "user-supplied" &&
      previousUsage?.contextWindow !== undefined &&
      String(previousUsage.providerInstanceId) === String(modelLimits.providerInstanceId) &&
      String(previousUsage.modelId) === String(modelLimits.modelId) &&
      previousUsage.requestShape === input.requestShape
    ) {
      // The emergency floor only admits a first turn. A matching runtime
      // observation survives restart and supplies the next turn's real bound.
      const { maxOutput, ...facts } = modelLimits;
      modelLimits = resolveEffectiveModelLimits([
        modelLimits,
        {
          ...facts,
          ...(modelLimits.source !== "conservative-fallback" && maxOutput !== undefined
            ? { maxOutput }
            : {}),
          contextWindow: previousUsage.contextWindow,
          source: "runtime-reported",
          confidence: "high",
          verifiedAt: previousUsage.observedAt,
          conflicts: [],
        },
      ]);
    }
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
      inspection: {
        displayLabel: input.displayLabel,
        modelLimits,
        serviceLimits: input.serviceLimits,
        capabilities: capabilityCounts(input.capabilityCatalog, selection.selected, input.entries),
        requestShape: input.requestShape,
        watchHeadroomTokens: input.watchHeadroomTokens,
      },
      modelLimits,
      serviceLimits: input.serviceLimits,
      reserves,
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
      capabilities: capabilityCounts(input.capabilityCatalog, selection.selected, input.entries),
    });
    const key = subjectKey(input.subject);
    this.#snapshots.set(key, snapshot);
    this.#planningFactsBySubject.set(key, {
      requestShape: input.requestShape,
      watchHeadroomTokens: input.watchHeadroomTokens,
    });
    return snapshot;
  }

  execute(input: unknown): Exclude<ContextCommandResult, { readonly kind: "compaction-started" }> {
    this.#assertReady();
    let command;
    try {
      command = decodeContextCommand(input);
    } catch {
      throw new ContextHarnessError("invalid", "Context command is invalid.");
    }
    // Compaction needs the thread's provider, capacity and spend authority,
    // which only the session compaction runner holds.
    if (command.kind === "compact-session") {
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
        ...(current.next.plan.inspection === undefined
          ? {}
          : { inspection: current.next.plan.inspection }),
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
    return command.kind === "update-context-overrides"
      ? { kind: "context-updated", snapshot }
      : { kind: "context-rebuilt", snapshot };
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
    // A request that reported no usage has no cost either: it stays unpriced,
    // so a money ceiling refuses instead of counting it as free.
    const cost =
      input.providerReported === false
        ? undefined
        : ledgerUsageCost(String(current.modelLimits.modelId), {
            inputTokens: input.actualInputTokens,
            outputTokens: input.actualOutputTokens,
            ...(input.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: input.reasoningTokens }),
            ...(input.cacheReadInputTokens === undefined
              ? {}
              : { cacheReadInputTokens: input.cacheReadInputTokens }),
            ...(input.cacheWriteInputTokens === undefined
              ? {}
              : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
            ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
          });
    const reconciliation = decodeUsageReconciliation({
      id: this.#uuid(),
      planId: current.next.plan.id,
      providerInstanceId: current.modelLimits.providerInstanceId,
      modelId: current.modelLimits.modelId,
      requestShape: input.requestShape,
      plannedInputTokens: current.next.plan.plannedInputTokens,
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      ...(input.contextTokens === undefined ? {} : { contextTokens: input.contextTokens }),
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
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
      ...(input.providerReported === false ? { providerReported: false } : {}),
      ...(cost === undefined ? {} : { cost }),
      varianceTokens: variance.varianceTokens,
      nextVarianceReserve: variance.nextVarianceReserve,
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
    // Read before the summary is requested: the commit must see the same ledger
    // version this plan was made from, not whatever the version is by then.
    const plannedVersion = this.#aggregateVersion(input.subject.aggregateId);
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
    if (this.#aggregateVersion(input.subject.aggregateId) !== plannedVersion) {
      return { kind: "context-changed" };
    }
    const snapshot = this.#commitSummary(current, produced.summary, produced.content, {
      expectedVersion: plannedVersion,
      events: () => [],
    });
    return {
      kind: "summary-created",
      summary: produced.summary,
      content: produced.content,
      snapshot,
    };
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
        for (const [sourceKey, id] of Array.from(summarizedSourceKeys)) {
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

  /** The subject's most recent compaction, if it has had one. */
  latestCompaction(subject: ContextSubjectRef): ContextCompactionRecord | undefined {
    this.#assertReady();
    return readContextCompactions(this.#persistence.connection, subject).at(-1);
  }

  /**
   * Whether a requested compaction of this subject is under way. No turn
   * starts meanwhile: its plan would fail the compaction as `context-changed`
   * after the summary was already paid for.
   */
  compactionRunning(subject: ContextSubjectRef): boolean {
    return this.latestCompaction(subject)?.status === "running";
  }

  compaction(
    subject: ContextSubjectRef,
    compactionId: ContextCompactionId,
  ): ContextCompactionRecord | undefined {
    this.#assertReady();
    return readContextCompaction(this.#persistence.connection, subject, compactionId);
  }

  /**
   * Whether a requested compaction of this subject would change anything now.
   *
   * There is no session to compact until a plan has been sent, and a thread
   * that has since moved to another provider or model has no session the
   * stored plan describes: summarizing it would write with a model the thread
   * no longer uses.
   */
  previewSessionCompaction(input: {
    readonly subject: ContextSubjectRef;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly conversation: ReadonlyArray<SessionConversationMessage>;
  }): SessionCompactionPreview {
    this.#assertReady();
    const current = this.#restored(input.subject);
    if (current === undefined || !describesSession(current, input)) return { kind: "no-session" };
    const selected = this.#selectCompaction(current, input.conversation);
    return selected.kind === "nothing-to-compact"
      ? selected
      : { kind: "summarize", executor: hostExecutor(current) };
  }

  /**
   * Journals a requested compaction, or returns the one already journaled
   * under this id so a repeated request never compacts twice.
   */
  requestCompaction(input: {
    readonly subject: ContextSubjectRef;
    readonly compactionId: ContextCompactionId;
    readonly executor: ContextCompactionExecutor;
  }):
    | {
        readonly kind: "requested";
        readonly record: ContextCompactionRecord;
        readonly version: number;
      }
    | { readonly kind: "existing"; readonly record: ContextCompactionRecord } {
    this.#assertReady();
    const existing = this.compaction(input.subject, input.compactionId);
    if (existing !== undefined) return { kind: "existing", record: existing };
    const requestedAt = decodeTimestamp(this.#clock());
    this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: input.subject.aggregateId },
      expectedVersion: this.#aggregateVersion(input.subject.aggregateId),
      events: [
        this.#pending(CONTEXT_COMPACTION_EVENT_NAMES.requested, {
          compactionId: input.compactionId,
          subject: input.subject,
          executor: input.executor,
          requestedBy: "local-window",
          requestedAt,
        }),
      ],
    });
    return {
      kind: "requested",
      record: decodeContextCompactionRecord({
        status: "running",
        compactionId: input.compactionId,
        executor: input.executor,
        requestedAt,
      }),
      // Read in the same turn of the event loop as the append, so a plan
      // journaled while the summary is being set up is not folded into it.
      version: this.#aggregateVersion(input.subject.aggregateId),
    };
  }

  /**
   * Summarizes the conversation before the recent tail with the thread's own
   * provider and model, and commits it as the subject's next plan.
   *
   * A requested compaction skips the reuse economics automatic maintenance
   * applies, because the person asked, but the summary must still be smaller
   * than what it replaces. The ledger version is read before the summary is
   * requested and the commit expects it, so a pin, an exclusion or a turn
   * planned in between fails the compaction rather than undoing that change.
   */
  async compactSession(input: CompactSessionInput): Promise<CompactSessionResult> {
    this.#assertReady();
    const requested = this.compaction(input.subject, input.compactionId);
    if (requested === undefined) return { kind: "discarded" };
    if (requested.status !== "running") return { kind: "settled", record: requested };
    const current = this.#restored(input.subject);
    if (current === undefined) {
      return this.#failCompaction(input.subject, input.compactionId, "subject-unavailable");
    }
    const { plannedVersion } = input;
    // The request fixed the version and the conversation it summarizes. A plan,
    // pin or exclusion journaled since then means the person's state is no
    // longer the one the request saw, so nothing is sent for it.
    if (this.#aggregateVersion(input.subject.aggregateId) !== plannedVersion) {
      return this.#failCompaction(input.subject, input.compactionId, "context-changed");
    }
    const selected = this.#selectCompaction(current, input.conversation);
    if (selected.kind === "nothing-to-compact") {
      // The conversation was compactable when the command was admitted.
      return this.#failCompaction(input.subject, input.compactionId, "context-changed");
    }
    const manifest = current.next.manifest;
    const outcome = await input.generateSummary({
      providerInstanceId: manifest.providerInstanceId,
      modelId: manifest.modelId,
      materials: selected.materials,
    });
    const usage = input.reportedUsage();
    try {
      const availability = input.subjectAvailability();

      // A purge erases the request with the thread; nothing may bring it back.
      // The summary's own spend is host accounting and stays, or a purged
      // thread would understate what the provider was asked to do.
      const latest = this.compaction(input.subject, input.compactionId);
      if (latest === undefined) {
        this.#recordCompactionUsage(input.subject, current, usage, selected.materialTokens);
        return { kind: "discarded" };
      }
      if (latest.status !== "running") return { kind: "settled", record: latest };
      const fail = (reason: ContextCompactionFailureReason) =>
        this.#failCompaction(input.subject, input.compactionId, reason, {
          usage,
          basePlan: current,
          materialTokens: selected.materialTokens,
        });
      // An ordinary delete keeps the thread's ledger until a purge, so the
      // request must end here: left running, it would hold the subject until the
      // next start closed it as interrupted. The summary is discarded either way.
      if (availability === "deleted") return fail("subject-unavailable");
      if (availability === "context-changed") return fail("context-changed");
      if (outcome.kind === "failed") return fail(outcome.reason);
      if (availability === "mode-disabled") return fail("subject-unavailable");
      if (this.#aggregateVersion(input.subject.aggregateId) !== plannedVersion) {
        return fail("context-changed");
      }
      const summaryTokens = outcome.summary.summaryTokens;
      if (summaryTokens.kind !== "known" || summaryTokens.tokens >= selected.materialTokens) {
        return fail("summary-not-smaller");
      }
      const summary = decodeContextSummary({
        id: this.#uuid(),
        sourceEntryIds: selected.entryIds,
        providerInstanceId: manifest.providerInstanceId,
        modelId: manifest.modelId,
        createdAt: decodeTimestamp(this.#clock()),
        usageCount: 0,
        summaryTokens,
        originalTokens: {
          kind: "known",
          tokens: selected.materialTokens,
          accuracy: "conservative-heuristic",
        },
        estimatedSavingsTokens: selected.materialTokens - summaryTokens.tokens,
        replacedSummaryIds: selected.replacedSummaryIds,
      });
      const usageReconciliation =
        usage === undefined
          ? undefined
          : this.#compactionUsage(current, usage, selected.materialTokens);
      let snapshot: ContextInspectorSnapshot;
      try {
        snapshot = this.#commitSummary(current, summary, outcome.summary.content, {
          expectedVersion: plannedVersion,
          events: ({ plan, timestamp }) => {
            const tokensBefore = current.next.plan.plannedInputTokens;
            const tokensAfter = plan.plannedInputTokens;
            const receipt = decodeContextCompactionReceipt({
              compactionId: input.compactionId,
              subject: input.subject,
              executor: hostExecutor(current),
              trigger: "requested",
              // Both figures are the planner's own estimate of the same request
              // before and after, so their difference is an estimate too.
              tokensBefore: {
                kind: "known",
                tokens: tokensBefore,
                accuracy: "conservative-heuristic",
              },
              tokensAfter: {
                kind: "known",
                tokens: tokensAfter,
                accuracy: "conservative-heuristic",
              },
              tokensFreed: {
                kind: "estimated",
                tokens: Math.max(0, tokensBefore - tokensAfter),
                accuracy: "conservative-heuristic",
              },
              summary: {
                visibility: "stored",
                summaryId: summary.id,
                summaryTokens,
                throughTurnId: selected.throughExchangeKey,
              },
              usage: compactionUsageOf(usageReconciliation),
              completedAt: timestamp,
            });
            return [
              ...(usageReconciliation === undefined
                ? []
                : [
                    this.#pending("context.usage-reconciled@1", {
                      reconciliation: usageReconciliation,
                    }),
                  ]),
              this.#pending(CONTEXT_COMPACTION_EVENT_NAMES.completed, { receipt }),
            ];
          },
        });
      } catch (error) {
        if (error instanceof ConcurrencyConflict) return fail("context-changed");
        throw error;
      }
      const completed = this.compaction(input.subject, input.compactionId);
      if (completed === undefined) {
        throw new ContextHarnessError("unavailable", "Compaction was not recorded.");
      }
      return { kind: "settled", record: completed, snapshot };
    } catch (error) {
      // Everything above that can throw runs after the provider was paid. A
      // request still running here had nothing journaled for it, usage
      // included, so the failure carries what the provider reported.
      if (this.compaction(input.subject, input.compactionId)?.status !== "running") throw error;
      return this.#failCompaction(input.subject, input.compactionId, "summary-failed", {
        usage,
        basePlan: current,
        materialTokens: selected.materialTokens,
      });
    }
  }

  /** Records a requested compaction that ended without changing the session. */
  failCompaction(
    subject: ContextSubjectRef,
    compactionId: ContextCompactionId,
    reason: ContextCompactionFailureReason,
  ): CompactSessionResult {
    this.#assertReady();
    return this.#failCompaction(subject, compactionId, reason);
  }

  /**
   * Journals how a runtime's own compaction of a requested session ended. The
   * runtime keeps the summary, so the receipt holds only what it reported and
   * what the host already knew of the window. Its usage is priced against the
   * subject's latest plan where it has one; a subject the host never planned
   * (a Code thread) carries the figures on the receipt alone, as its turns do.
   */
  settleRuntimeCompaction(input: {
    readonly subject: ContextSubjectRef;
    readonly compactionId: ContextCompactionId;
    readonly outcome: RuntimeCompactionOutcome;
    readonly usage: ReportedCompactionUsage | undefined;
  }): CompactSessionResult {
    this.#assertReady();
    const { subject, compactionId, outcome, usage } = input;
    const basePlan = this.#restored(subject);
    // No estimate was made for the runtime's own request, so it reconciles
    // against what it reported, as a planless child turn does.
    const spent =
      basePlan === undefined || usage === undefined
        ? undefined
        : { usage, basePlan, materialTokens: usage.inputTokens };
    const latest = this.compaction(subject, compactionId);
    if (latest === undefined) {
      // A purge erased the request; the runtime's spend stays host accounting.
      if (spent !== undefined) {
        this.#recordCompactionUsage(subject, spent.basePlan, usage, spent.materialTokens);
      }
      return { kind: "discarded" };
    }
    if (latest.status !== "running") return { kind: "settled", record: latest };
    if (outcome.kind === "failed") {
      return this.#failCompaction(
        subject,
        compactionId,
        outcome.reason,
        spent,
        outcome.sessionMayHaveChanged,
      );
    }
    const usageReconciliation =
      spent === undefined
        ? undefined
        : this.#compactionUsage(spent.basePlan, spent.usage, spent.materialTokens);
    const modelId = latest.executor.modelId;
    const cost =
      usage === undefined || modelId === undefined
        ? undefined
        : ledgerUsageCost(String(modelId), {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
    const before = outcome.tokensBefore;
    const completedAt = decodeTimestamp(this.#clock());
    const receipt = decodeContextCompactionReceipt({
      compactionId,
      subject,
      executor: latest.executor,
      trigger: "requested",
      tokensBefore: before,
      ...(outcome.tokensAfter === undefined
        ? {
            tokensAfter: { kind: "pending" },
            tokensFreed: { kind: "unknown", reason: "awaiting-next-report" },
          }
        : {
            tokensAfter: {
              kind: "known",
              tokens: outcome.tokensAfter,
              accuracy: "provider-reported",
            },
            // The difference is only as good as the weaker of its two figures,
            // and the figure after is always the runtime's own.
            tokensFreed: {
              kind: before.accuracy === "provider-reported" ? "measured" : "estimated",
              tokens: Math.max(0, before.tokens - outcome.tokensAfter),
              accuracy: before.accuracy,
            },
          }),
      summary: { visibility: "runtime-only" },
      usage:
        usageReconciliation !== undefined
          ? compactionUsageOf(usageReconciliation)
          : usage === undefined
            ? { kind: "unreported" }
            : {
                kind: "reported",
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                ...(cost === undefined ? {} : { cost }),
              },
      completedAt,
    });
    this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: subject.aggregateId },
      expectedVersion: this.#aggregateVersion(subject.aggregateId),
      events: [
        ...(usageReconciliation === undefined
          ? []
          : [this.#pending("context.usage-reconciled@1", { reconciliation: usageReconciliation })]),
        this.#pending(CONTEXT_COMPACTION_EVENT_NAMES.completed, { receipt }),
      ],
    });
    const completed = this.compaction(subject, compactionId);
    if (completed === undefined) {
      throw new ContextHarnessError("unavailable", "Compaction was not recorded.");
    }
    return { kind: "settled", record: completed };
  }

  /**
   * Journals a compaction a runtime made by itself during a turn. It has no
   * command and no requester, so it has no `requested` event: one completed
   * receipt, under an id derived from the turn and the compaction's place in
   * it, so a notification seen again after a recovery is journaled once.
   *
   * The window before is the runtime's own figure or the turn's latest report
   * when the turn had one, else the session's occupancy as a requested
   * compaction reads it. A compaction with no figure at all is not journaled:
   * a receipt never guesses its figure.
   */
  recordAutomaticCompaction(input: {
    readonly subject: ContextSubjectRef;
    readonly turnKey: string;
    readonly sighting: AutomaticCompactionSighting;
    readonly executor: Extract<ContextCompactionExecutor, { readonly kind: "runtime" }>;
    /** The session's latest journaled usage report, for a subject the host never planned. */
    readonly priorOccupancy?: { readonly tokens: number; readonly observedAt: string } | undefined;
  }): "recorded" | "already-recorded" | "unmeasured" {
    this.#assertReady();
    const { subject, sighting } = input;
    const compactionId = automaticCompactionId(subject, input.turnKey, sighting.position);
    if (this.compaction(subject, compactionId) !== undefined) return "already-recorded";
    const before = sighting.tokensBefore ?? this.occupancyBefore(subject, input.priorOccupancy);
    if (before === undefined) return "unmeasured";
    const receipt = decodeContextCompactionReceipt({
      compactionId,
      subject,
      executor: input.executor,
      trigger: "automatic",
      tokensBefore: before,
      ...(sighting.tokensAfter === undefined
        ? {
            tokensAfter: { kind: "pending" },
            tokensFreed: { kind: "unknown", reason: "awaiting-next-report" },
          }
        : {
            tokensAfter: {
              kind: "known",
              tokens: sighting.tokensAfter,
              accuracy: "provider-reported",
            },
            tokensFreed: {
              kind: before.accuracy === "provider-reported" ? "measured" : "estimated",
              tokens: Math.max(0, before.tokens - sighting.tokensAfter),
              accuracy: before.accuracy,
            },
          }),
      summary: { visibility: "runtime-only" },
      // The runtime's request rode inside the turn, and the turn's own usage
      // reports carry what it spent; counting it here too would bill it twice.
      usage: { kind: "unreported" },
      completedAt: decodeTimestamp(this.#clock()),
    });
    this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: subject.aggregateId },
      expectedVersion: this.#aggregateVersion(subject.aggregateId),
      events: [this.#pending(CONTEXT_COMPACTION_EVENT_NAMES.completed, { receipt })],
    });
    return "recorded";
  }

  /**
   * What the newest compaction of the subject's session after `since` left in
   * its window: its own figure after, or `pending` when it gave none or may
   * have changed the session without saying how. Undefined when nothing has
   * compacted the session since; with no `since`, any compaction counts.
   */
  sessionCompactedSince(
    subject: ContextSubjectRef,
    since: string | undefined,
  ): KnownTokenMeasurement | { readonly kind: "pending" } | undefined {
    this.#assertReady();
    const after = since === undefined ? undefined : Date.parse(since);
    const latest = readContextCompactions(this.#persistence.connection, subject)
      .filter((record) => {
        if (record.status === "running") return false;
        if (record.status === "failed" && !record.sessionMayHaveChanged) return false;
        const at = record.status === "completed" ? record.receipt.completedAt : record.failedAt;
        return after === undefined || Date.parse(at) > after;
      })
      .at(-1);
    if (latest === undefined) return undefined;
    return latest.status === "completed" ? latest.receipt.tokensAfter : { kind: "pending" };
  }

  /**
   * How full a runtime's window is before it compacts: the session's latest
   * usage report (`prior`, or for a subject the host plans, the occupancy its
   * plan reconciled), else the plan's own estimate. A compaction since that
   * report changed the window it describes: the figure that compaction
   * reported after stands instead, and without one the older report is only an
   * upper bound, and says so. Undefined when the host knows no figure at all.
   */
  occupancyBefore(
    subject: ContextSubjectRef,
    prior: { readonly tokens: number; readonly observedAt: string } | undefined,
  ): KnownTokenMeasurement | undefined {
    this.#assertReady();
    const planned = this.#restored(subject);
    const contextTokens = planned?.latestUsage?.contextTokens;
    const report =
      prior ??
      (planned?.latestUsage === undefined || contextTokens === undefined
        ? undefined
        : { tokens: contextTokens, observedAt: planned.latestUsage.observedAt });
    const estimate: KnownTokenMeasurement | undefined =
      planned === undefined
        ? undefined
        : {
            kind: "known",
            tokens: planned.next.plan.plannedInputTokens,
            accuracy: "conservative-heuristic",
          };
    const changedSince = this.sessionCompactedSince(subject, report?.observedAt);
    if (changedSince !== undefined) {
      if (changedSince.kind === "known") return changedSince;
      return report === undefined
        ? estimate
        : { kind: "known", tokens: report.tokens, accuracy: "conservative-heuristic" };
    }
    return report === undefined
      ? estimate
      : { kind: "known", tokens: report.tokens, accuracy: "provider-reported" };
  }

  /**
   * Closes the compactions a previous host process journaled but never
   * finished. The host summary was never committed, so its session is
   * unchanged; a runtime may have compacted before the host went away.
   */
  closeInterruptedCompactions(): number {
    this.#assertReady();
    let closed = 0;
    for (const running of listRunningContextCompactions(this.#persistence.connection)) {
      const record = this.compaction(running.subject, running.compactionId);
      if (record?.status !== "running") continue;
      this.#failCompaction(
        running.subject,
        running.compactionId,
        "interrupted",
        undefined,
        record.executor.kind === "runtime",
      );
      closed += 1;
    }
    return closed;
  }

  #failCompaction(
    subject: ContextSubjectRef,
    compactionId: ContextCompactionId,
    reason: ContextCompactionFailureReason,
    spent?: {
      readonly usage: ReportedCompactionUsage | undefined;
      readonly basePlan: ContextInspectorSnapshot;
      readonly materialTokens: number;
    },
    sessionMayHaveChanged = false,
  ): CompactSessionResult {
    // A failed request still spent what the provider reported, and the
    // ledger and spend ceilings count it.
    const usageReconciliation =
      spent?.usage === undefined
        ? undefined
        : this.#compactionUsage(spent.basePlan, spent.usage, spent.materialTokens);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: subject.aggregateId },
      expectedVersion: this.#aggregateVersion(subject.aggregateId),
      events: [
        ...(usageReconciliation === undefined
          ? []
          : [this.#pending("context.usage-reconciled@1", { reconciliation: usageReconciliation })]),
        this.#pending(CONTEXT_COMPACTION_EVENT_NAMES.failed, {
          compactionId,
          subject,
          reason,
          sessionMayHaveChanged,
          failedAt: decodeTimestamp(this.#clock()),
        }),
      ],
    });
    const record = this.compaction(subject, compactionId);
    if (record === undefined) {
      throw new ContextHarnessError("unavailable", "Compaction was not recorded.");
    }
    return { kind: "settled", record };
  }

  /**
   * Journals the summary request's reported usage without a compaction
   * outcome. A purged thread keeps no compaction events, but the tokens the
   * provider reported were still spent.
   */
  #recordCompactionUsage(
    subject: ContextSubjectRef,
    basePlan: ContextInspectorSnapshot,
    usage: ReportedCompactionUsage | undefined,
    materialTokens: number,
  ): void {
    if (usage === undefined) return;
    this.#persistence.journal.append({
      aggregate: { aggregateType: "context-ledger", aggregateId: subject.aggregateId },
      expectedVersion: this.#aggregateVersion(subject.aggregateId),
      events: [
        this.#pending("context.usage-reconciled@1", {
          reconciliation: this.#compactionUsage(basePlan, usage, materialTokens),
        }),
      ],
    });
  }

  /**
   * The compaction request's own usage. It is priced against the plan it
   * compacted because the ledger keys usage to a plan, but it is a summary
   * request, not a turn, so the subject's latest usage leaves it out.
   */
  #compactionUsage(
    basePlan: ContextInspectorSnapshot,
    usage: ReportedCompactionUsage,
    materialTokens: number,
  ) {
    const modelId = basePlan.next.manifest.modelId;
    const cost = ledgerUsageCost(String(modelId), {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return decodeUsageReconciliation({
      id: this.#uuid(),
      planId: basePlan.next.plan.id,
      providerInstanceId: basePlan.next.manifest.providerInstanceId,
      modelId,
      requestShape: CONTEXT_COMPACTION_REQUEST_SHAPE,
      plannedInputTokens: materialTokens,
      actualInputTokens: usage.inputTokens,
      actualOutputTokens: usage.outputTokens,
      ...(cost === undefined ? {} : { cost }),
      varianceTokens: usage.inputTokens - materialTokens,
      observedAt: decodeTimestamp(this.#clock()),
    });
  }

  /**
   * Picks what a requested compaction summarizes from the thread's own
   * conversation, matched to the stored plan by source rather than entry id
   * because a turn rebuilds its entries with fresh ids every time.
   *
   * The latest exchange is never in the stored plan — its prompt was that
   * plan's current request and its reply came after — so it arrives without
   * an entry, cannot be summarized, and anchors the tail.
   */
  #selectCompaction(
    current: ContextInspectorSnapshot,
    conversation: ReadonlyArray<SessionConversationMessage>,
  ):
    | { readonly kind: "nothing-to-compact" }
    | {
        readonly kind: "summarize";
        readonly entryIds: ReadonlyArray<ContextEntryId>;
        readonly materials: ReadonlyArray<ContextMaintenanceMaterial>;
        readonly materialTokens: number;
        readonly throughExchangeKey: string;
        readonly replacedSummaryIds: ReadonlyArray<ContextSummaryId>;
      } {
    const manifest = current.next.manifest;
    const pinned = new Set(manifest.overrides.pinnedEntryIds.map(String));
    const excluded = new Set(manifest.overrides.excludedEntryIds.map(String));
    const summarizable = (entry: ContextEntry) =>
      entry.category === "conversation" &&
      entry.eligibility.status === "eligible" &&
      entry.state !== "summarized" &&
      entry.tokens.kind === "known" &&
      !pinned.has(String(entry.id)) &&
      !excluded.has(String(entry.id));
    const contentByEntryId = new Map<string, string>();
    const items: Array<SessionCompactionItem> = [];
    // An earlier summary stands for the oldest conversation, ahead of every
    // message it did not replace.
    for (const entry of manifest.entries) {
      if (
        entry.source.kind !== "summary" ||
        entry.category !== "conversation" ||
        entry.state === "summarized"
      ) {
        continue;
      }
      const content = readContextSummaryContent(
        this.#persistence.connection,
        decodeContextSummaryId(entry.source.referenceId),
      );
      const usable = content !== undefined && content.length > 0 && summarizable(entry);
      if (usable) contentByEntryId.set(String(entry.id), `Earlier summary: ${content}`);
      items.push({
        ...(usable ? { entryId: entry.id } : {}),
        kind: "summary",
        exchangeKey: contextSourceKey(entry.source),
        tokens: entry.tokens.kind === "known" ? entry.tokens.tokens : 0,
        summarizable: usable,
      });
    }
    const entryBySource = new Map(
      manifest.entries
        .filter((entry) => entry.category === "conversation" && entry.source.kind === "message")
        .map((entry) => [contextSourceKey(entry.source), entry]),
    );
    for (const message of conversation) {
      const entry = entryBySource.get(contextSourceKey(message.source));
      if (entry?.state === "summarized") continue;
      const usable = entry !== undefined && summarizable(entry);
      if (usable) {
        contentByEntryId.set(
          String(entry.id),
          `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
        );
      }
      items.push({
        ...(usable ? { entryId: entry.id } : {}),
        kind: "message",
        exchangeKey: message.exchangeKey,
        tokens:
          entry?.tokens.kind === "known"
            ? entry.tokens.tokens
            : Math.max(16, Math.ceil(message.content.length / 4)),
        summarizable: usable,
      });
    }
    const selection = selectSessionCompaction({
      items,
      safeInputBudget: current.next.plan.safeInputBudget,
      summaryFraming: SUMMARY_PROMPT_FRAMING,
    });
    if (selection.kind === "nothing-to-compact") return selection;
    const selectedIds = new Set(selection.entryIds.map(String));
    const sizeByEntryId = new Map(
      items.flatMap((item) =>
        item.entryId === undefined ? [] : [[String(item.entryId), item.tokens] as const],
      ),
    );
    return {
      kind: "summarize",
      entryIds: selection.entryIds,
      materials: selection.entryIds.map((entryId) => ({
        entryId,
        content: contentByEntryId.get(String(entryId)) ?? "",
        sizeTokens: sizeByEntryId.get(String(entryId)) ?? 0,
      })),
      materialTokens: selection.materialTokens,
      throughExchangeKey: selection.throughExchangeKey,
      replacedSummaryIds: manifest.entries.flatMap((entry) =>
        entry.source.kind === "summary" && selectedIds.has(String(entry.id))
          ? [decodeContextSummaryId(entry.source.referenceId)]
          : [],
      ),
    };
  }

  /** The subject's current snapshot, restored from its projection after a restart. */
  #restored(subject: ContextSubjectRef): ContextInspectorSnapshot | undefined {
    const cached = this.#snapshots.get(subjectKey(subject));
    if (cached !== undefined) return cached;
    const inspection = readContextSubjectProjection(this.#persistence.connection, subject)?.next
      .plan.inspection;
    return inspection === undefined ? undefined : this.restoreSubject({ subject, ...inspection });
  }

  #commitSummary(
    current: ContextInspectorSnapshot,
    summary: ContextSummary,
    content: string,
    commit: {
      readonly expectedVersion: number;
      /** Events committed with the summary, given the plan it produced. */
      readonly events: (next: {
        readonly plan: ReturnType<typeof decodeContextPlan>;
        readonly timestamp: ReturnType<typeof decodeTimestamp>;
      }) => ReadonlyArray<PendingContextEvent>;
    },
  ): ContextInspectorSnapshot {
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
        ...(current.next.plan.inspection === undefined
          ? {}
          : { inspection: current.next.plan.inspection }),
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
        expectedVersion: commit.expectedVersion,
        events: [
          this.#pending("context.manifest-created@1", { manifest }),
          this.#pending("context.summary-created@1", { summary }),
          this.#pending("context.plan-created@1", { plan }),
          ...commit.events({ plan, timestamp }),
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
    return snapshot;
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
    const snapshot = this.#restored(subject);
    if (snapshot === undefined) {
      // Nothing has planned this subject's context yet — a thread before its
      // first turn has none. That is an empty answer, not a broken service, and
      // reporting it as one sent readers to a Retry button that could never
      // help.
      throw new ContextHarnessError("not-planned", "This thread has no context plan yet.");
    }
    if (afterSequence !== undefined && snapshot.sequence < afterSequence) {
      throw new ContextHarnessError("stale", "Context projection has not reached that sequence.");
    }
    const latestCompaction = this.latestCompaction(subject);
    return latestCompaction === undefined ? snapshot : { ...snapshot, latestCompaction };
  }

  #plan(
    manifest: ReturnType<typeof decodeContextManifest>,
    input: {
      readonly inspection?: ContextPlanInspection;
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
      ...(input.inspection === undefined ? {} : { inspection: input.inspection }),
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

  #pending(eventName: string, payload: unknown): PendingContextEvent {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      hostId: LOCAL_HOST_ID,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
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

/** The `summary` source-key prefix {@link contextSourceKey} produces. */
const SUMMARY_SOURCE_KEY_PREFIX = contextSourceKey({ kind: "summary", referenceId: "" });

/**
 * The journaled summaries a turn may send, given the conversation it selected.
 *
 * A summary's material is the set of conversation sources it replaced — the
 * ones the projection's manifest still records as `summarized` against it — so
 * it may only stand in when every one of those sources is part of this turn's
 * history. A summary that replaced an earlier summary is in range only when
 * that earlier one is too, because it carries the same conversation forward.
 *
 * A summary that is only partly in range is not partly trusted: it is dropped
 * whole, and the material it covered is sent as the real turns instead (which
 * this turn compacts again if it does not fit). Reusing it would put back
 * exactly the superseded conversation an edit exists to exclude.
 */
export function reusableContextSummaryIds(
  summarizedSourceKeys: ReadonlyMap<string, ContextSummaryId>,
  historySourceKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const replacedBySummary = new Map<string, Array<string>>();
  for (const [sourceKey, summaryId] of summarizedSourceKeys) {
    const replaced = replacedBySummary.get(String(summaryId));
    if (replaced === undefined) replacedBySummary.set(String(summaryId), [sourceKey]);
    else replaced.push(sourceKey);
  }
  const reusable = new Set<string>();
  const inRange = (summaryId: string, visiting: Set<string>): boolean => {
    if (reusable.has(summaryId)) return true;
    // A summary that (transitively) replaced itself records no history this
    // turn can check, so it fails closed rather than looping.
    if (visiting.has(summaryId)) return false;
    visiting.add(summaryId);
    const replaced = replacedBySummary.get(summaryId) ?? [];
    const covered =
      replaced.length > 0 &&
      replaced.every(
        (sourceKey) =>
          historySourceKeys.has(sourceKey) ||
          (sourceKey.startsWith(SUMMARY_SOURCE_KEY_PREFIX) &&
            inRange(sourceKey.slice(SUMMARY_SOURCE_KEY_PREFIX.length), visiting)),
      );
    visiting.delete(summaryId);
    if (covered) reusable.add(summaryId);
    return covered;
  };
  for (const summaryId of replacedBySummary.keys()) inRange(summaryId, new Set());
  return reusable;
}

function hostExecutor(snapshot: ContextInspectorSnapshot): ContextCompactionExecutor {
  return {
    kind: "host",
    providerInstanceId: snapshot.next.manifest.providerInstanceId,
    modelId: snapshot.next.manifest.modelId,
  };
}

function describesSession(
  snapshot: ContextInspectorSnapshot,
  thread: { readonly providerInstanceId: ProviderInstanceId; readonly modelId: ProviderModelId },
): boolean {
  return (
    String(snapshot.next.manifest.providerInstanceId) === String(thread.providerInstanceId) &&
    String(snapshot.next.manifest.modelId) === String(thread.modelId)
  );
}

function compactionUsageOf(
  reconciliation: UsageReconciliation | undefined,
): ContextCompactionUsage {
  return reconciliation === undefined
    ? { kind: "unreported" }
    : {
        kind: "reported",
        inputTokens: reconciliation.actualInputTokens,
        outputTokens: reconciliation.actualOutputTokens,
        ...(reconciliation.cost === undefined ? {} : { cost: reconciliation.cost }),
      };
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
  entries: ReadonlyArray<ContextEntry>,
): ContextCapabilityCounts {
  const isMcp = (kind: CapabilityCatalog["entries"][number]["componentKind"]) =>
    kind === "mcp-tool" || kind === "mcp-prompt" || kind === "mcp-resource";
  const isTool = (kind: CapabilityCatalog["entries"][number]["componentKind"]) =>
    kind === "octant-tool";
  const catalogTools = catalog.entries.filter((entry) => isTool(entry.componentKind));
  const selectedTools = selected.filter((entry) => isTool(entry.componentKind));
  const catalogReferences = new Set(catalogTools.map((entry) => entry.source.referenceId));
  const availableTools = new Set<string>();
  const loadedTools = new Set<string>();
  // Work and Chat can supply tool schemas directly in their attributed manifest.
  for (const entry of entries) {
    if (entry.category !== "octant-tools" || entry.source.kind !== "tool") continue;
    if (catalogReferences.has(entry.source.referenceId)) continue;
    availableTools.add(entry.source.referenceId);
    if (
      entry.eligibility.status === "eligible" &&
      entry.state !== "omitted" &&
      entry.state !== "reserved"
    ) {
      loadedTools.add(entry.source.referenceId);
    }
  }
  return {
    loadedTools: selectedTools.length + loadedTools.size,
    availableTools: catalogTools.length + availableTools.size,
    loadedMcp: selected.filter((entry) => isMcp(entry.componentKind)).length,
    availableMcp: catalog.entries.filter((entry) => isMcp(entry.componentKind)).length,
  };
}
