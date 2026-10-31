import type { ProviderExecutionPolicy } from "@octant/contracts";

/**
 * Per-thread network egress policy for tool/provider Seatbelt launches.
 *
 * Thread-level policies are three-valued. Harness tool commands materialize
 * `provider-endpoints-only` as `proxied`, where the OS opens only a per-launch
 * egress proxy that checks every connection against the thread's host rules
 * (docs/architecture.md § Harness tool egress rules). A wrapped provider
 * runtime gets `proxied` too where the host routes runtimes through their own
 * proxy (`network/providerRuntimeNetwork.ts`, which decides by the
 * provider's endpoints, the Project's rules, and the person's safe
 * networks); where it does not, the runtime keeps `allow` from
 * `materializeOsNetworkEgress` below.
 *
 * Defaults:
 * - Plan / Chat → `none`
 * - Work or Code approval-gated / auto-accept-edits → `provider-endpoints-only`
 * - Full access / explicit network approval → `unrestricted`
 *
 * Provider-owned runtimes that make their own API call are a scoped
 * exception: every posture but Full access resolves
 * `provider-endpoints-only` through `resolveProviderRuntimeEgressPolicy`.
 * Tools keep these defaults, Plan included.
 */

export type ThreadEgressPolicy = "none" | "provider-endpoints-only" | "unrestricted";

/**
 * OS-materialized network permission for a confined launch. `proxied` opens
 * nothing but the launch's own egress proxy: on macOS its loopback port, on
 * Linux a Unix socket an in-capsule forwarder relays to.
 */
export type OsNetworkEgress = "none" | "allow" | ProxiedNetworkEgress;

export interface ProxiedNetworkEgress {
  readonly kind: "proxied";
  readonly endpoint: EgressProxyEndpoint;
}

export type EgressProxyEndpoint =
  | { readonly kind: "loopback"; readonly port: number }
  | { readonly kind: "unix-socket"; readonly path: string };

/** How a harness tool command reaches the network. */
export type HarnessToolNetwork = "none" | "proxied" | "allow";

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
    input.mode !== "chat" &&
    (input.executionPolicy === "approval-gated" || input.executionPolicy === "auto-accept-edits")
  ) {
    // Auto-accepting edits inside the checkout says nothing about the network,
    // so it keeps exactly the egress approval-gated Code already has. Work is
    // guarded as Code is, so its commands follow the same rules.
    return "provider-endpoints-only";
  }
  return "none";
}

/**
 * Map a provider runtime's egress to the two-level OS permission on a host
 * that does not route runtimes through their own proxy: there
 * `provider-endpoints-only` becomes OS `allow`. A routed launch takes
 * `proxied` from its runtime network instead.
 */
export function materializeOsNetworkEgress(policy: ThreadEgressPolicy): "none" | "allow" {
  return policy === "none" ? "none" : "allow";
}

/**
 * Map thread egress for a harness tool command. `provider-endpoints-only`
 * runs on `proxied`, so the command reaches only the hosts a rule names;
 * `unrestricted` keeps open network because the person accepted it.
 */
export function materializeHarnessToolNetwork(policy: ThreadEgressPolicy): HarnessToolNetwork {
  switch (policy) {
    case "none":
      return "none";
    case "provider-endpoints-only":
      return "proxied";
    case "unrestricted":
      return "allow";
  }
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
 * defaults would launch those agents with OS `none`, so the turn never
 * starts. This named policy is the scoped exception:
 * the runtime reaches provider endpoints on every posture including Plan, and
 * tools still follow the thread defaults, Plan included.
 *
 * Plan is not an exception here because the model call is not a Plan side
 * effect. Measured on macOS 27 against this builder's profile: `none` ends the
 * call with `fetch failed` and no connection, `allow` reaches
 * api.anthropic.com and returns its status. A Plan runtime on `none` therefore
 * cannot answer at all — it retries until the turn times out — while what Plan
 * actually withholds, writing to the checkout and executing a program off its list, is
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
