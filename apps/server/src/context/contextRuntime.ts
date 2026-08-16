import {
  decideContextLengthRecovery,
  evaluateSemanticSummary,
  reconcileContextVariance,
} from "@octant/domain/context-compaction";
import {
  evaluateCapacityAdmission,
  reconcileReservedTokens,
} from "@octant/domain/provider-capacity-policy";
import type { ProviderInstanceId, ProviderServiceLimits, UtcTimestamp } from "@octant/contracts";
import { unavailableProviderServiceLimits } from "@octant/provider-sdk/context-facts";
import {
  ContextMaintenanceService,
  type ContextMaintenancePolicy,
} from "./contextMaintenanceService";
import type {
  ContextMaintenanceIdentityPort,
  ContextMaintenancePort,
} from "./contextMaintenancePort";
import {
  ProviderCapacityScheduler,
  type ProviderCapacitySchedulerOptions,
} from "./providerCapacityScheduler";

export const CONTEXT_MAINTENANCE_POLICY = Object.freeze({
  evaluateSummary: evaluateSemanticSummary,
  reconcileVariance: reconcileContextVariance,
  decideContextLengthRecovery,
}) satisfies ContextMaintenancePolicy;

/**
 * How many later turns a new summary must serve before it has paid for the
 * maintenance request that produced it.
 *
 * A summary is only worth a provider call when the material it replaces would
 * otherwise be re-planned turn after turn. Once a subject is over budget that
 * is exactly what happens — the same conversation prefix is dropped again on
 * every following turn — so the reviewed floor asks the summary to earn back
 * its own request within three of them. With the conservative cost and savings
 * estimates below that makes the break-even roughly 1.5x, which keeps
 * one-off overflow (a single oversized paste that will never be re-sent) on
 * deterministic reduction instead of spending a request on it.
 */
export const CONTEXT_SUMMARY_EXPECTED_REUSE_TURNS = 3;

/**
 * The share of the replaced material a generated summary is expected to keep.
 *
 * Estimated before generation, so it is deliberately pessimistic: half. The
 * service still rejects any summary that turns out larger than the material it
 * replaces, so an optimistic estimate here could only overstate savings, never
 * grow the context.
 */
export const CONTEXT_SUMMARY_EXPECTED_RETAINED_SHARE = 0.5;

export function makeContextMaintenanceService(options: {
  readonly port: ContextMaintenancePort;
  readonly identity: ContextMaintenanceIdentityPort;
}): ContextMaintenanceService {
  return new ContextMaintenanceService({
    port: options.port,
    identity: options.identity,
    policy: CONTEXT_MAINTENANCE_POLICY,
  });
}

export function makeProviderCapacityScheduler(
  options: Omit<ProviderCapacitySchedulerOptions, "capacityPolicy">,
): ProviderCapacityScheduler {
  return new ProviderCapacityScheduler({
    ...options,
    capacityPolicy: {
      evaluateAdmission: evaluateCapacityAdmission,
      reconcileReservedTokens,
    },
  });
}

/**
 * Supplies provider capacity facts for a caller that observes none of its own.
 *
 * An all-unavailable record states "this host observed nothing", not "this
 * provider has no limits". Writing it unconditionally would replace whatever an
 * ordinary turn observed — an active retry window, an exhausted quota, a drained
 * bucket — which both admits the caller past a wait this host already knows
 * about and leaves the shared scheduler degraded for every other turn until the
 * next real observation. So it is supplied only as a first record for a provider
 * nothing has been observed for; once facts exist they stay authoritative and
 * the caller is admitted, queued, or rejected against them like any other work.
 */
export function makeUnobservedProviderCapacityFacts(input: {
  readonly scheduler: ProviderCapacityScheduler;
  readonly now: () => UtcTimestamp;
}): (facts: {
  readonly providerInstanceId: ProviderInstanceId;
}) => ProviderServiceLimits | undefined {
  return ({ providerInstanceId }) => {
    if (input.scheduler.providerFacts(providerInstanceId) !== undefined) return undefined;
    return unavailableProviderServiceLimits(providerInstanceId, input.now(), "provider-discovery");
  };
}
