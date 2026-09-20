# 0140. A Plan turn is confined by Octant and reaches only its provider

**Status:** Accepted

## Context

0009 says Plan mode is read-only "at the sandbox, not only in policy", and that
a provider's own permission prompts are a useful signal that cannot be trusted
as the boundary. The Claude runtime met neither. `claudeSandboxSettings`
returned nothing outside the two postures that write, `claudeProcess` launched
without the shared builder, and the only thing holding a Plan turn read-only was
`permissionMode: "plan"` inside the provider's own runtime.

0139 recorded why and named the close condition: the Agent SDK composes the
launch and hands Octant's spawn callback only command, args, cwd, env, and a
signal, so the launch cannot see the thread's root or posture. That is fixable
where the query is opened, which does know both.

Closing it surfaced two things the older records did not anticipate, both
measured on macOS 27 against this builder's profile:

- A runtime on OS `none` cannot answer a Plan turn at all. The model call is
  the runtime's own HTTPS request: under `none` it ends in `fetch failed` and
  the turn retries until it times out; under `allow` it reaches the endpoint.
  0132 had reasoned that "a Plan turn that needs the network is a Full-access
  question", which holds for a tool and not for the process producing the plan.
- The Claude runtime keeps its subscription credential in the platform secret
  store rather than in its provider home, which 0009's read scope assumes. A
  deny-default launch reports itself signed out.

## Decision

- A Claude Plan launch goes through the shared confinement builder with the
  thread's checkout as its bound root. The checkout is readable and never
  writable, process execution and fork are denied, and the only write roots are
  the runtime's configuration directory, its secure-storage directory when the
  host names one, and the one scratch directory the runtime opens for itself.
  There is no unconfined fallback: a builder that cannot prepare the launch
  fails the turn.
- This partially supersedes one rule of 0139, that the Claude exception covers
  `claudeProcess.ts` whole. The exception now covers the approval-gated and
  auto-accept-edits postures, whose launches still run on the runtime's own
  sandbox settings. `providerProcessConfinement.test.ts` holds that narrowing
  as the live set and refuses a posture that is neither confined nor declared.
- A provider runtime that carries a turn resolves `provider-endpoints-only` on
  every posture but Full access, Plan included. This supersedes exactly one
  rule of 0132, that Plan stays `none` for the runtime as well as for tools.
  Octant-owned tools keep the thread defaults unchanged, `none` on Plan among
  them: what Plan withholds is writing and running something, and those are
  withheld by the launch's filesystem and process rules.
- A bound root a launch may not write is denied in the profile, not merely left
  ungranted. A checkout that sits under the launch's own temporary directory
  was writable through that directory's subpath grant, which made a Plan launch
  able to create a file in the checkout it may only read.
- A provider runtime that resolves its own subscription credential from the
  platform secret store may look up the security server. The store's files stay
  denied, so a confined process still cannot read it off disk; the daemon
  applies its own per-item rules and returns only what that binary is already
  trusted for. This is a scoped exception to the same rule of 0009 that 0126
  scoped for trust evaluation, and unlike that one it does reach private
  credential material, so it is set per launch and never for a tool.
- Full access stays unconfined. 0009 calls it a genuine, user-selected,
  unrestricted posture, so it is outside this rule rather than an exception
  to it.

## Consequences

- A Plan turn's read-only boundary is the operating system's, so a defect in
  the posture Octant maps into the provider is no longer the only thing between
  a Plan turn and the checkout.
- Plan turns start on every wrapped runtime. They could not before: ACP, Pi,
  and OpenCode carried the same `none` egress and the same silent timeout.
- The confined runtime can still obtain its own subscription credential, and
  the secret store stays unreadable as a file. That reach is narrower than the
  unconfined launch it replaces and wider than 0126 left it.
- The Codex exception and the two Claude postures that write are unchanged and
  still stand as 0139 records them.

## Related

- 0009 Sandbox confinement and approvals (Plan's rule now enforced; one read
  rule scoped)
- 0126 Seatbelt trust evaluation and launcher symlinks
- 0132 Provider runtimes reach provider endpoints (one rule superseded)
- 0139 Confinement wraps a runtime that carries one thread (one rule superseded)
