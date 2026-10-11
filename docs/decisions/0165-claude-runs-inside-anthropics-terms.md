# 0165. Claude runs inside Anthropic's terms

**Status:** Proposed

This record is a product decision, not legal advice.

## Context

Anthropic's Claude Code "Legal and compliance" page (fetched 10 Oct 2026,
<https://code.claude.com/docs/en/legal-and-compliance>) is the source of
truth for how a product may run Claude Code:

- "OAuth authentication is intended exclusively for purchasers of Claude
  Free, Pro, Max, Team, and Enterprise subscription plans and is designed
  to support ordinary use of Claude Code and other native Anthropic
  applications."
- "Developers building products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key
  authentication through Claude Console or a supported cloud provider.
  Anthropic does not permit third-party developers to offer Claude.ai
  login into their own applications, or to route requests through Free,
  Pro, or Max plan credentials on behalf of their users. Moreover,
  developers may not collect, store, or intermediate Claude.ai
  credentials or session tokens — sign-in to a Claude account must
  complete through Anthropic's own flow."
- "Nor does it prevent an end user from signing in to the unmodified
  Claude Code binary with their own Claude subscription."
- "Advertised usage limits for Pro and Max plans assume ordinary,
  individual usage of Claude Code and the Agent SDK."
- Customers who offer Claude Code in a product must keep the binary
  unmodified, must not remove an authentication method built into it, and
  must not pay for, resell, or intermediate Claude usage on an end user's
  behalf.

The Consumer Terms (section 3, item 7, fetched 10 Oct 2026) forbid
automated access except through an Anthropic API key or where Anthropic
explicitly permits it: "Except when you are accessing our Services via an
Anthropic API Key or where we otherwise explicitly permit it, to access
the Services through automated or non-human means, whether through a bot,
script, or otherwise."

The Agent SDK Quickstart and Overview repeat the login rule: "Unless
previously approved, Anthropic does not allow third party developers to
offer claude.ai login or rate limits for their products, including agents
built on the Claude Agent SDK."

Octant drives the installed `claude` binary through
`@anthropic-ai/claude-agent-sdk`. Subscription mode uses the person's own
CLI login; API-key mode sets `ANTHROPIC_API_KEY`. That main path matches
the unmodified-binary permission above.

It diverges at **Connect Claude for helpers**. A confined Plan or
subagent launch cannot reach the macOS Keychain the runtime uses for
subscription sign-in. Octant runs `claude setup-token`, scrapes the
printed OAuth token, stores it in the credential broker, and injects it
as `CLAUDE_CODE_OAUTH_TOKEN`. That path landed in #1058 (7 Oct 2026)
without its own record. It contradicts 0005 ("Octant never reads, stores,
renders, refreshes, exports, or journals OAuth tokens") and 0111
(Anthropic excluded from host-driven subscription OAuth "per vendor
prohibition"). It is the clearest conflict with "may not collect, store,
or intermediate Claude.ai credentials or session tokens."

0005 already disables provider telemetry where a runtime documents a
switch. Every Claude launch sets `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
Those are documented Claude Code switches. They are also the pattern
Anthropic cited in February 2026 when it objected to third-party
harnesses on subscription credentials that produced traffic without the
usual Claude Code telemetry. The risk is real on subscription launches;
it is ordinary product hygiene on an API-key launch.

Anthropic's Authentication page documents the replacement this record
chooses. `CLAUDE_CONFIG_DIR` is the supported way to give an account its
own settings, session history, and claude.ai login. On Linux and Windows
the login file lives under that directory. On macOS the login is stored
in the Keychain, keyed to that directory, and written to
`.credentials.json` under it only when the Keychain rejects the write.
Whether a confined launch that can read that directory, and cannot run
`/usr/bin/security`, still signs in is a must-verify on macOS.

## Decision

- **Octant never collects, stores, scrapes, or forwards Claude.ai OAuth
  or setup tokens.** It does not run `claude setup-token` to capture
  output, does not keep `CLAUDE_CODE_OAUTH_TOKEN` in the credential
  broker, and does not set that variable from Octant storage. Sign-in to
  a Claude account completes through Anthropic's own flow in the
  unmodified `claude` binary. Claude itself stores and refreshes what it
  stores.
- **The main path is the person's own Claude Code installation.** They
  sign in with their own subscription or their own API key through the
  unmodified `claude` binary. Octant launches that binary. It does not
  offer Claude.ai login as an Octant feature and does not route
  subscription credentials on anyone's behalf.
- **Confined launches stay on that same sign-in.** Each Claude account
  has a Claude-owned config directory (`CLAUDE_CONFIG_DIR`, and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` when that directory is distinct). The
  sandbox grants that launch narrowly scoped access to exactly those
  directories. The unmodified binary reads its own login there. Octant
  never reads, copies, or injects the credential. **Must-verify on
  macOS:** when those variables are set, does `claude` store the login in
  a file under the config directory, or only as a Keychain entry keyed
  to it, and what minimum sandbox access does the binary need to sign
  in without `/usr/bin/security` and without the Keychain file? If that
  verification shows the config-directory path cannot work, that
  instance switches to API-key authentication for every launch. Mixed
  CLI-plus-API-key is not available.
- **Several Claude accounts are allowed, later, on this same
  mechanism.** Each account has its own Claude-owned config directory.
  The person signs in once per account with unmodified
  `claude auth login`. Each thread is pinned to the account it
  started with; the person picks the account explicitly. Automatic
  failover, rotation between accounts when a usage limit is hit,
  load-balancing across subscriptions, and any pooling of
  subscriptions to get around limits are refused.
- **The native harness is an optional alternative, not the default.**
  People who want Claude on the native harness use an Anthropic API key
  on an Anthropic-compatible HTTP endpoint. Billing goes to the key
  owner. Claude subscription OAuth is never offered on the native
  harness or on Anthropic-compatible HTTP endpoints. 0111's Anthropic
  exclusion stands and this record extends it to that surface.
- **Subscription launches of the unmodified binary leave Claude's own
  telemetry, error reporting, and essential traffic intact.** Octant
  does not set `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, or
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` on those launches. Process
  ownership switches (auto-update, marketplace autoinstall, built-in
  agents, auto memory) stay off. API-key launches may keep the 0005
  telemetry guards.
- **Naming.** Octant may say, in plain text, that it runs Claude Code.
  It does not use the Claude Code or Anthropic names or logos as a
  product, feature, or company name, in its own logo, or in a way that
  suggests Anthropic built, endorses, or is partnered with Octant.
  "Connect Claude for helpers" is retired as an Octant feature name. The
  bundled Claude mark in 0095 remains a residual review against
  Anthropic's Trademark Guidelines.

0005 stays Accepted. This record restores its never-store rule for
Claude and retires the helper-token exception #1058 introduced. 0111
stays Proposed; its Anthropic exclusion is confirmed and extended as
above. No earlier record authorized the helper token.

## Consequences

- Confined Plan and subagent launches keep working on the person's
  subscription only if the macOS must-verify succeeds. If it fails, that
  instance switches to an Anthropic API key for every launch until a
  later change finds a Claude-owned storage path that does not require
  Octant to hold a token.
- Settings loses **Connect Claude for helpers**. Stored helper tokens
  are deleted from the broker, and the person is told to revoke them
  with Anthropic. A test or lint refuses any Octant path that sets
  `CLAUDE_CODE_OAUTH_TOKEN` from Octant storage.
- Several Claude accounts may land later on the same config-directory
  mechanism. They are not part of the helper-token remediation.
- User-facing copy stops presenting Claude login as an Octant-owned
  connect step.

## Related

- 0005 Provider SDK contract (never-store rule restored for Claude)
- 0111 Host-driven provider OAuth (Anthropic exclusion confirmed)
- 0095 Bundled provider logo marks (residual trademark review)
- 0102 Local provider usage history (local files only; unchanged)
- 0122 / 0132 Provider readiness and runtime egress (probes still launch
  the unmodified binary; they do not take a helper token)
- 0145 A Plan turn is confined by Octant (config-directory grant replaces
  the helper token)
- [Remediation plan](../plans/claude-inside-anthropics-terms.md)
