# 0122. Provider readiness probes reach provider endpoints

**Status:** Accepted

## Context

A provider readiness probe runs before any Chat, Work, or Code thread exists:
it authenticates the configured provider binary and reads the model catalog so a
picker can offer real models. For OpenCode 2 that read is an HTTP request to the
provider's own control plane (0097).

0009 resolves network egress from the thread's mode, execution policy, and an
explicit network approval. A probe has no thread, and the closest fit — Chat,
approval-gated — resolves `none`. A probe started under that rule reaches
nothing and reports an empty catalog, which is truthful but useless.

## Decision

- A provider readiness probe (`purpose: "probe"`) resolves the named policy
  `provider-endpoints-only` through `resolveProbeEgressPolicy` in the egress
  policy module. This is a scoped exception to one rule of 0009: that
  `unrestricted` egress requires Full access or an explicit network approval.
  The exception applies only to the non-mutating readiness check.
- The policy materializes as the OS `allow` value because Seatbelt enforcement
  is two-level in V1 and the finer host allowlist is enforced by Octant-owned
  brokered tools, which do not wrap provider-owned processes (0009). The probe
  is not granted `unrestricted` in the policy vocabulary.
- A probe keeps the non-thread confinement it already had: it launches in
  chat-mode confinement with no bound-root writes and no process exec or fork,
  writes only within the managed home and its temporary directory, and receives
  an allowlist-sanitized environment. It discovers models; it never carries a
  turn.
- Every remaining rule of 0009 stands unchanged, including per-thread egress
  for turns, the two-level OS materialization, and the approval requirements
  for `unrestricted` thread access.

## Consequences

- Provider discovery can authenticate and report the provider's real catalog on
  hosts where a Chat or Plan thread would be denied the network.
- The exception is one named policy in one module rather than a literal at a
  launch site, so a future egress change cannot silently widen it.
- A provider binary that ignores its documented read-only behavior still runs
  without a bound root or child-process authority; only the network reaches it.

## Related

- 0006 ACP agent drivers
- 0009 Sandbox confinement and approvals (one rule superseded in scope)
- 0097 OpenCode 2 uses HTTP discovery and ACP turns
