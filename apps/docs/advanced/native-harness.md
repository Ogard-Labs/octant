# Native Harness

The native harness is Octant's own agent loop for models you reach through an
API key or a local endpoint — OpenAI-compatible, Anthropic-compatible, Azure
AI Foundry providers (Ollama joins once its driver runs the tool loop). Where a coding CLI such as Claude Code or
Codex brings its own tools and its own loop, the harness gives an endpoint
model Octant's tools, Octant's authority checks, and Octant's journal, in
every mode and on every surface: web, desktop, phone, and the `octant` CLI.

## What the model gets

Nine working tools — `read`, `grep`, `glob`, `bash`, `edit`, `write`,
`web-fetch`, `web-search`, `todo-write` — four harness reads:
`context-remaining`, `journal-lookup`, `second-opinion`, and `delegate` — and
`ask-user`, which lets the lead stop and ask you something — plus `goal` and
`goal-check` for the thread's goal (see [Goals](#goals)). Each mode trims
the set to what it may reach:

| Mode | Files                   | Shell     | Web                 | Delegation |
| ---- | ----------------------- | --------- | ------------------- | ---------- |
| Chat | none                    | none      | when research is on | yes        |
| Work | inside the bound folder | none      | yes                 | yes        |
| Code | inside the checkout     | sandboxed | yes                 | yes        |

Every call passes the same server authority check as any other tool. A read
never needs an approval; an edit, a write, or a command follows the thread's
access posture, and a thread that has taken in untrusted content asks again
before writing. An edit needs a prior read of the same file and refuses when
the file changed since. A truncated result says how much was left out and
where to continue.

When a turn offers Octant's own tools — the built-in browser, Canvas, computer
use, the terminal, the Apple and Android simulators, helper agents — the model
also gets one line per tool saying what it is for.

## Verifying a model's tools

Checking a connection never spends a request on a model, so Octant does not
yet know whether an endpoint model can call tools, and it keeps tools off until
you say so. A model without verified tools is **Chat only**: it can answer, but
it gets none of Octant's tools and cannot start helper agents.

To change that, choose **Verify tools** next to the model: in the model picker,
under a model in **Settings → Octant Harness**, or in **Settings → Providers &
Models → Connection details**. Octant sends one request that asks the model to
call a test tool. That request may be billed by your provider, once per click.
A model that calls the tool is verified and gets Octant's tools; one that
answers in text stays Chat only, and a failed request (a wrong key, a timeout)
shows its error instead of a verdict. Verifying one model never turns tools on
for the others on the same endpoint, and changing the endpoint's configuration
asks you to verify again. Ollama has no Verify tools action yet.

## Conversations that survive a restart

The harness saves its conversation step by step as it works: your message,
each reply, and each tool call the moment it finishes. A Code thread on a
harness model therefore continues the same conversation on your next message,
tool calls included, and picks it up again after Octant restarts.

## Pausing and restarting

**Pause** — on the harness card, the phone panel, or `/pause` in the terminal —
lets the turn that is running finish, along with any helpers it already
started, and starts nothing new: the next message is refused, the lead cannot
start another helper, a helper waiting for other helpers to finish stays
waiting, and a goal loop on the thread is paused too. **Resume** lifts it
(resume the goal loop from its own panel).

If Octant restarts while a turn is running, or while the lead was waiting for
your answer to a question or an approval, the thread shows **Needs a check
after restart** and refuses new work, so nothing picks up behind your back.
Look at what the turn did, then press Resume. Resume first checks that the
thread's model endpoint is still on, that a Code thread's checkout has been
checked again since the restart (opening the thread does that), and that a
Work Project's folder is still where it was, and says what is missing if not; then it records the cut-off turn and
any question nobody can answer anymore as settled, and the thread runs again.

A helper that was waiting for other helpers when Octant stopped stays waiting
after the restart, even once they finish. Resuming the thread lets it go, or
press **Resume** on the helper's own page in the **Agents** dock tool.

If Octant stops while a tool is running, the model is told on its next turn
that the call was interrupted. A tool that only reads, such as `read` or
`grep`, is marked safe to call again. Anything else is marked as possibly
done, and the model is told to check before repeating it. Octant never
re-runs an interrupted call by itself.

When a long conversation no longer fits the model's window, older tool
results are left out of the request first, then whole earlier exchanges, with
a note to the model. The saved conversation keeps everything.

Forking a Code thread on a harness model gives the fork the model's own
memory up to the reply you forked from — every message, tool call, and result
— rather than a summary. Paths point at the fork's own folder, and secret
values the thread uses are blanked. The fork starts without the source's goal,
task list, notes, or approvals. If Octant cannot tell exactly where that reply
ends in the saved conversation, the fork gets a written summary instead.

## Goals

Give a thread a goal and the harness works toward it. Every turn starts with
the goal in front of the model: the objective, each acceptance criterion and
whether it is met yet, and how much of the budget is left.

A criterion is a concrete statement, ideally with a check command that proves
it — `bun run test parser` exits zero, for example. If the goal has no
criteria yet, the model writes them once with the `goal` tool before it
starts; after that only you change them. In a Code thread the model runs a
criterion's own check with `goal-check`. That asks for approval exactly as a
shell command does, and the approval shows the whole command (a check command
is at most 200 characters; put a longer one in a script). A criterion without a
check command is one you confirm.

The goal completes only when every criterion's check has passed — never
because the model says it is finished. That is also the model's signal to
stop. When the budget runs out first, the model is told to summarize where
the work stands and stop.

## Model slots

Routing is configured by slot, in **Settings → Octant Harness → Model slots**. A slot
is an ordered list of models: the first is used; the rest are fallbacks when
the first is rate-limited, down, or timing out. **Choose model** and **Add
fallback** add an empty row; Octant never picks a model for you, so choose a
provider and a model in the row before **Save slots**. Jobs the harness
performs map onto slots:

| Job                           | Default slot | Named in Settings  |
| ----------------------------- | ------------ | ------------------ |
| Implementer, Custom           | `default`    | Main model         |
| Planner                       | `plan`       | Planning           |
| Explorer, Researcher          | `task`       | Research and tasks |
| Reviewer                      | `slow`       | Careful review     |
| Titles, summaries, compaction | `smol`       | Quick jobs         |
| Image understanding           | `vision`     | Images             |
| Advisor                       | `advisor`    | Advisor            |

A Project may override the host's table. A job whose slot is not configured
runs on `default` and the session says so. Every routing decision — the
primary, a fallback with its reason and cooldown, a return to the primary, a
warning about an unconfigured slot — is journaled and shown on the thread's
harness card and in `octant harness session <thread-id>`.

The lead is the one job that does not start from its slot. It runs on the
model its thread chose, whatever the `default` slot lists. The slot only
matters when that model stops answering: see
[When the endpoint fails](#when-the-endpoint-fails).

## When the endpoint fails

A request to an endpoint is sent again when the failure is the kind that
usually passes: HTTP 408, 429, 500, 502, 503, 504, or 529, a refused or reset
connection, a stream that goes quiet, a stream that closes before its final
event, or a reply with no text and no tool call. It is tried up to five times,
waiting half a second, then one, two, and four seconds (never more than ten,
give or take a tenth). When the endpoint sends `Retry-After`, that wait is used
instead, up to a minute. A rejected key, an unsupported endpoint, or a spent
allowance is not retried.

Each retry is announced before its wait, so the thread can say "retrying 2/5 in
4 s". A request is only sent again while nothing of it has appeared: once the
reply has started to stream, a failure ends the turn rather than showing the
start of the answer twice. Pressing stop during a wait ends it at once. The
tokens a failed attempt used still count toward the turn.

A stream that stays silent for two minutes is treated as down. Any byte the
endpoint sends, including a keep-alive line or a reasoning update, restarts
that clock.

When the five attempts run out, the lead's model is reported to routing and the
turn continues on the next model of the `default` slot that is ready and has
not just failed, on whichever endpoint that model belongs to. The failed model
sits out for a minute, or for the time the endpoint asked. If the slot has no
other model, or none is ready, the turn fails with the endpoint's own error
and says why nothing took over. The next turn starts on the thread's own model
again. Delegated helpers and the advisor retry the same way, but they do not
move to another model mid-request.

## Delegation

The lead can hand a bounded task to a child with `delegate`: research,
implementation, or review. Provider harnesses use `octant_agents` for the same
host-managed workflow. Either parent can choose an Octant-harness or a
provider-harness child. The child runs on the model its role's slot names, or
an explicit eligible provider/model selected for that task, under authority no
wider than its parent. Code children have separate worktrees. An unconfigured
route can inherit the parent's eligible model; a configured but unavailable
route reports its refusal.

Both tools can collect replies and send a bounded follow-up to a completed
child, using its current version. A follow-up resumes the same conversation
and produces a new result to acknowledge. It never starts a fresh session
silently. The child status reports the identity and version needed for the
next request. The earlier reply must reach the parent or be explicitly collected
first. Status inspection does not consume replies, and collection refuses an
oversized response without marking it consumed.
Whether one may start at all is **Let the agent start subagents** under
**Settings → Octant Harness → Helper agents**: on by default, and when it is
off the lead is told subagents are turned off and does the work itself.

Children can wait on each other, so the lead can run a small graph. It starts
independent tasks side by side, then starts a task that needs their output with
`after`. That task begins only once all of them have finished, with their
replies in front of it; if one of them fails or is cancelled, it never runs.
`delegate wait` blocks until the children finish, and `status` shows what each
one is waiting on. How many children run at once is a setting (below); a
child that is only waiting does not take a slot.

This is how a frontier model plans and reviews while cheaper models read and
implement: put the strong model on `default` and `slow`, the cheap one on
`task`, and let the lead delegate.

## The advisor

When the `advisor` slot is configured, a second model reviews a digest of
each of the lead's turns. It may redirect the next turn or pause the run for
you; it can never run a tool, edit a file, or approve anything. Its
interventions appear on the harness card. A pause holds the thread: the next
prompt is refused with the advisor's reason until you press Resume on the
harness card, the phone panel, or type `/resume` in the CLI — the decision it
asked for is yours, not the next prompt's. The lead can also ask it a
question with `second-opinion`.

## Follow-ups

Follow-up suggestions work the same on every provider; see
[Suggested follow-ups](/guide/#suggested-follow-ups). A harness session also
lists them in the CLI (`/next 2` takes the second one), with the same preview
and confirmation.

## Approvals

A tool call the thread's posture only allows with your say-so — a write or a
command under approval-gated Code, for instance — no longer comes back to the
lead as a refusal. The lead waits while the call is shown to you inline: on
the harness card, the phone panel, the terminal UI's Approval panel, and as
a `[y]es / [a]lways / [n]o` prompt in line mode. **Allow** runs it once;
**Allow for this session** also covers that class of call (shell commands,
project file writes, …) for the rest of the thread's session and nothing
beyond it — the thread's posture is untouched, and a restart asks again.
**Deny** tells the lead not to retry. Every approval and decision is
journaled with the session.

## Steering and stopping

In the terminal UI, typing while the lead works queues a note instead of a
turn. The note reaches the lead inside its next tool result, so it lands
mid-turn; a note the lead never reached before the turn ended is sent as the
next prompt. Notes are saved as you send them, so one typed just before
Octant restarts still reaches the lead on the next turn. `/steer <note>` queues
one explicitly. Left-over notes are sent once, even with the thread open in
more than one terminal. `Esc` stops the
running turn; `Ctrl+C` stops it too, and a second press right after quits.

`/side <question>` asks the thread's Side Chat — the same one the app's Side
Chat panel shows — without stopping or adding to the running turn. Side Chat
reads the thread and cannot change it; in the terminal UI, `/back` returns to
the thread. `/goal` shows the thread's goal, and `/goal revise <objective>`
changes its objective. If another screen changed the goal first, nothing is
overwritten: the terminal says so and shows the newer goal.

`/fork` forks the thread at its last finished reply — a Code fork on its own
worktree and branch, a Chat fork with the conversation so far — and
`/checkpoint [name]` marks that reply. `/checkpoints` lists the marks, and
`/restore N` starts a new thread from one; the thread you are in is never
rewound. The terminal UI moves to the new thread; the line mode prints its id
and the `octant agent --thread` command that continues it. Work threads have
neither forks nor checkpoints yet, and the terminal says so.

## Questions

When the lead needs a decision it cannot make alone, it asks. The question
appears inline on the thread — on the harness card in the app, on the phone
panel, as a numbered prompt in the CLI, and in a Chat thread's own transcript
as a card on the turn that asked — with any options it offered, each with the
meaning the lead wrote for it, and a field for an answer no option covers.
Pick one or type an answer; the turn continues the moment it lands, and the
same question can be answered from any surface. A question nobody answers
within ten minutes expires and the lead is told to continue with its best
judgment; interrupting the turn cancels it. Every question and answer is
journaled with the session.

## From the terminal

```bash
octant agent --prompt "Summarize the open pull requests"
```

`octant agent` without `--prompt` opens the terminal UI on a new Chat thread:
the conversation as you / lead turns with timestamps; under each lead turn
its actions as a tree — the last few calls in full with what they touched and
how long they took, the rest folded into one line, failures in red, and a
spinner on the call still running — plus a Tasks panel when the lead keeps a
task list, a panel for a pending question or the suggested follow-ups, and a
footer with the run's status, token use, and cost. The reply appears as it
is written: the terminal follows the same live feed the app does, so text and
tool calls show up the moment the host has them.
It draws with the app's own theme tokens — `--theme system|light|dark|octant`
picks the preset, and the terminal's light or dark mode picks the palette.
Enter sends, Shift+Enter adds a line, `/next N`, `/pause`, and `/resume` work
as in the app, and a pending question is answered by typing its number or an
answer. The folder you run it in decides the mode, the way a coding CLI does: inside
a folder you have added as a Code Project, `octant agent` starts a Code
thread there — in the current checkout, approval-gated, so its edits and
commands ask you first, right there in the terminal; inside a Work Project it
starts a Work thread; anywhere else, Chat. `--mode chat|work|code` and
`--project <name>` override that, and a folder that is not a Project yet is
refused with the exact `octant project add` command to run. If the host is not
running, `octant agent` starts it the way `octant server start` does and
waits for it before opening the thread. `--plain` keeps the line-by-line mode, which is also what a pipe or
`--json` (one JSON object per line) gets. `--thread <id>` attaches to an
existing thread in whatever mode it is, and `--last` continues the latest
Code or Work thread of the Project you are in (anywhere else, your latest
Chat thread). A Code thread keeps its conversation from one run of
`octant agent` to the next, tool calls included. `--model <model>` picks the
harness model for a new Work or Code thread — `endpoint/model` when two
endpoints offer the same id — and an unknown name lists the ones on offer.
`--project <name>` files a new thread in a Project. The terminal opens the
Project and the thread in its own window on the host, exactly as the app
does, so the same checkout, goal, and approval rules apply to it. Inside the screen,
`/threads` lists your threads and `/open N` switches; `/model` lists every
model a harness endpoint offers and `/model N` switches the thread to it,
with the header showing how much of that model's window the last turn used.
Type `@` to attach a file from the working directory (images, PDFs, text)
and `#` to bring another thread's transcript in as read-only context; both
complete as you type. Ctrl+E opens each call's diff or output, Ctrl+R the
model's reasoning, `?` the key list. Paste works as in any terminal; drag to
select text and press Ctrl+C to copy it, or `/copy` to copy the last reply —
through the terminal (OSC 52, so over SSH too) and the host clipboard. A finished turn sends a desktop
notification unless `--quiet`. `octant harness slots` prints the routing
table.

## Honest limits

- Only endpoint providers run the harness. Coding CLIs keep their own tools;
  they can be delegated to as children, never made the lead. A lead falls back
  only to another endpoint model, never to a coding CLI.
- Anthropic-compatible endpoints offer tools when the endpoint does; a model
  that ignores tool calls simply answers in text. Ollama is not a harness
  provider yet: its driver has no tool loop, so it is not offered as a slot
  candidate until it does.
- Context is reduced by the host's planner; each prune and cut is journaled
  with the cache cost it paid, and the lead can read `context-remaining` to
  checkpoint before one.
