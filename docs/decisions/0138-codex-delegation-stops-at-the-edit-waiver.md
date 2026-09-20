# 0138. Codex delegation stops at the edit waiver

**Status:** Accepted

## Context

0018 waives exactly one approval class under `auto-accept-edits`,
`project-file-writes`, and keeps `shell-commands` prompting. 0104 lets a
compatible harness answer the prompts Octant would otherwise surface, and makes
delegation effective on both prompting postures, `approval-gated` and
`auto-accept-edits`.

Those two held together only while Codex ran under a `workspace-write` sandbox,
because an in-root file write then needed no escalation at all: the reviewer
never saw it, and the waiver was kept by the sandbox rather than by anyone's
decision. That sandbox is also what let a provider-run shell command write
inside the checkout without ever raising an approval, because `on-request` only
means the model _may_ escalate. Codex offers no "always ask" mode — measured on
codex-cli 0.154.0, `--ask-for-approval` takes only `on-request` and `never` — so
the sandbox has to keep refusing the write for the class to stay promptable, and
both prompting postures now run `read-only`.

Under `read-only` an in-root file write escalates like any other command, and
Codex's reviewer is thread-wide: it cannot be scoped to a class. 0104 also
records that for Codex the `requestApproval` callbacks are not sent to the host
at all when the reviewer is set, so the driver cannot apply the waiver behind
it. A reviewer that answers the command prompts therefore also answers the write
0018 waives, and its verdict may be to deny — turning a decision the user made
by choosing the posture into one a risk model makes per write.

There is no setting that satisfies both records. The capability is missing, not
merely awkward.

## Decision

- On Codex, `approvalsReviewer` is sent for `approval-gated` only. This is a
  scoped exception to one rule of 0104: that delegation is effective on both
  prompting postures. It supersedes that rule for this provider and no other.
- The waiver outranks the delegation. `auto-accept-edits` is a guarantee the
  user selected about their own edits; `autoApprove` is an opt-in convenience
  about who answers prompts. Where a provider can express only one, Octant keeps
  the guarantee and refuses to simulate the convenience.
- Every remaining rule of 0104 stands: the flag is still orthogonal to the
  posture, still clamped and inherited with it, still inert on `plan` and
  `full-access`, still disabled by taint, and still changes only who answers a
  prompt rather than what the sandbox permits.
- A provider whose approvals are per-class keeps delegation on both postures.
  Claude is unaffected: its permission mode is not a per-class grant, and
  Octant's own callbacks stay registered.
- The limitation is stated, not simulated. `harnessAutoReview` stays a truthful
  provider capability — Codex does support the reviewer — and this record is
  where the posture it does not reach is written down.

## Consequences

- A Codex thread on `auto-accept-edits` with `autoApprove` answers its own
  in-root patch edits and still asks the user about commands and network. That
  is less delegation than the flag suggests, which is why it is recorded rather
  than left to be inferred from the driver.
- The combination a user is most likely to want — accept my edits, review my
  commands for me — is the one Codex cannot express. If that becomes worth
  paying for, the way out is a per-class reviewer in the harness protocol, not a
  heuristic in Octant that reads a command string and decides it only writes
  in-root: Codex reports `commandActions` as `unknown` for a plain `> file`
  redirect, so that classification cannot be made honestly.
- Delegation on `approval-gated`, where no class is waived, is unchanged.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0018 Auto-accept edits as a fourth access posture
- 0104 Harness-delegated approvals (one rule superseded in scope)
