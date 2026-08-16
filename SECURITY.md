# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/Ogard-Labs/octant/security/advisories/new)
on this repository. Do not open a public issue, discussion, or pull request
for a suspected vulnerability.

Include what you can: affected version or commit, macOS version, the provider
or feature involved, reproduction steps, and the impact you believe it has.
Never include real credentials or tokens in a report.

## What to expect

- The maintainers will acknowledge your report and keep you informed as it is
  triaged and fixed.
- Octant is a volunteer-maintained technical preview. There is no bug bounty
  and no guaranteed response time, but reports are taken seriously.
- We will credit you in the fix or advisory unless you prefer otherwise.
- Once a fix is available, we will publish an advisory. Please give us a
  reasonable window before public disclosure.

## Scope

In scope:

- The desktop app (`apps/desktop`) and the shared renderer (`apps/web`).
- The local server (`apps/server`), which listens on loopback by default.
- Authenticated remote access, pairing, device keys, and revocation when the
  user enables the private listener (LAN or Tailscale).
- Provider credential handling, the Keychain broker, and provider drivers.
- Extension and skill installation, quarantine, trust, and activation.
- The Expo remote-control client (`apps/mobile`).

Out of scope: vulnerabilities in third-party providers, models, CLIs, or
services that Octant talks to; issues that require an attacker to already have
local user-level code execution on the host; and findings in unmerged
branches.

## Security model in brief

- **Local-first.** Projects, threads, memory, events, and layouts stay on the
  host. There is no telemetry, analytics, or crash reporting, and no cloud
  dependency by default. Network traffic is limited to the providers you
  configure and remote access you enable.
- **Server-side authority.** Chat, Work, and Code are enforced by the server
  before any side effect; the renderer never grants itself capability. Chat
  Projects have no filesystem or shell authority. Work binds one confined
  folder. Code binds one repository root and starts approval-gated; Plan mode
  is read-only.
- **Approvals.** Tool calls, promotions from Work to Code, pairing, and
  extension installs require explicit user approval on the host, not only in
  the renderer.
- **Extensions.** Installation never implies trust or activation. Packages
  are quarantined, disabled by default, contribute no context while disabled,
  and remain subject to sandbox and approval policy when enabled.
- **Credentials.** Provider secrets live in the macOS Keychain and are
  resolved by the desktop broker. They are never written to the event journal
  or returned to the renderer.
- **Remote clients** never exceed the host's mode, provider, Project, or
  thread authority. Pairing tickets are single-use and short-lived; sessions
  and device registrations expire and can be revoked.

The full threat model lives in `docs/security/`.
