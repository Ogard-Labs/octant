import type { ProviderExecutionPolicy } from "@octant/contracts";

/**
 * Per-thread network egress policy for tool/provider Seatbelt launches.
 *
 * Thread-level policies are three-valued. Seatbelt OS enforcement in V1 is only
 * two-level (`none` / `allow`). The finer `provider-endpoints-only` host
 * allowlist is enforced by Octant-owned brokered tools (browser origin
 * allowlists, research backends), not by a local egress proxy.
 *
 * Defaults:
 * - Work / Plan / Chat → `none`
 * - Code approval-gated / auto-accept-edits → `provider-endpoints-only`
 * - Full access / explicit network approval → `unrestricted`
 */

export type ThreadEgressPolicy = "none" | "provider-endpoints-only" | "unrestricted";

/** OS-materialized Seatbelt network permission. */
export type OsNetworkEgress = "none" | "allow";

export type ThreadEgressMode = "chat" | "work" | "code";
export type ThreadExecutionPolicy = ProviderExecutionPolicy;

export interface ResolveDefaultThreadEgressPolicyInput {
  readonly mode: ThreadEgressMode;
  readonly executionPolicy: ThreadExecutionPolicy;
  readonly explicitNetworkApproval?: boolean;
}

export interface ClampChildThreadEgressPolicyInput {
  readonly parent: ThreadEgressPolicy;
  readonly childNetworkAuthority: boolean;
  readonly requested?: ThreadEgressPolicy;
}

const EGRESS_RANK: Record<ThreadEgressPolicy, number> = {
  none: 0,
  "provider-endpoints-only": 1,
  unrestricted: 2,
};

export function resolveDefaultThreadEgressPolicy(
  input: ResolveDefaultThreadEgressPolicyInput,
): ThreadEgressPolicy {
  if (input.explicitNetworkApproval === true || input.executionPolicy === "full-access") {
    return "unrestricted";
  }
  if (input.executionPolicy === "plan") return "none";
  if (
    input.mode === "code" &&
    (input.executionPolicy === "approval-gated" || input.executionPolicy === "auto-accept-edits")
  ) {
    // Auto-accepting edits inside the checkout says nothing about the network,
    // so it keeps exactly the egress approval-gated Code already has.
    return "provider-endpoints-only";
  }
  return "none";
}

/**
 * Map thread egress to the two-level OS Seatbelt permission.
 *
 * `provider-endpoints-only` becomes OS `allow` because Seatbelt cannot express
 * host allowlists; brokers enforce the host-level restriction.
 */
export function materializeOsNetworkEgress(policy: ThreadEgressPolicy): OsNetworkEgress {
  return policy === "none" ? "none" : "allow";
}

export function clampChildThreadEgressPolicy(
  input: ClampChildThreadEgressPolicyInput,
): ThreadEgressPolicy {
  if (!input.childNetworkAuthority) return "none";
  const requested = input.requested ?? input.parent;
  return EGRESS_RANK[requested] <= EGRESS_RANK[input.parent] ? requested : input.parent;
}
