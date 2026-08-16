import {
  decodeThreadGoalCommand,
  type ThreadGoal,
  type ThreadGoalCommand,
  type ThreadGoalHistoryEntry,
  type ThreadGoalUpdated,
  type UtcTimestamp,
} from "@octant/contracts";
import { applyThreadGoalCommand, GoalPolicyRejection, type GoalAggregate } from "@octant/domain";

export interface GoalStore {
  readonly read: (threadId: string) => GoalAggregate;
  readonly write: (threadId: string, aggregate: GoalAggregate) => void;
}

/**
 * Failure a {@link GoalStore} raises instead of accepting a Goal it did not
 * durably retain. `conflict` means the store's head moved under the command
 * and the caller must reload; every other durable failure is `failed`, which
 * the service reports rather than treating the write as successful.
 */
export class GoalStoreError extends Error {
  override readonly name = "GoalStoreError";
  constructor(
    readonly category: "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export class InMemoryGoalStore implements GoalStore {
  readonly #byThread = new Map<string, GoalAggregate>();

  read(threadId: string): GoalAggregate {
    return this.#byThread.get(threadId) ?? { goal: null, history: [] };
  }

  write(threadId: string, aggregate: GoalAggregate): void {
    this.#byThread.set(threadId, {
      goal: aggregate.goal,
      history: [...aggregate.history],
    });
  }
}

export class GoalServiceError extends Error {
  override readonly name = "GoalServiceError";
  constructor(
    readonly category: "invalid" | "stale" | "conflict" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface GoalServiceOptions {
  readonly store: GoalStore;
  readonly clock?: () => string;
}

export class GoalService {
  readonly #store: GoalStore;
  readonly #clock: () => string;

  constructor(options: GoalServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  read(threadId: string): {
    readonly goal: ThreadGoal | null;
    readonly history: ReadonlyArray<ThreadGoalHistoryEntry>;
  } {
    return this.#store.read(threadId);
  }

  async execute(input: unknown): Promise<ThreadGoalUpdated> {
    let command: ThreadGoalCommand;
    try {
      command = decodeThreadGoalCommand(input);
    } catch {
      throw new GoalServiceError("invalid", "Goal command is invalid.");
    }

    const current = this.#store.read(command.threadId);
    try {
      const next = applyThreadGoalCommand(current, command, this.#clock() as UtcTimestamp);
      if (next.goal === null) {
        throw new GoalServiceError("failed", "Goal command produced no goal.");
      }
      this.#store.write(command.threadId, next);
      return { goal: next.goal, history: next.history };
    } catch (error) {
      if (error instanceof GoalPolicyRejection) {
        if (error.code === "version-conflict") {
          throw new GoalServiceError("stale", error.message);
        }
        throw new GoalServiceError("conflict", error.message);
      }
      // A durable store rejects the write rather than losing it. A moved head
      // is the same stale-version outcome the policy reports; anything else
      // means the Goal was not saved and must not be reported as applied.
      if (error instanceof GoalStoreError) {
        if (error.category === "conflict") {
          throw new GoalServiceError("stale", error.message);
        }
        throw new GoalServiceError("failed", error.message);
      }
      throw new GoalServiceError("failed", "Goal command failed.");
    }
  }
}
