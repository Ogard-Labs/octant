import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderReadiness,
  ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { automaticModelUnavailableReason } from "@octant/domain/automatic-model-policy";

/**
 * Whether the account the person chose for an automatic call can be asked
 * right now: a sentence saying why not, or undefined. It reads the account's
 * own state and reports it; it never offers another account.
 */
export function createAutomaticModelAccountCheck(input: {
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readiness: (id: ProviderInstanceId) => ProviderReadiness | undefined;
  readonly limits: () => ProviderUsageLimitsSnapshot;
  readonly nowMs?: () => number;
}): (providerInstanceId: ProviderInstanceId) => string | undefined {
  const nowMs = input.nowMs ?? Date.now;
  return (providerInstanceId) => {
    const instance = input.readProviderInstance(providerInstanceId);
    return automaticModelUnavailableReason({
      instance:
        instance === undefined
          ? undefined
          : { enabled: instance.enabled, displayName: instance.displayName },
      readiness: input.readiness(providerInstanceId),
      atLimit: instance !== undefined && atLimit(input.limits(), providerInstanceId, nowMs()),
    });
  };
}

function atLimit(
  snapshot: ProviderUsageLimitsSnapshot,
  providerInstanceId: ProviderInstanceId,
  nowMs: number,
): boolean {
  const entry = snapshot.entries.find(
    (candidate) => String(candidate.providerInstanceId) === String(providerInstanceId),
  );
  if (entry?.status !== "available") return false;
  if (entry.limits.quota === "exhausted") return true;
  return (entry.limits.rateLimitWindows ?? []).some(
    (window) =>
      window.status === "exhausted" &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  );
}
