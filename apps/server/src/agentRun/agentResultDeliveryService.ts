/**
 * The host's delivery of a finished subagent run's result into its parent
 * thread. A run that reaches a final lifecycle state owes its parent a
 * journaled turn carrying the framed result — this service watches committed
 * appends, dispatches through the mode's ordinary turn admission, and
 * journals how the delivery settled. A dispatch the parent cannot take yet —
 * its own turn is running, or no local window is registered — stays armed and
 * re-fires when the parent's aggregate commits again or the retry cadence
 * arrives. Nothing is polled away: a run whose delivery is still owed at boot
 * is found in the projection and delivered like one that finished live.
 */
import {
  decodeAgentRunResultDeliverySettled,
  decodeAgentRunStatusChanged,
  decodeCodeOperationEventFrame,
  type AgentRun,
  type AgentRunId,
  type AgentRunResultDeliveryOutcome,
  type CommittedAppend,
  type EventEnvelope,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

export type AgentRunDeliveryAggregateType = "chat-thread" | "work-thread" | "code-thread";

/**
 * What the service asks the mode when a finished run owes a delivery.
 * `inspect` re-reads the parent without side effects; `dispatch` admits the
 * one journaled delivery turn and answers whether it landed.
 */
export interface AgentResultDeliveryModePort {
  readonly inspect: (
    run: AgentRun,
  ) => Promise<{ readonly kind: "ready" } | { readonly kind: "invalid"; readonly detail: string }>;
  readonly dispatch: (
    run: AgentRun,
  ) => Promise<
    | { readonly kind: "dispatched" }
    | { readonly kind: "refused"; readonly detail: string }
    | { readonly kind: "deferred"; readonly detail: string }
  >;
}

export interface AgentResultDeliveryPorts {
  readonly chat: AgentResultDeliveryModePort;
  readonly work: AgentResultDeliveryModePort;
  readonly code: AgentResultDeliveryModePort;
}

export type AgentResultDeliveryTimerHandle = unknown;

interface PendingDelivery {
  readonly runId: AgentRunId;
  readonly aggregateType: AgentRunDeliveryAggregateType;
  readonly aggregateId: string;
  timer: AgentResultDeliveryTimerHandle | undefined;
  evaluating: boolean;
}

interface AgentResultDeliveryServiceOptions {
  readonly journal: Pick<Journal, "subscribeCommitted">;
  readonly agentRuns: Pick<AgentRunPersistenceService, "getById" | "snapshot" | "applyCommand">;
  readonly ports: AgentResultDeliveryPorts;
  readonly clock: () => Date;
  /** Injectable so tests drive the retry cadence by hand. */
  readonly schedule?: (atEpochMs: number, fire: () => void) => AgentResultDeliveryTimerHandle;
  readonly unschedule?: (handle: AgentResultDeliveryTimerHandle) => void;
  /** How long a deferred dispatch or a failed settle waits before retrying. */
  readonly retryAfterMs?: number;
  readonly onError?: (message: string, error: unknown) => void;
}

const DEFER_RETRY_AFTER_MS = 30_000;

/** A run that finished for good and has not settled how its result reached its parent. */
const owesDelivery = (run: AgentRun): boolean =>
  (run.lifecycleStatus === "completed" ||
    run.lifecycleStatus === "failed" ||
    run.lifecycleStatus === "cancelled") &&
  run.resultDelivery === undefined;

const aggregateTypeFor = (run: AgentRun): AgentRunDeliveryAggregateType | undefined => {
  switch (run.workspaceReceipt.mode) {
    case "chat":
      return "chat-thread";
    case "work":
      return "work-thread";
    case "code":
      return "code-thread";
    default:
      return undefined;
  }
};

export class AgentResultDeliveryService {
  readonly #options: AgentResultDeliveryServiceOptions;
  readonly #pending = new Map<string, PendingDelivery>();

  constructor(options: AgentResultDeliveryServiceOptions) {
    this.#options = options;
  }

  /**
   * Arm every finished run the projection still owes a delivery for. A run
   * that reached its final state while the host was away is found here and
   * delivered exactly like one that finished live.
   */
  start(): void {
    for (const run of this.#options.agentRuns.snapshot().values()) {
      if (owesDelivery(run)) this.#arm(run);
    }
  }

  stop(): void {
    for (const pending of this.#pending.values()) {
      this.#clearTimer(pending);
    }
    this.#pending.clear();
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      this.#onCommittedEvent(event);
    }
  }

  #onCommittedEvent(event: EventEnvelope): void {
    if (event.eventName === "agent.run-status-changed@1") {
      try {
        const { runId } = decodeAgentRunStatusChanged(event.payload);
        const run = this.#options.agentRuns.getById(runId);
        if (run !== undefined && owesDelivery(run)) this.#arm(run);
      } catch (error) {
        this.#options.onError?.("Agent-run status event did not decode.", error);
      }
      return;
    }
    if (event.eventName === "agent.run-result-delivery-settled@1") {
      // Whatever settled it — this service, a wait consume, a repair — the
      // run owes nothing more.
      try {
        const payload = decodeAgentRunResultDeliverySettled(event.payload);
        this.#dropRun(payload.runId);
      } catch (error) {
        this.#options.onError?.("Agent-run delivery-settle event did not decode.", error);
      }
      return;
    }
    this.#watchParent(event);
  }

  /**
   * A deferred delivery re-fires when its parent thread's aggregate commits
   * — the active turn settling is exactly such a commit. Code turns journal
   * on their own `code-operation` aggregates, so their frames name the
   * thread for the same wake.
   */
  #watchParent(event: EventEnvelope): void {
    const candidates: ReadonlyArray<readonly [AgentRunDeliveryAggregateType, string]> = (() => {
      if (
        event.aggregateType === "code-operation" &&
        event.eventName === "code.operation-event-recorded@1"
      ) {
        try {
          const frame = decodeCodeOperationEventFrame(event.payload);
          return [["code-thread", String(frame.threadId)] as const];
        } catch (error) {
          this.#options.onError?.("Agent-run delivery could not decode a code frame.", error);
          return [];
        }
      }
      if (
        event.aggregateType === "chat-thread" ||
        event.aggregateType === "work-thread" ||
        event.aggregateType === "code-thread"
      ) {
        return [[event.aggregateType as AgentRunDeliveryAggregateType, event.aggregateId] as const];
      }
      return [];
    })();
    for (const [aggregateType, aggregateId] of candidates) {
      for (const pending of this.#pending.values()) {
        if (
          pending.aggregateType !== aggregateType ||
          pending.aggregateId !== aggregateId ||
          pending.evaluating
        ) {
          continue;
        }
        // Re-evaluate the run rather than trusting the commit meant the
        // parent freed up: the port's dispatch is the authority on whether
        // the turn can be admitted now.
        this.#clearTimer(pending);
        queueMicrotask(() => void this.#evaluate(String(pending.runId)));
      }
    }
  }

  #arm(run: AgentRun): void {
    const aggregateType = aggregateTypeFor(run);
    if (aggregateType === undefined) return;
    const key = String(run.id);
    const existing = this.#pending.get(key);
    if (existing !== undefined) this.#clearTimer(existing);
    this.#pending.set(key, {
      runId: run.id,
      aggregateType,
      aggregateId: String(run.parentThreadId),
      timer: undefined,
      evaluating: false,
    });
    queueMicrotask(() => void this.#evaluate(key));
  }

  #dropRun(runId: AgentRunId): void {
    const pending = this.#pending.get(String(runId));
    if (pending === undefined) return;
    this.#clearTimer(pending);
    this.#pending.delete(String(runId));
  }

  #retryAfterMs(): number {
    return this.#options.retryAfterMs ?? DEFER_RETRY_AFTER_MS;
  }

  #clearTimer(pending: PendingDelivery): void {
    if (pending.timer === undefined) return;
    const unschedule =
      this.#options.unschedule ??
      ((handle: AgentResultDeliveryTimerHandle) => clearTimeout(handle as never));
    unschedule(pending.timer);
    pending.timer = undefined;
  }

  #armTimer(pending: PendingDelivery): void {
    const schedule =
      this.#options.schedule ??
      ((at: number, fire: () => void) => setTimeout(fire, Math.max(0, at - Date.now())));
    pending.timer = schedule(this.#options.clock().getTime() + this.#retryAfterMs(), () =>
      this.#evaluate(String(pending.runId)),
    );
  }

  async #evaluate(key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (pending === undefined || pending.evaluating) return;
    pending.evaluating = true;
    pending.timer = undefined;
    try {
      const run = this.#options.agentRuns.getById(pending.runId);
      // A settle that raced in — or a run state the host can no longer owe —
      // disarms silently; the journal already recorded whatever mattered.
      if (run === undefined || !owesDelivery(run)) {
        this.#pending.delete(key);
        return;
      }
      const port = this.#portFor(pending.aggregateType);
      const verdict = await port.inspect(run);
      if (verdict.kind === "invalid") {
        await this.#settle(pending, run, "invalidated", verdict.detail);
        return;
      }
      const result = await port.dispatch(run);
      if (result.kind === "dispatched") {
        await this.#settle(pending, run, "delivered");
      } else if (result.kind === "deferred") {
        // The parent cannot take the turn yet — keep it armed; a commit on
        // the parent's aggregate or the retry cadence re-fires it.
        this.#armTimer(pending);
      } else {
        await this.#settle(pending, run, "failed", result.detail);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The delivery threw.";
      const run = this.#options.agentRuns.getById(pending.runId);
      if (run !== undefined && owesDelivery(run)) {
        await this.#settle(pending, run, "failed", detail);
      } else {
        this.#pending.delete(key);
      }
    } finally {
      pending.evaluating = false;
    }
  }

  /**
   * Journals how the delivery settled. A refused settle — a consume that
   * raced it, or a version that moved — is checked against the projection
   * rather than trusted: a run the journal says is settled is disarmed; any
   * other refusal retries on the cadence so an owed delivery is never
   * dropped by a transient write.
   */
  async #settle(
    pending: PendingDelivery,
    run: AgentRun,
    outcome: AgentRunResultDeliveryOutcome,
    detail?: string,
  ): Promise<void> {
    const normalizedDetail =
      detail === undefined ? undefined : detail.trim().slice(0, 512).trim() || undefined;
    const result = this.#options.agentRuns.applyCommand({
      kind: "settle-agent-run-result-delivery",
      runId: run.id,
      expectedVersion: run.version,
      outcome,
      ...(normalizedDetail === undefined ? {} : { detail: normalizedDetail }),
    });
    if (result.kind === "run-updated") {
      this.#pending.delete(String(run.id));
      return;
    }
    const latest = this.#options.agentRuns.getById(run.id);
    if (latest === undefined || !owesDelivery(latest)) {
      this.#pending.delete(String(run.id));
      return;
    }
    this.#options.onError?.(
      "Agent-run result delivery settle was refused.",
      new Error(result.kind === "run-command-failed" ? result.message : "Unexpected result."),
    );
    this.#armTimer(pending);
  }

  #portFor(aggregateType: AgentRunDeliveryAggregateType): AgentResultDeliveryModePort {
    switch (aggregateType) {
      case "chat-thread":
        return this.#options.ports.chat;
      case "work-thread":
        return this.#options.ports.work;
      case "code-thread":
        return this.#options.ports.code;
    }
  }
}
