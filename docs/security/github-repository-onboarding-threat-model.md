# GitHub Repository Onboarding Threat Model

**Status:** Approved by Henrik (2026-08-28)

**Date:** 2026-08-07 (issue-browser delta approved 2026-08-28)

**Scope:** Host-scoped GitHub authentication, normalized catalogue reads (including issue list,
search, and detail), managed clone, Code Project binding, and create-from-issue thread context

**Design:** Implemented onboarding lives behind `/api/github/*` and is summarized in
[`../architecture.md`](../architecture.md). The approved issue-browser and create-from-issue shape
is recorded in this document.

## Overview

Octant is a local-first, server-authoritative workspace. This feature lets one macOS or Linux
host use its installed, authenticated GitHub CLI to discover accessible repositories, read bounded
metadata, and clone one user-confirmed repository into a managed inventory before binding it as an
ordinary Code Project.

The same host-scoped connection also feeds the issue browser and the approved,
not-yet-implemented create-from-issue flow.
Issue list, search, and detail reads reuse the existing catalogue route and the `issues-read`
capability. Creating a thread from an issue injects bounded, redacted GitHub issue text as
untrusted external content. Those surfaces do not clone, bind, or write back to GitHub.

The high-value assets are the host's GitHub authorization, private repository contents, managed
repository inventory, Code Project authority, local paths, normalized GitHub metadata, the
integrity of clone/recovery receipts, and the integrity of thread context assembled from GitHub
issue text. A compromise that exposes a token, clones an unapproved repository, writes outside the
inventory, binds the wrong repository, grants an agent broader GitHub visibility, or lets
attacker-authored issue text become instructions violates the product's core security model.

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
- **GitHub issue authors:** anyone who can file or comment on an accessible repository the
  principal can read. Their text is untrusted by definition and may enter Octant when the user
  creates a thread from that issue.
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
8. GitHub issue and comment text to context assembly and the issue-browser renderer.

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

### Prompt injection via issue bodies and comments

**Stories:** Anyone can author an issue or comment on an accessible repository, so create-from-issue
ingests attacker-authored text by design. A body or comment that looks like a system instruction,
approval grant, or tool invocation tries to become commands; a token-shaped string tries to persist
in context; a huge body tries to exhaust the first-turn budget.

**Controls:** the renderer attaches only `{ owner, name, number }` to the draft and never assembles
issue text. At creation the server reauthorizes `issues-read` against a fresh snapshot, reads the
issue through the catalogue, redacts SECRETISH material, strips NUL and terminal-control sequences,
and injects the bounded block only through
`apps/server/src/context/externalContentFraming.ts` data-delimited framing. That framing asserts
external content never reaches instruction sections. The server appends
`thread.external-content-ingested@1` (origin `external-content`, opaque source label) so the
thread-lifetime taint projection and irreversible-approval reconfirmation apply from turn one.
Field and whole-block sizes are capped and truncation is disclosed. Content can become action only
through a model-proposed tool call that then passes full policy, per the untrusted-content policy
in [`security-architecture-threat-model.md`](security-architecture-threat-model.md).

### Issue-browser rendering

**Stories:** Markdown or HTML in an issue body smuggles a non-github.com URL, spoofs Octant chrome,
or navigates the app from attacker-authored link text; an issue URL carries userinfo or a surprise
host.

**Controls:** the issue browser renders title, body, and comments as plain text — no markdown-to-HTML.
URLs are github.com-pinned, credential-free, and shown as inert full strings. Issue content never
drives in-app navigation. Those rules close link-smuggling and UI-spoofing paths the onboarding
model never considered.

### Revocation, rate limit, and partial failure

**Stories:** local logout is presented as OAuth revocation; a revoked credential leaves cached
private data actionable; rate-limit errors trigger uncontrolled retry; one host's failure blocks all
hosts or leaks its state to another.

**Controls:** distinguish local logout from GitHub-side revocation; re-probe before authority-bearing
actions; stale caches are read-only and host-local; bounded retry/backoff with explicit reset facts;
independent host capability states and credentials; no host-to-host synchronization.

## Approved issue-browser and create-from-issue design

This shape is approved and not yet implemented. It extends the existing GitHub catalogue; it does
not replace Code pull-request surfaces, clone, or Project binding. Credential disclosure,
confused-deputy, and rate-limit controls above apply unchanged to issue search and detail reads.

### Catalogue contracts and capability gate

`packages/contracts/src/githubCatalogue.ts` remains the only client-visible GitHub read surface.
The existing `kind: "issues"` request gains optional `search: safeText(160)` matching title text,
`#number`, or `author:` terms. The server composes the upstream query; the client never sends raw
query syntax. A new `kind: "issue"` request `{ owner, name, number }` returns `GithubIssueDetail`:
`number`, `title`, `state`, `author`, `createdAt`, `updatedAt`, github.com-pinned `url`, labels
(≤20, ≤50 chars each), bounded `body` with `bodyTruncated`, and ≤10 most recent comments (author,
`createdAt`, bounded body, truncated flag). All text fields pass the existing `safeText`/SECRETISH
filters. Failure remains `GithubCatalogueUnavailable` with capability `issues-read` — no new error
shape.

Server reads stay on `apps/server/src/github/ghRepositoryCataloguePort.ts` and
`apps/server/src/github/githubCatalogueService.ts`. Both list and detail are gated by the existing
`decideGithubCatalogueRead` policy (`packages/domain/src/githubCapabilityPolicy.ts`) with
capability `issues-read`, and they reuse the existing TTL/stale labels, bounded decoders,
`MAX_OUTPUT_BYTES`, sanitized environment, and central redaction. There is no new route:
`/api/github/catalogue/reads` already transports the union; the renderer uses `readCatalogue` on
`packages/client-runtime/src/githubClient.ts`.

### Plugin-shaped sidebar destination

The first-party GitHub plugin contributes a second `sidebar.destination`
(`destinationId: "github-issues"`, label "Issues", entry point
`builtin:github/issues-destination`). Availability is contribution present AND wired action AND
`issues-read` `available` in the authentication snapshot. Disabling the plugin removes the row;
missing capability hides it. The destination joins the existing sidebar-destination allowlist; it
is not a host-compiled Code-only branch. Full GitHub plugin extraction remains later sequenced
work and is not a prerequisite.

The browser is host-scoped, not Project-bound. Repository selection reuses the recents/search
patterns of the existing repository picker. The list supports state filter, search, and cursor
pagination. Unavailable responses render reason, remediation, and `retryAfterSeconds`; stale pages
carry the existing stale label. This surface is distinct from
`packages/contracts/src/codeProjectPullRequests.ts` and the Project-bound pull-request workspace.

### Create-from-issue framing

The composer `Create from…` control gains an Issues tab, hidden when `issues-read` is unavailable
or the plugin is disabled. Selecting an issue attaches only `{ owner, name, number }` to the draft.

A new `packages/contracts/src/githubIssueContext.ts` carries that reference as optional
`issueContext` on the mode creation requests the draft workspace already submits. At creation the
server reauthorizes `issues-read`, performs the issue detail read, and returns
`{ status: "ready", framed } | { status: "refused", reason }`. Refusal fails creation visibly.
The block enters the first turn only through `externalContentFraming.ts` and the server appends
`thread.external-content-ingested@1` via `apps/server/src/context/externalContentIngestionStore.ts`.
The thread is ordinary Chat, Work, or Code with normal authority. Nothing links back to GitHub;
no write-back path exists in the contracts.

Injected fields, exactly: repository `owner`/`name`, issue `number`, `state`, `title` (≤256 chars),
`author` login (≤128), `createdAt`/`updatedAt`, github.com-pinned `url`, labels (≤20 × ≤50 chars),
body (≤8 KiB UTF-8, explicit truncated marker), ≤10 most recent comments (author ≤128, body ≤2 KiB
each, per-comment truncated). The whole framed block is hard-capped at 32 KiB
(`MAX_NEW_THREAD_DRAFT_INTENT_BYTES`); truncation is disclosed, never silent.

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
- Prompt injection through ingested issue text that causes a model to propose an irreversible
  action. Framing, taint, and the untrusted-content policy still require a fresh confirmation
  before that proposal can execute.

### Low

- Misleading but non-authorizing scope, expiry, or refresh copy.
- Search/recents ordering or pagination defects that expose only repositories the principal may
  already list.
- Cosmetic progress, responsive, or accessibility defects that do not alter authority or conceal a
  required confirmation.
- Markdown or HTML in issue text that cannot navigate, execute, or spoof chrome because the
  browser renders plain text and does not follow issue links.

Security severity is lower when exploitation requires an already fully compromised host user and
cannot expand access, persist beyond that account, cross hosts, or expose a new credential. It is
higher when an authenticated remote client, malicious provider output, GitHub-controlled metadata,
or repository content crosses a server authority or filesystem boundary without additional local
compromise.
