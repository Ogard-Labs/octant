# 0065. A Project-scoped planner thread surveys the board and proposes work

**Status:** Accepted

## Context

Code work already has per-thread plans (0027), server-authoritative thread
boards (0051), and bounded subagents (0012), but no thread can see its whole
Project: each agent knows only its own thread, so cross-thread judgment —
"what is stuck, what is done, what should start next" — lives entirely with
the user. The roadmap deliberately listed swarm/dispatch launch surfaces as
not planned, because a surface that launches and steers fleets of agents is a
policy bypass dressed as leverage.

The maintainer (2026-08-29) explicitly authorized a narrow exception: one
designated thread per Code Project that may read that Project's board and
propose — never start — new work. This record is that authorization, and it
supersedes exactly one line of the roadmap's not-planned list: a Project
planner that only observes and proposes is now in scope. Dispatch, races, and
model-comparison launch surfaces remain not planned.

## Decision

- A Code Project may designate exactly one of its own Code threads as the
  planner thread, and undesignate it, through an authoritative server command
  journaled as `code.planner-designation-updated@1` on a Project-scoped
  aggregate. Designating a thread in another Project, a nonexistent or
  archived thread, or a second planner refuses as a value, decided by pure
  domain policy before any side effect.
- The planner thread's agent gets two app-managed tools, registered through
  the same seam as `octant_terminal` and `octant_browser`, advertised and
  answered only for the currently designated planner thread; any other thread
  calling them gets a refusal value, never a throw.
  - `octant_board` is strictly read-only: it returns the Project's existing
    server-authoritative board read-model, scoped to the planner's own
    Project, with bounded cards. It performs no GitHub calls; cached PR facts
    arrive with the freshness the board already labels them with.
  - `octant_propose_thread` records an advisory, journaled, pending work
    proposal (`code.planner-proposal-updated@1`) bounded in size and in
    pending count. A proposal executes nothing.
- Proposals follow the propose/confirm discipline of delivery outcomes: the
  pending item is server state the user resolves. Confirming routes creation
  through the existing thread-creation commands with the user's own creation
  parameters, inside the proposal's own Project; declining discards. Nothing
  is ever created without explicit user confirmation, and every 0012 bound on
  agent runs is untouched.
- Planner authority never exceeds the thread's own authority. The board read
  and the proposal work under any access posture because neither has an
  effect an approval could gate; everything else the planner thread does
  remains subject to its ordinary posture, sandbox, and approvals.
- No agent-to-agent messaging is introduced or implied. 0063 remains blocked
  on its threat model; the planner reads a projection and petitions the user.

## Consequences

- A Project gains one thread with honest cross-thread sight, and the user
  stays the only party who turns judgment into running work.
- Two new journaled aggregates rebuild from the journal like every other
  projection; replay and erasure paths treat them as ordinary Code events.
- The board read-model gains a second consumer, which constrains how freely
  its shape can change.
- Deferred, each requiring its own record or follow-up: dispatching or
  redirecting running work, planner-proposed agent runs, cross-Project
  planning, and the renderer surface for designating the planner and
  resolving proposals (the server API and journaled state ship first).

## Related

- 0012 Mixed-provider subagents and agent runs
- 0027 Plans as journaled artifacts
- 0051 Board cards summarize plan progress
- 0063 Agent-to-agent messaging authority
