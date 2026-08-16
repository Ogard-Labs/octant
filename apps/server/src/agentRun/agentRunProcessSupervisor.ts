import type { AgentRun, AgentRunId } from "@octant/contracts/agent-run";

export interface AgentRunProcessHandle {
  readonly pid: number;
  readonly receiptReady?: Promise<void>;
  readonly onExit: (listener: () => void) => void;
  readonly terminate: () => Promise<void>;
}

export interface AgentRunProcessPort {
  readonly spawn: (run: AgentRun) => AgentRunProcessHandle;
  readonly reconcile?: () => Promise<void>;
}

export class AgentRunProcessSupervisorError extends Error {
  override readonly name = "AgentRunProcessSupervisorError";
  readonly reason: "duplicate" | "not-found";

  constructor(reason: AgentRunProcessSupervisorError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

interface OwnedProcess {
  readonly runId: AgentRunId;
  readonly handle: AgentRunProcessHandle;
  stopping: boolean;
  deathNotified: boolean;
}

export class AgentRunProcessSupervisor {
  readonly #port: AgentRunProcessPort;
  readonly #onProcessDeath: ((runId: AgentRunId) => void) | undefined;
  readonly #processDeathSubscribers = new Set<(runId: AgentRunId) => void>();
  readonly #processes = new Map<AgentRunId, OwnedProcess>();

  constructor(options: {
    readonly port: AgentRunProcessPort;
    readonly onProcessDeath?: (runId: AgentRunId) => void;
  }) {
    this.#port = options.port;
    this.#onProcessDeath = options.onProcessDeath;
  }

  start(run: AgentRun): AgentRunProcessHandle {
    const existing = this.#processes.get(run.id);
    if (existing !== undefined) {
      throw new AgentRunProcessSupervisorError(
        "duplicate",
        "AgentRun already owns a supervised child process.",
      );
    }
    const handle = this.#port.spawn(run);
    const owned: OwnedProcess = {
      runId: run.id,
      handle,
      stopping: false,
      deathNotified: false,
    };
    this.#processes.set(run.id, owned);
    handle.onExit(() => {
      if (this.#processes.get(run.id) !== owned) return;
      this.#processes.delete(run.id);
      if (owned.stopping || owned.deathNotified) return;
      owned.deathNotified = true;
      this.#notifyProcessDeath(run.id);
    });
    // Receipt persistence is part of the startup boundary.  The orchestration
    // service intentionally returns the lifecycle result synchronously, so
    // observe the asynchronous receipt promise here before it can become an
    // unhandled rejection.  Treat a failed receipt like a controlled process
    // death and make a best-effort termination of the child we just owned.
    if (handle.receiptReady !== undefined) {
      void handle.receiptReady.catch(() => {
        if (this.#processes.get(run.id) !== owned || owned.deathNotified) return;
        owned.stopping = true;
        owned.deathNotified = true;
        this.#processes.delete(run.id);
        this.#notifyProcessDeath(run.id);
        void Promise.resolve()
          .then(() => owned.handle.terminate())
          .catch(() => undefined);
      });
    }
    return handle;
  }

  async stop(runId: AgentRunId): Promise<void> {
    const owned = this.#processes.get(runId);
    if (owned === undefined) return;
    owned.stopping = true;
    try {
      await owned.handle.terminate();
    } finally {
      if (this.#processes.get(runId) === owned) this.#processes.delete(runId);
    }
  }

  activeRunIds(): ReadonlyArray<AgentRunId> {
    return [...this.#processes.keys()].sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
  }

  async reconcile(): Promise<void> {
    await this.#port.reconcile?.();
  }

  subscribeToProcessDeath(listener: (runId: AgentRunId) => void): () => void {
    this.#processDeathSubscribers.add(listener);
    return () => {
      this.#processDeathSubscribers.delete(listener);
    };
  }

  #notifyProcessDeath(runId: AgentRunId): void {
    this.#onProcessDeath?.(runId);
    for (const subscriber of this.#processDeathSubscribers) subscriber(runId);
  }
}
