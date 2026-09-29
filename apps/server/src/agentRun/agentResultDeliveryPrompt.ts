import type { AgentRun } from "@octant/contracts";

/**
 * The turn input the host composes when delivering a finished subagent run's
 * result into its parent thread. The run is named by id so the parent agent
 * can still address it — status, cancel, or a later wait — with the managed
 * agents tool it already has, and the outcome line states honestly whether a
 * reply came back at all.
 */
export function agentResultDeliveryPrompt(run: AgentRun, resultText: string | undefined): string {
  const route = run.routingReceipt;
  const subagent = `${run.role} (${String(route.selectedProviderInstanceId)}/${String(
    route.selectedModelId,
  )})`;
  const heading =
    run.lifecycleStatus === "completed"
      ? "A subagent you delegated has finished."
      : "A subagent you delegated ended without completing.";
  const outcome =
    run.lifecycleStatus === "completed"
      ? `Result:\n${
          resultText === undefined || resultText.length === 0
            ? "(the reply is unavailable)"
            : resultText
        }${run.result?.truncated === true ? "\n(the reply was truncated)" : ""}`
      : `Outcome: ${run.lifecycleStatus} — ${run.recoveryReason ?? "no detail was recorded"}`;
  return [
    heading,
    "",
    `Subagent: ${subagent}`,
    `Run: ${String(run.id)}`,
    `Task: ${run.task}`,
    "",
    outcome,
  ].join("\n");
}
