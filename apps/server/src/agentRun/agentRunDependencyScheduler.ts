import {
  decodeAgentRunParentThreadId,
  decodeAgentRunStatusChanged,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  type AgentRunId,
  type AgentRunParentThreadId,
  type CommittedAppend,
} from "@octant/contracts";
import { AGENT_RUN_DEPENDENCY_WAITING_REASON } from "@octant/domain";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

/**
 * Starts child runs whose dependencies settled.
 *
 * A run that waits on siblings parks under its own reason and holds nothing.
 * Every committed status change is a moment its graph may have moved: the run
 * that changed may itself have just parked (its dependencies may already be
 * done), and every run parked on it may now be ready or doomed. A parent
 * thread's harness session being resumed is another: its children may have
 * been held while it was paused or needed a check after a restart. The
 * decision belongs to the orchestration service; this only notices when to
 * ask. At boot every parked run is asked once, so a dependency that failed
 * while the host was away fails its dependents; a ready one stays held until
 * a person lets it go.
 */
export class AgentRunDependencyScheduler {
  readonly #agentRuns: Pick<AgentRunPersistenceService, "getById" | "snapshot">;
  readonly #orchestration: Pick<
    AgentRunOrchestrationService,
    "releaseDependencyWait" | "releaseAfterParentResumed"
  >;
  readonly #onError: ((message: string, error: unknown) => void) | undefined;

  constructor(options: {
    readonly agentRuns: Pick<AgentRunPersistenceService, "getById" | "snapshot">;
    readonly orchestration: Pick<
      AgentRunOrchestrationService,
      "releaseDependencyWait" | "releaseAfterParentResumed"
    >;
    readonly onError?: (message: string, error: unknown) => void;
  }) {
    this.#agentRuns = options.agentRuns;
    this.#orchestration = options.orchestration;
    this.#onError = options.onError;
  }

  start(): void {
    for (const run of this.#agentRuns.snapshot().values()) {
      if (run.recoveryReason === AGENT_RUN_DEPENDENCY_WAITING_REASON) this.#release(run.id);
    }
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      if (
        event.aggregateType === NATIVE_HARNESS_SESSION_AGGREGATE_TYPE &&
        event.eventName === NATIVE_HARNESS_SESSION_EVENT_NAMES.resumed
      ) {
        let parentThreadId: AgentRunParentThreadId;
        try {
          parentThreadId = decodeAgentRunParentThreadId(String(event.aggregateId));
        } catch (error) {
          this.#onError?.("Harness session resume named no thread.", error);
          continue;
        }
        // Deferred like a status change: the session store sets the resumed
        // status only after its append returns.
        queueMicrotask(() => this.#releaseAfterParentResumed(parentThreadId));
        continue;
      }
      if (event.eventName !== "agent.run-status-changed@1") continue;
      let runId: AgentRunId;
      try {
        runId = decodeAgentRunStatusChanged(event.payload).runId;
      } catch (error) {
        this.#onError?.("Agent-run status event did not decode.", error);
        continue;
      }
      // Deferred: the projection folds this append after the listener runs,
      // so reading it now could see the run as it was before the change.
      queueMicrotask(() => this.#onRunChanged(runId));
    }
  }

  #onRunChanged(runId: AgentRunId): void {
    const changed = this.#agentRuns.getById(runId);
    if (changed?.recoveryReason === AGENT_RUN_DEPENDENCY_WAITING_REASON) this.#release(runId);
    for (const run of this.#agentRuns.snapshot().values()) {
      if (
        run.recoveryReason === AGENT_RUN_DEPENDENCY_WAITING_REASON &&
        (run.dependsOn ?? []).some((dependencyId) => String(dependencyId) === String(runId))
      ) {
        this.#release(run.id);
      }
    }
  }

  #releaseAfterParentResumed(parentThreadId: AgentRunParentThreadId): void {
    try {
      this.#orchestration.releaseAfterParentResumed(parentThreadId);
    } catch (error) {
      this.#onError?.("Runs held for a resumed session could not be released.", error);
    }
  }

  #release(runId: AgentRunId): void {
    try {
      this.#orchestration.releaseDependencyWait(runId);
    } catch (error) {
      this.#onError?.("A run waiting on its dependencies could not be released.", error);
    }
  }
}
