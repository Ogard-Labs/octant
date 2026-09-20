# 0138. Confinement wraps a provider runtime that carries one thread's authority

**Status:** Accepted

## Context

0009 says every Octant-spawned subprocess that can execute arbitrary code
launches through the shared Seatbelt profile builder, and that there is no
unconfined fallback. `acpProcess`, `openCodeProcess`, and `piProcess` do. The
Codex and Claude runtimes do not, and no record says why, so a reader has to
infer either that the rule is unenforced or that 0132 exempts provider
runtimes.

0132 does not. Its "Octant-owned brokers do not wrap provider-owned processes"
explains why `provider-endpoints-only` materializes as OS `allow` — the finer
host allowlist would need a broker — not whether a launch is wrapped at all.
`openCodeProcess` resolves that egress policy and prepares a confined launch in
the same call, so both statements already hold of one shipped launch.

What differs is what a launch knows. The builder binds exactly one root
(`SeatbeltProfileInput.boundRoot`) and needs the thread's mode and execution
policy to settle write, exec, and egress rules. OpenCode supplies all three
because it starts one process per connection and refuses to widen that
process's authority afterwards. The Codex app-server is leased once per
provider instance — `providerRuntimeRegistry` keys runtimes by `instanceId` and
the Codex driver's acquire ignores `projectRoot` — so one process carries every
thread on that instance, each picking its own root and `sandbox` value at
`thread/start`. No profile is exact for all of them, and one wide enough for
all of them is not a boundary. The Claude runtime does spawn per query with
that thread's `cwd`, but the Agent SDK composes the launch and hands Octant's
spawn callback only command, args, cwd, env, and a signal.

## Decision

- Octant wraps a provider runtime launch through the shared builder when the
  process carries exactly one thread's authority — one bound root, one mode,
  one execution policy, fixed for the life of the process. ACP, OpenCode, and
  Pi meet that and stay under 0009's rule unchanged.
- Every provider process module that launches without the shared builder is
  named here rather than left to a grep. This is a scoped exception to one rule
  of 0009, that every such subprocess launches through the shared builder:
  - **Codex** (`codexProcess.ts`): one app-server serves every thread on a
    provider instance, so no single bound root, mode, or execution policy
    exists when it launches.
  - **Claude** (`claudeProcess.ts`): the Agent SDK owns the launch, and its
    spawn callback carries no mode or execution policy.
  - **Oh My Pi discovery** (`ohMyPiProcess.ts`): a declaration-only probe in its
    managed home with sessions, tools, extensions, skills, and LSP off, in the
    family 0122 already carved out. Its turns run on the Pi runtime, which is
    wrapped.
- The exception covers the runtime process only. Octant-owned tools those
  threads reach — the terminal, the project-confined test runner, Git helpers,
  executable extension components — stay confined exactly as 0009 requires, and
  so do the Octant-owned brokered tools that hold the finer egress allowlist.
- The residual risk is stated, not simulated away. For these two families the
  only OS boundary on a model-generated shell command is the provider's own
  (`sandbox` on Codex's `thread/start`, `permissionMode` on a Claude query).
  0009 holds that a provider's own permission layer is a useful signal and not
  the boundary, and a defect in the posture that Octant maps into that layer is
  therefore a write inside the checkout with no Octant prompt — observed on a
  Codex Code thread whose approval-gated posture mapped to `workspace-write`.
- Every other rule of 0009 stands for both runtimes: allowlist-sanitized
  environments, credentials stripped from every child and refused in argv,
  durable process receipts with process-group termination, the server-side
  tool-call policy choke point, the approval categories, and untrusted-content
  taint.
- A new provider runtime is wrapped. `providerProcessConfinement.test.ts` keeps
  the live set as a manifest and refuses a module that uses no shared builder
  and claims no entry, an entry whose module has since adopted the builder, and
  a covered file this record does not name. The manifest, not this record, is
  the live set: an accepted record keeps its history, so confining a runtime
  drops a manifest entry rather than a line here. Reading modules catches one
  that never adopts the builder, the failure that produced this exception;
  proving a single launch inside a wrapped module needs a launch manifest.
- The exception closes per runtime, each as its own deliverable with its own
  evidence: Codex when its runtime lease is keyed by the thread's root and
  execution policy the way OpenCode's connection is, Claude when the SDK launch
  carries the thread's mode and policy through to the spawn callback.

## Consequences

- The boundary is written where a reader looks for it instead of inferred from
  which modules happen to import the builder, and the set cannot grow quietly.
- Octant's approval categories sit above the provider's sandbox for Codex and
  Claude rather than beneath it, so those two families depend on a correct
  posture mapping in a way the wrapped runtimes do not.

## Related

- 0009 Sandbox confinement and approvals (one rule superseded in scope)
- 0104 Harness-delegated approvals as a per-thread pass-through
- 0121 Provider-owned CLI runtimes, profiles, and updates
- 0132 Provider runtimes reach provider endpoints on Chat and Work turns
