import {
  decodeAgentRun,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeAgentRunRequested,
  decodeAgentRunResultAcknowledged,
  decodeAgentRunStatusChanged,
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
  type OctantMode,
  type ProjectId,
  type ProviderInstanceId,
  type UtcTimestamp,
} from "@octant/contracts";
import { effectiveAgentRunExecutionTarget, isAgentRunActiveStatus } from "@octant/domain";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
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
  readonly runId: AgentRunId;
  readonly fromStatus: AgentRunLifecycleStatus;
  readonly toStatus: AgentRunLifecycleStatus;
  readonly version: number;
  readonly updatedAt: UtcTimestamp;
  readonly recoveryReason?: string;
  readonly result?: AgentRunResult;
  readonly resultAcknowledgement?: AgentRunResultAcknowledgement;
}

export interface AgentRunResultAckApplyInput {
  readonly runId: AgentRunId;
  readonly version: number;
  readonly acknowledgedAt: UtcTimestamp;
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
        version: payload.version,
        updatedAt: event.occurredAt as UtcTimestamp,
        ...(payload.recoveryReason === undefined ? {} : { recoveryReason: payload.recoveryReason }),
        ...(payload.result === undefined ? {} : { result: payload.result }),
        ...(resultAcknowledgement === undefined ? {} : { resultAcknowledgement }),
      });
      return;
    }
    if (event.eventName === AGENT_RUN_RESULT_ACKNOWLEDGED) {
      const payload = decodeAgentRunResultAcknowledged(event.payload);
      this.applyResultAcknowledged({
        runId: payload.runId,
        version: payload.version,
        acknowledgedAt: payload.acknowledgedAt,
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
    const { recoveryReason: _previousRecoveryReason, ...runWithoutRecoveryReason } = existing;
    const next = decodeAgentRun({
      ...runWithoutRecoveryReason,
      lifecycleStatus: input.toStatus,
      version: input.version,
      updatedAt: input.updatedAt,
      ...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
      // A completion's reply is part of that event; a later event without one
      // must not erase the reply the run already recorded.
      ...(input.result === undefined ? {} : { result: input.result }),
      resultAcknowledgement: input.resultAcknowledgement ?? existing.resultAcknowledgement,
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
