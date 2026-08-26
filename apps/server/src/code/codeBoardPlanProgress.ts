import type { CodeThreadId } from "@octant/contracts";
import type { CodeBoardCard } from "@octant/contracts";
import type { PlanService } from "../plan/planService";
import type { CodeBoardPlanProgressSource } from "./codeThreadBoardService";

/**
 * Adapts the durable {@link PlanService} (0027) to the Code board's
 * step-completion count (0051). Reads the same per-thread state the Plan
 * dock reads; no new subsystem, no new write path.
 */
export function createCodeBoardPlanProgressSource(
  planService: Pick<PlanService, "read">,
): CodeBoardPlanProgressSource {
  return {
    read(threadId: CodeThreadId): CodeBoardCard["planProgress"] {
      const { plan } = planService.read(String(threadId));
      if (plan === null) return { kind: "none" };
      const steps = plan.steps.filter((step) => step.status !== "dropped");
      const done = steps.filter((step) => step.status === "done").length;
      return { kind: "present", done, total: steps.length };
    },
  };
}
