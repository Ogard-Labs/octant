import {
  decodeThreadPlanCommand,
  type ThreadPlan,
  type ThreadPlanCommand,
  type ThreadPlanHistoryEntry,
  type ThreadPlanUpdated,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  applyThreadPlanCommand,
  ThreadPlanPolicyRejection,
  type ThreadPlanAggregate,
} from "@octant/domain";

export interface PlanStore {
  readonly read: (threadId: string) => ThreadPlanAggregate;
  readonly write: (threadId: string, aggregate: ThreadPlanAggregate) => void;
}

/**
 * Failure a {@link PlanStore} raises instead of accepting a Plan it did not
 * durably retain. `conflict` means the store's head moved under the command
 * and the caller must reload; every other durable failure is `failed`, which
 * the service reports rather than treating the write as successful.
 */
export class PlanStoreError extends Error {
  override readonly name = "PlanStoreError";
  constructor(
    readonly category: "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export class InMemoryPlanStore implements PlanStore {
  readonly #byThread = new Map<string, ThreadPlanAggregate>();

  read(threadId: string): ThreadPlanAggregate {
    return this.#byThread.get(threadId) ?? { plan: null, history: [] };
  }

  write(threadId: string, aggregate: ThreadPlanAggregate): void {
    this.#byThread.set(threadId, {
      plan: aggregate.plan,
      history: [...aggregate.history],
    });
  }
}

export class PlanServiceError extends Error {
  override readonly name = "PlanServiceError";
  constructor(
    readonly category: "invalid" | "stale" | "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface PlanServiceOptions {
  readonly store: PlanStore;
  readonly clock?: () => string;
}

export class PlanService {
  readonly #store: PlanStore;
  readonly #clock: () => string;

  constructor(options: PlanServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  read(threadId: string): {
    readonly plan: ThreadPlan | null;
    readonly history: ReadonlyArray<ThreadPlanHistoryEntry>;
  } {
    return this.#store.read(threadId);
  }

  async execute(input: unknown): Promise<ThreadPlanUpdated> {
    let command: ThreadPlanCommand;
    try {
      command = decodeThreadPlanCommand(input);
    } catch {
      throw new PlanServiceError("invalid", "Plan command is invalid.");
    }

    const current = this.#store.read(command.threadId);
    try {
      const next = applyThreadPlanCommand(current, command, this.#clock() as UtcTimestamp);
      if (next.plan === null) {
        throw new PlanServiceError("failed", "Plan command produced no plan.");
      }
      this.#store.write(command.threadId, next);
      return { plan: next.plan, history: next.history };
    } catch (error) {
      if (error instanceof ThreadPlanPolicyRejection) {
        if (error.code === "version-conflict") {
          throw new PlanServiceError("stale", error.message);
        }
        throw new PlanServiceError("conflict", error.message);
      }
      // A durable store rejects the write rather than losing it. A moved head
      // is the same stale-version outcome the policy reports; anything else
      // means the Plan was not saved and must not be reported as applied.
      if (error instanceof PlanStoreError) {
        if (error.category === "conflict") {
          throw new PlanServiceError("stale", error.message);
        }
        throw new PlanServiceError("failed", error.message);
      }
      throw new PlanServiceError("failed", "Plan command failed.");
    }
  }
}
