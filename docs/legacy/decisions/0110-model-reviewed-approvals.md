# 0110. Native harness model-reviewed approvals as a reviewer swap

**Status:** Proposed

## Context

0009's choke point prompts a person when a Code thread's posture requires it.
0104 lets compatible external harnesses answer those prompts; the native
harness (0007) has no equivalent. A middle tier — a separate reviewer model
that may approve or deny with a rationale — would make the person the
exception without widening confinement.

0067 forbids the advisor from granting approvals. 0025 suspends unattended
loops at policy edges. 0009 maps provider and model signals into approval
categories and does not let those signals answer them. This record is the
scoped exception and the reviewer role. It does not authorize implementation.

## Decision

- **Reviewer swap, not a grant.** When the 0009 choke point would prompt a
  person, the native harness is running, and the host setting is on, a
  separate reviewer model call may approve or deny with a rationale. Sandbox
  profile, bound root, egress, and approval categories are unchanged. The
  reviewer never mints authority. There is nothing to review when the
  posture would not prompt: Full access; `auto-accept-edits` for
  `project-file-writes`; Plan.
- **Not a fifth posture.** A per-posture flag on postures that already
  `decidesCodeEffectsByApproval` (`approval-gated` and `auto-accept-edits`).
  Rank, clamp, and inherit (agent runs, linked threads, automations, remote
  clients, profiles) may only narrow the flag, never widen it.
- **Dedicated `reviewer` slot.** 0066's built-in slots gain `reviewer`. The
  Reviewer job still maps to `slow`; this slot is for approval verdicts
  only. 0067's rule that the advisor never executes tools, edits files, or
  grants approvals stands — that constraint is on the advisor only. This
  role is not the advisor and does not give the advisor side-effect
  authority.
- **Bounded untrusted context.** The reviewer sees only the approval request
  plus bounded facts: tool id, args, approval class, bound-root path-check
  result, taint state, and a short policy summary. Not the full transcript.
  The reviewer system prompt treats the request as data; instructions inside
  it are never followed. Ambiguity defaults to deny / escalate-to-person.
  On deny, the lead is told to find a materially safer path or ask the user.
- **Eligible classes (first cut).** Reviewer-eligible: `shell-commands` and
  `network-access` only. Never eligible: `destructive-irreversible`,
  `publish-to-target`, `credential-secret-access`, `privilege-expansion`,
  `access-outside-project`, and `project-file-writes` (those stay a person
  or the existing posture waiver). Taint still wins:
  `externalContentIngested` threads keep fresh-person-confirmation for
  irreversible classes regardless of the reviewer. Eligibility does not
  expand under elevated postures.
- **Model floor.** The setting refuses to enable unless the `reviewer` slot
  resolves to a configured model. Silent resolution of an unconfigured slot
  to `default` is 0066's warning case and is not sufficient to enable the
  feature. The verdict is a narrow classify; `smol` is an allowed mapping
  but not a hardcoded vendor default.
- **Settings and receipts.** User/host settings only; never repo-committed
  project config. Journaled as a decision receipt like every other policy
  outcome, with the reviewer's rationale attached. The renderer never sees
  a secret; this is not a credential feature.
- **Goal loops (0025).** Unattended loops still suspend at policy edges. A
  loop must not consume reviewer approvals. 0025 stays Accepted; this
  record names that so 0025 is not silently weakened. A standing grant a
  person gave earlier still applies.
- **Native harness only; remote cannot enable.** External-provider drivers
  stay on 0104's pass-through. Their permission callbacks map into 0009
  categories and never widen them. A remote principal cannot enable the
  flag or act as the reviewer (0013). Remote never exceeds host authority.

This record is a scoped exception to one rule of 0009, which otherwise
stands: provider and model signals map into approval categories and never
answer them. The reviewer may only answer prompts the choke point already
generated, for the declared eligible classes. Remaining 0009 rules — OS
confinement, the choke point, Plan read-only, taint, and the categories
themselves — stand.

## Consequences

- The person is no longer the only answerer of shell and network prompts
  under the native harness, but only after an explicit host setting and a
  configured reviewer slot. Every other class, and every prompt the choke
  point would not have raised, is unchanged.
- Injection that tells the reviewer to approve cannot mint a category or
  waive taint; the allowlist, bounded context, and ambiguity-to-person
  rule are the controls. Escape probes for this path are a release-gate
  follow-up, not evidence that the feature exists today.
- Implementation is not authorized. Accepting this record is the start
  gate for a later change that lands the setting, slot, and choke-point
  swap.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode (one rule superseded)
- 0025 Long-running goal loops (unchanged)
- 0066 Native harness model role slots (`reviewer` slot)
- 0067 Native harness turn loop, advisor, and follow-up suggestions
- 0104 Harness-delegated approvals as a per-thread pass-through
