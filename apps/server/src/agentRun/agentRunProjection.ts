import {
  MAX_AGENT_RESULT_PACKETS,
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  decodeAgentRun,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeAgentRunRequested,
  decodeAgentRunResultAcknowledged,
  decodeAgentRunResultDeliverySettled,
  decodeAgentRunStatusChanged,
  decodeUsageResumeCancelled,
  decodeUsageResumeScheduled,
  decodeUsageResumeSettled,
  type EventEnvelope,
  type AgentRun,
  type AgentRunCenterStatusFilter,
  type AgentRunCenterWorkspaceKind,
  type AgentRunId,
  type AgentRunLifecycleStatus,
  type AgentRunParentThreadId,
  type AgentRunRequestId,
  type AgentRunResult,
  type AgentRunResultAcknowledgement,
  type AgentRunResultDelivery,
  type OctantMode,
  type ProjectId,
  type ProviderInstanceId,
  type UtcTimestamp,
  type UsageResumeThreadState,
} from "@octant/contracts";
import { effectiveAgentRunExecutionTarget, isAgentRunActiveStatus } from "@octant/domain";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_RESULT_DELIVERY_SETTLED,
  AGENT_RUN_STATUS_CHANGED,
} from "./agentRunEventStore";

/**
 * Honest route receipt data surfaced to parent/Agents consumers.
 * Mirrors the immutable routing receipt: the originally requested target, the
 * effective execution target (explicit fallback aware), whether the route was
 * derived from a multi-model pool, and the recorded routing reason.
 */
export interface AgentRunParentSummaryRoute {
  readonly requestedProviderInstanceId: AgentRun["routingReceipt"]["selectedProviderInstanceId"];
  readonly requestedModelId: AgentRun["routingReceipt"]["selectedModelId"];
  readonly executionProviderInstanceId: AgentRun["routingReceipt"]["selectedProviderInstanceId"];
  readonly executionModelId: AgentRun["routingReceipt"]["selectedModelId"];
  readonly poolDerived: boolean;
  readonly selectionKind?: "requested" | "fallback";
  readonly routingReason?: string;
}

export interface AgentRunParentSummaryEntry {
  readonly runId: AgentRunId;
  readonly requestId: AgentRunRequestId;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly parentRunId?: AgentRunId;
  readonly role: AgentRun["role"];
  readonly task: string;
  readonly lifecycleStatus: AgentRunLifecycleStatus;
  readonly executionKind: AgentRun["executionKind"];
  readonly usageQuality: AgentRun["routingReceipt"]["usageQuality"];
  readonly route: AgentRunParentSummaryRoute;
  readonly resultAcknowledgement: AgentRunResultAcknowledgement;
  /** The completed child's reply identity, readable by the parent thread. */
  readonly result?: AgentRunResult;
  /**
   * The reply text behind `result`, read from the AgentRun content store.
   * Absent while `result` is present means the parent thread was deleted and
   * the reply was purged with it.
   */
  readonly resultText?: string;
  readonly recoveryReason?: string;
  /**
   * How the host settled this result's delivery into the parent. Absent while
   * the delivery is still owed. Lets the parent's own surfaces tell a result
   * the parent already holds from one only the person can read.
   */
  readonly resultDeliveryOutcome?: AgentRunResultDelivery["outcome"];
  readonly usageLimit?: AgentRun["usageLimit"];
  readonly usageResume?: AgentRun["usageResume"];
  readonly version: AgentRun["version"];
  readonly updatedAt: UtcTimestamp;
}

export interface AgentRunCenterCandidate {
  readonly run: AgentRun;
  readonly route: AgentRunParentSummaryRoute;
}

export interface ListAgentRunCenterCandidatesInput {
  readonly status: AgentRunCenterStatusFilter;
  readonly mode: OctantMode | "all";
  readonly projectId?: ProjectId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly parentThreadId?: AgentRunParentThreadId;
  readonly search?: string;
}

export interface AgentRunStatusApplyInput {
  readonly generation?: number;
  readonly runId: AgentRunId;
  readonly fromStatus: AgentRunLifecycleStatus;
  readonly toStatus: AgentRunLifecycleStatus;
  readonly version: number;
  readonly updatedAt: UtcTimestamp;
  readonly recoveryReason?: string;
  readonly result?: AgentRunResult;
  readonly resultAcknowledgement?: AgentRunResultAcknowledgement;
  readonly usage?: AgentRun["usage"];
  readonly usageLimit?: AgentRun["usageLimit"];
}

export interface AgentRunResultAckApplyInput {
  readonly runId: AgentRunId;
  readonly version: number;
  readonly acknowledgedAt: UtcTimestamp;
}

export interface AgentRunResultDeliveryApplyInput {
  readonly runId: AgentRunId;
  readonly version: number;
  readonly delivery: AgentRunResultDelivery;
}

function summaryRoute(receipt: AgentRun["routingReceipt"]): AgentRunParentSummaryRoute {
  const execution = effectiveAgentRunExecutionTarget(receipt);
  const decision = receipt.poolRoute?.decision;
  const routingReason =
    decision === undefined
      ? receipt.selectedFallback?.reason
      : decision.kind === "selected"
        ? decision.reason
        : decision.message;
  return {
    requestedProviderInstanceId: receipt.selectedProviderInstanceId,
    requestedModelId: receipt.selectedModelId,
    executionProviderInstanceId: execution.providerInstanceId,
    executionModelId: execution.modelId,
    poolDerived: decision !== undefined,
    ...(decision?.kind === "selected" ? { selectionKind: decision.selectionKind } : {}),
    ...(routingReason === undefined ? {} : { routingReason }),
  };
}

/**
 * Rebuildable in-memory AgentRun projection. Replays journaled AgentRun events
 * into current run state, request-id receipts, and parent-summary indexes.
 * Idempotent: duplicate or out-of-order older versions never roll state back.
 */
export class AgentRunProjection implements Projection {
  readonly name = "agent-runs";
  readonly dependencies: ReadonlyArray<string> = [];
  // Runs live only in these maps, so every host start must replay them all:
  // resuming from the stored checkpoint showed a restarted host no children.
  readonly holdsStateInMemory = true as const;
  readonly #resultHistory = new Map<AgentRunId, ReadonlyArray<AgentRun>>();
  readonly #truncatedResults = new Set<AgentRunId>();
  readonly #byId = new Map<AgentRunId, AgentRun>();
  readonly #byRequestId = new Map<AgentRunRequestId, AgentRunId>();
  readonly #byParent = new Map<AgentRunParentThreadId, Set<AgentRunId>>();

  reset(_connection: SqliteConnection): void {
    this.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === AGENT_RUN_REQUESTED) {
      this.applyRequested(decodeAgentRunRequested(event.payload).run);
      return;
    }
    if (event.eventName === AGENT_RUN_STATUS_CHANGED) {
      const payload = decodeAgentRunStatusChanged(event.payload);
      const existing = this.getById(payload.runId);
      const resultAcknowledgement =
        payload.toStatus === "completed"
          ? {
              required: true as const,
              acknowledged: false as const,
              followUpReason: "unacknowledged-child-result",
            }
          : existing?.resultAcknowledgement;
      this.applyStatusChanged({
        runId: payload.runId,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        ...(payload.generation === undefined ? {} : { generation: payload.generation }),
        version: payload.version,
        updatedAt: event.occurredAt as UtcTimestamp,
        ...(payload.recoveryReason === undefined ? {} : { recoveryReason: payload.recoveryReason }),
        ...(payload.result === undefined ? {} : { result: payload.result }),
        ...(resultAcknowledgement === undefined ? {} : { resultAcknowledgement }),
        ...(payload.usage === undefined ? {} : { usage: payload.usage }),
        ...(payload.usageLimit === undefined ? {} : { usageLimit: payload.usageLimit }),
      });
      return;
    }
    if (
      event.eventName === USAGE_RESUME_SCHEDULED ||
      event.eventName === USAGE_RESUME_CANCELLED ||
      event.eventName === USAGE_RESUME_SETTLED
    ) {
      this.applyUsageResume(event);
      return;
    }
    if (event.eventName === AGENT_RUN_RESULT_ACKNOWLEDGED) {
      const payload = decodeAgentRunResultAcknowledged(event.payload);
      this.applyResultAcknowledged({
        runId: payload.runId,
        version: payload.version,
        acknowledgedAt: payload.acknowledgedAt,
      });
      return;
    }
    if (event.eventName === AGENT_RUN_RESULT_DELIVERY_SETTLED) {
      const payload = decodeAgentRunResultDeliverySettled(event.payload);
      this.applyResultDeliverySettled({
        runId: payload.runId,
        version: payload.version,
        delivery: payload.delivery,
      });
    }
  }

  applyRequested(runInput: AgentRun): void {
    const run = decodeAgentRun(runInput);
    const existing = this.#byId.get(run.id);
    if (existing !== undefined && existing.version >= run.version) {
      return;
    }
    this.#index(run);
  }

  applyStatusChanged(input: AgentRunStatusApplyInput): void {
    const runId = decodeAgentRunId(input.runId);
    const existing = this.#byId.get(runId);
    if (existing === undefined) return;
    if (existing.version >= input.version) return;
    if (existing.lifecycleStatus !== input.fromStatus && existing.version + 1 === input.version) {
      // Allow only if versions still advance; otherwise ignore inconsistent out-of-order.
    }
    const generation = input.generation ?? existing.generation ?? 1;
    const newGeneration = generation > (existing.generation ?? 1);
    const {
      result: previousResult,
      resultDelivery: previousDelivery,
      usageResume: previousUsageResume,
      recoveryReason: _previousRecoveryReason,
      usage: _previousUsage,
      usageLimit: _previousUsageLimit,
      ...runWithoutRecoveryReason
    } = existing;
    const next = decodeAgentRun({
      ...runWithoutRecoveryReason,
      generation,
      ...(!newGeneration && previousResult !== undefined ? { result: previousResult } : {}),
      ...(!newGeneration && previousDelivery !== undefined
        ? { resultDelivery: previousDelivery }
        : {}),
      ...(!newGeneration && previousUsageResume !== undefined
        ? { usageResume: previousUsageResume }
        : {}),
      lifecycleStatus: input.toStatus,
      version: input.version,
      updatedAt: input.updatedAt,
      ...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
      // A completion's reply is part of that event; a later event without one
      // must not erase the reply the run already recorded.
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(input.usageLimit === undefined ? {} : { usageLimit: input.usageLimit }),
      resultAcknowledgement: newGeneration
        ? { required: false, acknowledged: false }
        : (input.resultAcknowledgement ?? existing.resultAcknowledgement),
    });
    this.#index(next);
    if (next.result !== undefined || next.recoveryReason !== undefined) {
      const previous = this.#resultHistory.get(runId) ?? [];
      const snapshots = [...previous.filter((item) => (item.generation ?? 1) !== generation), next];
      if (snapshots.length > MAX_AGENT_RESULT_PACKETS) this.#truncatedResults.add(runId);
      this.#resultHistory.set(runId, snapshots.slice(-MAX_AGENT_RESULT_PACKETS));
    }
  }

  resultHistory(runId: AgentRunId): {
    readonly runs: ReadonlyArray<AgentRun>;
    readonly truncated: boolean;
  } {
    return {
      runs: this.#resultHistory.get(runId) ?? [],
      truncated: this.#truncatedResults.has(runId),
    };
  }

  /**
   * A usage-resume event is journaled on the run's own aggregate, so it bumps
   * the aggregate head without producing a status change. Folding it here —
   * with `version` taken from the event — keeps `run.version` equal to the
   * head, which every later command's expected-version CAS depends on.
   */
  applyUsageResume(event: EventEnvelope): void {
    const runId = decodeAgentRunId(event.aggregateId);
    const existing = this.#byId.get(runId);
    if (existing === undefined) return;
    if (existing.version >= event.aggregateVersion) return;
    let usageResume: UsageResumeThreadState | undefined;
    if (event.eventName === USAGE_RESUME_SETTLED) {
      const payload = decodeUsageResumeSettled(event.payload);
      usageResume = {
        record: payload.resume,
        status: payload.outcome,
        ...(payload.detail === undefined ? {} : { detail: payload.detail }),
      };
    } else if (event.eventName === USAGE_RESUME_SCHEDULED) {
      usageResume = {
        record: decodeUsageResumeScheduled(event.payload).resume,
        status: "scheduled",
      };
    } else {
      // A withdrawn opt-in leaves no state: the cancelled event supersedes
      // rather than settles, so the run reports nothing armed or resolved.
      decodeUsageResumeCancelled(event.payload);
      usageResume = undefined;
    }
    this.applyUsageResumeState({
      runId,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
      usageResume,
    });
  }

  /**
   * Folds the latest usage-resume state — or its absence once an opt-in is
   * withdrawn — into the run, keeping `version` equal to the aggregate head
   * the journaled event established.
   */
  applyUsageResumeState(input: {
    readonly runId: AgentRunId;
    readonly version: number;
    readonly updatedAt: UtcTimestamp;
    readonly usageResume: UsageResumeThreadState | undefined;
  }): void {
    const runId = decodeAgentRunId(input.runId);
    const existing = this.#byId.get(runId);
    if (existing === undefined) return;
    if (existing.version >= input.version) return;
    const { usageResume: _dropped, ...rest } = existing;
    const next = decodeAgentRun({
      ...rest,
      ...(input.usageResume === undefined ? {} : { usageResume: input.usageResume }),
      version: input.version,
      updatedAt: input.updatedAt,
    });
    this.#index(next);
  }

  applyResultAcknowledged(input: AgentRunResultAckApplyInput): void {
    const runId = decodeAgentRunId(input.runId);
    const existing = this.#byId.get(runId);
    if (existing === undefined) return;
    if (existing.version >= input.version) return;
    const next = decodeAgentRun({
      ...existing,
      version: input.version,
      updatedAt: input.acknowledgedAt,
      resultAcknowledgement: {
        required: true,
        acknowledged: true,
        acknowledgedAt: input.acknowledgedAt,
      },
    });
    this.#index(next);
  }

  applyResultDeliverySettled(input: AgentRunResultDeliveryApplyInput): void {
    const runId = decodeAgentRunId(input.runId);
    const existing = this.#byId.get(runId);
    if (existing === undefined) return;
    if (existing.version >= input.version) return;
    const next = decodeAgentRun({
      ...existing,
      version: input.version,
      updatedAt: input.delivery.settledAt,
      resultDelivery: input.delivery,
    });
    this.#index(next);
  }

  getById(runId: AgentRunId): AgentRun | undefined {
    return this.#byId.get(decodeAgentRunId(runId));
  }

  getByRequestId(requestId: AgentRunRequestId): AgentRun | undefined {
    const runId = this.#byRequestId.get(decodeAgentRunRequestId(requestId));
    return runId === undefined ? undefined : this.#byId.get(runId);
  }

  parentSummary(parentThreadId: AgentRunParentThreadId): ReadonlyArray<AgentRunParentSummaryEntry> {
    const parent = decodeAgentRunParentThreadId(parentThreadId);
    const ids = this.#byParent.get(parent);
    if (ids === undefined) return [];
    const entries: AgentRunParentSummaryEntry[] = [];
    for (const runId of ids) {
      const run = this.#byId.get(runId);
      if (run === undefined) continue;
      entries.push({
        runId: run.id,
        requestId: run.requestId,
        parentThreadId: run.parentThreadId,
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
        role: run.role,
        task: run.task,
        lifecycleStatus: run.lifecycleStatus,
        executionKind: run.executionKind,
        usageQuality: run.routingReceipt.usageQuality,
        route: summaryRoute(run.routingReceipt),
        resultAcknowledgement: run.resultAcknowledgement,
        ...(run.result === undefined ? {} : { result: run.result }),
        ...(run.recoveryReason === undefined ? {} : { recoveryReason: run.recoveryReason }),
        ...(run.resultDelivery === undefined
          ? {}
          : { resultDeliveryOutcome: run.resultDelivery.outcome }),
        ...(run.usageLimit === undefined ? {} : { usageLimit: run.usageLimit }),
        ...(run.usageResume === undefined ? {} : { usageResume: run.usageResume }),
        version: run.version,
        updatedAt: run.updatedAt,
      });
    }
    return entries.sort((left, right) => {
      if (left.updatedAt === right.updatedAt) {
        return String(left.runId).localeCompare(String(right.runId));
      }
      return left.updatedAt < right.updatedAt ? -1 : 1;
    });
  }

  /** Every run started in the Project, by the Project its routing receipt names. */
  projectRunIds(projectId: ProjectId): ReadonlyArray<AgentRunId> {
    const ids: AgentRunId[] = [];
    for (const run of this.#byId.values()) {
      if (String(run.routingReceipt.projectId ?? "") === String(projectId)) ids.push(run.id);
    }
    return ids;
  }

  /**
   * Every run matching the center query filters, newest first. Authorization is
   * applied by the route before pagination so pages contain only readable rows.
   */
  listCenterCandidates(
    input: ListAgentRunCenterCandidatesInput,
  ): ReadonlyArray<AgentRunCenterCandidate> {
    const search = input.search?.trim().toLowerCase();
    const matches: AgentRunCenterCandidate[] = [];
    for (const run of this.#byId.values()) {
      if (input.mode !== "all" && run.routingReceipt.mode !== input.mode) continue;
      if (
        input.projectId !== undefined &&
        String(run.routingReceipt.projectId ?? "") !== String(input.projectId)
      ) {
        continue;
      }
      if (
        input.providerInstanceId !== undefined &&
        run.routingReceipt.selectedProviderInstanceId !== input.providerInstanceId
      ) {
        continue;
      }
      if (
        input.parentThreadId !== undefined &&
        String(run.parentThreadId) !== String(input.parentThreadId)
      ) {
        continue;
      }
      const active = isAgentRunActiveStatus(run.lifecycleStatus);
      if (input.status === "active" && !active) continue;
      if (input.status === "history" && active) continue;
      if (search !== undefined && search.length > 0) {
        const haystack = `${run.task} ${run.role} ${run.lifecycleStatus}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      matches.push({ run, route: summaryRoute(run.routingReceipt) });
    }
    return matches.sort((left, right) =>
      centerCursorKey(right.run).localeCompare(centerCursorKey(left.run)),
    );
  }

  activeCounts(): {
    readonly global: number;
    readonly byParent: Map<AgentRunParentThreadId, number>;
  } {
    let global = 0;
    const byParent = new Map<AgentRunParentThreadId, number>();
    for (const run of this.#byId.values()) {
      if (!isAgentRunActiveStatus(run.lifecycleStatus)) continue;
      global += 1;
      byParent.set(run.parentThreadId, (byParent.get(run.parentThreadId) ?? 0) + 1);
    }
    return { global, byParent };
  }

  snapshot(): ReadonlyMap<AgentRunId, AgentRun> {
    return new Map(this.#byId);
  }

  clear(): void {
    this.#resultHistory.clear();
    this.#truncatedResults.clear();
    this.#byId.clear();
    this.#byRequestId.clear();
    this.#byParent.clear();
  }

  #index(run: AgentRun): void {
    this.#byId.set(run.id, run);
    this.#byRequestId.set(run.requestId, run.id);
    const parentSet = this.#byParent.get(run.parentThreadId) ?? new Set<AgentRunId>();
    parentSet.add(run.id);
    this.#byParent.set(run.parentThreadId, parentSet);
  }
}

function centerCursorKey(run: AgentRun): string {
  return `${run.updatedAt}~${String(run.id)}`;
}

export function workspaceKindForRun(run: AgentRun): AgentRunCenterWorkspaceKind {
  return run.workspaceReceipt.kind;
}

export function paginateCenterCandidates(
  candidates: ReadonlyArray<AgentRunCenterCandidate>,
  limit: number,
  cursor: string | undefined,
): { readonly items: ReadonlyArray<AgentRunCenterCandidate>; readonly nextCursor?: string } {
  const window =
    cursor === undefined
      ? candidates
      : candidates.filter((candidate) => centerCursorKey(candidate.run) < cursor);
  const items = window.slice(0, limit);
  const last = items[items.length - 1];
  if (window.length <= items.length || last === undefined) return { items };
  return { items, nextCursor: centerCursorKey(last.run) };
}

export function clampCenterLimit(limit: number, max: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 1;
  return Math.min(limit, max);
}
