# Native Harness

The native harness is Octant's own agent loop for models you reach through an
API key or a local endpoint — OpenAI-compatible, Anthropic-compatible, Azure
AI Foundry, and Ollama providers. Where a coding CLI such as Claude Code or
Codex brings its own tools and its own loop, the harness gives an endpoint
model Octant's tools, Octant's authority checks, and Octant's journal, in
every mode and on every surface: web, desktop, phone, and the `octant` CLI.

## What the model gets

Nine working tools — `read`, `grep`, `glob`, `bash`, `edit`, `write`,
`web-fetch`, `web-search`, `todo-write` — four harness reads:
`context-remaining`, `journal-lookup`, `second-opinion`, and `delegate` — and
`ask-user`, which lets the lead stop and ask you something. Each mode trims
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

## Model slots

Routing is configured by slot, in **Settings → Agents → Model slots**. A slot
is an ordered list of models: the first is used; the rest are fallbacks when
the first is rate-limited, down, or timing out. Jobs the harness performs map
onto slots:

| Job                           | Default slot |
| ----------------------------- | ------------ |
| Lead, Implementer, Custom     | `default`    |
| Planner                       | `plan`       |
| Explorer, Researcher          | `task`       |
| Reviewer                      | `slow`       |
| Titles, summaries, compaction | `smol`       |
| Image understanding           | `vision`     |
| Advisor                       | `advisor`    |

A Project may override the host's table. A job whose slot is not configured
runs on `default` and the session says so. Every routing decision — the
primary, a fallback with its reason and cooldown, a return to the primary, a
warning about an unconfigured slot — is journaled and shown on the thread's
harness card and in `octant harness session <thread-id>`.

## Delegation

The lead can hand a bounded task to a child with `delegate`: research,
implementation, or review. The child runs on the model its role's slot names,
under authority no wider than its parent, in its own worktree for Code, and
returns a reply the lead collects. Whether a child may start at all is the
**Subagent creation** posture in Settings → Agents: under _Ask_ the lead is
told a person must start children; under _Automatic_ they start within the
usual bounds.

This is how a frontier model plans and reviews while cheaper models read and
implement: put the strong model on `default` and `slow`, the cheap one on
`task`, and let the lead delegate.

## The advisor

When the `advisor` slot is configured, a second model reviews a digest of
each of the lead's turns. It may redirect the next turn or pause the run for
you; it can never run a tool, edit a file, or approve anything. Its
interventions appear on the harness card. The lead can also ask it a question
with `second-opinion`.

## Follow-ups

At the end of a turn the lead may suggest up to three follow-ups. They appear
as chips on the harness card and as a numbered list in the CLI (`/next 2`
takes the second one). Activating one shows exactly what would be created and
asks you to confirm; nothing is created by the suggestion itself. On confirm
the host creates the thread the follow-up names — a Chat or Work thread in
the same Project, or a Code thread in the current checkout or on its own
worktree — under the lead's model, and the app opens it with the prompt
waiting in the composer. Sending it is still your move. A Code follow-up
starts approval-gated, because Full access is remembered per thread.

## Questions

When the lead needs a decision it cannot make alone, it asks. The question
appears inline on the thread — on the harness card in the app, on the phone
panel, and as a numbered prompt in the CLI — with any options it offered as
buttons. Pick one or type an answer; the turn continues the moment it lands,
and the same question can be answered from any surface. A question nobody
answers within ten minutes expires and the lead is told to continue with its
best judgment; interrupting the turn cancels it. Every question and answer is
journaled with the session.

## From the terminal

```bash
octant agent --prompt "Summarize the open pull requests"
```

`octant agent` without `--prompt` opens an interactive session on a new Chat
thread; `--thread <id>` attaches to an existing one and `--project <name>`
files the thread in a Project. `/session` prints the harness session; `--json`
emits one JSON object per line for scripts. `octant harness slots` prints the
routing table.

## Honest limits

- Only endpoint providers run the harness. Coding CLIs keep their own tools;
  they can be delegated to as children, never made the lead.
- Ollama and Anthropic-compatible endpoints offer tools when the endpoint
  does; a model that ignores tool calls simply answers in text.
- Context is reduced by the host's planner; each prune and cut is journaled
  with the cache cost it paid, and the lead can read `context-remaining` to
  checkpoint before one.
