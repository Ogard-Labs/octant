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

### EU and ZDR labels

Provider instances and individual models can carry user-maintained **EU** and
**ZDR** labels. These labels are local policy metadata, not a claim that
Octant independently verified a provider's residency or retention guarantees.
Use the labels in **Settings → Providers & Models** when a Project needs a
data-handling boundary.

On a Work or Code Project page, **Provider access** offers three policies:

- **Allow all providers** (the backwards-compatible default)
- **Allow EU or ZDR tagged providers/models**
- **Allow only selected providers**

The host enforces the selected policy for new threads, provider/model changes,
and every turn. If a policy changes while a thread is open, a follow-up is
refused when its current provider or model is no longer accepted. Picker
filtering is only a convenience; it cannot bypass the server check. A provider
must still be installed, enabled, authenticated, and ready regardless of its
labels or whitelist entry.

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
one instance per driver family for the preferred safe candidate. On first run,
a detected Claude Code or Codex CLI instance is created enabled; every other
detected runtime is created disabled. After first run, auto-registration
always creates a disabled instance. Auto-registration never toggles an
existing instance, never stores credentials, never logs in, and never installs
or automatically updates CLIs. Explicit **Update CLI** actions are separate
and only invoke a verified provider-owned updater. Disabled rows whose binary
the current scan found show **"Detected on this host — enable to use"**;
enabling runs the Connection Check first. A scan that has not run, failed, or
was cancelled is not treated as proof that a runtime is gone, so the switch
stays off until a scan completes. A scan proves absence only for the
directories it actually searched: a binary configured outside every searched
location can still be enabled, and the host then checks that it exists. Once a
scan completes, providers that are switched on are listed first under
**Configured providers**, and the ones that are off are separated into those
detected on this host and supported providers it did not find. Each provider is a card with its logo,
name, maker, and a state line (a filled dot for ready, a ring for needs setup, a
muted ring for off), two to a row on a wide window. A manual endpoint addition has no local
binary, is not described as undetected, and can be enabled without detection.
Enabled is not ready: detection does not assert authentication.

Discovery also recognizes a narrowly parsed alias declaration for a supported
executable in `~/.bash_aliases`, `~/.bash_profile`, `~/.bashrc`, `~/.zprofile`,
or `~/.zshrc`. Octant reads those files without sourcing them, accepts only a
single executable token or absolute executable path, then applies the same
absolute-path, executable-file, symlink, probe-timeout, and output-size checks
as ordinary `PATH` results. Shell functions, aliases with arguments, command
substitution, and aliases that exist only in an already-running interactive
shell are intentionally ignored; add a persistent alias declaration or use the
manual binary path field for those cases.

Local CLI and SDK providers include Codex CLI, Claude Agent SDK,
OpenCode CLI, Kilo ACP, Pi RPC, Oh My Pi, Devin ACP, Mistral Vibe ACP,
Ollama, Kimi Code ACP, Grok Build ACP, Goose ACP, GLM Agent, Gemini CLI ACP,
GitHub Copilot ACP, Cline ACP, Qwen Code ACP, and fx ACP.
fx is the one ACP provider Octant runs in a managed home rather than against a
native profile, because its ACP entrypoint exposes no profile-path variable;
it authenticates with a Vercel AI Gateway API key instead of a CLI login.

Codex commentary and subsequent answer messages retain paragraph boundaries
in new responses, including when the provider sends a completed message
without streaming its text. Previously saved responses are not rewritten.

Provider-owned CLI login is the default. Octant launches the configured
provider executable at its stored absolute path and points it at the provider's
documented native profile (for example `~/.grok`, `~/.gemini`, `~/.cline/data`,
or `~/.qwen`). It does not copy the binary, create a second login, or read
credentials from another desktop app. Run the provider's login command in a
terminal, then use **Check connection** in Octant. Explicit API-key mode remains
available for profiles that support it. Mistral Vibe from Octant requires a
Mistral API key entered in **Settings → Providers** because its confined launch
does not read the macOS Keychain.

The **Update CLI** action is shown only for providers with a verified native
update command. It runs that command against the same configured executable,
when no active session is using it, and then reports whether the observed
version changed, stayed the same, could not be compared, or the follow-up
connection check failed. Exit zero is not treated as proof that the binary was
replaced. When Settings is connected to another Octant host, the action runs
on that selected host against its configured binary; no updater command or
shell authority is sent to the renderer. Stop active sessions before updating.
Unsupported or unverified
commands stay unavailable. Octant never silently replaces a CLI or updates
providers without an explicit action. OpenCode is not updated by that
provider-owned command. **Settings → Providers & Models** shows the installed
and available versions of Octant's managed OpenCode copy and an **Update**
action. Update checks the same managed tool channel as device tools, verifies
the registry integrity hash, stages the release, and keeps the previous copy
if the new one does not start. A failure says why. Update writes only inside
Octant's managed location. It never replaces an OpenCode you installed
elsewhere. **Use Octant's copy** appears only after you agree, and it switches
this provider to the managed executable instead of overwriting your other
install. On a headless
host, use the provider's device/non-interactive login when available; no
desktop browser window is required by the architecture.

Oh My Pi is discovery-only in this release. Its Connection Check verifies the
pinned version and lists the models it reports, but Octant cannot start a turn
on it yet, so the provider row stays **Unavailable** with that explanation and
no Chat, Work, or Code picker offers its models. A saved default that points
at it is kept and shown as unavailable rather than removed.

Connection details distinguish the installed version from the version Octant
supports. A failed check reports only bounded process facts such as the stage,
exit code or signal, and a fixed safe diagnostic classification; raw provider
output, arguments, paths, environment values, and credentials are never shown.
An installed but unsupported Oh My Pi version is **Incompatible**, not an
available update: use its supported-version fact to choose the provider-owned
installation action outside Octant.

Released OpenCode 2 installs the `opencode` executable; `opencode2` names the
earlier beta build, which discovery still accepts as a fallback and shows as
**OpenCode 2 preview**. When both names are installed, discovery prefers
`opencode`. Which routes run is selected by the installed binary's version,
not by that name: a 1.x binary keeps the legacy session API, and a 2.x binary
lists providers and models from its HTTP catalogue. OpenCode 2 is listing
only, turns not yet supported. Octant never falls back to an unconfined
session or treats the 2.x version as the legacy runtime.

### API endpoints

Direct API endpoints use the short **Add API endpoint** flow. Supported
profiles:

- **OpenAI-compatible** HTTP (`auto`, `responses`, or `chat-completions`)
- **Anthropic-compatible** HTTP (`auto` or `messages`)
- **Azure AI Foundry** (OpenAI-compatible v1 profile; base URL must end with
  `/openai/v1/`; API-key only)
- **Ollama** local HTTP (loopback origin only)

Image generation profiles are also provider instances. Open **Settings → Image
generation → Add image provider** to choose a provider, enter its API key, and
set its model allowlist. The same profiles are available from the manual form
in **Providers & Models**:

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
order you set in Settings. Choose a source icon along the top or search across all
providers. Native model rows keep the model name prominent; models limited to
chat and analysis retain that distinction in Work and Code. Sub-provider catalogs
keep their grouping and filters. Sources change on click, not hover; short
result lists shrink to fit.

Star models for **Favorites**, or use **Recent** for your last five explicit
choices, saved locally. Both lists show each model's provider. From Search,
press **Down** to focus the results, use **Up/Down** to browse, and press
**Enter** to choose. **Escape** closes the picker without changing the selection.

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

Chat also offers these levels on its start screen, before the first message.
The chosen level is applied to the new thread before that message is sent.
New threads remember your last composer model and reasoning choice locally,
including after reloading the app. Reasoning is remembered separately for each
provider/model and restored only if that level is still supported. A model with
no remembered level starts at its provider default. Settings defaults do not
overwrite this last-used preference.

When a provider declares reasoning or effort levels, the model picker in Chat, Work,
and Code shows the selected model's levels below the model list. Work and Code offer
this control both when creating a thread and in an existing thread's composer.
**Default** uses the provider's own default. The choice is saved on the thread
and passed to the provider when the next turn's session starts. Only values the
selected model declares are accepted. Changing the provider or model of an
existing Work or Code thread resets that thread’s choice to Default; remembered
new-thread preferences never overwrite an existing thread’s settings. Models without a declared reasoning option do not show
this control. Drag the slider or use the arrow keys to adjust it. **Home** selects
Default and **End** selects the highest declared level. The full track and its
step markers show the available range; the reset button restores Default.

Chat also offers the model's other declared options, such as Codex **Service
tier**, in its composer. Work validates saved options again before starting a
turn; if the model no longer declares the selected level, choose a supported
level or Default before sending.

## Readiness and capabilities

Readiness states are `ready`, `unavailable`, `unauthenticated`,
`incompatible`, `degraded`, and `checking`. Capabilities are `supported`,
`unsupported`, or `unavailable`. Providers report capabilities honestly in
every mode and fail closed when a capability is unsupported. When a
connection check refuses, Settings names an Octant-authored reason and the
next action instead of a generic incompatibility sentence. Detected versions
stay visible when the probe read them. Raw provider output never appears here.

A Codex CLI configured for Amazon Bedrock authenticates with
`AWS_BEARER_TOKEN_BEDROCK` (plus `AWS_REGION`) or an `AWS_PROFILE` whose keys
are in the AWS shared config. Octant deliberately does not pass static IAM
keys exported in the environment (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) to the Codex runtime, so a host
that relies on them shows Codex as not ready with that reason. This is
intended, not a bug: move the keys into a profile or use the bearer token.

## Next steps

- [Context budgets and limits](/advanced/context-budgets) to understand how turns fit provider limits
- [Subagents](/advanced/subagents) for child runs that inherit provider settings
- [Release compatibility](/advanced/release-compatibility) for preview boundaries

## Devin Fusion settings

With an eligible paid Devin account and a current Devin CLI, check the Devin ACP
connection in **Settings → Providers & Models**. Discovery reads the options for
each model, so a large catalog can take tens of seconds to finish checking.
Turn preparation also refreshes discovery and can take a similar amount of time.

Choose a Fusion pairing in the composer model picker. Its **Lead** and
**Sidekick** controls select available pairings; **Thinking** sets the lead's
effort. **Speed → Fast** enables Fast Mode where that pairing supports it;
**Standard** disables it, and **Default** leaves the choice to Devin. Models
without a fast variant do not show a speed control. These settings are available
in Chat, Work, and Code and are applied when a thread starts or resumes. New
threads remember supported choices per provider and pairing; existing threads
keep their saved settings. Changing lead or sidekick carries any explicit effort
or speed choice that the new pairing also supports.
Model settings pause while a pairing change is being checked, then become editable
again when the change is confirmed or refused.

Octant refuses a setting that Devin no longer offers rather than silently using
a different one. Check the connection again to refresh the available choices.
Fusion model selection does not change Octant's access or approval policy.

See [Devin's Fusion documentation](https://docs.devin.ai/cli/fusion) for account
eligibility and model pricing.
