import type { ThreadPlanAggregate } from "@octant/domain";
import type { PlanStore } from "./planService";

/** In-memory store used only by Plan service and route tests. */
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
