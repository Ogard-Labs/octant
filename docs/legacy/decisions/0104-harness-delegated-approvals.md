# 0104. Harness-delegated approvals as a per-thread pass-through

**Status:** Accepted

## Context

0009 makes Octant the approval boundary: provider permission callbacks map into
Octant's approval categories but never widen them. 0018 adds `auto-accept-edits`
as a posture that waives project-file-write prompts only. Both keep Octant's
server-side gate as the authority that decides which prompts reach a person.

Compatible harnesses already expose a native "answer approvals for me" mode:
Codex routes approval requests to an `auto_review` reviewer on `thread/start`
and `turn/start`; the Claude Agent SDK supports `permissionMode: "auto"`, a
model classifier that approves or denies permission prompts. Octant's drivers
map both postures to fixed harness settings today and never pass either native
mode through, so the capability is invisible to the user.

## Decision

- `ProviderCapabilities` gains `harnessAutoReview`. A provider that supports it
  reports `"supported"`; every other provider reports `"unsupported"` and the
  option is never offered.
- `CodeThread` gains `autoApprove: boolean` (optional, default `false`). It is
  orthogonal to the posture: the posture says what the sandbox permits and which
  classes Octant prompts for; `autoApprove` says who answers the prompts Octant
  would otherwise surface — the user, or the harness's own reviewer.
- Delegation is effective only when `autoApprove` is `true`, the posture is
  `approval-gated` or `auto-accept-edits` (the two postures that produce
  prompts), the provider reports the capability, and the thread has not ingested
  untrusted content. A thread that is `plan` or `full-access` produces no
  prompts, so the flag is inert there.
- When effective, the Claude driver sends `permissionMode: "auto"` and the
  Codex driver sends `approvalsReviewer: "auto_review"` at session and turn
  start. Octant's `canUseTool` and `PreToolUse` callbacks remain registered for
  Claude; whether the SDK calls them in `auto` mode is the SDK's behavior, and
  the sandbox stays the confinement boundary regardless. For Codex the reviewer
  handles approvals internally and the `requestApproval` callbacks are not sent
  to the host; the sandbox is the boundary.
- Taint still wins, per 0018. When a thread has ingested untrusted content,
  delegation is not enabled for the next turn, so irreversible classes come
  back to the user. Mid-turn taint acquisition is a known limitation for Codex
  (the reviewer is set per turn and cannot be revoked mid-turn); for Claude the
  driver may switch back to `default` mid-turn via `setPermissionMode`.
- Confinement is unchanged: the same bound root, the same Seatbelt or Bubblewrap
  profile, the same egress policy. The flag changes who answers a prompt, not
  what the sandbox permits. It does not widen writable roots, network access,
  approval categories, or credential access.
- The flag lives on the thread, set via `change-code-thread-access` alongside
  the posture. It is clamped and inherited with the posture across agent runs,
  automations, linked threads, and profiles. Remote clients cannot enable it
  beyond the host's authority.
- This is a scoped exception to 0009's rule that provider permission callbacks
  never widen approval categories: the harness's reviewer answers prompts
  Octant would have surfaced, but the categories themselves and the sandbox
  confinement are unchanged. 0009's remaining rules stand.

## Consequences

- A user who opts in sees fewer prompts on compatible providers: the harness's
  reviewer answers them. The sandbox still confines what the process can do.
- For Codex, Octant's server-side authority check is not invoked for delegated
  approvals; the sandbox is the boundary. For Claude, Octant's callbacks may
  still run depending on SDK behavior. The decision states this asymmetry
  rather than hiding it.
- A tainted thread cannot delegate: irreversible classes come back to the
  user. The limitation for Codex is mid-turn taint, which the next turn
  corrects.
- The flag is a new authority-carrying field on the thread, clamped alongside
  the posture. Every site that clamps or inherits the posture must also clamp
  or inherit the flag.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0018 Auto-accept edits as a fourth access posture
- 0110 Native harness model-reviewed approvals (native path; this record is external)
