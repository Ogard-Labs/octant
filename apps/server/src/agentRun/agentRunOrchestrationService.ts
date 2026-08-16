import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunCommand,
  AgentRunCommandResult,
  AgentRunId,
  AgentRunParentThreadId,
  AgentRunWorkspaceReceipt,
} from "@octant/contracts";
import { MAX_AGENT_RUN_RESULT_CHARACTERS } from "@octant/contracts";
import {
  agentRunPoolRouteWaitingReason,
  agentRunResultReference,
  effectiveAgentRunExecutionTarget,
  isAgentRunTerminalStatus,
} from "@octant/domain";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";
import type { AgentRunSessionOutcome } from "./agentRunSessionPort";

const MAX_RECOVERY_REASON_CHARACTERS = 1_024;

export type AgentRunOrchestrationFailureReason =
  | "workspace-denied"
  | "authority-drift"
  | "capacity-queued"
  | "not-found"
  | "unsupported";

export class AgentRunOrchestrationError extends Error {
  override readonly name = "AgentRunOrchestrationError";
  constructor(
    readonly reason: AgentRunOrchestrationFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentRunCapacityPort {
  readonly tryReserve: (input: {
    readonly runId: AgentRunId;
    readonly providerInstanceId: string;
  }) =>
    | { readonly status: "reserved"; readonly reservationId: string }
    | { readonly status: "queued"; readonly reason: string };
  readonly release: (reservationId: string) => void;
}

export interface AgentRunWorktreePort {
  readonly isVerifiedIsolation: (
    workspace: Extract<AgentRunWorkspaceReceipt, { kind: "code-worktree" }>,
  ) => boolean;
  readonly isParentCheckout: (
    workspace: Extract<AgentRunWorkspaceReceipt, { kind: "code-worktree" }>,
  ) => boolean;
}

export interface AgentRunApprovalPort {
  readonly isCurrent: (input: {
    readonly runId: AgentRunId;
    readonly authority: AgentRunAuthority;
  }) => boolean;
}

export interface AgentRunProcessSupervisorPort {
  readonly start: (run: AgentRun) => unknown;
  readonly stop: (runId: AgentRunId) => Promise<void>;
  readonly reconcile?: () => Promise<void>;
  readonly subscribeToProcessDeath?: (listener: (runId: AgentRunId) => void) => () => void;
}

export interface AgentRunOrchestrationServiceOptions {
  readonly persistence: AgentRunPersistenceService;
  readonly capacity: AgentRunCapacityPort;
  readonly worktree: AgentRunWorktreePort;
  readonly approvals: AgentRunApprovalPort;
  readonly processes?: AgentRunProcessSupervisorPort;
}

export interface AdmitAgentRunInput {
  readonly command: Extract<AgentRunCommand, { kind: "request-agent-run" }>;
  readonly parentAuthority: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
  readonly confirmed: boolean;
  readonly liveAuthority: AgentRunAuthority;
}

/**
 * Server orchestration over AgentRun persistence: workspace isolation checks,
 * live authority revalidation, capacity reservation/queueing, and leaf-first
 * cancellation. Provider process spawn remains outside this seam.
 */
export class AgentRunOrchestrationService {
  readonly #persistence: AgentRunPersistenceService;
  readonly #capacity: AgentRunCapacityPort;
  readonly #worktree: AgentRunWorktreePort;
  readonly #approvals: AgentRunApprovalPort;
  readonly #processes: AgentRunProcessSupervisorPort | undefined;
  readonly #reservations = new Map<AgentRunId, string>();
  /**
   * Runs whose settled session outcome this service durably recorded. A run is
   * added only once an append succeeded: the marker suppresses the death the
   * supervisor publishes right after a settlement, so claiming membership for a
   * settlement no journal accepted would leave a sessionless run marked active
   * with nothing left to correct it.
   */
  readonly #settledSessions = new Set<AgentRunId>();
  /** Runs currently being stopped by {@link cancelLeafFirst}. */
  readonly #cancelling = new Set<AgentRunId>();

  constructor(options: AgentRunOrchestrationServiceOptions) {
    this.#persistence = options.persistence;
    this.#capacity = options.capacity;
    this.#worktree = options.worktree;
    this.#approvals = options.approvals;
    this.#processes = options.processes;
    options.processes?.subscribeToProcessDeath?.((runId) => {
      const current = this.#persistence.getById(runId);
      if (current === undefined || isAgentRunTerminalStatus(current.lifecycleStatus)) return;
      // A managed session reports every non-completed outcome as death right
      // after it settles. A settlement that was durably recorded already holds
      // the honest state and the provider's own reason, so re-reporting it here
      // would overwrite that with a generic process death. A settlement no
      // journal accepted recorded nothing, so this death is what keeps the run
      // from claiming to be active without a session.
      if (this.#settledSessions.has(runId)) return;
      try {
        this.onProcessDeath(runId, current.version);
      } catch (error) {
        // The publisher is the supervisor's synchronous settle path. A throw
        // here would skip its death bookkeeping and propagate into the
        // runtime's settle listener, leaving a pending cancellation awaiting a
        // settlement that never resolves, so a still-broken journal is
        // surfaced on the host log instead.
        console.error(
          `AgentRun ${String(runId)} process death could not be persisted:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  admit(input: AdmitAgentRunInput): AgentRunCommandResult {
    const existing = this.#persistence.getByRequestId(String(input.command.requestId));
    if (existing !== undefined) return { kind: "run-accepted", run: existing };

    this.#assertWorkspaceAllowed(input.command.workspaceReceipt);
    // Live grant may be narrower than the mode/parent ceiling; it must never
    // claim wider authority. Admission clamps against both.
    this.#assertLiveGrantWithinParentCeiling(input.parentAuthority, input.liveAuthority);
    if (this.#processes === undefined) {
      throw new AgentRunOrchestrationError(
        "unsupported",
        "Managed AgentRun execution is unavailable on this host.",
      );
    }

    const accepted = this.#persistence.requestRun({
      command: input.command,
      parentAuthority: input.parentAuthority,
      liveParentGrant: input.liveAuthority,
      ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
      ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
      confirmed: input.confirmed,
    });
    if (accepted.kind !== "run-accepted") return accepted;

    // A pool decision without an eligible candidate is admitted durably but
    // never reserves capacity or starts; the immutable route already records
    // why every candidate was rejected.
    const poolWaitingReason = agentRunPoolRouteWaitingReason(accepted.run.routingReceipt);
    if (poolWaitingReason !== undefined) {
      return this.#persistence.applyCommand({
        kind: "wait-agent-run",
        runId: accepted.run.id,
        expectedVersion: accepted.run.version,
        recoveryReason: poolWaitingReason,
      });
    }

    const reservation = this.#capacity.tryReserve({
      runId: accepted.run.id,
      // Reserve on the candidate that actually executes: the explicit pool
      // fallback when one was selected, otherwise the primary selection.
      providerInstanceId: String(
        effectiveAgentRunExecutionTarget(accepted.run.routingReceipt).providerInstanceId,
      ),
    });
    if (reservation.status === "queued") {
      return this.#persistence.applyCommand({
        kind: "wait-agent-run",
        runId: accepted.run.id,
        expectedVersion: accepted.run.version,
        recoveryReason: reservation.reason,
      });
    }

    this.#reservations.set(accepted.run.id, reservation.reservationId);
    return accepted;
  }

  start(
    runId: AgentRunId,
    expectedVersion: number,
    liveAuthority: AgentRunAuthority,
  ): AgentRunCommandResult {
    const current = this.#persistence.getById(runId);
    if (current === undefined) {
      return {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message: "AgentRun does not exist.",
      };
    }
    if (agentRunPoolRouteWaitingReason(current.routingReceipt) !== undefined) {
      return {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message:
          "AgentRun pool route recorded no eligible candidate; the run remains Waiting until it is re-requested.",
      };
    }
    this.#assertWorkspaceAllowed(current.workspaceReceipt);
    this.#assertAuthorityWithinLiveAuthority(current.authority, liveAuthority);
    if (!this.#approvals.isCurrent({ runId, authority: liveAuthority })) {
      if (current.lifecycleStatus === "queued") {
        return this.#persistence.applyCommand({
          kind: "interrupt-agent-run",
          runId,
          expectedVersion: expectedVersion as never,
          recoveryReason: "approval-or-extension-drift",
        });
      }
      return this.#persistence.applyCommand({
        kind: "wait-agent-run",
        runId,
        expectedVersion: expectedVersion as never,
        recoveryReason: "approval-or-extension-drift",
      });
    }
    const started = this.#persistence.applyCommand({
      kind: "start-agent-run",
      runId,
      expectedVersion: expectedVersion as never,
    });
    if (
      this.#processes === undefined ||
      started.kind !== "run-updated" ||
      started.run.lifecycleStatus !== "starting"
    ) {
      return started;
    }
    try {
      // A run that waited after an earlier settlement is live again, so that
      // settlement must no longer suppress this incarnation's death report.
      this.#settledSessions.delete(started.run.id);
      this.#processes.start(started.run);
      return started;
    } catch {
      return this.onProcessDeath(started.run.id, started.run.version);
    }
  }

  /**
   * Cancel leaf-first: descendants before parent. A cancellation is durable only
   * after its process confirms termination, so capacity cannot be reused while
   * execution might still be live.
   */
  async cancelLeafFirst(input: {
    readonly runId: AgentRunId;
    readonly scope: "self" | "subtree" | "hierarchy";
  }): Promise<ReadonlyArray<AgentRunCommandResult>> {
    const root = this.#persistence.getById(input.runId);
    if (root === undefined) {
      return [
        {
          kind: "run-command-failed",
          reason: "unsupported-transition",
          message: "AgentRun does not exist.",
        },
      ];
    }

    const order = this.#collectCancelOrder(root.id, input.scope);
    const results: AgentRunCommandResult[] = [];
    for (const id of order) {
      const run = this.#persistence.getById(id);
      if (run === undefined) continue;
      if (isAgentRunTerminalStatus(run.lifecycleStatus)) continue;
      if (this.#processes !== undefined) {
        // A managed session settles `cancelled` while this stop is still
        // awaited. Marking the run here is what lets that settlement defer to
        // this loop, which owns the leaf-first ordering and the reservation.
        this.#cancelling.add(id);
        try {
          await this.#processes.stop(id);
        } catch {
          results.push({
            kind: "run-command-failed",
            reason: "unsupported-transition",
            message: "AgentRun process did not confirm termination; cancellation remains pending.",
          });
          continue;
        } finally {
          this.#cancelling.delete(id);
        }
      }
      this.#releaseReservation(id);
      results.push(
        this.#persistence.applyCommand({
          kind: "cancel-agent-run",
          runId: id,
          expectedVersion: run.version as never,
          scope: "self",
        }),
      );
    }
    return results;
  }

  onProcessDeath(runId: AgentRunId, expectedVersion: number): AgentRunCommandResult {
    this.#releaseReservation(runId);
    return this.#persistence.applyCommand({
      kind: "interrupt-agent-run",
      runId,
      expectedVersion: expectedVersion as never,
      recoveryReason: "provider-process-death",
    });
  }

  /**
   * Persists the one terminal fact of a managed in-process session.
   *
   * Mirrors {@link onProcessDeath}: the supervisor observes the outcome, this
   * service releases capacity and records the durable transition, so no
   * lifecycle command is ever invented outside the persistence seam. Only a
   * completion carrying a usable result may record Completed; every other
   * outcome keeps the ambiguity the session reported. Completion leaves the
   * parent's acknowledgement outstanding, so finishing a child never satisfies
   * the parent's delivery target.
   *
   * Returns `undefined` when there is nothing honest left to record: an unknown
   * run, a run already terminal through process death or restart recovery, a
   * repeated settle, or a cancellation {@link cancelLeafFirst} is persisting.
   *
   * The run is marked settled only once an append actually recorded the
   * outcome, so a settlement the journal rejected still lets the death the
   * supervisor publishes next record that this run has no session.
   */
  onSessionSettled(input: {
    readonly runId: AgentRunId;
    readonly outcome: AgentRunSessionOutcome;
  }): AgentRunCommandResult | undefined {
    const current = this.#persistence.getById(input.runId);
    if (current === undefined) return undefined;
    if (isAgentRunTerminalStatus(current.lifecycleStatus)) return undefined;
    if (this.#settledSessions.has(input.runId)) return undefined;
    if (input.outcome.kind === "cancelled" && this.#cancelling.has(input.runId)) return undefined;

    this.#releaseReservation(input.runId);
    let recorded: AgentRunCommandResult;
    try {
      recorded = this.#recordSettlement(current, input.outcome);
    } catch (error) {
      return this.#failUnpersistedSettlement(input.runId, error);
    }
    if (recorded.kind === "run-updated") this.#settledSessions.add(input.runId);
    return recorded;
  }

  #recordSettlement(current: AgentRun, outcome: AgentRunSessionOutcome): AgentRunCommandResult {
    const expectedVersion = current.version as never;
    switch (outcome.kind) {
      case "completed":
        return this.#recordSessionCompletion(current, outcome);
      case "waiting":
        return this.#persistence.applyCommand({
          kind: "wait-agent-run",
          runId: current.id,
          expectedVersion,
          recoveryReason: boundedRecoveryReason(outcome.reason),
        });
      case "cancelled":
        return this.#persistence.applyCommand({
          kind: "cancel-agent-run",
          runId: current.id,
          expectedVersion,
          scope: "self",
        });
      case "failed":
        return this.#persistence.applyCommand({
          kind: "fail-agent-run",
          runId: current.id,
          expectedVersion,
          recoveryReason: boundedRecoveryReason(
            `${outcome.failure.category}: ${outcome.failure.message}`,
          ),
        });
      case "interrupted":
        return this.#persistence.applyCommand({
          kind: "interrupt-agent-run",
          runId: current.id,
          expectedVersion,
          recoveryReason: boundedRecoveryReason(outcome.reason),
        });
    }
  }

  /**
   * A settlement whose journal append threw must not leave the run claiming to
   * be active while its session is already gone, and it must never propagate
   * back into the session supervisor: settlement always finishes so a pending
   * cancellation can resolve. The failure is recorded through the ordinary
   * fail path with a precise recovery reason; when even that append fails the
   * error is surfaced on the host log and the caller receives a command
   * failure instead of an exception.
   *
   * Only a recorded fail marks the run settled. Leaving the marker unset when
   * neither append landed is what lets the death the supervisor publishes right
   * after this settlement record the run's end, instead of being suppressed and
   * leaving a sessionless run active until the next host start.
   */
  #failUnpersistedSettlement(runId: AgentRunId, error: unknown): AgentRunCommandResult {
    const message = error instanceof Error ? error.message : String(error);
    const latest = this.#persistence.getById(runId);
    if (latest !== undefined && !isAgentRunTerminalStatus(latest.lifecycleStatus)) {
      try {
        const failed = this.#persistence.applyCommand({
          kind: "fail-agent-run",
          runId: latest.id,
          expectedVersion: latest.version as never,
          recoveryReason: boundedRecoveryReason(`settlement-persistence-failure: ${message}`),
        });
        if (failed.kind === "run-updated") {
          this.#settledSessions.add(runId);
          return failed;
        }
      } catch {
        // The fail append hit the same broken persistence; fall through so the
        // reported failure still names the original error.
      }
    }
    console.error(
      `AgentRun ${String(runId)} settled but its terminal state could not be persisted: ${message}`,
    );
    return {
      kind: "run-command-failed",
      reason: "invalid",
      message: `AgentRun settlement could not be persisted: ${message}`,
    };
  }

  /**
   * A session that completed without a visible reply delivered nothing, so it
   * is recorded as failed rather than as a completion with an invented result.
   * A real reply is an observed running child result, which the lifecycle
   * requires before Completed, so the run's execution is recorded first.
   *
   * The reply itself is persisted by the completion append, so the parent and
   * the user can read what the child answered after settlement and after a
   * restart, and the recorded reference names that stored reply.
   */
  #recordSessionCompletion(
    run: AgentRun,
    outcome: Extract<AgentRunSessionOutcome, { kind: "completed" }>,
  ): AgentRunCommandResult {
    const reply = boundedResultText(outcome.responseText);
    if (reply === undefined) {
      return this.#persistence.applyCommand({
        kind: "fail-agent-run",
        runId: run.id,
        expectedVersion: run.version as never,
        recoveryReason: "managed-session-completed-without-result",
      });
    }
    let current = run;
    if (current.lifecycleStatus !== "running") {
      const running = this.#persistence.applyCommand({
        kind: "mark-agent-run-running",
        runId: current.id,
        expectedVersion: current.version as never,
      });
      if (running.kind !== "run-updated") return running;
      current = running.run;
    }
    return this.#persistence.applyCommand({
      kind: "complete-agent-run",
      runId: current.id,
      expectedVersion: current.version as never,
      result: {
        reference: agentRunResultReference(current.id),
        truncated: reply.truncated,
      },
      resultText: reply.text,
    });
  }

  parentSummary(parentThreadId: AgentRunParentThreadId) {
    return this.#persistence.parentSummary(parentThreadId);
  }

  cancellationTargets(input: {
    readonly runId: AgentRunId;
    readonly scope: "self" | "subtree" | "hierarchy";
  }): ReadonlyArray<AgentRun> {
    const root = this.#persistence.getById(input.runId);
    if (root === undefined) return [];
    return this.#collectCancelOrder(root.id, input.scope)
      .map((id) => this.#persistence.getById(id))
      .filter(
        (run): run is AgentRun =>
          run !== undefined && !isAgentRunTerminalStatus(run.lifecycleStatus),
      );
  }

  #collectCancelOrder(runId: AgentRunId, scope: "self" | "subtree" | "hierarchy"): AgentRunId[] {
    if (scope === "self") return [runId];
    const ordered: AgentRunId[] = [];
    const visit = (id: AgentRunId) => {
      for (const child of this.#persistence.snapshot().values()) {
        if (child.parentRunId === id) {
          visit(child.id);
        }
      }
      ordered.push(id);
    };
    if (scope === "subtree") {
      visit(runId);
      return ordered;
    }
    // hierarchy: cancel entire forest under top-most parent of runId
    let root = runId;
    const seen = new Set<AgentRunId>();
    while (true) {
      if (seen.has(root)) break;
      seen.add(root);
      const current = this.#persistence.getById(root);
      if (current?.parentRunId === undefined) break;
      root = current.parentRunId;
    }
    visit(root);
    return ordered;
  }

  #releaseReservation(runId: AgentRunId): void {
    const reservationId = this.#reservations.get(runId);
    if (reservationId !== undefined) {
      this.#capacity.release(reservationId);
      this.#reservations.delete(runId);
      this.#dequeueCapacityWaiter();
    }
  }

  /**
   * Capacity is released only after a terminal process signal. At that point,
   * atomically attempt the oldest persisted capacity waiter and let the normal
   * start path repeat approval and workspace checks before spawning it.
   */
  #dequeueCapacityWaiter(): void {
    for (const run of this.#persistence.snapshot().values()) {
      if (
        run.lifecycleStatus !== "waiting" ||
        run.recoveryReason !== "provider-capacity-saturated" ||
        !this.#approvals.isCurrent({ runId: run.id, authority: run.authority })
      ) {
        continue;
      }

      const reservation = this.#capacity.tryReserve({
        runId: run.id,
        providerInstanceId: String(
          effectiveAgentRunExecutionTarget(run.routingReceipt).providerInstanceId,
        ),
      });
      if (reservation.status === "queued") return;

      this.#reservations.set(run.id, reservation.reservationId);
      let started: AgentRunCommandResult;
      try {
        started = this.start(run.id, run.version, run.authority);
      } catch {
        this.#capacity.release(reservation.reservationId);
        this.#reservations.delete(run.id);
        continue;
      }
      if (started.kind === "run-command-failed") {
        this.#capacity.release(reservation.reservationId);
        this.#reservations.delete(run.id);
      }
      return;
    }
  }

  #assertWorkspaceAllowed(workspace: AgentRun["workspaceReceipt"]): void {
    if (workspace.kind === "chat-virtual") return;
    if (workspace.kind === "work-root") return;
    if (workspace.kind === "code-worktree") {
      if (this.#worktree.isParentCheckout(workspace)) {
        throw new AgentRunOrchestrationError(
          "workspace-denied",
          "AgentRun cannot execute in the parent checkout.",
        );
      }
      if (!workspace.verified || !this.#worktree.isVerifiedIsolation(workspace)) {
        throw new AgentRunOrchestrationError(
          "workspace-denied",
          "Code AgentRun requires a verified isolated worktree.",
        );
      }
      return;
    }
    throw new AgentRunOrchestrationError("workspace-denied", "Unsupported AgentRun workspace.");
  }

  #assertLiveGrantWithinParentCeiling(
    parentCeiling: AgentRunAuthority,
    live: AgentRunAuthority,
  ): void {
    const booleanKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
    if (booleanKeys.some((key) => live[key] && !parentCeiling[key])) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority drifted wider than the parent AgentRun authority ceiling.",
      );
    }
    const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
      plan: 0,
      "approval-gated": 1,
      "auto-accept-edits": 2,
      "full-access": 3,
    };
    if (executionRank[live.executionPolicy] > executionRank[parentCeiling.executionPolicy]) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority drifted wider than the parent AgentRun execution policy ceiling.",
      );
    }
    if (
      live.permissionPersistence === "project-default" &&
      parentCeiling.permissionPersistence !== "project-default"
    ) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority drifted wider than the parent AgentRun permission persistence ceiling.",
      );
    }
  }

  #assertAuthorityWithinLiveAuthority(effective: AgentRunAuthority, live: AgentRunAuthority): void {
    const booleanKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
    if (booleanKeys.some((key) => effective[key] && !live[key])) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority no longer permits the admitted AgentRun authority.",
      );
    }
    const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
      plan: 0,
      "approval-gated": 1,
      "auto-accept-edits": 2,
      "full-access": 3,
    };
    if (executionRank[effective.executionPolicy] > executionRank[live.executionPolicy]) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority no longer permits the admitted AgentRun execution policy.",
      );
    }
    if (
      effective.permissionPersistence === "project-default" &&
      live.permissionPersistence !== "project-default"
    ) {
      throw new AgentRunOrchestrationError(
        "authority-drift",
        "Live authority no longer permits the admitted AgentRun permission persistence.",
      );
    }
  }
}

const RESULT_TRUNCATION_MARKER = `\n\n[octant: child reply truncated at ${String(
  MAX_AGENT_RUN_RESULT_CHARACTERS,
)} characters]`;

/**
 * A child reply is untrusted provider output entering an append-only journal,
 * so it is bounded here rather than at whatever produced it. An over-long reply
 * is truncated rather than rejected: the child did the work, and discarding a
 * long answer would be indistinguishable from a child that answered nothing.
 * The kept prefix states that it was cut, so no reader mistakes it for the
 * whole reply. An empty reply stays absent so the caller fails the run.
 */
function boundedResultText(
  responseText: string,
): { readonly text: string; readonly truncated: boolean } | undefined {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= MAX_AGENT_RUN_RESULT_CHARACTERS) {
    return { text: trimmed, truncated: false };
  }
  const kept = trimmed
    .slice(0, MAX_AGENT_RUN_RESULT_CHARACTERS - RESULT_TRUNCATION_MARKER.length)
    .trimEnd();
  return { text: `${kept}${RESULT_TRUNCATION_MARKER}`, truncated: true };
}

/**
 * A recovery reason is a bounded, non-empty contract field. A port that reports
 * an empty reason still ended the session, so the honest record is that the
 * reason was missing rather than a rejected command that leaves the run active.
 */
function boundedRecoveryReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length === 0
    ? "managed-session-ended-without-a-reported-reason"
    : trimmed.slice(0, MAX_RECOVERY_REASON_CHARACTERS);
}

export function createInMemoryCapacityPort(): AgentRunCapacityPort & {
  readonly queued: string[];
} {
  const reserved = new Map<string, string>();
  const queued: string[] = [];
  let next = 1;
  let available = 4;
  return {
    queued,
    tryReserve: ({ runId }) => {
      if (available <= 0) {
        queued.push(String(runId));
        return { status: "queued", reason: "provider-capacity-saturated" };
      }
      available -= 1;
      const reservationId = `res-${next++}`;
      reserved.set(reservationId, String(runId));
      return { status: "reserved", reservationId };
    },
    release: (reservationId) => {
      if (reserved.delete(reservationId)) available += 1;
    },
  };
}
