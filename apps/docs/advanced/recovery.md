---
description: Journal-based recovery, replay, rebuilds, conflict recovery, and diagnostic tooling.
---

# Recovery and Troubleshooting

Octant's recovery model is built on the durable event journal: every
meaningful action is journaled as a versioned event, and every projection can
be rebuilt from that journal. This makes crashes and interruptions recoverable
instead of destructive.

## The event journal

The journal is append-only and stores versioned envelopes carrying event,
aggregate, sequence, correlation, causation, actor, and timestamp identity.
Optimistic concurrency uses expected aggregate versions. A termination before
commit writes nothing; after commit, the full batch is preserved even if the
caller never received a response. Repeating an operation with the same event
IDs cannot duplicate work.

Malformed or unsupported events are **quarantined** with typed reasons and
stop the affected projection without rewriting history. Ambiguous recovery
state is always **Waiting** or **recovery-required**, never **Done** or
healthy.

## Low memory

Octant watches how much memory its host process uses and what your system says
about memory pressure. It reads both on your machine only and sends nothing
anywhere.

When memory runs low, the host first stops what is only waiting: provider
processes with no turn using them and sessions kept warm for a quick reply. It
then frees caches it can rebuild. A running turn is never stopped; the notice
tells you how many kept going. Your next message starts a stopped provider
again, so the cost is a slower first reply.

You see a short notice only when something was stopped or memory was very low.
Settings, then Host, shows the current memory level, the host's size, and the
last relief.

If the host ends without a clean stop, for example because the system ran out
of memory, the per-user service starts it again. The next time Octant opens, it
tells you the host stopped unexpectedly and shows the last memory reading it
took. That reading is a hint, not a diagnosis: a normal reading means the cause
is not known.

## Recovery tooling

Operator commands cover the journal and projections:

- `db:status` — inspect database and projection state
- `db:verify` — verify the journal and projections
- `db:rebuild` — rebuild projections from the journal
- `db:rebuild --projection <name>` — rebuild a single projection

Rebuilds never edit or delete journal events. Quarantine retirement happens
only after a successful explicit rebuild. A confirmed thread purge is the
separate data-lifecycle exception: it removes that thread's own journal
events so a later rebuild cannot resurrect the transcript, and it records a
tombstone rather than leaving a hole with no explanation.

## Saving diagnostics to ask for help

When something is wrong and you want someone to look, Octant can write one
file about your host. Open **Settings › Host › Maintenance** and choose
**Save diagnostics…**, or run this in a terminal on the same computer:

```sh
octant diagnostics export --out ~/Downloads/octant-diagnostics.zip
octant diagnostics export --list
```

Before anything is written, Octant lists what the file will include and what it
never includes. In Settings you then choose **Save file** or **Cancel**; in the
terminal the same list prints first, and `--list` stops after it. `--out` takes a
name ending in `.zip`, or a new or empty folder, and never overwrites.

The file holds:

- Octant and runtime versions, and your operating system, processor type, and memory.
- Each enabled provider by kind: whether it is ready, signed in, and which
  capabilities it reports. Not its name, address, or models.
- The newest 200 host log lines, and the names and times of the newest 200
  journal events. The events' contents stay out.
- Your default guardrail level, how many Code threads run at each level, and the
  sandbox tools Octant found.
- Uptime, memory, processor time, and slow-statement counters.

It never holds messages, prompts, replies, file contents, Project or thread
names, API keys, tokens, or passwords. Your home folder shows as `~`. Octant
sends the file nowhere: you read it, and you choose whether to send it. Octant
records that you saved one, with the time and the kind of place (for example
Downloads), never the folder name or anything the file holds.

This is separate from **Failure report** in the same place, which exports a
redacted report about one failed operation, found by its correlation ID.

## User-level recovery

- **Chat**: a failed or interrupted turn states why in the transcript. The
  sentence is Octant's, taken from a bounded code on the attempt, and the
  support correlation stays beside it. A call the app itself is running does
  not hang the turn past the turn's own deadline.
- **Local clients**: reopening Electron after sleep or a host restart renews
  its client context automatically. A browser tab keeps its session across a
  reload; after a host restart it asks you to open Octant from the desktop app
  or run `octant web` again, because a browser session starts only from that
  one-time link. Neither creates another store or needs a recovery workflow.
- **Connection lost**: a Chat thread that cannot reach the host shows one notice,
  **Can't reach the host**, with **Retry now**, and changes to **Reconnected** for a
  moment when the host answers. The subagent card and the message queue only dim
  and disable their controls meanwhile; your draft is kept.
- **Threads**: reconnect resumes from bounded live cursors. If a cursor belongs
  to an older host process or fell outside replay, the client reloads the
  thread from the host before applying more updates.
- **Queued messages**: once Octant acknowledges a queued message, the host
  retains it and its attachments when you close the conversation. You can
  inspect, edit, reorder or remove pending messages from the queue. Normal
  completion starts the next message. A stopped or failed turn, changed access
  or unavailable attachment holds the queue and explains why. While the host
  holds queued follow-ups, the composer shows **Follow-up paused** with
  **Resume** without opening the queue. After a host
  restart, review the retained messages and choose **Resume**. Octant
  checks current access again and never blindly repeats an uncertain send.
  If the connection drops before confirmation, use **Check queue** after
  reconnecting. Octant keeps the original submission identity across navigation
  and reload, and preserves any newer draft you have written.
  If you changed the provider, model or access settings, restore the original
  settings before resuming, or remove and resubmit the message. Queue controls
  are available in authenticated local windows; paired remote clients do not
  support them yet.
- **Settings**: a failed settings command restores the last authoritative
  value and announces the failure.
- **Zen**: when state cannot be decoded, **Recover Zen** restores the main
  workspace instead of trapping you; Zen rebuilds from the journal after
  restart or reconnect, and concurrent mutations surface a version conflict
  with a refresh.
- **Editor**: a stale save blocks with a conflict result that preserves the
  authoritative file and your draft. See
  [Editor and terminals](/advanced/editor-and-terminals).
- **Worktrees**: ambiguous repository identity or inventory becomes
  `waiting` or `unavailable` and is never pruned automatically. See
  [Git and worktrees](/advanced/git-worktrees).
- **Extensions**: the extension supervisor quarantines crash-looping
  components and reconciles after restart; interrupted installs recover to
  an honest state, never a visible partial package. See
  [Plugins and skills](/advanced/plugins-and-skills).
- **Previews**: a missing, changed, revoked, or offline source restores as an
  honest unavailable or stale placeholder, never a silently substituted file.

## Previews and evidence honesty

Octant never infers a green from partial output. Preview and validation
surfaces show distinct states for denied, missing, stale, superseded,
interrupted, failed, and inconclusive results, and keep superseded runs from
being resurrected by delayed completion.

## Next steps

- [Privacy and security](/advanced/privacy-and-security) for where data lives
- [Remote access](/advanced/remote-access) for reconnect and replay behavior
- [Release compatibility](/advanced/release-compatibility) for migration boundaries
