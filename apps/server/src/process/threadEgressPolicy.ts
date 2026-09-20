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
 *
 * Provider-owned runtimes that make their own API call are a scoped
 * exception (0132, extended by 0145): every posture but Full access resolves
 * `provider-endpoints-only` through `resolveProviderRuntimeEgressPolicy`.
 * Tools keep these defaults, Plan included.
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

/**
 * The egress a provider readiness probe may have.
 *
 * A probe is not a thread: it authenticates against the provider's own control
 * plane to read the model catalog before any thread exists. Resolving the
 * policy here instead of writing `allow` at the launch site keeps this one
 * exception named and in the same module as the thread defaults.
 */
export function resolveProbeEgressPolicy(): ThreadEgressPolicy {
  return "provider-endpoints-only";
}

/**
 * The egress a provider runtime may have when it carries a turn.
 *
 * ACP, Pi, OpenCode, and Claude call their own control plane. The thread
 * defaults in 0009 would launch those agents with OS `none`, so the turn never
 * starts. This named policy is the scoped exception (0132, extended by 0145):
 * the runtime reaches provider endpoints on every posture including Plan, and
 * tools still follow the thread defaults, Plan included.
 *
 * Plan is not an exception here because the model call is not a Plan side
 * effect. Measured on macOS 27 against this builder's profile: `none` ends the
 * call with `fetch failed` and no connection, `allow` reaches
 * api.anthropic.com and returns its status. A Plan runtime on `none` therefore
 * cannot answer at all — it retries until the turn times out — while what Plan
 * actually withholds, writing to the checkout and executing a process, is
 * withheld by the filesystem and process rules rather than by this one.
 */
export function resolveProviderRuntimeEgressPolicy(
  input: ResolveDefaultThreadEgressPolicyInput,
): ThreadEgressPolicy {
  if (input.explicitNetworkApproval === true || input.executionPolicy === "full-access") {
    return "unrestricted";
  }
  return "provider-endpoints-only";
}

export function clampChildThreadEgressPolicy(
  input: ClampChildThreadEgressPolicyInput,
): ThreadEgressPolicy {
  if (!input.childNetworkAuthority) return "none";
  const requested = input.requested ?? input.parent;
  return EGRESS_RANK[requested] <= EGRESS_RANK[input.parent] ? requested : input.parent;
}
