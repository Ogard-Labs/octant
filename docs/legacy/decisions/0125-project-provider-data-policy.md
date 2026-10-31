# 0125. Projects may restrict providers by residency labels

**Status:** Accepted

## Context

Provider discovery and model catalogs tell Octant what is installed and what a
runtime reports. They do not, by themselves, tell a person whether a provider
is acceptable for a particular Work or Code Project. A Project may need a
simple, reviewable boundary such as EU processing or zero data retention
(ZDR), while another Project may permit every configured provider.

The boundary must also hold after a thread is created. A Project policy can
change while a thread is open, so checking only the model picker or thread
creation would allow a later follow-up to bypass the new restriction.

## Decision

- Provider instances and individual models may carry user-maintained `eu` and
  `zdr` labels. Labels are metadata for local policy; they are not a vendor
  guarantee or an assertion that Octant independently verified data residency
  or retention.
- Bound Work and Code Projects have an optional provider policy. Missing policy
  is equivalent to **Allow all providers** for backwards compatibility.
- The policy has three modes: **all**, **eu-zdr** (a provider or its selected
  model must have an `eu` or `zdr` label), and **whitelist** (the provider
  instance must be explicitly listed). Chat Projects do not use this boundary.
- The server is authoritative. It checks the policy before Work/Code thread
  creation, provider/model handoff, and every provider turn, including a
  follow-up on an existing thread. A failed check is an actionable
  unauthorized result and no provider side effect is started.
- Settings provide the convenience editor for provider/model labels and each
  Project page exposes the three policy modes and its provider whitelist.
  Renderer filtering is advisory only; it cannot grant access that the server
  refused.
- Discovery state and policy labels are independent. A provider that is not
  installed or otherwise unavailable remains unable to start a turn even when
  it is whitelisted or labeled.

## Consequences

The policy survives catalog probes and is included in Project summaries, so all
windows render the same choice. A provider or model can be hidden from pickers
without changing policy, and a policy change immediately affects open threads
on their next turn. Because labels are explicitly user-maintained, the UI must
keep the distinction between a label and independently verified compliance
visible in its help text.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0007 Direct API providers and the native agent harness
