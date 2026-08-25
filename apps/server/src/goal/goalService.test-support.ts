import type { GoalAggregate } from "@octant/domain";
import type { GoalStore } from "./goalService";

/** In-memory store used only by Goal service and route tests. */
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
