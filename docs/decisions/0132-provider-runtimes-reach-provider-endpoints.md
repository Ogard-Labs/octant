# 0132. Provider runtimes reach provider endpoints on Chat and Work turns

**Status:** Accepted

## Context

0009 resolves per-thread network egress as none for Chat, Work, and Plan,
provider-endpoints-only for approval-gated Code, and unrestricted for Full
access or an explicit network approval. 0122 already carved a named exception
for a readiness probe, which is why a Chat picker can show a provider as Ready.

ACP, Pi, and OpenCode provider processes make their own HTTPS calls. Codex and
Claude do not consult the thread policy, so Chat and Work appear to work for
those two families. For everyone else the same Chat or Work turn launches the
agent with OS none, the model call retries until it times out, and the surface
reports a generic unavailable failure. The explicit-network-approval input
exists on the policy and has no caller, so nothing in the product can grant
the missing egress.

The thread policy is still the right answer for tools (browser, shell, Git).
It is the wrong answer for the provider runtime that has to reach its own
control plane to produce a turn.

## Decision

- A provider runtime process that carries a turn resolves
  provider-endpoints-only through resolveProviderRuntimeEgressPolicy in the
  egress policy module, for Chat, Work, and Code, unless the thread is Full
  access or has an explicit network approval (unrestricted) or is Plan (none).
  This is a scoped exception to one rule of 0009: that Chat and Work turns
  resolve none.
- The exception applies only to the provider-owned process (ACP, Pi, OpenCode
  and any future runtime that makes its own API call). Octant-owned tools keep
  the thread policy, including none for Chat, Work, and Plan.
- The policy materializes as OS allow because Seatbelt enforcement is
  two-level in V1 and Octant-owned brokers do not wrap provider-owned
  processes (0009). The runtime is not granted unrestricted in the policy
  vocabulary.
- A probe keeps 0122's resolveProbeEgressPolicy. Plan stays none for the
  runtime as well as for tools: Plan is read-only at the sandbox, and a Plan
  turn that needs the network is a Full-access or Code approval-gated
  question, not this exception.
- Every remaining rule of 0009 stands unchanged, including child clamping,
  two-level OS materialization, and the approval requirements for
  unrestricted thread access.

## Consequences

- Chat and Work turns can complete for a provider whose agent calls its own
  API, on the same OS permission a Code turn already had.
- The exception is one named policy in one module rather than a literal at
  each launch site, so a future egress change cannot silently widen it.
- Plan and tool launches are unchanged; a Work document thread still cannot
  browse or shell without a separate grant.

## Related

- 0006 ACP agent drivers
- 0009 Sandbox confinement and approvals (one rule superseded in scope)
- 0122 Provider readiness probes reach provider endpoints
- 0144 A Plan turn is confined by Octant (one rule superseded)
