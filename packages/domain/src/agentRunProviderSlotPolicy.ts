import type { AgentRun } from "@octant/contracts";

/**
 * The recovery reason a child carries while it waits for the provider to take
 * another request. It is what the Agents tab and the terminal show, so it is a
 * sentence rather than a token. Such a child holds no run slot, no provider
 * slot and no session: it starts by itself when a slot frees.
 */
export const AGENT_RUN_PROVIDER_SLOT_WAITING_REASON = "Waiting for a free request slot";

/**
 * How long a child waits for a provider slot before it ends Interrupted with
 * the capacity reason, as it did before it could wait.
 *
 * Five minutes is the idle bound of a Chat turn: a turn that stops making
 * progress is cut off after that long, so a normal holder frees its slot well
 * inside the wait. A longer wait would only mean a person's unanswered
 * question is holding the slot, and the child should tell them so rather than
 * look busy for as long as that takes.
 */
export const AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS = 5 * 60_000;

export function agentRunWaitsForProviderSlot(
  run: Pick<AgentRun, "lifecycleStatus" | "recoveryReason">,
): boolean {
  return (
    run.lifecycleStatus === "waiting" &&
    run.recoveryReason === AGENT_RUN_PROVIDER_SLOT_WAITING_REASON
  );
}

/**
 * Whether a child has waited for a provider slot as long as it may. The wait
 * began when the run last changed status, which is when it parked, so the
 * deadline is read from the journal and not from memory.
 */
export function agentRunProviderSlotWaitExpired(
  run: Pick<AgentRun, "lifecycleStatus" | "recoveryReason" | "updatedAt">,
  nowMs: number,
): boolean {
  return (
    agentRunWaitsForProviderSlot(run) &&
    nowMs - Date.parse(run.updatedAt) >= AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS
  );
}
