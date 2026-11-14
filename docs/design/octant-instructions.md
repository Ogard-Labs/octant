# Octant instructions

This topic specification owns the instructions a person writes for Octant
itself: one text for the person, an optional one per Project, and an
orchestration text for coordinator threads. It owns where they are kept, who
may change them, how they reach a turn, and how they stand beside a provider's
own instruction files. Architecture owns the context a turn is built from
([Held standing context](../architecture.md#held-standing-context)) and person
memory ([Person memory](../architecture.md#person-memory)); Coordinator threads
owns the coordinator role ([Coordinator threads](coordinator-threads.md)).

Status: partly built. Built: the contracts and journal events, your
instructions as a `person-instructions` block in Chat, Work, and Code on every
provider and in Octant Harness's system prompt, the route that changes them,
the inspector label, Export my data, the Your instructions field in
Settings › General, and Project instructions with their `project-instructions`
block and field beside Project memory. Designed, not built: orchestration
(delivery slice 4).

## Why

Octant supplements the providers it runs and never replaces them: a provider
reads its own instruction files, and any workflow that works in the provider's
own app works in Octant (maintainer decision, 2026-11-14). Those files describe
how one agent should work. They cannot say what only Octant knows: which
provider or model should take which kind of job, how a coordinator should split
work and hand it back, when to use the board, Canvas, routines, or wake-ups,
and the person's rules for work that crosses threads and providers. Person
memory is learned, not written, and is framed as data rather than instructions,
so it cannot carry a rule the person wants followed.

## Three texts

| Text                 | Written where                                 | Reaches                                                                                  | Limit       |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| Your instructions    | Settings › General, under Your identity       | Every new turn in Chat, Work, and Code, on every provider, in every Project              | 8,000 chars |
| Project instructions | The Project's settings, beside Project memory | Every turn in that Project's threads, after your instructions                            | 4,000 chars |
| Orchestration        | Settings › General, under Your instructions   | Coordinator threads only (and a Project's designated planner), after the two texts above | 4,000 chars |

Each text is plain text the person writes. Octant never generates, rewrites,
or appends to it, and an empty text sends nothing.

Orchestration is for the coordinator's job: when to start a worker rather than
do the work itself, which provider and model suits which kind of task, how a
worker should report back, and when to stop and ask. A coordinator still starts
workers only under its start setting and bounds
([Coordinator threads](coordinator-threads.md#the-start-setting)); the text
guides its choices and grants nothing.

## Beside the provider's own files

The texts are added to what a provider already reads, never put in its place:

- **No file is written.** Octant never writes the texts into a Project folder,
  a home folder, `CLAUDE.md`, `AGENTS.md`, or any file a provider reads, the
  rule Architecture already sets for agent briefs.
- **No system prompt is replaced.** The texts travel as standing context beside
  the person's message (below), so a provider's own system prompt and its own
  instruction files reach the model exactly as they do outside Octant.
- **Which wins.** The texts open by saying they are the person's instructions
  for working inside Octant: Octant's features, Octant's tools, and work
  across threads and providers. On how the provider itself works (coding
  style, a repository's conventions), the provider's own instruction files
  come first. The texts do not try to restate those files; a text that
  duplicates them is the person's choice, and Octant does not deduplicate it.

Rationale: one cross-provider copy of a person's coding rules was considered
and rejected. It would drift from the provider files the person already keeps,
it would compete with them, and a provider used outside Octant would not see
it. Limiting the texts to what only Octant knows keeps Octant a supplement.

## How a turn receives them

- **Blocks.** Your instructions are one `person-instructions` context block,
  Project instructions one `project-instructions` block, and orchestration one
  `orchestration-instructions` block. They are placed after Octant's own
  instructions and before person memory, Project memory, and the conversation,
  in that order.
- **Standing.** Each is a standing block under the rules of
  [Held standing context](../architecture.md#held-standing-context): a
  session that holds it is not sent it again, so a provider's prompt cache
  keeps its prefix. A thread takes the texts as they are when its session
  starts or resumes; a change the person makes reaches a running session once,
  at its next turn, as a keyed revision that follows the earlier copy.
- **Octant Harness.** The harness adds them to its system prompt after
  Octant's instructions, as it does for `instructions`.
- **Every turn.** Unlike person memory, the texts also reach turns Octant
  starts itself (a routine, a wake-up, a message wake, a coordinator's
  worker), because they are rules the person wrote for all work in Octant. A
  provider's own subagent sees them only if its provider passes the lead's
  context to it; Octant does not inject them into a subagent.
- **Plan and Chat.** Plan and Chat get them too. They change nothing about
  what Plan or Chat may do: Plan stays read-only and Chat keeps no folder and
  no shell.
- **Inspector.** The context inspector lists each block by name (Your
  instructions, Project instructions, Orchestration) with its size in Chat and
  Work. A Code window, which is counted by part, counts them with Octant's
  instructions, as it counts person memory: the runtime's part list is a
  closed set, and a part per text would widen it for three small blocks.
- **Key.** Each block carries a fixed key, so an edit is a revision of the copy
  a session holds rather than a withdrawal. Clearing a text does withdraw it:
  a running session is sent its whole standing context again without the text
  (the rule in Held standing context), so a cleared rule never stands alone in
  its history.

## Authority

- **No authority.** The texts grant nothing. They cannot change a thread's
  level, allow a tool, lift a guardrail, start a worker past its bounds, or
  answer an approval. An approval is still answered only by the person or the
  level's reviewer, whatever a text says.
- **Who changes them.** Only a person, from a local window on this host or a
  device the host's own person paired (maintainer decision, 2026-11-12). No
  agent, routine, peer, hub, or spoke may read-modify-write them, and no tool
  writes them.
- **Journal.** Each change is journaled with the whole new text under the
  record's expected version (`person-instructions.changed@1`,
  `project-instructions.changed@1`); a stale version is refused. Agents may
  read the texts only as the context blocks above. The route
  (`/api/octant-instructions`) answers a client that does not act as the
  host's person read-only, refuses its change, and refuses an agent grant's
  session even a read; the journal refuses a change whose actor is an agent or
  the host itself.
- **Secrets.** The editor warns when a text looks like it holds a secret (the
  same checks person memory runs, shared from
  `@octant/domain/secret-shaped-text-policy`). The text is kept as written,
  since Octant never rewrites it; logs redact secret values as they do
  everywhere.

## Where they are kept

- On this host only. They are not synced to a hub or spoke and travel with no
  thread, the rule person memory follows.
- Export my data carries them: an `instructions` page with the three texts.
- Deleting a Project deletes its Project instructions. A Project is archived
  rather than removed, so this is the Project-scoped purge that already erases
  Project memory: it erases the `project-instructions` aggregate from the
  journal and the host stops sending the block at once. Turning off a text
  (clearing it) sends nothing from the next session on.
- A Project block's key names its Project, so a thread is never sent another
  Project's text as a revision of its own. A change for a Project that is not
  on this host is refused.

## Settings

Settings › General, under Your identity, gains **Your instructions** and
**Orchestration**, each a multi-line text field with its character count and
limit, a line saying what it is for and that a provider's own instruction files
still apply, and Save. A Project's settings gain **Project instructions**
beside Project memory. A window that cannot change them shows them read-only.
The count is the field's length as the limit counts it, and Save stays off
until the text changed and fits. The likely-secret warning shows while the
text matches and does not block Save: the person may mean it. A save made
against a version another window already changed is refused, says so, and the
field rereads the current text.

## Delivery

Each slice lands on its own:

1. Contracts, the journal events, and the `person-instructions` block in context
   assembly for every mode and provider, with Octant Harness.
2. Settings › General: Your instructions.
3. Project instructions: the Project field and its block.
4. Orchestration: the field and its block for coordinator threads and a
   Project's designated planner.

## Not in this design

- Instructions per provider inside Octant. A provider's own files already do
  that.
- Instructions a thread or an agent writes for later threads. That is memory.
- Organization-set instructions, which fall outside the
  [Current Release Boundary](../architecture.md#current-release-boundary).

## Verification

- Domain and contracts: the events decode, stale versions are refused, and the
  limits hold.
- Server: each block reaches a new session in Chat, Work, and Code on a
  provider that keeps its own conversation and on Octant Harness, in the order
  above; a held session is not sent a block again; an edit reaches a running
  session once as a keyed revision; a routine's turn gets them; a non-coordinator
  thread gets no orchestration block.
- Authority: a remote client that is not the host's paired person, an agent
  tool, and a routine are refused a change.
- Web: the fields save, show their limit, warn on a likely secret, and render
  read-only where the window cannot change them.
