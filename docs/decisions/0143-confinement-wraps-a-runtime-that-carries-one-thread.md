# 0143. Confinement wraps a provider runtime that carries one thread's authority

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
process's authority afterwards. Codex cannot, for a reason that is its own and
not a gap in the rule. Claude can, and is not wrapped yet.

## Decision

- Octant wraps a provider runtime launch when the process carries exactly one
  thread's authority: one bound root, one mode, one execution policy, fixed for
  the life of the process. The ACP, OpenCode, and Pi turn launches meet that and
  stay under 0009's rule below Full access. On Full access OpenCode and Pi
  return the binary unwrapped, and ACP does too unless its profile carries
  0006's static denials, which it enforces through an allow-default wrapper
  adding only those. That is 0009's user-selected unrestricted posture, not a
  gap: it drops the deny-default bound-root profile and nothing more.
- Every provider process module that launches without the shared builder is
  named here rather than left to a grep, and only one is excepted. **Codex**
  (`codexProcess.ts`) is a scoped exception to one rule of 0009, that every such
  subprocess launches through that builder: the app-server is leased once per
  provider instance — `providerRuntimeRegistry` keys runtimes by `instanceId`
  and the driver's acquire ignores `projectRoot` — so one process carries every
  thread on that instance, each picking its own root and `sandbox` at
  `thread/start`. No profile is exact for all of them, and one wide enough for
  all of them is not a boundary. The exception covers the runtime process only;
  Octant-owned tools those threads reach stay confined as 0009 requires.
- **Claude** (`claudeProcess.ts`) is a gap, not an exception. It meets the test
  above: one process per query, and the query that installs the SDK's
  `spawnClaudeCodeProcess` holds the thread's root and execution policy, so a
  per-query callback can close over them though the SDK calls it with only
  command, args, cwd, env, and a signal. It is unwrapped because that is not
  wired. Whether a deny-default profile admits a Claude runtime — its credential
  store, its own model call under OS `none` — is unverified here and needs a
  real host.
- Probes are outside both. Every family spawns the configured executable to read
  a version or an auth state before any confined launch, and discovery does the
  same to a candidate it found. That does not satisfy 0009 and is not excepted:
  a standing gap, inventoried in the threat model. The Oh My Pi connection check
  (`ohMyPiProcess.ts`) is the sharper case: its version check and RPC probe run
  unconfined though 0122 exempts a probe from egress only and still requires it
  to launch confined. The gate holds it and Claude so they stay visible; that is
  bookkeeping, not an exception.
- Three sentences in other Accepted records are affected, and each stands except
  where named. 0057's list of runtimes confined through the shared builder
  includes Codex, which is not, so that name is superseded in scope. 0018 and
  0104 say confinement is unchanged across postures and delegated approval,
  naming the same Seatbelt profile. That holds of every wrapped runtime; for
  Codex it holds as "the same sandbox", the provider's own, which neither
  auto-accept nor a delegated reviewer changes.
- The residual risk is inventoried by posture in the threat model's sandbox
  section: which postures carry a provider sandbox, what each runtime's
  environment withholds, and what a model-generated command inside an unwrapped
  runtime can read. Two entries bind this record. A Claude Plan turn is
  read-only by `permissionMode` alone and not at any sandbox, which 0009
  requires; this record names that an open defect, authorizes nothing, and
  supersedes no Plan rule, and closing the Claude gap has to fix it first. And
  0009 holds that a provider's permission layer is a signal and not the
  boundary, so a defect in the posture Octant maps into it is a write inside the
  checkout with no Octant prompt — observed, and since fixed, on a Codex Code
  thread whose approval-gated posture mapped to `workspace-write`. What the
  missing boundary leaves standing is the class, not that instance.
- Process receipts, group termination, broker-coordinate stripping, the
  tool-call policy choke point, the approval categories, and untrusted-content
  taint stand unchanged for both runtimes.
- A new provider runtime is wrapped. `providerProcessConfinement.test.ts` keeps
  the live set as a manifest: it refuses a module that uses no shared builder
  and claims no entry, an entry whose module has since adopted the builder, and
  a covered file this record does not name. The manifest, not this record, is
  the live set; an accepted record keeps its history, so confining a runtime
  drops a manifest entry. Reading modules catches one that never adopts the
  builder, the failure that produced this record; proving a single launch inside
  a wrapped module needs a launch manifest.
- Each closes as its own deliverable with its own evidence: the Codex exception
  when its runtime lease is keyed by the thread's root and execution policy as
  OpenCode's connection is, the Claude gap when its per-query spawn callback
  prepares a confined launch.

## Consequences

- The boundary is written where a reader looks for it instead of inferred from
  which modules import the builder, and the set cannot grow quietly.
- Octant's approval categories sit above the provider's sandbox for these two
  rather than beneath it, so they depend on a correct posture mapping in a way
  the wrapped runtimes do not.

## Related

- 0009 Sandbox confinement and approvals (one rule superseded in scope)
- 0018 Auto-accept edits as a fourth access posture
- 0057 Linux confinement uses Bubblewrap (names Codex as confined)
- 0104 Harness-delegated approvals as a per-thread pass-through
- 0121 Provider-owned CLI runtimes, profiles, and updates
- 0132 Provider runtimes reach provider endpoints on Chat and Work turns
