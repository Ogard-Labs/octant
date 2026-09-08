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

### Model visibility

Expand a provider and use **Shown / Hidden** beside each reported model to
choose which models appear in model pickers. This preference applies across
the app and survives connection checks and discovery refreshes. Hiding a
model keeps the provider configured and preserves tasks already using that
model. Show it again in the same list to make it selectable for new tasks.

New-task defaults use visible models. If every model is hidden, show a model
in Provider Settings before starting a new task. Visibility is a selection
preference; it does not grant or change provider permissions.

### App-managed browser tools

The Browser view and an agent's browser access are separate capabilities.
A tool-capable model can still lack an adapter for Octant's app-managed tools;
check the provider's capability details before relying on agent browser control.
Manual browser controls remain governed by the thread's normal policy.

Supported app-tool adapters can request an isolated browser session under
**Ask for approvals** without changing the task to Full access. The request
names the origin. Cancelling the task revokes its browser grant, and Plan mode
refuses browser effects. The native OpenCode CLI adapter currently reports
app-managed tools as unsupported; its text and native-tool support do not imply
an app-browser bridge. The adapter requires isolated configuration before it can
expose Octant tools; changing the thread to Full access does not remove that
requirement.

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

The beta `opencode2` executable appears separately as **OpenCode 2 preview**.
Octant uses its bounded loopback HTTP API to discover the provider catalog and
models, then uses the executable's ACP transport for Code and Work sessions.
The ACP path carries `session/request_permission`, model and mode selection,
streaming updates, resume, and cancellation through the shared ACP driver. Chat
and Plan sessions stay unavailable because the beta `acp` entrypoint starts a
same-binary server child and those modes do not grant process-spawn authority.
Octant never falls back to an unconfined session or treats the beta version as
the legacy OpenCode runtime. App-managed browser tools remain a separate
capability and are not implied by this ACP transport.
The launch keeps the user's existing global OpenCode config readable while
writing runtime cache, state, and temporary files under Octant's managed home;
the provider-owned auth directory is the only host data path with write access.
Custom plugins and discovered skills are suppressed for the ACP child process.

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
- **Black Forest Labs Image** (`flux-pro-1.1`, `flux-pro-1.1-ultra`,
  `flux-dev`, `flux-kontext-pro`, `flux-kontext-max`, `flux-2-pro`, and
  `flux-2-flex` as suggestions)
- **Ideogram Image** (`ideogram-v3` and `ideogram-v4` as suggestions)

Allowlists are manual-entry; suggested IDs are not the only values Octant
accepts. Image profiles have no editable base URL. GPT Image models require
OpenAI Organization Verification. Black Forest Labs generates exactly one
image per request and does not accept reference images; it has no quality,
size, or aspect ratio controls of its own. Ideogram also does not accept
reference images and has no quality, size, or aspect ratio controls of its
own, but does generate up to Octant's own variant limit per request. They
never appear in the Chat, Work, or Code model picker — they are not thread
drivers.

Provider-specific setup guidance is documented in Settings, including the
Amazon Bedrock Mantle regional endpoint and API-key credential.

### Custom image sources

An enabled **OpenAI-compatible** HTTP provider can also serve image
generation, the same way it already can serve Voice: in **Settings → Image
Generation**, name the instance and a model as a custom image source. No
second credential or base URL is needed — the instance's own endpoint keeps
serving chat, voice, and images at once. Recraft is a working example: its
API matches OpenAI's image format, so it needs no dedicated Octant support —
just add it as an OpenAI-compatible endpoint and register it as a custom
image source. Up to 20 custom sources may be configured alongside the
dedicated OpenAI Image, Gemini Image, Black Forest Labs Image, and Ideogram
Image profiles.

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
