# 0102. Local provider usage history

**Status:** Proposed

## Context

Octant's attributed usage ledger describes activity recorded by Octant. People
also use the same providers in other applications and need to understand that
history alongside their current account limits. Adding those numbers to the
Octant ledger would count overlapping activity twice and would incorrectly
assign external activity to Octant Projects and threads.

Local provider logs contain both accounting facts and private conversation
content. A history reader must extract only accounting fields and must not turn
opening Usage into credential discovery, provider execution, or a network call.
Subscription limits, token totals, API-equivalent estimates, and actual charges
are different measurements.

## Decision

- Add a local history read capability through the published provider SDK. An
  installed provider adapter may implement it without reaching into host
  internals. The host calls the capability without acquiring a model session
  or starting the provider process.
- Opening or refreshing local provider history reads only bounded, recognized
  usage files under the adapter's documented history roots. It does not read
  provider configuration, credentials, cookies, Keychain entries, or arbitrary
  renderer-supplied paths. Symlinks cannot escape those roots. A missing or
  unsupported source is reported explicitly.
- Parsers consume files incrementally with limits on files, bytes, record size,
  and work per request. They project recognized accounting facts immediately;
  prompts, messages, tool arguments, account identities, and raw records are
  never persisted, returned, logged, or attached to provider context. Oversized
  or malformed input makes coverage partial instead of producing a false zero.
- Records retain opaque source-installation, session, and event identities.
  Repeated reads, copied files, cumulative counters, and multiple configured
  instances must not multiply the same event. Each adapter defines and tests
  its event identity and cumulative-counter semantics.
- Normalize input tokens to processed input including cache reads and cache
  writes. Retain uncached input and cache dimensions separately when known.
  Output includes reasoning when the provider's output count includes it;
  reasoning is never added a second time. Missing component measurements stay
  unknown even when a processed total is known.
- Monetary facts require a source. Provider-recorded cost and API-equivalent
  estimates carry different labels; neither is described as a subscription
  invoice. Unknown pricing is unavailable, never zero. Totals disclose unpriced
  records and do not silently combine currencies or incompatible cost kinds.
- Local provider history and Octant-attributed usage remain separate sources in
  the Usage destination. A local history source may include Octant activity if
  the provider logged it, but the two totals are not added. The UI names the
  source, coverage, read time, and any truncation.
- The host aggregates totals, provider/model breakdowns, and daily series for an
  explicit range and viewing timezone. A local authenticated Usage endpoint
  returns those bounded aggregates. External history is not exposed through
  model tools or to remote clients merely because they can read one Project.
- Quota windows remain a separate provider-reported snapshot. Display remaining
  percentages and reset countdowns only from observed facts. After a reset,
  await a fresh reading; do not assume a refill. A source may provide useful
  token history while providing no account quota information.
- Start with formats whose accounting semantics can be validated against
  primary sources and synthetic fixtures. Additional adapters follow the same
  seam and evidence requirements. OpenUsage and other applications are design
  references, not installation dependencies.

## Consequences

- People can inspect provider history from outside Octant without changing its
  thread ledger or granting a model additional access.
- The same Usage interface can compare available sources while exposing gaps
  honestly. This is not a claim that local logs cover every device or all
  account billing.
- This change does not implement spend-ceiling enforcement, account/admin
  reporting, credential import, remote history sharing, or pricing guesses.
- Verification covers repeat reads, cumulative events, copied files, malformed
  and oversized records, cache normalization, timezones, local-only authority,
  and absence of conversation or credential fields from responses.

## Related

- [0008 Context budget and capacity](0008-context-budget-and-capacity.md)
- [0001 Plugin architecture](0001-plugin-architecture.md)
- [0060 Usage spend ceilings](0060-usage-spend-ceilings.md)
