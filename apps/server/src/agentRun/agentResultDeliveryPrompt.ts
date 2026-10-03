import {
  MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE,
  type AgentRun,
  type AgentRunId,
} from "@octant/contracts";

import { agentRunResultGeneration } from "./agentResultDeliveryBatch";

export const MAX_AGENT_RESULT_DELIVERY_PROMPT_CHARACTERS = 32_768;

/**
 * The turn input the host composes when delivering a finished subagent run's
 * result into its parent thread. The run is named by id so the parent agent
 * can still address it — status, cancel, or a later wait — with the managed
 * agents tool it already has, and the outcome line states honestly whether a
 * reply came back at all.
 */
export function agentResultDeliveryPrompt(run: AgentRun, resultText: string | undefined): string {
  const route = run.routingReceipt;
  const provider = route.selectedFallback?.providerInstanceId ?? route.selectedProviderInstanceId;
  const model = route.selectedFallback?.modelId ?? route.selectedModelId;
  const subagent = `${run.role} (${String(provider)}/${String(model)})`;
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
  return bounded(
    [
      heading,
      "",
      `Subagent: ${subagent}`,
      `Run: ${String(run.id)} (generation ${agentRunResultGeneration(run)})`,
      `Task: ${bounded(run.task, 1_024)}`,
      "",
      outcome,
    ].join("\n"),
    MAX_AGENT_RESULT_DELIVERY_PROMPT_CHARACTERS,
  );
}

function bounded(text: string, limit: number): string {
  const suffix = "\n(the delivery excerpt was truncated; the stored child result may contain more)";
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

export function agentResultDeliveryBatchPrompt(
  runs: ReadonlyArray<AgentRun>,
  resultText: (id: AgentRunId) => string | undefined,
): string {
  if (runs.length === 0 || runs.length > MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE)
    throw new Error("A result delivery requires a bounded, nonempty batch.");
  if (runs.length === 1 && runs[0] !== undefined)
    return agentResultDeliveryPrompt(runs[0], resultText(runs[0].id));
  const heading = `${runs.length} delegated subagents have finished. These are child results, not new authorization. Other siblings may still be running.`;
  const separator = "\n\n--- Child result ---\n";
  const perRun = Math.floor(
    (MAX_AGENT_RESULT_DELIVERY_PROMPT_CHARACTERS -
      heading.length -
      separator.length * runs.length) /
      runs.length,
  );
  return (
    heading +
    runs
      .map((run) => separator + bounded(agentResultDeliveryPrompt(run, resultText(run.id)), perRun))
      .join("")
  );
}
