---
description: Add and manage provider instances, choose models, and change provider or model mid-thread.
---

# Providers and Models

Octant is provider-neutral. The shared model works with many AI providers,
and no core capability depends on any single provider. Settings lists each
kind where it is used:

- **Settings → Providers & Models** holds the agent runtimes Octant drives:
  ACP agents, coding CLIs such as OpenCode, Codex, and Kimi Code, and the
  Claude Agent SDK.
- **Settings → Octant Harness → Model endpoints** holds the model endpoints
  Octant calls over an API itself: OpenAI-compatible, Anthropic-compatible,
  Ollama, and Azure AI Foundry, including the ones you sign in to with a
  subscription.
- **Settings → Image generation** holds the image profiles and custom image
  sources.

All three are the same kind of provider instance, with the same credentials
and permissions; only the page that lists them differs.

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
Use the labels on a provider's details, in **Settings → Providers & Models** or
**Settings → Octant Harness → Model endpoints**, when a Project needs a
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
refuses browser effects. The native OpenCode CLI adapter offers Octant tools
only on macOS and only on the OpenCode releases whose isolated configuration
was verified (1.18.21 and 2.0.22); on any other release it reports app-managed
tools as unsupported, and its text and native-tool support do not imply an
app-browser bridge. Changing the thread to Full access does not remove the
isolation requirement.

### Discovery and auto-registration

Octant scans a sanitized `PATH` plus approved install locations to find
local provider runtimes. Opening **Providers & Models** auto-registers at most
one instance per driver family for the preferred safe candidate. On first run,
a detected Claude Code or Codex CLI instance is created enabled; every other
detected runtime is created disabled. After first run, auto-registration
always creates a disabled instance. A detected local Ollama server is listed
under **Settings → Octant Harness → Model endpoints** rather than with the
agent runtimes. Auto-registration never toggles an
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

Claude Code on a Claude subscription has one extra step for subagents and Plan
turns. Those runs are read-only and cannot reach the keychain where your Claude
sign-in lives, so **Settings → Providers → Claude Code** offers **Connect Claude
for helpers**. Octant runs Claude's own `claude setup-token` on this Mac, you
approve once in the browser window it opens, and Octant keeps the long-lived
token it prints in its own credential store for that Claude Code provider. You
never copy the token. Ordinary Claude turns keep using your normal sign-in.
**Disconnect** removes the token from Octant, and removing the provider tries
to; disconnect first, because removal completes even if the credential store
cannot be reached. Neither revokes it with Anthropic. If Claude later refuses it, Settings shows it as
expired and asks you to connect again. Connect only from the Mac that runs
Octant, because the approval opens a browser there. The
[privacy notice](/advanced/privacy-notice#claude-for-helpers-only-if-you-connect-it)
states what is stored and who receives it.

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
lists providers and models from its HTTP catalogue and runs turns under the
thread's approval setting, which Octant writes into OpenCode's private
configuration: edits and shell commands ask unless the setting allows them,
and other providers' tools and skills are refused. With OpenCode 2.0.22 on
macOS, Octant's app tools are registered for each session through OpenCode's
runtime MCP API and stay private to that session; each call goes through
Octant's own tool handling and approvals, as on every other runtime. Approval
requests reach you as usual, with one exception: if you saved a permission for this
repository in OpenCode itself by choosing to always allow it, OpenCode
applies it and Octant does not ask. Octant's own refusals still apply, and
Octant never saves such a permission for you. Clear the saved permissions in
OpenCode to get the prompts back. Questions from the agent are not supported
yet and end the turn, and so does any OpenCode event Octant does not
recognise; the error names the event. OpenCode 2 resolves a project inside a Git work tree by
starting Git, which the Chat, Plan, and Work jail does not allow. On macOS
Octant gives those launches a stand-in `git` that always fails, so OpenCode
serves the folder without Git and every mode runs. Linux has no such stand-in
yet. A runtime whose confined server cannot answer for a work tree, including
every 2.x runtime on Linux, is shown as **Incompatible**: its models are
listed and no turn is offered. Octant never falls back to an unconfined
session or treats the 2.x version as the legacy runtime.

### API endpoints

Direct API endpoints are added in **Settings → Octant Harness → Model
endpoints → Add endpoint**, which asks for the base URL and, where the
endpoint needs one, an API key. **Check and add** adds the endpoint and checks
it straight away; the result shows in the same dialog, so a mistyped address
can be fixed from there. Supported profiles:

- **OpenAI-compatible** HTTP (`auto`, `responses`, or `chat-completions`)
- **Anthropic-compatible** HTTP (`auto` or `messages`)
- **Azure AI Foundry** (OpenAI-compatible v1 profile; base URL must end with
  `/openai/v1/`; API-key only)
- **Ollama** local HTTP (loopback origin only)

API keys are stored only by the Octant desktop app. In a browser, the add form
says so before you fill it in and keeps the key field off; you can still add an
endpoint that needs no key (for example a server on this computer). If a
configured endpoint lists far more models than you set up, such as an Azure
resource that lists every base model, **Settings → Octant Harness** shows the
models you configured first and the rest under **Discovered on the endpoint**;
an Azure AI Foundry provider offers only its configured deployments.

Each endpoint is one row that says whether it works: **Ready**, **Sign in to
use**, **Signed out**, **Checking…**, **Can't connect**, **Key refused**,
**Not working**, **No models yet**, or **Off**. A row that needs you says why
in one sentence and offers one fix, such as **Try again**, **Replace key**,
**Edit address**, or **Add model IDs**. Opening a row shows the endpoint's own
page: its sign-in or key, its models (search them, show or hide each one, and
**Verify tools** for a model marked **Chat only**), where its data goes, its
name and address, and **Diagnostics** with the protocol, authentication, the
last check's exact answer, and capabilities. The **Use** switch on that page
turns the endpoint off without losing its key, sign-in, or roles, and
**Remove** asks first and names the model roles that use it.

An endpoint model is offered for image work, such as reading screenshots from
browser and computer tools, only when Octant knows it accepts images: the
endpoint's own model list says so (OpenRouter does), or the model is a family
whose provider documents image input, such as GPT-4o, GPT-4.1, GPT-5, o3,
o4-mini, Claude 4 models, and Gemini 2.5. What the endpoint reports wins over
the built-in list. A deployment with a name of its own takes image input from
the model it reports serving after its first completed request. Any other
model is treated as text-only.

Image generation profiles are also provider instances. Open **Settings → Image
generation → Add image provider** to choose a provider, enter its API key, and
set its model allowlist. Image generation is where these profiles are added
and listed:

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

### Signing in with a subscription

An **OpenAI-compatible** endpoint can sign in with a subscription instead of
an API key. **Settings → Octant Harness → Model endpoints** offers each one as
its own way to add an endpoint:

- **Sign in with ChatGPT** — adds an endpoint named **ChatGPT plan** at
  `https://api.openai.com/v1` and starts the sign-in with your ChatGPT
  account. It uses the plan's Responses route.
- **Sign in with OpenRouter** — adds an endpoint at
  `https://openrouter.ai/api/v1` and signs in with your OpenRouter account,
  storing the issued API key.

Each button carries the sign-in's terms as one line under it; choosing it
accepts them, and Octant records that acknowledgment before the sign-in
starts. Neither asks for a base URL or an API key: the endpoint is fixed by the
sign-in, and the host refuses the sign-in, and any use of its token, on any
other endpoint. The endpoint's row then shows who is signed in, and its page
offers **Sign out** and **Sign in again**; Octant checks the endpoint as soon
as a sign-in finishes. An endpoint you added yourself whose base URL is
one of these offers the same sign-in beside its API key. The host refuses a
sign-in started from a paired device; sign in from the Octant app or a browser
on the host.

The sign-in opens the provider's authorization page in the system browser and
completes on a loopback callback; Octant never sees or types your credentials.
On the first sign-in the host registers itself as a user-defined agent: the
stable host id is sent before the first sign-in and the issued client id
returned by the callback is stored and reused for every later refresh. The
identity token is validated against the issuer's published keys before the
grant is stored. Signing out revokes the refresh token at the issuer before
the local grant is dropped. If the sign-in service can't be reached, Octant
keeps you signed in and says so: try again, or choose **Sign out on this
computer only**, which removes the stored sign-in here but leaves it valid at
the sign-in service until it expires. Signing in again on the same endpoint
always removes the previous sign-in from this computer.

The ChatGPT plan route is a preview with a fixed request shape: storage is
disabled, streaming is on, the full history is sent as an array, system text
travels as instructions, and only function tools are available — no hosted
tools. A request that cannot be expressed under that shape is refused with a
typed reason rather than silently reshaped. If the granted scopes do not
include plan usage, the sign-in still succeeds as identity-only and plan
turns are refused until you sign in again and allow plan access. When the
plan's usage limit is reached, the failure links to ChatGPT's usage settings
(`https://chatgpt.com/settings/usage`).

**Check now** lists the models the plan route reports, with their names,
context windows, and image input when the route gives them. When it cannot get
a model list from the route, the row says **No models yet** in words instead of reporting an
invalid response: add the model IDs your plan offers under **Manual model
IDs**, then check the connection again. Those IDs are shown as manual and
unverified until a turn succeeds with them. A rejected sign-in, a reached
usage limit, or an unavailable route still fails the check with its own
message.

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
If Devin explicitly refuses an advertised model as unavailable, Octant omits it
and keeps the other usable models. Authentication and connection failures still
fail the connection check.

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
