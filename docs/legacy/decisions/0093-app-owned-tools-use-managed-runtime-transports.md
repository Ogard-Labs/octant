# 0093. App-owned tools use managed runtime transports

**Status:** Accepted

## Context

The host owns browser tools and their policy, but a managed provider runtime
cannot invoke them unless its adapter exposes the offered tool catalogue.
A visible Browser tab therefore did not establish that the running agent
could use it. The Code tool adapter also required Full access for every
browser operation, even when a narrower isolated session was sufficient.

## Decision

- A managed provider adapter may expose the exact app-authored catalogue
  through its runtime's structured tool-call protocol or an in-process tool
  server owned by that provider connection. The latter is a narrow exception
  to 0006's disabled provider-native tool-server rule.
  User, Project, plugin, external-process, and remote tool-server configuration
  remain disabled. Installing or discovering a server never grants authority.
- Calls and results cross the existing provider SDK tool-request/answer
  contract. Adapters do not call host browser, terminal, filesystem, or
  approval services directly. The host's existing tool policy remains the
  authority before every effect.
- Tool definitions own their usage guidance and argument schemas. Adapters
  preserve both for the exact offered catalogue; unavailable tools contribute
  no guidance. Detailed schema discovery can use a read-only operation on an
  already offered tool, as Canvas does for its closed block catalogue. This
  introduces no separate global MCP registration or additional authority.
- The connection binds the tool catalogue before sending its prompt. Only
  the expected in-process server and its offered tool names are accepted
  during runtime attestation. Changing a catalogue cannot overlap a running
  tool-enabled turn. Late, duplicate, or cancelled answers are refused.
  Per-request transport cancellation reaches the executor even while it waits
  for approval; a late approval cannot start an expired request.
- The Codex app-server adapter opts into its experimental API capability during
  initialize because `thread/start.dynamicTools` is rejected without that
  negotiation. The adapter uses no other experimental methods or fields.
- An approval-gated Code thread can request one isolated browser session.
  The request names its allowed origin and uses the thread's existing inline
  approval surface. It grants no shell, filesystem, or general network access
  and never changes the thread's access posture.
- An accepted browser grant is held only for that host process and is bound
  to the window, thread, checkout, provider, model, and browser context. Stop,
  expiry, a changed owner, cancellation, or a new context cannot reuse it.
  Plan mode refuses browser effects. Stopping an owned browser remains possible.
- Browser origin allowlists, credential-field protection, and authority checks
  still run in the browser service. Approval does not bypass them. Other Code
  host tools retain their existing access requirements.

## Consequences

A provider can use the same isolated browser that its thread displays while
remaining approval-gated. Providers without a verified tool transport continue
to report that capability as unsupported. App-owned tool results remain bounded,
untrusted data. No external server, credential, or persistent trust setting is
introduced by the bridge.

## Related

- 0005 Provider SDK contract and honest capabilities
- 0006 Managed provider isolation
- 0009 Sandbox confinement and approvals
- 0044 Thread-owned dock tools
