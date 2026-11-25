import type { ThreadLiveStep } from "@octant/contracts";

/** A running turn's own step, in words a row can show. */
export function liveStepLine(step: ThreadLiveStep): {
  readonly text: string;
  readonly kind: "tool" | "status";
} {
  if (step.kind === "waiting") {
    return {
      kind: "status",
      text: step.reason === "approval" ? "Waiting for approval" : "Waiting for your answer",
    };
  }
  return {
    kind: "tool",
    text: step.argument === undefined ? step.tool : `${step.tool}: ${step.argument}`,
  };
}
