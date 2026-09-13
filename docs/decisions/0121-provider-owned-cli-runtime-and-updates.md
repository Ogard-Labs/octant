# 0121. Provider-owned CLI runtimes, profiles, and updates

**Status:** Accepted

## Context

Octant currently launches the configured provider executable, but several ACP
profiles redirect the CLI into an Octant-managed home and expose a second
browser-authentication path. That makes a CLI login appear to be missing,
breaks headless operation, and can make settings imply that Octant owns a
provider credential. A provider CLI also owns its installation and update
mechanism; Octant must not become a second package manager by copying or
bundling another binary.

## Decision

- A configured provider CLI is always the provider-owned executable at its
  stored absolute path. Octant never copies, downloads, replaces, or bundles a
  duplicate provider binary.
- Provider-owned authentication is the default for CLI providers. The process
  receives the provider's documented host profile location (for example
  `~/.vibe`, `~/.grok`, `~/.gemini`, `~/.cline/data`, or `~/.qwen`) through the
  provider's environment variable or data-root convention. Octant stores no
  provider token and does not require a second browser login.
- Explicit API-key mode remains available only where the provider contract
  supports it. It is an opt-in credential-broker path, not a replacement for
  the provider's CLI login.
- Reusing a host profile does not remove Octant's process boundary. Project
  roots, managed temporary state, network policy, tool callbacks, approvals,
  and the existing Seatbelt/Bubblewrap confinement remain app-managed. Only
  the narrowly allowlisted provider profile paths are exposed to the process.
- CLI updates are explicit host-local actions. A profile may expose a
  provider-documented update subcommand; Octant runs that command against the
  same configured binary only when no active session is using it, then
  re-probes the resulting version. The user must stop active sessions first.
  Providers without a verified update command report the action as unsupported.
  Octant never silently updates a CLI.
- This is a scoped exception to the no-update rule in 0005 and its first-run
  restatement in 0112: discovery still never installs or automatically updates
  a runtime, but an explicit user action may invoke a verified provider-owned
  updater. It also supersedes 0057's Kimi-specific immutable-profile bullet;
  the remaining Bubblewrap and Seatbelt confinement rules still stand.
- This supersedes only 0006's allowance for a managed profile to hold
  provider-native authentication state. The generic ACP driver, protocol,
  capability, and authority rules in 0006 remain accepted.
- Headless hosts use the provider's non-interactive/device login when the CLI
  supports one. Desktop browser OAuth is not an architectural prerequisite for
  an ACP provider.
- The generic ACP browser-auth command remains a reserved capability for a
  future provider that explicitly advertises delegated browser authentication;
  no shipped CLI profile uses it, and provider settings must not present it as
  the login path for a native CLI.

## Consequences

- A successful `provider login` in the user's terminal is the login Octant
  uses, so provider activation no longer depends on an app-specific browser
  flow or duplicated credential state.
- Updating a CLI may require the host account to have write permission to its
  installation directory and may be unavailable for system-managed installs.
- A provider's own profile can contain provider-owned settings; ACP command
  inventory and Octant's process authority checks still fail closed when those
  settings advertise unsupported or unsafe capabilities.

## Related

- 0005 Provider SDK contract
- 0006 ACP agent drivers (superseded for managed-profile authentication)
- 0009 Sandbox confinement and approvals
- 0054 Headless host credential store
- 0057 Linux confinement uses Bubblewrap
