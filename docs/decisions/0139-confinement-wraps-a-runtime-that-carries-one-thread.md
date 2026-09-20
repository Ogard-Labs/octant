# 0139. Confinement wraps a provider runtime that carries one thread's authority

**Status:** Accepted

## Context

0009 says every Octant-spawned subprocess that can execute arbitrary code
launches through the shared Seatbelt profile builder, with no unconfined
fallback. `acpProcess`, `openCodeProcess`, and `piProcess` do. The Codex and
Claude runtimes do not, and no record says why, so a reader has to infer that
the rule is unenforced or that 0132 exempts provider runtimes.

0132 does not. Its "Octant-owned brokers do not wrap provider-owned processes"
explains why `provider-endpoints-only` materializes as OS `allow` — the finer
host allowlist would need a broker — not whether a launch is wrapped at all.
`openCodeProcess` resolves that egress policy and prepares a confined launch in
the same call, so both already hold of one shipped launch.

What differs is what a launch knows. The builder binds exactly one root
(`SeatbeltProfileInput.boundRoot`) and needs the thread's mode and execution
policy to settle write, exec, and egress rules. OpenCode supplies all three
because it starts one process per connection and refuses to widen that
process's authority afterwards. The two runtimes below cannot, for reasons that
are theirs and not a gap in the rule.

## Decision

- Octant wraps a provider runtime launch when the process carries exactly one
  thread's authority: one bound root, one mode, one execution policy, fixed for
  the life of the process. The ACP, OpenCode, and Pi turn launches meet that
  below Full access and stay under 0009's rule unchanged. On Full access all
  three return the binary unwrapped — 0009's genuine, user-selected,
  unrestricted posture, not a gap; ACP keeps 0006's static denials there.
- This exception covers whole modules, so it does not reach version probes.
  Every family, wrapped or not, spawns the configured executable for
  `--version` before any confined launch. That does not satisfy 0009 and is not
  excepted here; it is a standing gap across every family, recorded in the
  threat model and closing in its own change.
- Every provider process module that launches without the shared builder is
  named here rather than left to a grep. This is a scoped exception to one rule
  of 0009, that every such subprocess launches through that builder:
  - **Codex** (`codexProcess.ts`): the app-server is leased once per provider
    instance — `providerRuntimeRegistry` keys runtimes by `instanceId` and the
    driver's acquire ignores `projectRoot` — so one process carries every
    thread on that instance, each picking its own root and `sandbox` value at
    `thread/start`. No profile is exact for all of them, and one wide enough
    for all of them is not a boundary.
  - **Claude** (`claudeProcess.ts`): it does spawn per query with that thread's
    `cwd`, but the Agent SDK composes the launch and hands Octant's spawn
    callback only command, args, cwd, env, and a signal.
  - **Oh My Pi discovery** (`ohMyPiProcess.ts`): a declaration-only probe in its
    managed home with sessions, tools, extensions, skills, and LSP off, in the
    family 0122 carved out. Its turns run on the wrapped Pi runtime.
- The exception covers the runtime process only. Octant-owned tools those
  threads reach — terminal, test runner, Git helpers, executable extension
  components, brokered tools — stay confined exactly as 0009 requires.
- The residual risk is inventoried by posture in the threat model's sandbox
  section rather than averaged into a sentence here: which postures carry a
  provider sandbox, what each runtime's environment actually withholds, and
  what a model-generated command inside an unwrapped runtime can therefore
  read. Two entries there bind this record. A Claude Plan turn is read-only by
  `permissionMode` alone and not at any sandbox, which 0009 requires, so
  closing this exception for Claude has to fix that first. And 0009 holds that
  a provider's permission layer is a signal and not the boundary, so a defect
  in the posture Octant maps into it is a write inside the checkout with no
  Octant prompt — observed, and since fixed, on a Codex Code thread whose
  approval-gated posture mapped to `workspace-write`. What the missing boundary
  leaves standing is the class, not that one instance.
- Process receipts, group termination, broker-coordinate stripping, the
  tool-call policy choke point, the approval categories, and untrusted-content
  taint stand unchanged for both runtimes.
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
  which modules import the builder, and the set cannot grow quietly.
- Octant's approval categories sit above the provider's sandbox for these two
  rather than beneath it, so they depend on a correct posture mapping in a way
  the wrapped runtimes do not.

## Related

- 0009 Sandbox confinement and approvals (one rule superseded in scope)
- 0104 Harness-delegated approvals as a per-thread pass-through
- 0121 Provider-owned CLI runtimes, profiles, and updates
- 0132 Provider runtimes reach provider endpoints on Chat and Work turns
