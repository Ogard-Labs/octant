# 0112. First-run Claude Code and Codex CLI enablement

**Status:** Accepted

## Context

0005 says discovery may auto-register a **disabled** instance for a detected
installed runtime, and that enablement and authority remain explicit and
fail-closed. That keeps every backend opt-in: detection is not trust, and a
row in Settings is not a ready provider.

On a fresh host the rule leaves the composer unusable even when Claude Code
or Codex CLI is already installed and authenticated. First run reports every
detected runtime off. Starting a thread then means finding Settings, then
Providers & Models, then a per-provider switch, before the product has done
anything. Other runtimes should stay opt-in; those two are the defaults a
first run should be able to start with when they are already on the machine.

## Decision

- 0005 remains Accepted. This record supersedes only the rule that discovery
  auto-registration always creates a **disabled** instance. Remaining 0005
  rules stand, including: Octant never installs or updates provider runtimes;
  install is not trust and not enablement for extensions; authentication stays
  provider-native with no silent API-key fallback; enablement of every runtime
  other than the two named here stays explicit and fail-closed.
- On first run only, auto-registering a detected `claude` or `codex` driver
  kind creates that instance **enabled**. When both are detected, both are
  created enabled. The existing readiness order still picks the default for
  new threads; this record does not invent a ranking.
- Every other detected driver kind still auto-registers disabled and requires
  an explicit switch.
- Eligibility is decided once per scan from durable host state, not from "the
  registry happens to be empty." The scan is eligible only while
  `firstRunOnboarding` is `pending` and no provider instance of any driver has
  already been recorded. After onboarding is completed or skipped, later
  auto-registers stay disabled even if the user deleted every provider.
  Candidates in the same eligible scan share that decision, so both supported
  defaults can enable together.
- Auto-register never toggles an existing instance. A user who disables Claude
  Code or Codex CLI keeps it disabled across rediscovery, restart, and
  upgrade. An instance already present for that driver family is neither
  created again nor enabled.
- Enabled is not ready. Detection does not assert authentication,
  reachability, or compatibility. An enabled-but-unauthenticated CLI reports
  needs-setup / `unauthenticated`, never `ready`.
- A machine with neither runtime installed keeps the existing empty-state
  path. First run still says which of those two it turned on.
- This is host discovery, not a remote credential change. Remote clients
  cannot exceed host, mode, provider, Project, or thread authority.

## Consequences

- A fresh Mac with Claude Code or Codex CLI already installed can start a
  thread from first run without visiting Settings. The user can turn that
  instance off afterwards, and later scans will not turn it back on.
- Hosts that have already answered first run, or that already recorded a
  provider choice, do not gain a newly enabled Claude or Codex instance from
  this policy.
- Other detected CLIs continue to appear off until enabled. The setup surface
  names Claude Code and Codex CLI when first run turns them on, so enablement
  is not silent.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0019 User profile and first-run setup
- 0033 First run asks what to call you
