# 0009. Sandbox confinement, approvals, and Plan mode

**Status:** Accepted

## Context

Agents run shells, tests, Git, provider processes, extension servers, and
browser or computer-use tools on the user's machine. Path checks in
TypeScript are not confinement: a provider process or tool can follow a
symlink, spawn a child, or open a network socket. Providers also ship their
own permission prompts, which are useful signals but cannot be trusted as the
boundary. Octant needs OS-enforced confinement, one policy choke point, and
approval categories that stay independent of which provider is running.

## Decision

- Every Octant-spawned subprocess that can execute arbitrary code (provider
  runtimes, shell commands, the project-confined test runner, Git helpers,
  executable extension components) launches through one shared macOS Seatbelt
  profile builder with a deny-default profile. Reads are scoped to the bound
  root, provider home, runtime directories, and a private temp; writes are
  scoped to provider home and temp, plus the bound root only for non-Plan,
  non-Chat sessions; the rest of the user's home is enumerated as denied.
  Missing `sandbox-exec` fails closed as `incompatible`; there is no
  unconfined fallback.
- Bound roots are exact: the Work Project folder, the Code checkout or
  worktree, or a Chat scratch area. Chat has no host filesystem, shell, or Git
  authority.
- Network egress is a per-thread policy resolved by the policy engine and
  materialized at launch: `none` (Work document work and Plan mode),
  `provider-endpoints-only` (default for approval-gated Code), or
  `unrestricted` (Full access or an explicit network approval). OS enforcement
  is two-level (`none` / `allow`); finer host allowlists are enforced by
  Octant-owned brokered tools, and that limitation is stated, not simulated.
- Child processes receive an allowlist-sanitized environment. Credential
  broker coordinates, bridge secrets, and provider credentials are stripped
  from every child; secrets reach a process only as named references resolved
  at launch.
- Server-side tool-call policy is one choke point: a closed tool catalog, a
  declared-capability ceiling per tool or extension component, mode and
  posture rules, and decision receipts. Every surface that dispatches a tool
  calls it before side effects. The catalog is app-managed and named for what
  it operates — the thread's terminal, its isolated browser, its Apple
  toolchain — and every entry is offered only where the host actually holds
  that capability. A tool takes no shortcut the equivalent visible control
  could not take: it carries the same request, resolves the same thread,
  checkout, and posture, and is refused by the same policy.
- Approval categories are independent and scoped: Project file writes, shell
  commands, network access, external application observation or control,
  destructive or irreversible actions, credential access, access outside the
  selected root, and privilege or sandbox expansion. Grants are recorded.
  Provider permission callbacks map into these categories; they never widen
  them.
- Plan mode is strictly read-only in every mode and under every access
  preference: writes and process execution are denied at the sandbox, not
  only in policy. Approval-gated Code confines execution to the exact root and
  correlates side-effect approvals. Full access is a genuine, user-selected,
  unrestricted posture and is never inferred or silently restored.
- Content ingested from outside (tool results, web, files, extension output)
  is provenance-tagged untrusted data, framed as data in context, and taints
  the thread for its lifetime; irreversible approval classes then require
  fresh confirmation. Instruction-shaped text in results is never executed.
- Browser automation uses per-thread isolated contexts with deny-by-default
  origin allowlists and credential-field protection. Computer use requires
  allowlisted applications, session expiry, a visible stop, and process
  ownership.
- Native App-Sandbox confinement with security-scoped bookmarks and an XPC
  broker is the intended stronger boundary for Work; it is proven through a
  disposable feasibility gate before it replaces the Seatbelt path, and
  signing an unsandboxed bundle is not accepted as evidence.
- Host-observed conveniences (for example listing and stopping local dev
  servers from a Code thread) are server-authoritative and fail closed: never
  stop a process merely because it holds a port; never expose to Chat.
- Escape probes are part of the test suite; the release gate is that they
  fail closed.

## Consequences

- Confinement is uniform across providers and tools, so a new tool cannot
  accidentally run unconfined; it must go through the shared builder.
- Users see honest `incompatible` states on hosts without the sandbox
  primitive rather than a degraded silent mode.
- Two-level egress means some workflows need an explicit network approval;
  the finer allowlist lives in brokered tools until a local proxy is justified.
- Provider-native permission UX is partially duplicated by Octant approvals;
  that redundancy is the price of not trusting the provider as the boundary.

## Related

- 0003 Product modes and authority
- 0005 Provider SDK contract
- 0011 Extensions and skills activation ladder
- 0012 Mixed-provider subagents
