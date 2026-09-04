---
description: Add and manage provider instances, choose models, and change provider or model mid-thread.
---

# Providers and Models

Octant is provider-neutral. The shared model works with many AI providers,
and no core capability depends on any single provider. Providers are managed
in **Settings → Providers & Models**.

## Provider instances

Each configured provider is an **instance** with a display name, driver,
enabled state, readiness, version, model count, and capability summary. From
an instance you can enable, disable, rename, remove, edit its binary path, run
a non-mutating **Connection Check**, and review discovered models and
capabilities.

- **Disabling** an instance prevents new sessions while preserving its
  configuration and historical thread references.
- **Removing** is rejected while active sessions depend on the instance.

### Discovery and auto-registration

Octant scans a sanitized `PATH` plus approved install locations to find
local provider runtimes. Opening **Providers & Models** auto-registers at most
one **disabled** instance per driver family for the preferred safe candidate.
Auto-registration never enables a provider, never stores credentials, never
logs in, and never installs or updates CLIs. Auto-registered rows show
**"Detected on this host — enable to use"**; enabling runs the Connection
Check first.

Local CLI and SDK providers include Codex CLI, Claude Agent SDK,
OpenCode CLI, Kilo ACP, Pi RPC, Oh My Pi, Devin ACP, Mistral Vibe ACP,
Ollama, Kimi Code ACP, Grok Build ACP, Goose ACP, GLM Agent, Gemini CLI ACP,
GitHub Copilot ACP, Cline ACP, and Qwen Code ACP.

### API endpoints

Direct API endpoints use the short **Add API endpoint** flow. Supported
profiles:

- **OpenAI-compatible** HTTP (`auto`, `responses`, or `chat-completions`)
- **Anthropic-compatible** HTTP (`auto` or `messages`)
- **Azure AI Foundry** (OpenAI-compatible v1 profile; base URL must end with
  `/openai/v1/`; API-key only)
- **Ollama** local HTTP (loopback origin only)

Image generation profiles are also provider instances, added from the same
manual form:

- **OpenAI Image** (`gpt-image-2` and related GPT Image models as suggestions)
- **Gemini Image** (Gemini 3.1 image models as suggestions, with
  `gemini-2.5-flash-image` as a legacy suggestion)

Allowlists are manual-entry; suggested IDs are not the only values Octant
accepts. Image profiles have no editable base URL. GPT Image models require
OpenAI Organization Verification. They never appear in the Chat, Work, or Code
model picker — they are not thread drivers.

Provider-specific setup guidance is documented in Settings, including the
Amazon Bedrock Mantle regional endpoint and API-key credential.

### Credentials

Credentials are write-only and stored as indirect references in the macOS
Keychain — never returned to the interface, never journaled, never placed in
process arguments or diagnostics. Remote endpoints require bearer or API-key
authentication; anonymous access is accepted only for loopback. OAuth and
subscription modes work where the official runtime supports them and are
never silently replaced by API-key modes.

## Choosing a model

The **provider-first model picker** groups models by provider instance in the
order you set in Settings. In Work and Code the picker splits models into
**"Tool-capable"** and **"Chat and analysis only"**; in Chat it lists
**"Models"**. Capability badges show **Tools**, **Vision**, **Reasoning**, and
context limit (for example, **"400K context"**).

A model that becomes unavailable stays visible on the current selection with
an actionable reason, so history is never silently rewritten. Model catalogs
come from runtime metadata, provider model endpoints, Octant's reviewed
catalog, or your own supplied metadata for generic endpoints.

## Changing provider or model in a thread

Existing Work and Code threads can change provider or model mid-thread from
the composer's **"Provider and model"** button. The change applies as a
**next-turn handoff**: the new provider and model are used for the following
turn. Readiness is validated before the change is recorded, thread identity
and history are preserved with change provenance, and an active provider turn
ends with the honest state **"Provider turn interrupted."**

## Effort, reasoning and speed

When a provider declares per-model options, the Chat composer shows one
compact selector per option right after the model picker: **Effort** for
Claude models that support effort levels, and **Reasoning** and **Service
tier** (speed) for Codex models that advertise them. Each selector starts at
**Default**, meaning the provider's own default. Your choice is stored on the
thread and handed to the provider when the next turn's session starts. Only
values the selected model actually declares are accepted; switching to a model
that does not offer an option clears that option back to Default. Models that
declare no options show no selectors.

## Readiness and capabilities

Readiness states are `ready`, `unavailable`, `unauthenticated`,
`incompatible`, `degraded`, and `checking`. Capabilities are `supported`,
`unsupported`, or `unavailable`. Providers report capabilities honestly in
every mode and fail closed when a capability is unsupported.

## Next steps

- [Context budgets and limits](/advanced/context-budgets) to understand how turns fit provider limits
- [Subagents](/advanced/subagents) for child runs that inherit provider settings
- [Release compatibility](/advanced/release-compatibility) for preview boundaries
