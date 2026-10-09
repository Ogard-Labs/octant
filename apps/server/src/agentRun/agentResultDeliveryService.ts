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
  MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE,
  decodeAgentRunStatusChanged,
  decodeCodeOperationEventFrame,
  type AgentRun,
  type AgentRunId,
  type AgentRunResultDeliveryOutcome,
  type AgentRunResultDeliveryMark,
  type CommittedAppend,
  type EventEnvelope,
} from "@octant/contracts";
import {
  agentRunResultGeneration,
  type AgentResultDeliveryMember,
} from "./agentResultDeliveryBatch";
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
  readonly dispatch: (runs: ReadonlyArray<AgentRun>) => Promise<
    | {
        readonly kind: "dispatched";
        readonly runIds: ReadonlyArray<AgentRunId>;
        readonly runGenerations?: AgentRunResultDeliveryMark["runGenerations"];
      }
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
  /**
   * Journals that a child's reply is about to enter its parent, which taints
   * the parent: the child may have relayed content it fetched, and a local
   * tool result no longer taints the parent after it. Answers whether the
   * taint was recorded; a delivery whose taint could not be recorded waits.
   */
  readonly recordResultIngestion?: (run: AgentRun) => boolean;
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
        queueMicrotask(() => void this.#evaluate(this.#key(pending)));
      }
    }
  }

  #key(parent: Pick<PendingDelivery, "aggregateType" | "aggregateId">): string {
    return `${parent.aggregateType}:${parent.aggregateId}`;
  }

  #owed(parent: PendingDelivery): ReadonlyArray<AgentRun> {
    return [...this.#options.agentRuns.snapshot().values()]
      .filter(
        (run) =>
          owesDelivery(run) &&
          aggregateTypeFor(run) === parent.aggregateType &&
          String(run.parentThreadId) === parent.aggregateId,
      )
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          String(left.id).localeCompare(String(right.id)),
      )
      .slice(0, MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE);
  }

  #arm(run: AgentRun): void {
    const aggregateType = aggregateTypeFor(run);
    if (aggregateType === undefined) return;
    const parent = { aggregateType, aggregateId: String(run.parentThreadId) };
    const key = this.#key(parent);
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      if (existing.evaluating) return;
      this.#clearTimer(existing);
    } else {
      this.#pending.set(key, { ...parent, timer: undefined, evaluating: false });
    }
    queueMicrotask(() => void this.#evaluate(key));
  }

  #dropRun(runId: AgentRunId): void {
    const run = this.#options.agentRuns.getById(runId);
    if (run === undefined) return;
    const aggregateType = aggregateTypeFor(run);
    if (aggregateType === undefined) return;
    const key = this.#key({ aggregateType, aggregateId: String(run.parentThreadId) });
    const pending = this.#pending.get(key);
    if (pending === undefined || pending.evaluating || this.#owed(pending).length > 0) return;
    this.#clearTimer(pending);
    this.#pending.delete(key);
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
    this.#clearTimer(pending);
    pending.timer = schedule(this.#options.clock().getTime() + this.#retryAfterMs(), () =>
      this.#evaluate(this.#key(pending)),
    );
  }

  async #evaluate(key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (pending === undefined || pending.evaluating) return;
    pending.evaluating = true;
    this.#clearTimer(pending);
    try {
      const port = this.#portFor(pending.aggregateType);
      const ready: AgentRun[] = [];
      for (const run of this.#owed(pending)) {
        const verdict = await port.inspect(run);
        if (this.#pending.get(key) !== pending) return;
        if (verdict.kind === "invalid") {
          this.#settle(
            pending,
            { runId: run.id, generation: agentRunResultGeneration(run) },
            "invalidated",
            verdict.detail,
          );
        } else {
          const current = this.#options.agentRuns.getById(run.id);
          if (current !== undefined && owesDelivery(current)) ready.push(current);
        }
      }
      const runs = ready.flatMap((run) => {
        const current = this.#options.agentRuns.getById(run.id);
        return current !== undefined && owesDelivery(current) ? [current] : [];
      });
      if (runs.length === 0) return;
      const record = this.#options.recordResultIngestion;
      if (record !== undefined && !runs.every((run) => record(run))) {
        this.#armTimer(pending);
        return;
      }
      const result = await port.dispatch(runs);
      if (this.#pending.get(key) !== pending) return;
      if (result.kind === "dispatched") {
        const requested = new Set(runs.map((run) => `${run.id}:${agentRunResultGeneration(run)}`));
        const covered =
          result.runGenerations ?? result.runIds.map((runId) => ({ runId, generation: 1 }));
        if (
          result.runIds.length === 0 ||
          new Set(result.runIds.map(String)).size !== result.runIds.length ||
          covered.length !== result.runIds.length ||
          new Set(covered.map((member) => String(member.runId))).size !== covered.length ||
          covered.some(
            (member) =>
              !result.runIds.some((id) => String(id) === String(member.runId)) ||
              !requested.has(`${member.runId}:${member.generation}`),
          )
        ) {
          throw new Error(
            "The delivery did not identify a nonempty subset of the requested results.",
          );
        }
        for (const member of covered) this.#settle(pending, member, "delivered");
      } else if (result.kind === "deferred") {
        this.#armTimer(pending);
      } else {
        // Preparation may outlive one member's result. That refusal describes
        // the stale batch, so rebuild it without failing its healthy siblings.
        if (
          runs.some((run) => {
            const current = this.#options.agentRuns.getById(run.id);
            return (
              current === undefined ||
              (current.generation ?? 1) !== (run.generation ?? 1) ||
              current.lifecycleStatus !== run.lifecycleStatus ||
              !owesDelivery(current)
            );
          })
        )
          return;
        for (const run of runs)
          this.#settle(
            pending,
            { runId: run.id, generation: agentRunResultGeneration(run) },
            "failed",
            result.detail,
          );
      }
    } catch (error) {
      // A dispatch may have journaled its turn before throwing. Keep every
      // unsettled member owed so the next admission can read that durable mark.
      this.#options.onError?.("Agent-run result delivery will retry.", error);
      if (this.#pending.get(key) === pending) this.#armTimer(pending);
    } finally {
      pending.evaluating = false;
      if (this.#pending.get(key) === pending) {
        if (this.#owed(pending).length === 0) {
          this.#clearTimer(pending);
          this.#pending.delete(key);
        } else if (pending.timer === undefined) {
          queueMicrotask(() => void this.#evaluate(key));
        }
      }
    }
  }

  #settle(
    pending: PendingDelivery,
    member: AgentResultDeliveryMember,
    outcome: AgentRunResultDeliveryOutcome,
    detail?: string,
  ): void {
    const runId = member.runId;
    const run = this.#options.agentRuns.getById(runId);
    if (
      run === undefined ||
      !owesDelivery(run) ||
      agentRunResultGeneration(run) !== member.generation
    )
      return;
    const normalizedDetail = detail?.trim().slice(0, 512).trim() || undefined;
    const command = {
      kind: "settle-agent-run-result-delivery" as const,
      runId,
      expectedVersion: run.version,
      outcome,
      generation: member.generation,
      ...(normalizedDetail === undefined ? {} : { detail: normalizedDetail }),
    };
    const result = this.#options.agentRuns.applyCommand(command);
    if (result.kind === "run-updated") return;
    const latest = this.#options.agentRuns.getById(runId);
    if (latest === undefined || !owesDelivery(latest)) return;
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
