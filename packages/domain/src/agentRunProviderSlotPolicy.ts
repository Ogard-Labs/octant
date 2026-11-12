import { DEFAULT_AGENT_RUN_PROVIDER_SLOT_WAIT_MINUTES, type AgentRun } from "@octant/contracts";

/**
 * The recovery reason a child carries while it waits for the provider to take
 * another request. It is what the Agents tab and the terminal show, so it is a
 * sentence rather than a token. Such a child holds no run slot, no provider
 * slot and no session: it starts by itself when a slot frees. The text only
 * describes the wait; the host recognises a waiting child by its own record.
 */
export const AGENT_RUN_PROVIDER_SLOT_WAITING_REASON = "Waiting for a free request slot";

/**
 * How long a child waits for a provider slot, by default, before it ends
 * Interrupted with the capacity reason, as it did before it could wait. A
 * person may choose another wait in Helper agents settings.
 *
 * Half an hour, because the turn holding the slot is often a long one: at
 * the earlier five minutes a helper ended while the slot it needed was a few
 * minutes from free. The wait stays bounded so a slot held by a person's
 * unanswered question ends the child with that reason rather than leaving it
 * looking busy for as long as the question sits.
 */
export const AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS =
  DEFAULT_AGENT_RUN_PROVIDER_SLOT_WAIT_MINUTES * 60_000;

/**
 * Whether a child has waited for a provider slot as long as it may. The wait
 * began when the run last changed status, which is when it parked, so the
 * deadline is read from the journal and not from memory. Whether the run waits
 * for a slot at all is the host's own record, never this reason text: a
 * provider's `waiting` message may read the same.
 */
export function agentRunProviderSlotWaitExpired(
  run: Pick<AgentRun, "lifecycleStatus" | "updatedAt">,
  nowMs: number,
  limitMs: number = AGENT_RUN_PROVIDER_SLOT_WAIT_LIMIT_MS,
): boolean {
  return run.lifecycleStatus === "waiting" && nowMs - Date.parse(run.updatedAt) >= limitMs;
}
