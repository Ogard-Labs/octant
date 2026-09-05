import type { NativeHarnessTodoItem } from "@octant/contracts";
import type { PlanService } from "../plan/planService";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

/**
 * `todo-write` over the thread's own Plan. A task list is a plan the model
 * proposes for itself, so it lands where plans already live and shows up on
 * the same board cards, rather than in a second notes store nobody reviews.
 */
export function createNativeHarnessTodoPort(input: {
  readonly plans: Pick<PlanService, "read" | "execute">;
  readonly threadId: string;
  readonly uuid: () => string;
}): NonNullable<NativeHarnessToolPorts["todo"]> {
  return {
    replace: async (items: ReadonlyArray<NativeHarnessTodoItem>) => {
      if (items.length === 0) return;
      const current = input.plans.read(input.threadId).plan;
      const steps = items.map((item) => ({ stepId: input.uuid(), title: item.title }));
      if (current === null) {
        await input.plans.execute({
          kind: "propose-thread-plan",
          threadId: input.threadId,
          expectedVersion: 0,
          planId: input.uuid(),
          revisionId: input.uuid(),
          title: "Tasks",
          steps,
        });
      } else {
        await input.plans.execute({
          kind: "revise-thread-plan",
          threadId: input.threadId,
          expectedVersion: current.version,
          planId: current.id,
          revisionId: input.uuid(),
          title: current.title,
          steps,
        });
      }
      for (const [index, item] of items.entries()) {
        if (item.status === "pending") continue;
        const plan = input.plans.read(input.threadId).plan;
        const step = steps[index];
        if (plan === null || step === undefined) return;
        await input.plans.execute({
          kind: "set-thread-plan-step-status",
          threadId: input.threadId,
          expectedVersion: plan.version,
          planId: plan.id,
          stepId: step.stepId,
          status: item.status,
        });
      }
    },
  };
}
