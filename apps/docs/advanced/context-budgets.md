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
Opening the popover does not make a further provider or network call.
Inspect context opens the composition list so you can pin, exclude, or
rebuild the next-turn plan. Switching the active pane closes a popover or
inspector that belonged to the previous thread and retargets every value.

The planner, manifest, and limits on this page do not change with that
placement. Sensitive values are redacted in previews.

## When you are blocked

Octant will not send an over-budget turn. Remedies include unpinning or
excluding content, compacting a range, unloading optional tools or MCP
servers, replacing raw results with artifact references, reducing the output
reserve, switching to a larger-context model, or starting a fresh thread with
a structured handoff.

## Next steps

- [Providers and models](/advanced/providers) for selecting a model and limits
- [Subagents](/advanced/subagents) for how child runs share context capacity
- [Recovery and troubleshooting](/advanced/recovery) when a thread needs repair
