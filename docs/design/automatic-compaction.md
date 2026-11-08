# Automatic compaction

Status: Building (slice 3 of 4)
Size: Full — crosses contracts, the context service, every runtime adapter,
Settings and the provider-switch handoff.
Owner: maintainers · Started: 2026-11-07 · Approved: 2026-11-07, maintainer (Q-1 and Q-2 answered)
Working assumptions: rules are host-wide (Q-3 ruled Later).

This topic specification owns when Octant compacts a session without being asked
each time, and how a person sets those rules. Architecture owns what a
compaction is, who performs it, and its refusals
([Architecture: compacting a session on request](../architecture.md#context-and-usage-accounting)).
DESIGN.md owns the Settings controls.

## 1. Requirements

### Sources

| ID  | Location                                                     | What it contributes                                                                                                                      |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Maintainer request, 2026-11-07                               | "Auto-compaction … for providers and harness. Must be customizable … after inactivity or when limits are getting close … handover."      |
| S2  | `apps/server/src/context/sessionCompaction.ts`               | Requested compaction for Chat, Work and Code on every runtime that claims `sessionCompaction`; its refusals; local-window principal only |
| S3  | `apps/server/src/harness/nativeHarnessLoop.ts`               | Octant Harness compacts only on request; near the window it trims (drops older results, then whole exchanges) instead                    |
| S4  | `claudeAgentSdkPort.ts`, `codexDriver.ts`                    | Claude Code and Codex compact by themselves at their own point; Octant passes no threshold to either                                     |
| S5  | `providerUsageLimitsService.ts`, `ProviderRateLimitWindow`   | Per-instance account windows with `utilization` 0..1 and `status` allowed / warning / exhausted                                          |
| S6  | `agentRun/conversationHandoff.ts`, `code/codeForkHandoff.ts` | Provider switch and fork hand over a bounded raw selection of prompts and replies; no summary                                            |
| S7  | `completedThreadArchiveSweep.ts`                             | House pattern for a host-side periodic pass: self-rescheduling timer, setting read lazily                                                |
| S8  | `docs/architecture.md`, "Compacting a session on request"    | "The host never starts a replacement provider session seeded with its own summary behind the person's back."                             |

### Requirements

| ID    | Requirement                                                                                                                                                                              | Priority    | Acceptance criterion                                                                                                                                                                                         | Sources |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| FR-1  | A person can turn each automatic trigger on or off and set its number in Settings.                                                                                                       | Must        | Given Settings → General → Compaction, when the person picks "At 80% full", then the host's settings read back 80 and the next qualifying thread compacts at 80%.                                            | S1      |
| FR-2  | **Window fill trigger.** When a thread's last usage report shows the window at or above the set share, Octant compacts it before the next turn.                                          | Must        | Given the trigger at 70% and a Code turn on Octant Harness that ends at 72%, when the turn settles, then one compaction with reason `window-fill` is journaled and the next turn is built from its summary.  | S1, S3  |
| FR-3  | Where a runtime takes a compaction point (Claude Code, Codex), Octant hands it the set share, so the runtime also compacts at that point inside a long turn.                             | Should      | Given the trigger at 70%, when a Claude Code session opens, then its reported `autoCompactThreshold` is 70% of its window (± 1%).                                                                            | S1, S4  |
| FR-4  | Octant Harness compacts inside a turn, between model steps, when the next request would pass the set share, instead of trimming history.                                                 | Should      | Given the trigger at 70% and a harness turn whose next step would be at 75%, then the step is sent after a compaction, and no `OMITTED_HISTORY_NOTE` appears in that request.                                | S1, S3  |
| FR-5  | **Idle trigger.** A thread with no turn for the set time is compacted once, if its window holds at least a minimum.                                                                      | Must        | Given the trigger at 30 minutes and a thread whose last turn ended 31 minutes ago holding 60K tokens, then one compaction with reason `idle` runs; a second sweep 10 minutes later runs none.                | S1      |
| FR-6  | **Limit trigger.** When the thread's provider reports an account window at or above the set share, the thread is compacted after its turn settles.                                       | Must        | Given the trigger at 90% and a Claude Code turn after which the 5-hour window reads 91%, then one compaction with reason `limit-near` runs for that thread, and none for its next turn below a new crossing. | S1, S5  |
| FR-7  | After a limit-triggered compaction, the thread holds a portable handover summary that a provider switch or fork to another provider uses as its first block.                             | Must? (Q-2) | Given FR-6 fired on a Claude Code thread, when the person switches the thread to Codex, then the handoff's first block is that summary and its raw selection covers only turns after it.                     | S1, S6  |
| FR-8  | After a limit-triggered compaction the person is told, with a direct way to pick another model or provider.                                                                              | Should      | Given FR-6 fired, then the thread shows "Claude Code is at 91% of its 5-hour limit. This thread is compacted and ready to move." with **Switch model**.                                                      | S1      |
| FR-9  | Every automatic compaction says why it ran, on the timeline divider and the compaction receipt.                                                                                          | Must        | The divider reads "Compacted automatically · window 72% full" (or "· idle 31 min", "· 5-hour limit 91%").                                                                                                    | S1      |
| FR-10 | An automatic compaction passes every refusal a requested one passes, and is skipped silently when refused, leaving no trace.                                                             | Must        | Given a turn running, a spend ceiling reached, or a disabled mode, then no compaction runs and nothing is journaled.                                                                                         | S2      |
| NFR-1 | Automatic compaction never runs on a thread more than once per trigger crossing, and at most one runs per provider instance at a time.                                                   | Must        | A replayed journal and a restarted host do not start a second compaction for a crossing already handled.                                                                                                     | S2      |
| NFR-2 | The idle sweep costs no provider call when nothing qualifies.                                                                                                                            | Must        | A sweep over 500 idle threads with nothing qualifying makes zero provider requests and finishes in under 50 ms.                                                                                              | S7      |
| CON-1 | Automatic compaction replaces the confirm dialog with the person's setting; it never starts a new provider session seeded with Octant's summary on its own.                              | Must        | —                                                                                                                                                                                                            | S8      |
| CON-2 | New runtime behavior reaches the system through `@octant/provider-sdk` capabilities, not adapter-specific branches in the context service.                                               | Must        | —                                                                                                                                                                                                            | AGENTS  |
| ASM-1 | Claude Code accepts a compaction point through its environment, and Codex through `model_auto_compact_token_limit` in thread config. To be read at pinned releases before FR-3 is built. | —           | —                                                                                                                                                                                                            | S4      |

### Traceability

| Source statement                  | Disposition                        |
| --------------------------------- | ---------------------------------- |
| "auto-compaction … for providers" | FR-2, FR-3, FR-6                   |
| "… and harness"                   | FR-2, FR-4                         |
| "Must be customizable"            | FR-1; per-Project → Q-3            |
| "auto-compact after inactivity"   | FR-5                               |
| "when limits are getting close"   | FR-6, FR-8                         |
| "in case you want to handover"    | FR-7, FR-8; automatic switch → Out |

## 2. Scope

- In: FR-1 … FR-10, NFR-1, NFR-2, CON-1, CON-2.
- Out: switching a thread to another provider automatically. The person picks the
  next model (S8; maintainer, 2026-11-07, with the plan's approval).
- Later: per-Project or per-thread overrides (Q-3; host-wide rules first,
  maintainer, 2026-11-07).

## 3. Conceptual design

### Purpose

Compact a thread at the moments a person chose — the window filling, the thread
going quiet, or the provider's account limit getting close — so the next turn is
cheaper and a move to another model loses little. It never deletes history, never
switches provider by itself, and never runs where a requested compaction would be
refused.

### Context map

```
 Person ──settings──▶ [ Octant host ] ──compact request──▶ Runtime (Claude Code, Codex, Harness, …)
                         ▲      │                              │
           usage + limit │      └─ journal (receipts, reasons) │
             reports ────┴─────────────────────────────────────┘
```

Trust boundary: host → runtime. The threats are a compaction spending budget the
person did not expect (denial of service on their quota) and a compaction sending
a thread's conversation where its Project's provider policy forbids (disclosure).
Both are closed by FR-10: the same admission as a requested compaction, plus the
spend ceiling.

### Capabilities

| Capability                              | FR               |
| --------------------------------------- | ---------------- |
| Hold the person's compaction rules      | FR-1             |
| Decide that a thread should compact now | FR-2, FR-5, FR-6 |
| Push the fill point into runtimes       | FR-3, FR-4       |
| Run a compaction with no window present | FR-10, NFR-1     |
| Hand a summary to the next model        | FR-7, FR-8       |
| Explain each compaction (cross-cutting) | FR-9             |

### Components

| Component                | Responsibility                                                                                   | Requirements                   |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| Compaction rules         | The settings schema, defaults, and pure decision "compact now, and why" from facts               | FR-1, FR-2, FR-5, FR-6         |
| Compaction scheduler     | Calls the decision after each settled turn and on an idle sweep; starts at most one per instance | FR-2, FR-5, FR-6, NFR-1, NFR-2 |
| Session compaction       | The existing service, given a `host-policy` caller that carries the thread's last-turn authority | FR-10, CON-1                   |
| Runtime compaction point | A provider-sdk capability through which an adapter takes the fill point                          | FR-3, FR-4, CON-2              |
| Handover summary         | A host-written, provider-neutral summary kept on the thread and read by the switch/fork handoff  | FR-7, FR-8                     |

### Domain concepts

- **Trigger crossing**: the moment a measured value first reaches a rule's number.
  It resets only when the value falls back below (after a compaction, a new
  window period, or a reset limit).
- **Compaction reason**: `window-fill`, `idle`, `limit-near`, or `requested`.
- **Handover summary**: text Octant itself holds, unlike a runtime's own summary,
  which stays inside that runtime's session.

## 4. Logical design

### Component contracts

- **Compaction rules** (pure, `packages/domain`): `decideAutomaticCompaction(rules, facts) → { compact: false } | { compact: true, reason, crossing }`.
  Facts: last window fill and window size, last turn end, last compaction and its
  crossing, account windows for the instance, now.
- **Compaction scheduler** (server): `turnSettled(threadRef)` (sync enqueue,
  best-effort) and `sweep()` every minute. Starts compactions through Session
  compaction with a deterministic `compactionId` derived from thread, reason and
  crossing, so a repeat is the same compaction (NFR-1; idempotency already in S2).
- **Session compaction**: new caller `host-policy`. It is admitted where
  `local-window` is, minus the window check, plus: the rules are on, and for Code
  the checkout is the one the thread's last turn resolved, re-checked against the
  Project's current binding. A move refuses `no-session`.
- **Runtime compaction point** (`@octant/provider-sdk`): capability
  `compactionPoint: supported | unsupported`; session open receives
  `compactionPoint?: { share: 0.5..0.95 }`.
- **Handover summary**: `write(thread)` after a `limit-near` compaction (Q-2);
  `latest(thread) → { text, throughTurn } | undefined`, read by
  `providerSwitchHandoffRecord` and `selectCodeForkHandoff`.

### Data ownership

| Datum                  | Owner                         | Readers                          |
| ---------------------- | ----------------------------- | -------------------------------- |
| Compaction rules       | Shell settings                | Scheduler, adapters, Settings UI |
| Crossings handled      | Journal (compaction events)   | Scheduler (on restart)           |
| Window fill per thread | Turn usage journal (existing) | Scheduler                        |
| Account windows        | Provider usage limits service | Scheduler, FR-8 notice           |
| Handover summary       | Context journal (new event)   | Switch and fork handoff          |

### Scenario walkthroughs

1. **Harness fill, between turns (FR-2, FR-9, NFR-1).** Turn ends at 72% →
   runner calls `turnSettled` → decision `window-fill` → Session compaction
   (`host-policy`, id from crossing) → harness `compact` → receipt with reason →
   divider. A restart replays the receipt; the same crossing is handled.
2. **Claude Code long turn (FR-3).** Session opens with share 0.7 → runtime
   compacts by itself mid-turn → existing `TurnCompactions` journals it → the
   between-turn check sees the fill below 70% and does nothing.
3. **Idle (FR-5, NFR-2).** Sweep reads last-turn times from projections (no
   provider call), finds one thread idle 31 min at 60K → compacts it. Next sweep:
   crossing already handled.
4. **Limit near, then switch (FR-6, FR-7, FR-8).** Turn settles, usage limits read
   91% → compact (`limit-near`) → handover summary written with the same provider
   → notice with Switch model → person picks Codex → handoff leads with the
   summary plus later turns.
5. **Refused (FR-10).** Spend ceiling reached → Session compaction refuses →
   scheduler journals a skip, shows nothing.

### NFR mechanisms

| NFR   | Mechanism                                                | Arithmetic                                                                       |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| NFR-1 | Deterministic id per crossing + per-instance single slot | Same id → existing record (S2); one slot → at most N instances running at once   |
| NFR-2 | Sweep reads projections only; decision is pure           | 500 threads × one indexed row read + a pure check ≈ well under 50 ms; 0 requests |

### Risk register

- ASM-1 is unverified. If a runtime takes no compaction point, FR-3 falls back to
  the between-turn check for it (the turn can still overrun mid-turn).
- A compaction costs one full read of the window. Idle compaction of a thread the
  person never returns to is pure cost, so idle needs a minimum fill and is off by
  default.
- `limit-near` spends a little of the quota that is running out. The summary is
  one request; that is the price of a usable handover.
- A Code compaction without a window is the new authority path (slice 1 tests it
  first).

## 5. Decisions

### D-1: Automatic compaction reuses the requested path (Accepted, 2026-11-07)

Context: requested compaction already has admission, refusals, receipts and
dividers for every runtime (S2). Options: (a) a second compaction path for
automatic runs; (b) the same service with a `host-policy` caller. Choice: (b).
Consequences: one set of refusals; Code needs a windowless checkout resolution.

### D-2: Limit trigger writes a portable handover summary (Accepted, 2026-11-07)

Context: a runtime's own summary stays inside its session, so a switch to another
provider gets today's raw selection (S6). Options: (a) compact only; (b) compact
and also write a host summary with the same provider. Choice: (b); the maintainer
chose it on 2026-11-07 (Q-2).
Consequences: one extra summary request per crossing; switch and fork handoff
read it.

### D-3: Window fill is on at 85% for threads Octant keeps (Accepted, 2026-11-07)

Options: (a) every trigger off; (b) window fill on at 85% for Octant Harness and
host-planned threads, where today the only answer near the edge is trimming.
Choice: (b); the maintainer chose it on 2026-11-07 (Q-1). Runtimes that compact
by themselves keep their own point unless the person sets one.

### D-4: A rule acts under the window whose turn crossed it (Accepted, 2026-11-07)

Context: a Code compaction resumes the session in the checkout a window resolves
(`resolveCheckoutRoot`, `effectiveThread`), and no windowless path exists.
Options: (a) add a host-authority checkout resolution for rules; (b) pass the
turn's own window with the turn's end, and refuse a Code rule without one.
Choice: (b). It adds no new authority path; the window that just ran a turn on
the checkout is the one that compacts it. Consequences: the idle rule (slice 2)
needs a window that can still open the thread, or it skips Code threads.

### D-5: The handover summary covers Chat and Work; Code waits (Superseded by D-6)

Context: the host holds the whole conversation of a Chat or Work thread
(`sessionCompactionConversation`), so it can ask the thread's own provider for a
summary of it before the runtime compacts. A Code thread's conversation lives in
its runtime session and its operation journal; the host reads it only as the
bounded selection a switch hands over. Options: (a) build a full Code
conversation reader in this slice; (b) write the summary for Chat and Work, and
let a Code thread's switch keep today's bounded selection. Choice: (b), so the
limit rule, its notice and **Switch model** reach every mode now, and a Code
reader is its own change. Consequences: FR-7 holds for Chat and Work only; a
Code thread is still compacted and told it is ready to move.

### D-6: Code threads get the handover summary too (Accepted, 2026-11-08)

Context: the maintainer asked for every part not yet built, D-5's Code gap
included. The host can read a Code thread's public conversation from its
operation journal and evidence store, the same sources its export and its
switch handoff read. Options: (a) leave Code on the raw selection; (b) read
the whole conversation (prompts and finished replies, rewound turns left out)
for the summary, run the summary in a private host folder rather than the
checkout, and lead a Code provider switch with it. Choice: (b). Consequences:
FR-7 holds in every mode; a fork's first turn still hands over as before,
since its handoff carries the source's turns, which the summary never read.

## 6. Build plan

| Slice | What it delivers                                                                                                                           | Requirement IDs                       | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------- |
| 1     | Rules in settings + pure decision; `host-policy` caller; window-fill trigger between turns on every runtime; reason on receipt and divider | FR-1 (fill), FR-2, FR-9, FR-10, NFR-1 | Built   |
| 2     | Idle sweep                                                                                                                                 | FR-1 (idle), FR-5, NFR-2              | Built   |
| 3     | Limit trigger, notice, handover summary read by switch and fork                                                                            | FR-1 (limit), FR-6, FR-7, FR-8        | Planned |
| 4     | Runtime compaction point (Claude Code, Codex) and in-turn harness compaction                                                               | FR-3, FR-4                            | Planned |

## 7. Open questions

| ID  | Question                                                                     | Blocks |
| --- | ---------------------------------------------------------------------------- | ------ |
| Q-1 | Answered 2026-11-07: window fill on at 85% for threads Octant keeps (D-3).   | —      |
| Q-2 | Answered 2026-11-07: yes, the limit trigger writes a handover summary (D-2). | —      |
| Q-3 | Host-wide rules first; per-Project overrides wait (Later).                   | —      |

## 8. Detailed design

### Slice 1: window fill between turns

- **Settings** (`packages/contracts/src/shell.ts`): `autoCompactOctantWindowPercent`
  (`AutoCompactWindowPercent | null`, default 85) and
  `autoCompactRuntimeWindowPercent` (default `null`, "Runtime decides").
  `AutoCompactWindowPercent` is an integer from 50 to 95. Settings → General →
  Compaction offers Off, then 50, 60, 70, 75, 80, 85, 90 and 95.
- **Cause** (`packages/contracts/src/context.ts`): `ContextCompactionCause`, for
  example `{ "kind": "window-fill", "filledPercent": 91, "thresholdPercent": 85 }`.
  It is optional on `context.compaction-requested@1`, on the running and failed
  records, and on the receipt; `requestedBy` also takes `host-policy`. Older
  events decode unchanged.
- **Decision** (`packages/domain/src/contextCompaction.ts`):
  `decideWindowFillCompaction` compacts when `tokens × 100 ≥ threshold × window`,
  never on an unnamed window, and after a rule's last attempt only once the window
  has grown `WINDOW_FILL_RETRY_POINTS` (5) points beyond where that attempt left
  it: the fill after a completed one, the fill a failed one started from. A
  compaction that frees little because the kept tail alone passes the share is
  therefore not paid for after every turn.
- **Service** (`sessionCompaction.ts`): principal `host-policy`, admitted where a
  local window is; `start(command, principal, windowId, cause)`; a Code rule
  with no window is refused `no-session` before anything is journaled.
  `windowFill(subject)` reads the fill from stored facts exactly as a compaction
  reads its figure before (`occupancyBefore`): the runtime's latest report (Code
  adds `contextWindow` to `latestWindowOccupancy`), else the plan's latest usage,
  else the plan's estimate, and never a report older than a later compaction; `keeper` is `octant` where the
  instance's driver keeps no conversation of its own.
- **Rule** (`windowFillCompaction.ts`, now `turnEndCompaction.ts`): hears every settled turn through
  `observeTurnEnded` in the harness wiring (Chat, Work and Code all end there),
  picks the share by keeper, and starts the compaction under an id derived from
  the thread and the turn's end, so the same end seen twice is one compaction.
  It asks again up to three times, 500 ms apart, while the ending turn still
  holds the thread (`turn-running`), and stops on any other refusal.
- **Text** (`sessionCompactionPresentation.ts`): "Compacted automatically ·
  window 91% full · 41.2K freed · summary by Octant Harness"; "Compacting
  automatically…"; "Couldn't compact automatically: …".

Failure modes: a rule that cannot read the thread leaves it alone; a rule waits
for 5 more points after its last attempt; a restart closes a running rule compaction as
`interrupted`, exactly as a requested one.

### Slice 2: idle sweep

- **Setting** (`shell.ts`): `autoCompactIdleMinutes` (`AutoCompactIdleMinutes | null`,
  5 to 1440, default `null`). Settings → General → Compaction → **Compact quiet
  threads** offers Never, then 15, 30, 60, 120 and 240 minutes.
- **Cause**: `ContextCompactionCause` becomes a union; the idle member is, for
  example, `{ "kind": "idle", "idleMinutes": 31, "thresholdMinutes": 30 }`.
- **Decision** (`decideIdleCompaction`): compacts when whole minutes since the
  last turn's end reach the rule and the window holds at least
  `IDLE_COMPACTION_MIN_TOKENS` (20,000). Below that the compaction's own read of
  the window costs more than the next turn saves.
- **Rule** (`idleCompaction.ts`, `IdleCompactions`): the same turn-end observer
  records each thread's last end and its window in memory. A pass every minute
  checks the time first, so a thread not yet due costs no read; a due thread is
  skipped if any compaction ran or started since its last turn. One attempt per
  quiet spell, under an id derived from the turn that began it; only
  `turn-running` keeps the spell for the next pass. While the rule is off the
  pass forgets every spell, so turning it on never compacts a backlog at once.
  The timer starts once the
  host serves and stops at shutdown, like the completed-thread sweep.
- **Service**: option `windowOpen`, read from the window authority store. A rule
  on a Code thread whose window has closed is refused `no-session` before
  anything is journaled, since `open` could not resume its session and would
  leave a failed compaction. Slice 1's rule gets the same check.
- **Text**: "Compacted automatically · idle 31 min · …"; from two hours,
  "idle 2 h".

Failure modes: a pass that throws is dropped and the timer goes on; a refused
spell waits for the thread's next turn.

### Slice 3: limit rule and handover summary

- **Setting**: `autoCompactLimitPercent` (`AutoCompactLimitPercent | null`, 50 to
  99, default `null`). Settings → General → Compaction → **Compact near a usage
  limit** offers Never, then 75, 80, 85, 90 and 95% used.
- **Cause**: `{ "kind": "limit-near", "window": "five_hour", "usedPercent": 91,
"thresholdPercent": 90 }`. `window` is the provider's own name for the account
  window, as `ProviderRateLimitWindow.window` carries it.
- **Decision** (`decideLimitCompaction`): over the instance's stored account
  windows, the fullest one at or past the rule, counting an exhausted window
  with no share as 100%. Its crossing is the window plus `resetsAt`, so a thread
  is compacted once per limit period. A window with no reset, or one already
  reset, is passed over.
- **Rule** (`turnEndCompaction.ts`, `TurnEndCompactions`, renamed from slice 1's
  window-fill rule): after a turn, the limit rule is judged first and the
  window-fill rule only when it does not act, since one compaction serves both
  and only the limit rule writes a handover. The account windows come from
  `ProviderUsageLimitsService.snapshot()`, a stored reading; no provider is asked.
  Once the period's compaction exists, later turns in that period go to the
  window-fill rule, so a limit that stays high never stands in for it.
  `windowFill` also returns the thread's provider instance.
- **Handover** (`sessionCompaction.ts` `#writeHandover`): for a `limit-near`
  compaction of a runtime-kept thread (Code since D-6), the host first asks the
  thread's own provider, tool-free, for a summary of the conversation it holds
  (newest first, at most 400,000 characters), then asks the runtime to compact.
  The text is stored in the summary content store, committed with the receipt,
  which names it as `handover.summaryId` with `throughSource`, the last message
  it read. A host-summarized thread needs none: its stored summary is the
  handover. A summary that fails lets the compaction go on without one. What it
  reads is fixed when the rule asks, and the spend ceiling reserves for it (its
  input plus 3,000 tokens of answer) beside the compaction, so a ceiling with
  room for only one refuses the rule.
- **Switch** (`withHandoverSummary`): a provider switch in any mode (not a Code fork) reads
  `ContextHarnessService.handoverSummary` (the latest compaction, if the limit
  rule made it, and only while the last message it read is still in the
  thread, so a rewind past it never brings removed turns back) and leads the handoff with it in up to three 4,000-character
  blocks after the framing block. Where that leaves no room, the oldest verbatim
  messages give way and count as earlier messages. The record says
  `handoverSummary: true`. The summary is cut to 11,500 characters when written,
  so a switch carries all of it. A later switch on (A to B to C) still leads with
  A's summary until another compaction replaces it; the newest messages follow
  it verbatim.
- **Notice**: under the divider, "Codex is at 91% of its 5-hour limit. This
  thread is compacted and ready to move." with **Switch model**, which opens the
  composer's model picker through the composer scope.

Failure modes: a reading with no account windows never acts; a ledger that
cannot be read hands a switch the raw selection, as before.

## 9. Verification

| Acceptance criterion                                           | Test                                                                                                                                                                                                   | Result | Change      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------- |
| FR-1 (fill): Settings writes both shares                       | `SettingsView.test.tsx` "compacts Octant threads at 85% by default and leaves runtimes…"                                                                                                               | Pass   | This change |
| FR-1 (fill): rendered on an isolated host                      | Playwright on a scratch host: defaults shown, 70% survives a reload, no clipping at 1280 and 390 wide, no console errors                                                                               | Pass   | This change |
| FR-2: compacts past the share, under the turn                  | `windowFillCompaction.test.ts` (7 tests); `contextCompaction.test.ts` window-fill tests                                                                                                                | Pass   | This change |
| FR-2: host compaction records cause and requester              | `sessionCompaction.test.ts` "records a compaction a rule the person set started…"                                                                                                                      | Pass   | This change |
| FR-9: timeline names the rule and the fill                     | `CompactionDivider.test.tsx` "says which rule compacted the thread…"                                                                                                                                   | Pass   | This change |
| FR-10: refused rule leaves nothing behind                      | `windowFillCompaction.test.ts` "stops after any other refusal…"; `sessionCompaction.test.ts` "refuses a rule on a Code thread with no window…"                                                         | Pass   | This change |
| NFR-1: no repeat after a compaction that freed little          | `windowFillCompaction.test.ts` "does not compact again after a rule's compaction that freed too little"                                                                                                | Pass   | This change |
| NFR-1: one compaction per turn end                             | `windowFillCompaction.test.ts` "gives the same turn's end announced twice the same compaction id"                                                                                                      | Pass   | This change |
| FR-1 (idle): Settings writes the minutes, off by default       | `SettingsView.test.tsx` "leaves quiet threads alone by default…"                                                                                                                                       | Pass   | This change |
| FR-5: one compaction per quiet spell, above the minimum        | `idleCompaction.test.ts` (8 tests); `contextCompaction.test.ts` "compacting a quiet thread"                                                                                                            | Pass   | This change |
| FR-5: Code only under an open window                           | `sessionCompaction.test.ts` "refuses a rule on a Code thread with no open window…"                                                                                                                     | Pass   | This change |
| FR-9 (idle): timeline says how long it was quiet               | `CompactionDivider.test.tsx` "says how long the thread was quiet…"                                                                                                                                     | Pass   | This change |
| NFR-2: a pass with nothing due reads nothing                   | `idleCompaction.test.ts` "reads nothing and asks no provider…" (500 threads, under 50 ms, zero reads)                                                                                                  | Pass   | This change |
| FR-1 (limit): Settings writes the share, off by default        | `SettingsView.test.tsx` "leaves the limit rule off by default…"                                                                                                                                        | Pass   | This change |
| FR-1 (idle, limit): all four rows rendered on an isolated host | Playwright on a scratch host: defaults shown, 30 minutes and 90% survive a reload, no clipping at 1280 and 390 wide, no console errors                                                                 | Pass   | This change |
| FR-6: once per limit period, ahead of window fill              | `turnEndCompaction.test.ts` limit tests; `contextCompaction.test.ts` "compacting when an account limit gets close"                                                                                     | Pass   | This change |
| FR-7: handover written first, stored with the receipt          | `sessionCompaction.test.ts` "writes a handover summary with the thread's own provider…", "writes no handover summary…"                                                                                 | Pass   | This change |
| FR-7: a switch leads with the handover                         | `conversationHandoff.test.ts` "handing a thread to another provider after the limit rule"                                                                                                              | Pass   | This change |
| FR-8: notice, and Switch model opens the picker                | `ComposerModelPicker.test.tsx` "opens from the limit notice under a compaction…"                                                                                                                       | Pass   | This change |
| FR-7 for Code threads                                          | `codeSessionConversation.test.ts`; `sessionCompaction.test.ts` "writes a handover summary for a Code thread…"; `codeOperationRuntime.test.ts` "leads a provider switch with the limit rule's summary…" | Pass   | This change |
| FR-6 to FR-8 on a real runtime                                 | Not run: needs a live provider near its account limit                                                                                                                                                  | Open   | —           |
| FR-2 on a real runtime                                         | Not run: needs a live Octant Harness endpoint turn past 85%                                                                                                                                            | Open   | —           |

## 10. Codebase deltas and change log

### Codebase deltas

- FR-10 said a refused rule journals its skip. Refusals in this service leave no
  trace by design (S2), and a skip per turn would flood the ledger, so the
  requirement now says nothing is journaled.
- The design placed the window-less Code path in the service; D-4 replaces it
  with the turn's own window.
- Review found that the first back-off applied to failed attempts only, so a
  completed compaction that left the window above the share was repeated after
  every turn, and that host threads read a usage report older than the latest
  compaction. Both are fixed as described in Slice 1.
- The design had the idle sweep read last-turn times from projections. It
  reads the turns that ended while the host ran instead: that is also where it
  learns each Code turn's window (D-4), and it keeps a pass free of reads. A
  thread whose last turn ended before the host started is not compacted for
  being idle.
- FR-7 said the raw selection after a handover covers only turns after it. The
  switch keeps the newest verbatim messages instead, and drops only the oldest
  when the summary needs room: the next model benefits from the exact last
  words, and the overlap is bounded by the handoff's own block limit.
- FR-7 covered Chat and Work only (D-5) until D-6 added Code. A Code fork's
  first turn still hands over without the summary.
- Slice 1's `WindowFillCompactions` became `TurnEndCompactions`, since it now
  judges the limit rule too.
- Review found that a limit period already answered still claimed every later
  turn, so the window-fill rule never ran in that period; that "Switch model"
  opened every picker under the workspace's shared scope; and that a 20,000
  character summary lost its end in a switch. Each is fixed as Slice 3 says.
- A second review found that a rewind after the limit rule still handed the
  summary over, with the turns the rewind removed, and that the spend ceiling
  reserved for the compaction alone. Both are fixed as Slice 3 says.

### Change log

- 2026-11-07: First draft from the maintainer request and the current code.
- 2026-11-07: Q-1 and Q-2 answered; D-1 to D-3 accepted, D-4 added; slice 1
  built with its detailed design and verification.
- 2026-11-07: Slice 2 (idle rule) built.
- 2026-11-07: Slice 3 (limit rule, handover summary, notice) built; D-5 added.
- 2026-11-08: Code handover summary built; D-6 supersedes D-5.
