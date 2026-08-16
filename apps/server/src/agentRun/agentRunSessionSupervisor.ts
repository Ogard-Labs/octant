import type { AgentRun, AgentRunId } from "@octant/contracts";
import type { AgentRunProcessSupervisorPort } from "./agentRunOrchestrationService";
import { AgentRunProcessSupervisorError } from "./agentRunProcessSupervisor";
import {
  isAgentRunSessionDeath,
  type AgentRunSessionHandle,
  type AgentRunSessionOutcome,
  type AgentRunSessionPort,
} from "./agentRunSessionPort";

export interface AgentRunSessionSupervisorOptions {
  readonly port: AgentRunSessionPort;
  readonly onProcessDeath?: (runId: AgentRunId) => void;
  /**
   * Observes every terminal outcome, including clean completions that are not
   * a death. Persisting the child-thread result belongs to the caller, so the
   * supervisor never invents a lifecycle command of its own.
   */
  readonly onSessionSettled?: (input: {
    readonly runId: AgentRunId;
    readonly outcome: AgentRunSessionOutcome;
  }) => void;
  /**
   * Run ids the durable AgentRun projection still considers active. Supplied at
   * startup so {@link AgentRunSessionSupervisor.reconcile} can recognise runs
   * whose in-process session died with the previous host.
   */
  readonly persistedActiveRunIds?: () => ReadonlyArray<AgentRunId>;
}

interface OwnedSession {
  readonly runId: AgentRunId;
  readonly handle: AgentRunSessionHandle;
  stopping: boolean;
  settled: boolean;
  deathNotified: boolean;
}

/**
 * Supervises Octant-managed children that execute as in-process provider
 * sessions rather than spawned operating-system processes.
 *
 * It satisfies `AgentRunProcessSupervisorPort` unchanged: that port was already
 * shaped around start/stop/reconcile/death and never required a pid, so managed
 * execution needs no second authority or lifecycle path. Duplicate and
 * not-found semantics reuse `AgentRunProcessSupervisorError` so callers handle
 * one supervision error type regardless of which backend owns a child.
 */
export class AgentRunSessionSupervisor implements AgentRunProcessSupervisorPort {
  readonly #port: AgentRunSessionPort;
  readonly #onProcessDeath: ((runId: AgentRunId) => void) | undefined;
  readonly #onSessionSettled: AgentRunSessionSupervisorOptions["onSessionSettled"];
  readonly #persistedActiveRunIds: (() => ReadonlyArray<AgentRunId>) | undefined;
  readonly #processDeathSubscribers = new Set<(runId: AgentRunId) => void>();
  readonly #sessions = new Map<AgentRunId, OwnedSession>();
  readonly #reconciledDeaths = new Set<AgentRunId>();

  constructor(options: AgentRunSessionSupervisorOptions) {
    this.#port = options.port;
    this.#onProcessDeath = options.onProcessDeath;
    this.#onSessionSettled = options.onSessionSettled;
    this.#persistedActiveRunIds = options.persistedActiveRunIds;
  }

  start(run: AgentRun): AgentRunSessionHandle {
    if (this.#sessions.has(run.id)) {
      throw new AgentRunProcessSupervisorError(
        "duplicate",
        "AgentRun already owns a supervised managed session.",
      );
    }
    const handle = this.#port.start(run);
    const owned: OwnedSession = {
      runId: run.id,
      handle,
      stopping: false,
      settled: false,
      deathNotified: false,
    };
    this.#sessions.set(run.id, owned);
    // A run id is live again, so a death recorded for an earlier incarnation
    // must not suppress reconciliation of this one.
    this.#reconciledDeaths.delete(run.id);

    handle.onSettled((outcome) => {
      if (this.#sessions.get(run.id) !== owned) return;
      this.#settle(owned, outcome);
    });

    // Startup work continues after `start` returns because orchestration
    // commits the lifecycle transition synchronously. Observe the promise here
    // so a failed startup becomes a controlled death instead of an unhandled
    // rejection, and make a best-effort stop of the session we just owned.
    if (handle.startupReady !== undefined) {
      void handle.startupReady.catch(() => {
        if (this.#sessions.get(run.id) !== owned || owned.settled) return;
        // Suppress the settle-path death rule and raise the death here, so a
        // startup failure reports exactly one death even though the supervisor
        // is the one stopping the session.
        owned.stopping = true;
        this.#settle(owned, {
          kind: "interrupted",
          reason: "Managed AgentRun session startup did not complete.",
        });
        if (!owned.deathNotified) {
          owned.deathNotified = true;
          this.#notifyProcessDeath(run.id);
        }
        void Promise.resolve()
          .then(() => this.#port.stop(run.id))
          .catch(() => undefined);
      });
    }
    return handle;
  }

  /**
   * Leaf-first cancellation calls this once per descendant before its parent.
   * It resolves only after the port confirms the session stopped, and a
   * supervisor-initiated stop never reports process death: the caller is
   * already persisting the cancellation.
   *
   * A stop the port could not confirm keeps the session owned and rethrows.
   * Forgetting it would make the next cancellation find nothing, report
   * success, and let the caller journal a terminal state while the provider
   * execution may still be live; it would also orphan the eventual outcome,
   * because a settlement from a session this supervisor no longer owns is
   * ignored. Retaining it keeps the run supervised, retryable, and honest.
   */
  async stop(runId: AgentRunId): Promise<void> {
    const owned = this.#sessions.get(runId);
    if (owned === undefined) return;
    owned.stopping = true;
    try {
      await this.#port.stop(runId);
    } catch (error) {
      // The caller is not persisting a cancellation after a failed stop, so
      // this run is an ordinary supervised session again: a death it reaches
      // on its own must still be reported.
      if (!owned.settled) owned.stopping = false;
      throw error;
    }
    // Settling removes the session; one that settled while this stop was
    // awaited already removed itself, so only a stale entry is cleared here.
    if (!owned.settled) this.#settle(owned, { kind: "cancelled" });
    else if (this.#sessions.get(runId) === owned) this.#sessions.delete(runId);
  }

  activeRunIds(): ReadonlyArray<AgentRunId> {
    return [...this.#sessions.keys()].sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
  }

  /**
   * An in-process session cannot outlive its host. Any run the journal still
   * considers active after a restart therefore has no live execution, and the
   * design forbids leaving it visibly Running: report it as dead exactly once
   * so recovery marks it interrupted with a concrete reason.
   */
  async reconcile(): Promise<void> {
    await this.#port.reconcile?.();
    for (const runId of this.#persistedActiveRunIds?.() ?? []) {
      if (this.#sessions.has(runId) || this.#reconciledDeaths.has(runId)) continue;
      this.#reconciledDeaths.add(runId);
      this.#notifyProcessDeath(runId);
    }
  }

  subscribeToProcessDeath(listener: (runId: AgentRunId) => void): () => void {
    this.#processDeathSubscribers.add(listener);
    return () => {
      this.#processDeathSubscribers.delete(listener);
    };
  }

  #settle(owned: OwnedSession, outcome: AgentRunSessionOutcome): void {
    if (owned.settled) return;
    owned.settled = true;
    if (this.#sessions.get(owned.runId) === owned) this.#sessions.delete(owned.runId);
    try {
      this.#onSessionSettled?.({ runId: owned.runId, outcome });
    } catch (error) {
      // Settlement persistence is the callback's job and it contains its own
      // failures; anything that still escapes must not break settling. A throw
      // here would skip the death notification, propagate into the runtime's
      // settle listener, and leave a pending stop() awaiting a settlement
      // promise that never resolves — so the session must always finish
      // settling, and the error is surfaced instead of silently dropped.
      console.error(
        `AgentRun ${String(owned.runId)} settlement observer threw; the session is settled anyway:`,
        error,
      );
    }
    if (owned.stopping || owned.deathNotified || !isAgentRunSessionDeath(outcome)) return;
    owned.deathNotified = true;
    this.#notifyProcessDeath(owned.runId);
  }

  #notifyProcessDeath(runId: AgentRunId): void {
    this.#onProcessDeath?.(runId);
    for (const subscriber of this.#processDeathSubscribers) subscriber(runId);
  }
}
