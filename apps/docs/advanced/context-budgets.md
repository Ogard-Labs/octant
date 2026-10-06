---
description: How Octant plans every turn within provider context windows, respects limits, and stays honest at the edges.
---

# Context Budgets and Limits

One provider-neutral context planner gates every turn — Chat, Work, Code,
tools, memory, attachments, and subagents. Its job is to keep each request
inside the provider's real limits without silently dropping the material you
need.

## Safe input budget

The **safe input budget** is the model context window minus reserves for the
response, provider reasoning, framing, observed variance, and a safety
margin. No turn is sent over budget, and there is no **"send anyway"**
bypass. When a request does not fit, Octant reduces the input in a fixed
order:

1. Deduplicate repeated content.
2. Remove superseded snapshots and stale context.
3. Load only the tool schemas a turn actually needs.
4. Replace large results with summaries plus artifact references.
5. Reuse durable summaries.
6. Summarize older conversation ranges.
7. Narrow retrieved memory.
8. Ask you for direction.

Never silently removed: mode and safety policy, authority and approvals, the
current request, task and follow-up state, pinned content, and explicitly
selected critical material.

## Model and service limits

Model context limits and service-level limits are shown separately. A service
limit that is not reported is `unavailable`, never `unlimited`. Octant
learns service limits from ordinary responses and low-frequency probes — it
does not poll quotas just to animate the interface.

Settings → Usage lists what each provider has reported. Claude Code and
Codex narrate their account usage windows during a session; OpenAI-compatible,
Anthropic-compatible, and Azure AI Foundry endpoints disclose request and
token buckets in the headers of the responses Octant already asked for. A
provider that has not spoken yet says so, and a runtime that never will —
OpenCode, Pi, the ACP agents, or a local Ollama — says that instead, so you
are not left waiting for a number that cannot come.

## Overrides

Per-turn overrides let you **pin** or **exclude** content, disable tools,
plugins, skills, or MCP servers, and rebuild or inspect the manifest. Pins do
not bypass the safe budget. Overrides are scoped to a turn; there is no hidden
persistent thread policy.

## Compaction

Compaction reduces older context without deleting local originals. It prefers
deduplication, structured summaries, and provider-native compaction, and only
writes a new summary when the result is genuinely net-positive. The default
maintenance model is the active provider and model; a cheaper or local model
can be configured, and cross-vendor maintenance is opt-in with bounded
material.

## Watching usage

The active thread's composer shows a circular used-versus-available meter.
Opening it — pointer, Enter, Space, or the configured keyboard shortcut —
shows used tokens, the context-window maximum, the used percentage, free
space, and only the categories the host actually measured. Estimated,
deferred, unavailable, or provider-reported values say so. Provider account
limits appear in a separate section, and only when the host reported them.
For Codex CLI turns, the meter uses the latest request's context occupancy and
window size reported by the app-server, rather than cumulative input tokens
or account quota. These values are retained with the turn and restored when
the thread is reopened, including Chat usage reconciliations. The meter labels
planner health as **Next turn** so it is distinct from the last reported window
reading. Older Chat reconciliations without these fields retain the legacy
input-token and planned-window fallback until a new provider usage report arrives;
they cannot recover runtime occupancy retroactively. Code turns without context
values need a new provider usage report before a context percentage can appear. A thread that
has no plan yet is checked again when its turns advance; reopening the app is
not required to pick up its first plan.
For Claude Code threads, the popover also says how much room is left before
the runtime compacts the session by itself, for example **152.8K until
auto-compact**. That figure is the runtime's own compaction point, which
Claude Code states when the session opens, less what the latest request put in
the window. It appears only while the runtime says compaction is on and has
given a point, so a thread whose runtime says nothing, such as one on Codex CLI,
shows no line rather than a guess. The popover does not compact the session;
Claude Code does that itself when the session reaches the point.
When no provider, catalog, or setting has named the model's context window,
the meter shows what the window holds and nothing to divide it by: the figure
has no maximum and no percentage, the ring stays empty rather than full, and the
popover says no window was reported. Octant plans such a turn against a
128,000-token estimate so that an ordinary thread is sent whole; the context
inspector lists that limit as an estimate and the number is never shown as the
model's window. The first window a provider reports replaces it.
Opening the popover does not make a further provider or network call.

### What fills the window

Open the chevron beside the figure to see what the window holds. Each part has
one colour wherever it appears: the popover's bar and key, and the entries in
the context inspector. Free space and Reserved are always grey. Parts are
listed in a fixed order and the colours are chosen so that neighbouring parts
look clearly different in both the light and the dark theme. The colour never
carries the meaning alone: every part is named beside its swatch, with its
tokens and share. The ring itself stays amber, and turns red when the window is
nearly full.

What the breakdown can say depends on the runtime:

- **Claude Code** reports its own categories after each turn: system prompt,
  system tools, MCP tools, memory files, skills, agents, messages, and the room
  it keeps in reserve. They are shown as the provider's figures. Tools it knows
  of but has not loaded are counted as **deferred** and take no share of the
  bar. Memory file paths and skill names are never kept, only how many there
  are.
- **Codex CLI, OpenCode, Pi and ACP agents** report one occupancy figure and no
  categories. Where Octant registered tools with the session, it counts their
  definitions itself and shows them as **Octant tools**, marked **Estimated**
  (a conservative estimate: four characters to a token). Everything else the
  provider reported is shown as **Other (provider)**, also marked Estimated,
  because what is left of a figure after an estimate is not exact. A runtime
  that gives no window size shows no share at all.
- A planned thread (Octant Harness, Chat, Work) shows the categories Octant
  itself attributed, as before.

The parts and Other (provider) always add up to what the window holds. If the
runtime's breakdown is a little larger than the last request's fill, because it
was taken after the reply, the window is shown as the larger figure. While a
turn is still running, the breakdown is from the last turn that reported one
and the difference lands in Other (provider).

### Inspecting the plan

Inspect context opens the composition list so you can pin, exclude, or
rebuild the next-turn plan. A thread that has not been planned yet is an
empty answer, not a failed connection. Switching the active pane closes a popover or
inspector that belonged to the previous thread and retargets every value.

The Usage destination and Settings also show provider-reported capacity.
Rolling windows show the percentage left and time until reset. Absolute limits
also show the remaining count. Account-scoped limits can include activity from
other apps; model and provider-instance limits are labeled separately. After a
reset time passes, Octant waits for an updated reading instead of assuming the
quota has refilled. Missing windows are not counted as zero, and a failed refresh
keeps the last successful reading visibly stale.

The planner, manifest, and limits on this page do not change with that
placement. Sensitive values are redacted in previews.

## When you are blocked

Octant will not send an over-budget turn. Remedies include unpinning or
excluding content, compacting a range, unloading optional tools or MCP
servers, replacing raw results with artifact references, reducing the output
reserve, switching to a larger-context model, or starting a fresh thread with
a structured handoff.

## Unreported thread usage

A new or unused fork has no provider usage report of its own. Its context
disclosure shows **Not reported** until a report arrives; a provider-reported
zero remains zero. Available account-limit readings are shown independently.

## Next steps

- [Usage and limits](/advanced/usage-and-limits) for cross-app history and remaining capacity
- [Providers and models](/advanced/providers) for selecting a model and limits
- [Subagents](/advanced/subagents) for how child runs share context capacity
- [Recovery and troubleshooting](/advanced/recovery) when a thread needs repair
