import {
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
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunCommandResult,
  type AgentRunId,
  type AgentRunParentThreadId,
  type EventEnvelope,
  type UtcTimestamp,
  type UsageResumeRecord,
  type UsageResumeSettled,
} from "@octant/contracts";
import {
  AGENT_RUN_DEPENDENCY_WAITING_REASON,
  AgentRunPolicyRejected,
  assertAgentRunCapacityAvailable,
  agentRunPoolRouteWaitingReason,
  assertAgentRunUsageResumeCancellable,
  assertAgentRunUsageResumeSchedulable,
  createAgentRunFromRequest,
  effectiveAgentRunExecutionTarget,
  evaluateAgentRunCommand,
  isAgentRunActiveStatus,
  isAgentRunTerminalStatus,
} from "@octant/domain";
import { readAgentRunResultText } from "../persistence/agentRunContentStore";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_AGGREGATE_TYPE,
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_RESULT_DELIVERY_SETTLED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
  AgentRunEventStoreError,
  MAX_AGENT_RUN_REPLAY_LIMIT,
} from "./agentRunEventStore";
import { AgentRunProjection, type AgentRunParentSummaryEntry } from "./agentRunProjection";
import type {
  AgentRunCenterCandidate,
  ListAgentRunCenterCandidatesInput,
} from "./agentRunProjection";

export interface AgentRunPersistenceServiceOptions {
  readonly store: AgentRunEventStore;
  readonly projection: AgentRunProjection;
  readonly uuid: () => string;
  readonly clock: () => string;
  /**
   * Holds the AgentRun content store. A completed child's reply is parent-thread
   * content, so it is read from here rather than replayed from the journal.
   */
  readonly connection: SqliteConnection;
}

export interface RequestAgentRunInput {
  readonly command: Extract<AgentRunCommand, { kind: "request-agent-run" }>;
  readonly parentAuthority: AgentRunAuthority;
  /** Parent thread live effective grant; clamped together with parentAuthority. */
  readonly liveParentGrant?: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
  readonly confirmed: boolean;
}

/**
 * Server-owned AgentRun persistence seam: request-id idempotent command
 * application, journal append before effect, rebuildable projection, parent
 * summary query, and restart reconciliation that never invents Completed.
 */
export class AgentRunPersistenceService {
  readonly #store: AgentRunEventStore;
  readonly #projection: AgentRunProjection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #connection: SqliteConnection;

  constructor(options: AgentRunPersistenceServiceOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#connection = options.connection;
  }

  /**
   * A run may wait only on siblings that exist under the same parent thread
   * and can still complete. Waiting on a run that already failed would admit
   * work that is certain never to start.
   */
  #refuseDependencies(command: RequestAgentRunInput["command"]): AgentRunCommandResult | undefined {
    for (const dependencyId of command.dependsOn ?? []) {
      const dependency = this.#projection.getById(dependencyId);
      if (dependency === undefined || dependency.parentThreadId !== command.parentThreadId) {
        return {
          kind: "run-command-failed",
          reason: "invalid",
          message: `AgentRun dependency ${String(dependencyId)} is not a run of this thread.`,
        };
      }
      // An interrupted sibling can still be retried, so it is waited on like
      // a running one; failed and cancelled siblings are where waiting ends.
      if (dependency.lifecycleStatus === "failed" || dependency.lifecycleStatus === "cancelled") {
        return {
          kind: "run-command-failed",
          reason: "invalid",
          message: `AgentRun dependency ${String(dependencyId)} already ${dependency.lifecycleStatus}; this run could never start.`,
        };
      }
    }
    return undefined;
  }

  requestRun(input: RequestAgentRunInput): AgentRunCommandResult {
    const existing = this.#projection.getByRequestId(input.command.requestId);
    if (existing !== undefined) {
      return { kind: "run-accepted", run: existing };
    }

    const counts = this.#projection.activeCounts();
    const activeForParent = counts.byParent.get(input.command.parentThreadId) ?? 0;
    const parent =
      input.command.parentRunId === undefined
        ? undefined
        : this.#projection.getById(input.command.parentRunId);
    if (input.command.parentRunId !== undefined && parent === undefined) {
      return {
        kind: "run-command-failed",
        reason: "invalid",
        message: "AgentRun parent does not exist.",
      };
    }
    const dependencyRefusal = this.#refuseDependencies(input.command);
    if (dependencyRefusal !== undefined) return dependencyRefusal;
    if (parent !== undefined && parent.parentThreadId !== input.command.parentThreadId) {
      return {
        kind: "run-command-failed",
        reason: "invalid",
        message: "AgentRun parent belongs to a different thread.",
      };
    }
    if (parent !== undefined && !parent.authority.subagents) {
      return {
        kind: "run-command-failed",
        reason: "unauthorized",
        message: "AgentRun parent is not authorized to create subagents.",
      };
    }
    let run: AgentRun;
    try {
      run = decodeAgentRun(
        createAgentRunFromRequest({
          runId: decodeAgentRunId(this.#uuid()),
          command: input.command,
          ...(parent === undefined ? {} : { parentDepth: parent.depth }),
          // A nested child is bounded by the already-persisted parent
          // authority, not merely the outer thread/mode ceiling resolved by
          // the caller. This keeps every hierarchy edge monotonic.
          parentAuthority: parent?.authority ?? input.parentAuthority,
          ...(input.liveParentGrant === undefined && parent === undefined
            ? {}
            : {
                // Nested children also clamp against the outer live grant when
                // present; the persisted parent authority is already the prior
                // clamp result and remains the mode/parent ceiling above.
                liveParentGrant: parent?.authority ?? input.liveParentGrant,
              }),
          ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
          ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
          activeGlobal: counts.global,
          activeForParent,
          confirmed: input.confirmed,
          now: this.#now(),
        }),
      );
    } catch (error) {
      return policyFailure(error);
    }

    try {
      // The admitted selection is stored against the parent thread by this
      // append, never journaled with it: the receipt records the snapshot id
      // and the block count, and the blocks themselves stay purgeable.
      this.#store.appendRequested(run, input.command.admittedContext);
    } catch (error) {
      if (error instanceof AgentRunEventStoreError && error.category === "invalid") {
        // concurrent request-id race: re-check projection/request map after conflict
        const raced = this.#projection.getByRequestId(input.command.requestId);
        if (raced !== undefined) return { kind: "run-accepted", run: raced };
        return {
          kind: "run-command-failed",
          reason: "stale-version",
          message: error.message,
        };
      }
      throw error;
    }

    this.#projection.applyRequested(run);
    return { kind: "run-accepted", run };
  }

  applyCommand(
    command: Exclude<AgentRunCommand, { kind: "request-agent-run" }>,
  ): AgentRunCommandResult {
    const runId =
      "runId" in command ? decodeAgentRunId(command.runId) : decodeAgentRunId(this.#uuid());
    const current = this.#projection.getById(runId);
    let next: AgentRun;
    try {
      if (command.kind === "resume-agent-run" && current?.lifecycleStatus === "completed") {
        const counts = this.#projection.activeCounts();
        assertAgentRunCapacityAvailable({
          activeGlobal: counts.global,
          activeForParent: counts.byParent.get(current.parentThreadId) ?? 0,
        });
      }
      next = evaluateAgentRunCommand(current, command, this.#now());
    } catch (error) {
      return policyFailure(error);
    }

    if (command.kind === "confirm-agent-run") {
      // confirmation is policy-checked only in 11B; no journal event until start.
      return { kind: "run-updated", run: next };
    }

    if (command.kind === "acknowledge-agent-run-result") {
      try {
        this.#store.appendResultAcknowledged({
          runId: next.id,
          version: next.version,
          expectedVersion: command.expectedVersion,
          acknowledgedAt: next.resultAcknowledgement.acknowledgedAt ?? this.#now(),
        });
      } catch (error) {
        return storeFailure(error);
      }
      this.#projection.applyResultAcknowledged({
        runId: next.id,
        version: next.version,
        acknowledgedAt: next.resultAcknowledgement.acknowledgedAt ?? this.#now(),
      });
      return { kind: "run-updated", run: next };
    }

    if (
      command.kind === "schedule-agent-run-usage-resume" ||
      command.kind === "cancel-agent-run-usage-resume"
    ) {
      return this.#applyUsageResumeCommand(current, command);
    }

    if (command.kind === "settle-agent-run-result-delivery") {
      const delivery = next.resultDelivery;
      if (delivery === undefined) {
        return {
          kind: "run-command-failed",
          reason: "unsupported-transition",
          message: "AgentRun result delivery settle produced no delivery.",
        };
      }
      try {
        this.#store.appendResultDeliverySettled({
          runId: next.id,
          version: next.version,
          expectedVersion: command.expectedVersion,
          delivery,
        });
      } catch (error) {
        return storeFailure(error);
      }
      this.#projection.applyResultDeliverySettled({
        runId: next.id,
        version: next.version,
        delivery,
      });
      return { kind: "run-updated", run: next };
    }

    const fromStatus = current?.lifecycleStatus;
    if (fromStatus === undefined) {
      return {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message: "AgentRun does not exist.",
      };
    }

    try {
      this.#store.appendStatusChanged({
        runId: next.id,
        fromStatus,
        toStatus: next.lifecycleStatus,
        generation: next.generation ?? 1,
        version: next.version,
        expectedVersion: command.expectedVersion,
        occurredAt: next.updatedAt,
        ...(next.recoveryReason === undefined ? {} : { recoveryReason: next.recoveryReason }),
        ...(next.usageLimit === undefined ? {} : { usageLimit: next.usageLimit }),
        // The reply's identity is journaled and its text stored by the same
        // append as the completion, so a rejected append leaves no Completed
        // run claiming a result nobody has.
        ...(command.kind === "complete-agent-run"
          ? {
              result: command.result,
              resultText: command.resultText,
              run: next,
              ...(next.usage === undefined ? {} : { usage: next.usage }),
            }
          : {}),
      });
    } catch (error) {
      return storeFailure(error);
    }

    this.#projection.applyStatusChanged({
      runId: next.id,
      fromStatus,
      toStatus: next.lifecycleStatus,
      generation: next.generation ?? 1,
      version: next.version,
      updatedAt: next.updatedAt,
      ...(next.recoveryReason === undefined ? {} : { recoveryReason: next.recoveryReason }),
      ...(next.result === undefined ? {} : { result: next.result }),
      ...(next.usage === undefined ? {} : { usage: next.usage }),
      ...(next.usageLimit === undefined ? {} : { usageLimit: next.usageLimit }),
      resultAcknowledgement: next.resultAcknowledgement,
    });
    return { kind: "run-updated", run: next };
  }

  /**
   * The person's own usage-resume opt-in for a run still waiting on a
   * disclosed reset. The journaled record derives only from facts the run
   * already holds — the client supplies no resume fields — and the append
   * bumps the aggregate head, which the projection fold then reports as the
   * run's new version.
   */
  #applyUsageResumeCommand(
    current: AgentRun | undefined,
    command: Extract<
      AgentRunCommand,
      { kind: "schedule-agent-run-usage-resume" | "cancel-agent-run-usage-resume" }
    >,
  ): AgentRunCommandResult {
    if (current === undefined) {
      return {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message: "AgentRun does not exist.",
      };
    }
    try {
      if (command.kind === "schedule-agent-run-usage-resume") {
        assertAgentRunUsageResumeSchedulable(current, command.expectedVersion);
      } else {
        assertAgentRunUsageResumeCancellable(current, command.expectedVersion);
      }
    } catch (error) {
      return policyFailure(error);
    }

    const resume: UsageResumeRecord | undefined =
      command.kind === "schedule-agent-run-usage-resume"
        ? current.usageLimit?.resetsAt === undefined
          ? undefined
          : {
              threadId: String(current.id),
              turnId: String(current.id),
              providerInstanceId: effectiveAgentRunExecutionTarget(current.routingReceipt)
                .providerInstanceId,
              usageLimit: current.usageLimit,
              resetsAt: current.usageLimit.resetsAt,
              scheduledAt: this.#now(),
            }
        : current.usageResume?.record;
    if (resume === undefined) {
      return {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message: "AgentRun has no usage-limit resume to apply.",
      };
    }

    let committed;
    try {
      committed = this.#store.appendUsageResume({
        runId: current.id,
        expectedVersion: command.expectedVersion,
        occurredAt: this.#now(),
        eventName:
          command.kind === "schedule-agent-run-usage-resume"
            ? USAGE_RESUME_SCHEDULED
            : USAGE_RESUME_CANCELLED,
        resume,
      });
    } catch (error) {
      return storeFailure(error);
    }
    this.#projection.applyUsageResume(committed);
    const updated = this.#projection.getById(current.id);
    if (updated === undefined) {
      return {
        kind: "run-command-failed",
        reason: "invalid",
        message: "AgentRun usage-resume fold produced no run.",
      };
    }
    return { kind: "run-updated", run: updated };
  }

  /**
   * Folds a settle the usage-resume scheduler committed straight to the
   * journal into the live projection — this projection is not journal-fed, so
   * without the fold the run would keep reporting `scheduled` after its
   * recovery resolved.
   */
  applyUsageResumeSettled(settled: UsageResumeSettled): void {
    const runId = decodeAgentRunId(settled.resume.threadId);
    this.#projection.applyUsageResumeState({
      runId,
      version: readAggregateVersion(this.#connection, AGENT_RUN_AGGREGATE_TYPE, String(runId)),
      updatedAt: this.#now(),
      usageResume: {
        record: settled.resume,
        status: settled.outcome,
        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
      },
    });
  }

  /**
   * The parent's view of its children, with each completed child's reply read
   * back from the content store.
   *
   * A run whose parent thread was permanently deleted keeps its result identity
   * and reports no text, so a reader is told the reply is gone rather than
   * handed an empty one.
   */
  parentSummary(parentThreadId: AgentRunParentThreadId): ReadonlyArray<AgentRunParentSummaryEntry> {
    return this.#projection
      .parentSummary(decodeAgentRunParentThreadId(parentThreadId))
      .map((entry) => {
        if (entry.result === undefined) return entry;
        const resultText = this.resultText(entry.runId);
        return resultText === undefined ? entry : { ...entry, resultText };
      });
  }

  listCenterCandidates(
    input: ListAgentRunCenterCandidatesInput,
  ): ReadonlyArray<AgentRunCenterCandidate> {
    return this.#projection.listCenterCandidates(input);
  }

  /** The stored reply of a completed run, or `undefined` once it was purged. */
  resultText(runId: AgentRunId): string | undefined {
    const run = this.#projection.getById(decodeAgentRunId(runId));
    if (run?.result === undefined) return undefined;
    return readAgentRunResultText(this.#connection, {
      runId: run.id,
      reference: run.result.reference,
    });
  }

  getById(runId: AgentRunId): AgentRun | undefined {
    return this.#projection.getById(decodeAgentRunId(runId));
  }

  getByRequestId(requestId: string): AgentRun | undefined {
    return this.#projection.getByRequestId(decodeAgentRunRequestId(requestId));
  }

  snapshot(): ReadonlyMap<AgentRunId, AgentRun> {
    return this.#projection.snapshot();
  }

  rebuildFromJournal(): void {
    this.#projection.clear();
    const replay = this.#store.replayAll(MAX_AGENT_RUN_REPLAY_LIMIT);
    if (replay.status !== "ok") {
      throw new AgentRunEventStoreError("invalid", "AgentRun rebuild requires a snapshot.");
    }
    for (const envelope of replay.events) {
      this.#applyEnvelope(envelope);
    }
  }

  /**
   * After restart, non-terminal runs without independent resume evidence become
   * Interrupted with a restart recovery reason. Never Completes without a
   * recorded child result.
   */
  reconcileAfterRestart(): ReadonlyArray<AgentRun> {
    const interrupted: AgentRun[] = [];
    for (const run of this.#projection.snapshot().values()) {
      if (isAgentRunTerminalStatus(run.lifecycleStatus)) continue;
      if (!isAgentRunActiveStatus(run.lifecycleStatus) && run.lifecycleStatus !== "waiting") {
        continue;
      }
      // A run Waiting on its immutable pool decision never held execution
      // state; restart preserves the original decision and routing reason
      // instead of rewriting it to a restart interruption. A run parked on a
      // journaled usage limit holds no live execution either — its session
      // already ended on the limit and the reset fact rides the aggregate —
      // so the wait, and any recovery opt-in bound to it, survives restart.
      // A run parked on its dependencies never started either; it stays
      // parked, and the orchestration service holds it until a person or its
      // parent's resumed session lets it go.
      if (
        run.lifecycleStatus === "waiting" &&
        (agentRunPoolRouteWaitingReason(run.routingReceipt) !== undefined ||
          run.usageLimit !== undefined ||
          run.recoveryReason === AGENT_RUN_DEPENDENCY_WAITING_REASON)
      ) {
        continue;
      }
      const result = this.applyCommand({
        kind: "interrupt-agent-run",
        runId: run.id,
        expectedVersion: run.version,
        recoveryReason: "restart-without-resumable-execution",
      });
      if (result.kind === "run-updated") {
        interrupted.push(result.run);
      }
    }
    return interrupted;
  }

  #applyEnvelope(envelope: EventEnvelope): void {
    if (envelope.eventVersion !== 1) return;
    if (envelope.eventName === AGENT_RUN_REQUESTED) {
      const payload = decodeAgentRunRequested(envelope.payload);
      this.#projection.applyRequested(payload.run);
      return;
    }
    if (envelope.eventName === AGENT_RUN_STATUS_CHANGED) {
      const payload = decodeAgentRunStatusChanged(envelope.payload);
      const existing = this.#projection.getById(payload.runId);
      const resultAcknowledgement =
        payload.toStatus === "completed"
          ? {
              required: true as const,
              acknowledged: false as const,
              followUpReason: "unacknowledged-child-result",
            }
          : existing?.resultAcknowledgement;
      this.#projection.applyStatusChanged({
        runId: payload.runId,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        ...(payload.generation === undefined ? {} : { generation: payload.generation }),
        version: payload.version,
        updatedAt: envelope.occurredAt as UtcTimestamp,
        ...(payload.recoveryReason === undefined ? {} : { recoveryReason: payload.recoveryReason }),
        ...(payload.result === undefined ? {} : { result: payload.result }),
        ...(payload.usage === undefined ? {} : { usage: payload.usage }),
        ...(payload.usageLimit === undefined ? {} : { usageLimit: payload.usageLimit }),
        ...(resultAcknowledgement === undefined ? {} : { resultAcknowledgement }),
      });
      return;
    }
    if (envelope.eventName === AGENT_RUN_RESULT_ACKNOWLEDGED) {
      const payload = decodeAgentRunResultAcknowledged(envelope.payload);
      this.#projection.applyResultAcknowledged({
        runId: payload.runId,
        version: payload.version,
        acknowledgedAt: payload.acknowledgedAt,
      });
      return;
    }
    if (envelope.eventName === AGENT_RUN_RESULT_DELIVERY_SETTLED) {
      // Every committed event moves the aggregate head, and the fold carries
      // that head into run.version — skipping it here would leave a rebuilt
      // run stale-versioned against its own journal.
      const payload = decodeAgentRunResultDeliverySettled(envelope.payload);
      this.#projection.applyResultDeliverySettled({
        runId: payload.runId,
        version: payload.version,
        delivery: payload.delivery,
      });
      return;
    }
    if (
      envelope.eventName === USAGE_RESUME_SCHEDULED ||
      envelope.eventName === USAGE_RESUME_CANCELLED ||
      envelope.eventName === USAGE_RESUME_SETTLED
    ) {
      this.#projection.applyUsageResume(envelope);
    }
  }

  #now(): UtcTimestamp {
    return this.#clock() as UtcTimestamp;
  }
}

function policyFailure(error: unknown): AgentRunCommandResult {
  if (error instanceof AgentRunPolicyRejected) {
    const reason = mapPolicyCode(error.code);
    return {
      kind: "run-command-failed",
      reason,
      message: error.message,
    };
  }
  throw error;
}

function storeFailure(error: unknown): AgentRunCommandResult {
  if (error instanceof AgentRunEventStoreError) {
    return {
      kind: "run-command-failed",
      reason: "stale-version",
      message: error.message,
    };
  }
  throw error;
}

function mapPolicyCode(
  code: AgentRunPolicyRejected["code"],
): Extract<AgentRunCommandResult, { kind: "run-command-failed" }>["reason"] {
  switch (code) {
    case "posture-rejected":
      return "posture-rejected";
    case "authority-widening":
      return "authority-widening";
    case "limit-reached":
      return "limit-reached";
    case "unsupported-transition":
      return "unsupported-transition";
    case "stale-version":
      return "stale-version";
    case "fallback-forbidden":
      return "fallback-forbidden";
    case "invalid-completion":
    case "invalid-acknowledgement":
    case "invalid-depth":
    case "invalid-workspace":
      return "invalid";
    default:
      return "invalid";
  }
}
