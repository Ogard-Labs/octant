# 0018. Auto-accept edits as a fourth access posture

**Status:** Accepted

## Context

0009 defines three Code access postures: Plan (read-only), approval-gated, and
Full access. In practice a long editing session under approval-gated produces a
prompt for every file write, while the user's actual intent is narrower than
Full access: accept the agent's edits inside the bound root, but keep asking
about shell commands, network, destructive actions, credentials, and anything
outside the root. Users answer prompt after prompt for the one class they never
intended to review, which trains them to approve without reading — the opposite
of what the approval boundary is for.

Raising such a thread to Full access is the wrong relief valve: Full access is a
genuine unrestricted posture, requires native confirmation, and waives every
class at once.

## Decision

- `ProviderExecutionPolicy` gains a fourth member, `auto-accept-edits`, ranked
  between `approval-gated` and `full-access` everywhere authority is compared,
  clamped, or inherited (agent runs, automations, linked threads, profiles).
- The posture waives exactly one approval class: `project-file-writes`. Shell
  commands, network access, external application control, destructive or
  irreversible actions, credential access, access outside the selected root,
  and privilege expansion still prompt, at the same choke points as
  approval-gated.
- It is an approval posture, not an access grant. Every decision site that
  means "this thread decides effects by approval" asks
  `decidesCodeEffectsByApproval(posture)` rather than comparing against
  `"approval-gated"`, so a surface can never treat the new posture as Full
  access by falling through an equality check.
- Confinement is unchanged from approval-gated: same bound root, same Seatbelt
  profile, same `provider-endpoints-only` egress. The posture changes who
  answers a project-file-write prompt, not what the sandbox permits.
- Taint still wins. Once a thread has ingested untrusted content, irreversible
  classes require fresh confirmation; the waiver is evaluated after that check,
  never before it.
- Selecting it needs no native confirmation, because it grants no authority the
  host would otherwise refuse. Raising a thread to Full access still does.
- Providers map it to their own approval-gated settings; Octant's gate, not the
  provider's, decides which writes proceed unprompted. A provider that cannot
  express the distinction simply keeps asking, and Octant answers.

## Consequences

- The common editing loop stops generating prompts the user was always going to
  approve, so the prompts that remain carry information again.
- A thread in this posture can rewrite any file inside its bound root without
  asking. That is the point, and it is why the waiver stops at the root
  boundary: `access-outside-project` is untouched.
- Every posture comparison is now a four-way decision. Exhaustive switches and
  rank maps catch the omissions; equality checks against `"approval-gated"` do
  not, which is why the shared predicate exists.

## Related

- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
