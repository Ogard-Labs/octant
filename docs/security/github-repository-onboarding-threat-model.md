# GitHub Repository Onboarding Threat Model

**Status:** Proposed for Henrik review

**Date:** 2026-08-07

**Scope:** Host-scoped GitHub authentication, normalized reads, managed clone, and Code Project binding

**Design:** [`../specs/2026-08-07-host-scoped-github-repository-onboarding-design.md`](../specs/2026-08-07-host-scoped-github-repository-onboarding-design.md)

## Overview

Octant is a local-first, server-authoritative workspace. This feature lets one macOS or Linux
host use its installed, authenticated GitHub CLI to discover accessible repositories, read bounded
metadata, and clone one user-confirmed repository into a managed inventory before binding it as an
ordinary Code Project.

The high-value assets are the host's GitHub authorization, private repository contents, managed
repository inventory, Code Project authority, local paths, normalized GitHub metadata, and the
integrity of clone/recovery receipts. A compromise that exposes a token, clones an unapproved
repository, writes outside the inventory, binds the wrong repository, or grants an agent broader
GitHub visibility violates the product's core security model.

## Threat Model, Trust Boundaries, and Assumptions

### Actors and controlled inputs

- **Host user:** controls the `gh` installation, active GitHub account, credential store, inventory
  setting, repository choice, and explicit approvals.
- **Authenticated client:** may be the local desktop renderer or a paired browser. It controls
  request timing, searches, cursors, and requested actions but never becomes the authority owner.
- **Provider/agent:** controls prompts and app-managed tool inputs within current host, mode,
  Project, thread, and approval policy. It is not trusted with credentials or arbitrary repository
  discovery.
- **GitHub and network:** return attacker-influenced names, descriptions, branches, API errors,
  pagination, clone content, redirects, and transport failures.
- **Repository content:** is untrusted after clone. Git configuration, attributes, hooks, submodules,
  filenames, symlinks, and working-tree content may be malicious.
- **Local attacker:** may race filesystem paths or replace directories when they already possess
  access as the same host user. Octant still prevents accidental authority expansion and detects
  identity changes, but cannot defend secrets from a fully compromised user account or kernel.

### Trust boundaries

1. Renderer or remote client to authenticated Octant server routes.
2. Provider/agent tool calls to server-side capability and repository policy.
3. Server to the installed `gh` process and operating-system credential store.
4. Server and `gh`/Git to GitHub over the network.
5. Clone process to the managed inventory filesystem.
6. Verified checkout to Code Project binding and later Code tools.
7. One host to another host in a multi-host client; credentials and mutable state never cross.

### Assumptions and invariants

- The host operating system, `gh` binary selected through an allowlisted executable resolution, and
  credential-store implementation are trusted components. Unknown versions or storage modes fail
  closed.
- TLS and GitHub's service identity are relied upon; Octant does not add a proxy or certificate
  bypass.
- Octant never reads a token value or accepts a token field. It strips ambient token variables
  and rejects external-token precedence.
- Every effect is reauthorized on the owning host. Renderer state and stale catalogue data cannot
  authorize clone or Project binding.
- One Code Project binds one verified local repository identity and one optional GitHub repository
  identity. Names and paths alone are never identity.
- Full compromise of the host user or GitHub account is outside the containment guarantee, but the
  product must not amplify that compromise across hosts or expose credentials to providers/clients.

## Attack Surface, Mitigations, and Attacker Stories

### Credential disclosure or substitution

**Stories:** A malicious client asks for raw `gh` output; an error contains an Authorization header;
an ambient `GH_TOKEN` silently selects a different account; Linux `gh` falls back to plaintext; a
provider triggers authentication or scope refresh; a child process inherits Octant broker or
provider secrets.

**Controls:** strict command/field allowlists; no token-producing commands; secure-store proof;
external-token and plaintext-storage rejection; exact account/host binding; sanitized child
environments; bounded structured decoders; central redaction; no raw stdout, stderr, paths, or
environment in contracts/events; user-only setup and scope refresh.

### Confused-deputy GitHub access

**Stories:** A Chat agent enumerates private repositories; a Code agent changes owner/repository in
a tool call; a paired browser queries another Project's repository; a stale scope or catalogue page
is treated as authorization; an organization repository is exposed despite missing SSO approval.

**Controls:** authenticated principal plus host/mode/Project/thread checks on every route and tool;
Project-fixed repository identity for agent reads; no raw API proxy; per-operation capability
probes; opaque cursors; bounded outputs; stale read-only state; server-side rejection of repository
or host mismatch.

### Filesystem escape and destination races

**Stories:** owner/name contains traversal; a symlink swaps the inventory or destination; a
case-insensitive collision targets another directory; a partial clone is adopted as valid; a
malicious pre-existing directory is overwritten; a restart loses ownership and deletes user data.

**Controls:** server-derived path segments; canonical component walks; no arbitrary destination;
exclusive repository/destination reservation; same-filesystem staging; no overwrite or automatic
cleanup of unknown content; ownership receipts before mutation; identity revalidation before and
after atomic rename; explicit recovery states; quarantine instead of destructive repair.

### Clone transport and repository identity confusion

**Stories:** a crafted URL embeds credentials; a redirect or renamed repository yields the wrong
origin; a fork with the same name is bound; Git configuration changes credential helpers; a bare or
submodule checkout is accepted; default branch changes during clone.

**Controls:** `owner/name` selected from a fresh normalized GitHub node identity; fixed GitHub host;
non-HTTPS `gh` protocol rejected before clone; shell disabled; no URL supplied by the client;
`--no-checkout` plus an Octant-owned empty template directory and suppressed ambient Git config;
origin URL normalization rejects userinfo, query, and unexpected hosts; post-clone fresh
node-identity observation; canonical Git common/object identity; bare and submodule-root refusal;
explicit empty-repository/default-branch outcomes. Repository content is not materialized until
identity verification passes, then only through a hardened checkout of the verified object with
hooks, optional filesystem monitors, and submodule initialization disabled.

### Process, cancellation, and recovery abuse

**Stories:** clone hangs or floods output; cancellation leaves a credentialed process; duplicate
requests clone twice; restart reports success without verification; a process continues after its
client disconnects; malicious progress text injects secrets or terminal escapes.

**Controls:** server-owned process group; fixed timeout and output bounds; terminal-control stripping
and redaction; durable lifecycle/ownership receipt; idempotent request IDs; destination locks;
explicit cancellation and forced tree cleanup; restart reconciliation that never restarts work;
success only after post-promotion identity verification.

### Untrusted repository content after clone

**Stories:** hooks, submodules, attributes, symlinks, filenames, or project scripts execute during
verification or immediately gain Code authority; a cloned repository attempts to escape later Code
file/terminal boundaries.

**Controls:** clone verification runs no repository code or hooks; submodule initialization is not
automatic; Project binding grants only the ordinary approval-gated Code posture; existing file,
terminal, Git, test, provider, extension, and tool policies remain in force; Plan stays read-only;
executable actions require their normal approvals.

### Revocation, rate limit, and partial failure

**Stories:** local logout is presented as OAuth revocation; a revoked credential leaves cached
private data actionable; rate-limit errors trigger uncontrolled retry; one host's failure blocks all
hosts or leaks its state to another.

**Controls:** distinguish local logout from GitHub-side revocation; re-probe before authority-bearing
actions; stale caches are read-only and host-local; bounded retry/backoff with explicit reset facts;
independent host capability states and credentials; no host-to-host synchronization.

## Severity Calibration

### Critical

- Returning or persisting a usable GitHub token in renderer, provider, event, log, or cross-host
  state.
- A remote client or provider cloning/binding without owning-host authorization in a way that grants
  Code execution over attacker-selected content.
- Filesystem escape that overwrites executable or credential material outside the managed inventory
  and is reachable by a paired client or repository-controlled input.

### High

- Cross-Project or cross-host private repository enumeration through an authorization bypass.
- Binding a different GitHub repository than the user confirmed because node identity is ignored.
- Clone cancellation/recovery leaving a credentialed process or adopting an attacker-controlled
  destination as verified.
- Persisting a plaintext GitHub token as a product-supported Linux setup path.

### Medium

- Unbounded repository metadata or clone output causing host resource exhaustion.
- Rate-limit handling that repeatedly hammers GitHub or hides stale authorization facts.
- Leaking private repository names or host paths in non-secret diagnostics to an unauthorized
  client.
- A destination collision that blocks onboarding but cannot overwrite or grant authority.

### Low

- Misleading but non-authorizing scope, expiry, or refresh copy.
- Search/recents ordering or pagination defects that expose only repositories the principal may
  already list.
- Cosmetic progress, responsive, or accessibility defects that do not alter authority or conceal a
  required confirmation.

Security severity is lower when exploitation requires an already fully compromised host user and
cannot expand access, persist beyond that account, cross hosts, or expose a new credential. It is
higher when an authenticated remote client, malicious provider output, GitHub-controlled metadata,
or repository content crosses a server authority or filesystem boundary without additional local
compromise.
