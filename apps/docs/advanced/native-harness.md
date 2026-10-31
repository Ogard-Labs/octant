# Native Harness

The native harness is Octant's own agent loop for models you reach through an
API key or a local endpoint — OpenAI-compatible, Anthropic-compatible, Azure
AI Foundry providers, and a local Ollama. Where a coding CLI such as Claude Code or
Codex brings its own tools and its own loop, the harness gives an endpoint
model Octant's tools, Octant's authority checks, and Octant's journal, in
every mode and on every surface: web, desktop, phone, and the `octant` CLI.

## What the model gets

Nine working tools — `read`, `grep`, `glob`, `bash`, `edit`, `write`,
`web-fetch`, `web-search`, `todo-write` — three harness reads:
`context-remaining`, `second-opinion`, and `delegate` — and
`ask-user`, which lets the lead stop and ask you something — plus `goal` and
`goal-check` for the thread's goal (see [Goals](#goals)). Each mode trims
the set to what it may reach:

| Mode | Files                   | Shell     | Web                 | Delegation |
| ---- | ----------------------- | --------- | ------------------- | ---------- |
| Chat | none                    | none      | when research is on | yes        |
| Work | inside the bound folder | none      | yes                 | yes        |
| Code | inside the checkout     | sandboxed | yes                 | yes        |

`todo-write` keeps the lead's own task list: pending, in-progress and done
items that show on the thread's agent card, the phone and the terminal as the
lead works. It is separate from a plan, so it needs no approval and never
asks you to review one.

Web means `web-fetch`, plus `web-search` once a SearXNG search endpoint is
set. A Chat thread gets neither, and cannot open a page, until you turn
research on for it.

`context-remaining`, `second-opinion`, and `journal-lookup` are offered in
every mode and reach none of those. `journal-lookup` re-reads earlier
messages of the thread's own conversation after a context cut (see
[Honest limits](#honest-limits)); a Side Chat does not get it. A thread that has read outside content cannot send a
`second-opinion` question, since another model would receive it unmarked.

Every call passes the same server authority check as any other tool. A Chat
thread holds that authority with or without a Project. A thread that can no
longer act (archived, its folder or Project changed, or its provider turned
off) has every tool call refused, and the model is told why so it can say so.
A read never needs an approval; an edit, a write, or a command follows the
thread's access posture. Once a thread has taken in outside content — a
fetched page, search results, or a helper's reply — it asks before every
edit, write, command, and page fetch, unless the thread is at Full access,
where outside content is only tagged. Reading,
searching, and running commands in your own folder do not count as outside
content. A web search on such a thread does not ask, because it only reaches
the search endpoint you set; instead, below Full access, Octant refuses a query that looks like it
carries data — a link, an email address, a key or other long random-looking
token, an encoded or hex string, or more than 200 characters — and tells the
model why, so it can ask a plain question instead. A short query can still
carry a few words, but only to your own search endpoint. An edit needs a prior read of the same file and refuses when
the file changed since. A truncated result says how much was left out and
where to continue.

When a turn offers Octant's own tools — the built-in browser, Canvas, computer
use, the terminal, the Apple and Android simulators, helper agents — the model
also gets one line per tool saying what it is for.

## Parity with Claude Code and Codex

Parity means a thread on the harness behaves like one on Claude Code or Codex
where you can see it: the same tools for the mode, a pending approval or
question asking for your attention the way a provider's question does and
answerable in the thread itself, a task
list that shows progress as
the lead works, and the same session on web, terminal, and phone. Each release
checks these before it says the harness is at parity. The checklist is in the
[architecture](https://github.com/Ogard-Labs/octant/blob/main/docs/architecture.md#native-harness).

## Network for commands

On a Code thread that is approval-gated or auto-accepts edits, a harness
command — `bash`, or the check a goal runs — reaches the network only through
Octant's egress proxy, on macOS and Linux. It reaches only the hosts and ports
you allowed for that thread or its Project, until the allowance ends. Every
other host fails, and so do your own machine, your local network, cloud
metadata addresses, a connection that skips the proxy, and name lookups.
HTTPS Git remotes, npm, pip, cargo, Go, and curl use the proxy by themselves;
SSH remotes, raw TCP, UDP, and HTTP/3 do not work. Full access keeps open
network, and Plan has none.

When a command is refused a host, the thread's **Agents** tab lists it under
**Network access** (with **Propose refused hosts** on). Nothing is allowed until
you choose: allow it on the thread for 1 hour, 8 hours, or 7 days, or on the
whole Project for 7 or 30 days from a window on this computer, and ask the
model to try again. Every allowance expires, and **Revoke** ends it at once,
open connections included.

What a command receives through the proxy counts as outside content. After a
package install or a clone, the thread asks before every command, and the
hosts you allowed stop applying to it on their own. Instead, each command's
approval lists the hosts the thread and its Project allow, already ticked, and
hosts a command was refused earlier, unticked. The command reaches only the
hosts you leave ticked when you choose **Allow**, and only while it runs: the
next command asks again and starts from the list, not from your last answer.
A helper agent's command on such a thread asks the same way, with the same
list; a helper never reaches a host its parent thread does not allow.

In `octant agent`, the approval prints the list with `[x]` beside each ticked
host. Line mode takes `y` for the ticked hosts, `y 1,3` for exactly those, and
`y none` for none; a number the list does not have refuses the command. In the
terminal UI, type a host's number and press Enter to tick or untick it, then
`y` to allow with the hosts ticked. A list longer than eight hosts shows a page
at a time with the numbers of the ticked hosts on other pages; `>` and `<` turn
the page.

## Verifying a model's tools

Checking a connection never spends a request on a model, so Octant does not
yet know whether an endpoint model can call tools, and it keeps tools off until
you say so. A model without verified tools is **Chat only**: it can answer, but
it gets none of Octant's tools and cannot start helper agents.

To change that, choose **Verify tools** next to the model: in the model picker,
under a model in **Settings → Octant Harness**, or in **Settings → Octant
Harness → Model endpoints → Connection details**. Octant sends one request that asks the model to
call a test tool. That request may be billed by your provider, once per click.
A model that calls the tool is verified and gets Octant's tools; one that
answers in text stays Chat only, and a failed request (a wrong key, a timeout)
shows its error instead of a verdict. Verifying one model, or that model using
a tool in a thread, never turns tools on for the others on the same endpoint,
and changing the endpoint's configuration
asks you to verify again. On Ollama the request runs on this computer, and a model
Ollama says cannot use tools stays Chat only without one.

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
results are left out of the request first. In Chat, Work, and Code alike,
Octant then summarizes the earlier turns for the model with the same model and
no tools, carrying its latest task list along, and the thread shows a
compaction divider and the context meter marks the session compacted. A Chat
summary is not asked about files, and a Chat model is not told to look for
any. Only when there is nothing earlier to summarize, the summary fails, or
the running turn outgrows the window again, are whole earlier exchanges left
out, with a note to the model that names the saved messages it can read back
with `journal-lookup`. The note points the model at its task list and, in Work
and Code, at the files on disk. A saved message too long for one read, such as
the history a restarted conversation begins with, comes back in parts the
model reads one after another. The saved conversation keeps everything.

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

Each surface shows the same ledger: every criterion with its check command,
the last thing that check observed (met or not), and whether it holds. Open
**Environment** on a Code thread, or **Keep working on this unattended** on a
Work thread, and the criteria are listed under the objective. A Code thread
shows its goal there only once it has one, and only to read; `/goal` in the
terminal lists the same criteria.

The goal completes only when every criterion's check has passed — never
because the model says it is finished. That is also the model's signal to
stop. When the budget runs out first, the model is told to summarize where
the work stands and stop.

## Model slots

Routing is configured by slot. Settings calls a slot a **model role** and
names it by its job, in **Settings → Octant Harness → Model roles**; the CLI
(`octant harness slots`) and this guide keep the slot ids. A slot is an
ordered list of models: the first choice is used, and the rest are backups for
when the model before them is rate-limited, down, or timing out.

Each change saves as you make it. It is sent with the version the page read,
so if the roles changed elsewhere in the meantime, the page says so, reloads,
and asks you to make your change again. Octant never picks a model for you.
With exactly one endpoint ready and no main model, the page offers
**Use** _model_ **as the main model**; nothing is set until you press it. Open
a role's backups to add one, move one up or down, or remove it. **Reading
images** offers only models that accept images. Which job uses which role is
folded away under **Which job uses which role**; the lead and the advisor are
not listed there, since the advisor runs only on its own role. Jobs the harness performs map
onto slots:

| Job                           | Default slot | Named in Settings    |
| ----------------------------- | ------------ | -------------------- |
| Implementer, Custom           | `default`    | Main model           |
| Planner                       | `plan`       | Planning             |
| Explorer, Researcher          | `task`       | Research and lookups |
| Reviewer                      | `slow`       | Careful review       |
| Titles, summaries, compaction | `smol`       | Quick jobs           |
| Image understanding           | `vision`     | Reading images       |
| Advisor                       | `advisor`    | Advisor              |

A Project may override the host's table. A job whose slot is not configured
runs on `default` and the session says so; Settings shows such a role as
**Same as main model**. The advisor is the exception: with no model of its own
it is off, and Settings shows **Off**. Every routing decision — the
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

Each retry is announced before its wait. While the turn is quiet, the thread's
working indicator, the terminal footer, and the phone's session panel say
"Provider busy, retrying 2/5 in 4 s" and count the wait down. The line is
ordinary text, not a warning; it disappears when the next reply text or tool
call arrives, or when the turn ends, whether it finished, failed, or was stopped. A
retry that runs out still fails with the endpoint's own alert. The turn's
detail counts those same announcements. A request is only sent again while nothing of it has appeared: once the
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
Whether one may start at all is **Let the agent start helper agents** under
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

The advisor runs only once you choose a model for the `advisor` slot (the
**Advisor** role in Settings); until then it is off, even when a main model is
set, because it costs one extra request on every turn. With a model chosen, a
second model reviews a digest of each of the lead's turns. It may redirect the
next turn or pause the run for you; it can never run a tool, edit a file, or
approve anything. Its interventions appear on the harness card. A pause holds the thread: the next
prompt is refused with the advisor's reason until you press Resume on the
harness card, the phone panel, or type `/resume` in the CLI — the decision it
asked for is yours, not the next prompt's. The lead can also ask it a
question with `second-opinion` in Chat, Work, and Code; with no advisor model
chosen, the call is refused and the lead carries on without it.

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
beyond it — the thread's posture is untouched, and a restart asks again. It
stops covering the thread once the thread takes in outside content: from then
on each such call asks again, and the choice is not offered. A request from a
child is answered once as well: the terminal prompt, the terminal UI, the
harness card, and the phone panel offer no session-wide choice for it, and the
card and the phone panel name that child, its provider, and its model.
**Deny** tells the lead not to retry. Every approval and decision is
journaled with the session.

On a Code thread in **Auto**, Octant Shield answers these approvals before
anyone is asked. It allows reads and edits inside the thread's folder, your
Project's own test and build commands, and Git commands that only read,
without a model call; it refuses or hands you the calls that look harmful
(a download piped into a shell, an encoded command, reading keys and sending
them out, persistence, mass deletion, force-pushing); and it asks a small
model about the rest. That model sees only your own messages in the thread
and the pending call, never what the agent read. When Shield is unsure, its
model does not answer, or the thread has read outside content and the call
would reach out or could not be undone, the approval comes to you with
Shield's reason. Octant Shield also reads each tool result before the model
does and labels text that looks like an injection: instructions aimed at the
agent, hidden or encoded text, a request to send secrets out, or a false claim
of authority. A labelled result marks the thread, its tool row says "Outside
content" and what was found, and Shield's model is told the kinds it found,
never the text. After three denials in a row, or twenty in one thread, the
next call comes to you. Each decision shows in the transcript as an Octant
Shield line beside the tool rows. A class you allowed for the session goes
through on your word without asking Shield, and a subagent's calls are
answered the same way. When you answer on another surface first, the
line-mode prompt closes with an "answered elsewhere" note instead of waiting
for input (with `--json`, an `approval-settled` line).

A Browser call that needs a site you have not allowed waits the same way. The
terminal UI shows it in a Site approval panel, and line mode asks
`Browser wants to open <site>` with a `[y]es / [a]lways this site / [n]o`
prompt. **Always** remembers the site, as **Always allow** does in the app,
and it is only offered in Work threads. A Code thread's site ask is answered
once. With `--json`, the ask is printed as a `site-approval` line and the
answer is read from stdin, the same as for other approvals. When stdin has
ended, the call is refused as `browser-approval-denied` and the turn
continues without waiting for the ask to expire.

## Steering and stopping

In the terminal UI, typing while the lead works queues a note instead of a
turn. The note reaches the lead inside its next tool result, so it lands
mid-turn; a note the lead never reached before the turn ended is sent as the
next prompt. Notes are saved as you send them, so one typed just before
Octant restarts still reaches the lead on the next turn. `/steer <note>` queues
one explicitly. Left-over notes are sent once, even with the thread open in
more than one terminal. The app has the same
note box beside the composer, shown only while the lead works: a note is queued the same way and
marked queued, then delivered. After the turn ends, the app sends notes the lead
never reached as the next message in the same thread, preserving your unsent
composer draft. Paused sessions and queues, pending approvals, budget limits,
and restart recovery still need attention before work continues.

If the next message is refused, the app keeps the claimed notes in the current
window and offers **Retry next message** after you resolve the refusal. If the send response
is lost, **Check submission** checks the same message without creating a
second copy. If the host does not confirm which client took the notes, the app
keeps their text visible and does not resend them automatically: another
window or terminal may have taken them. Check the conversation before copying
that text into a new message, and keep the window open while resolving it.
This handoff does not guarantee recovery after closing or reloading a window
with a pending follow-up. Notes still in the steering list can also be discarded.

In the terminal, a refused next prompt leaves its text in **Retained steering
notes**, without replacing your draft. The error may mean the host accepted
the message but could not answer. Check the conversation and queue before
using `/notes copy` to copy and resend the text manually. `/notes discard`
removes this terminal's recovery copy. Notes stay with their original thread
when you switch threads. If taking the notes loses its response, the terminal
keeps the displayed text with a warning that another client may own it. Neither
case retries automatically. Keep the terminal open until resolved; this recovery
copy is not saved across terminal restarts.

`Esc` stops the
running turn; `Ctrl+C` stops it too, and a second press right after quits.

`/side <question>` asks the thread's Side Chat — the same one the app's Side
Chat panel shows — without stopping or adding to the running turn. Side Chat
reads the thread and cannot change it; in the terminal UI, `/back` returns to
the thread. `/goal` shows the thread's goal with each criterion's check, latest evidence and
whether it is met, and `/goal revise <objective>` changes its objective. If another screen changed the goal first, nothing is
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
panel, as a numbered prompt in the CLI, in a Work thread as a question card
above its composer, in a Code thread as its own inline question, and in a
Chat thread's own transcript as a card on the turn that asked — with any
options it offered, each with the meaning the lead wrote for it, and a field
for an answer no option covers.
Pick one or type an answer; the turn continues the moment it lands, and the
same question can be answered from any surface. The terminal
shows a Chat thread's question too, read from the turn that asked, and closes
its prompt with a note when the app answers first. A question nobody answers
within ten minutes expires and the lead is told to continue with its best
judgment; interrupting the turn cancels it. While it waits, the thread says
it needs you the way a provider's question does: its sidebar mark and the
pane header say **Needs you** rather than running, the Inbox lists it as
waiting for your answer, and a Work task files under Waiting on the board. A
Work thread's question is also listed in Home's **Needs you** card, the menu
bar, and the command palette; there **Review request** (or the row) opens the
thread, and you answer on its question card. Answering, interrupting, or the
question expiring clears all of them. Every
question and answer is journaled with the session (in Chat, with the turn that
asked).

## From the terminal

```bash
octant agent --prompt "Summarize the open pull requests"
```

A refused prompt prints the host's reason. With `--prompt`, the command exits
with a nonzero status; it never repeats an earlier reply as the new result.
If the earlier conversation cannot be read, the command stops before sending
and asks you to try again.

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
answer. `/agents` lists the thread's helper agents with their state,
role, model, and age; `/agent N` shows one — its brief, what it has said or
reported, and anything blocking it — and `/agent N <message>` replies: it
steers a working helper, follows up on a finished one, or answers a question
the helper asked. The host decides what a helper accepts, as in the app, and
a refusal is printed. `octant harness agents <thread-id> [N] [--json]` reads
the same list or one helper without starting a turn. The folder you run it in decides the mode, the way a coding CLI does: inside
a folder you have added as a Code Project, `octant agent` starts a Code
thread there — in the current checkout, approval-gated, so its edits and
commands ask you first, right there in the terminal. A Project that remembers
Full access (`octant project access <name> full-access`) starts it with Full
access instead, the same as a new thread in the app that keeps Remember for
this Project; the host decides, and there is no flag that asks for more. Inside a Work Project it
starts a Work thread; anywhere else, Chat. `--mode chat|work|code` and
`--project <name>` override that, and a folder that is not a Project yet is
refused with the exact `octant project add` command to run. If the host is not
running, `octant agent` starts it the way `octant server start` does and
waits for it before opening the thread. `--plain` keeps the line-by-line mode, which is also what a pipe or
`--json` (one JSON object per line) gets. `--thread <id>` attaches to an
existing thread in whatever mode it is, and `--last` continues the latest
Code or Work thread of the Project you are in (anywhere else, your latest
Chat thread). A Code thread keeps its conversation from one run of
`octant agent` to the next, tool calls included, and a long one shows its
newest 50 turns. `--model <model>` picks the
model for a new thread. Chat can select a configured CLI account or endpoint;
Work and Code select a harness endpoint. Use `endpoint/model` when two
accounts or endpoints offer the same model id. On a cold host, Chat waits for
configured providers that have not finished discovery before resolving the name.
Unknown or ambiguous names
are refused before inference and list the available choices. Give accounts
distinct labels if their qualified names collide. `--model` cannot be combined
with `--thread` or `--last`; change an existing thread through its model picker.
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
- Every endpoint model, Anthropic-compatible ones included, is Chat only
  until you verify its tools. Ollama is reached only on this computer's loopback
  address; a remote, LAN, or tunnelled Ollama is refused.
- Context is reduced by the host's planner; each prune and cut is journaled
  with the cache cost it paid, and the lead can read `context-remaining` to
  checkpoint before one. The note in front of a cut names the earlier
  messages by number and the lead can read them back with `journal-lookup`,
  a bounded read of that thread's own conversation with your credentials
  redacted. It reads the conversation the running turn uses: when Octant had
  to start a Chat or Work thread's conversation afresh (after a compaction, a
  retry, edit, or regenerated reply, or a change of model or provider), the
  earlier one is not read
  back, and the new one already began from the thread's history. Every mode
  summarizes earlier turns of a continued conversation before it cuts them;
  the history a fresh conversation begins with was already planned and
  compacted, so the turn that carries it does not summarize it again. An endpoint that never reports the model's window,
  such as some Azure AI Foundry deployments, gives the lead no figure: the tool
  says the context is unavailable instead of reporting room against an estimate.
