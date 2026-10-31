import type { ChatAttempt } from "@octant/contracts";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";

/**
 * Whether the runtime executing this attempt can kill its own process alone.
 * Read from the attempt's provider, because a multi-model pool can run an
 * attempt on a different provider than the one the thread has saved.
 */
export function attemptCanForceStop(
  snapshot: ProviderRegistrySnapshot | undefined,
  attempt: Pick<ChatAttempt, "providerInstanceId"> | undefined,
): boolean {
  if (snapshot === undefined || attempt === undefined) return false;
  const observation = snapshot.observedStates.find(
    (candidate) => candidate.instanceId === attempt.providerInstanceId,
  );
  return observation?.capabilities.forceStop === "supported";
}
