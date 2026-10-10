---
description: "Complete the first-run flow: configure a provider, create a Project, and start your first thread."
---

# First Run

After launching Octant for the first time, the welcome surface asks only what
your first task needs, in three steps: **Providers** (what this Mac can
reach), **Project** (the folder the task works in), and **Model** (the model it
starts with). Every step is optional. **Skip setup** is available from the
first step and keeps answers that have already been saved. Quitting without
completing or skipping leaves first run pending. If Octant could not save one
of your answers it tells you, and pressing Skip setup or the primary action
again continues without that answer.

Your name and avatar, appearance, and Navigator are not part of first run. Set
them whenever you like in **Settings → Profile**, **Settings → Appearance**,
and **Settings → Navigator**.

The last screen is a readiness view. It reports three facts separately:
whether a provider can answer, whether a Project exists for the mode you
selected, and whether that mode has a model it can actually use. When all
three hold, **Start a task** opens the new-task composer in that Project. A
missing prerequisite opens its exact setup surface — provider settings,
Project create, or the Model step — and returns to the same draft when that
surface closes. Skip does not mark the host ready or start a thread.

## Configure a provider

Octant is provider-neutral. No core capability requires a specific provider.

If Claude Code (`claude`) or Codex CLI (`codex`) is already installed, first
run enables the detected instance so a thread can start without visiting
Settings. Both are enabled when both are found. You can turn either off later;
later scans, restarts, and upgrades do not turn it back on. Other detected
CLIs still appear off until you enable them. Enabled is not ready: an
unauthenticated CLI still reports that it needs setup.

When nothing usable is already on, **Set up a provider** opens Settings on
the Providers section:

1. Create a new provider instance (for example, OpenCode, Codex, or Claude). A
   model endpoint Octant calls over an API itself, such as an
   OpenAI-compatible endpoint or **Sign in with ChatGPT**, is added under
   **Settings → Octant Harness → Model endpoints** instead.
2. Provide the required configuration:
   - **OpenCode**: absolute path to the `opencode` binary, or use **Update** in
     Providers to install Octant's copy and agree before switching to it.
     Update never replaces an OpenCode you installed elsewhere. Run `opencode login`
     outside Octant if authentication is required.
   - **Codex**: absolute path to the `codex` binary. Run `codex login` outside
     Octant if authentication is required.
   - **Claude**: absolute path to the Claude Code binary and an authentication
     mode (subscription or API key).
   - **OpenAI-compatible** (under Model endpoints): endpoint URL, Bearer
     credential, and optional model IDs.
3. Run **Connection Check** to verify readiness. The check reports normalized
   readiness, detected version, models, and capabilities without sending a
   prompt or exposing account identity.

Credentials are stored in the host secret store (macOS Keychain, or Linux
Secret Service on a headless host) and resolved through the authenticated
host broker. They are never written to the event journal or returned to the
renderer.

Closing Settings returns to first run with the answers you already gave.

## Create your first Project

A task starts in a Project. The Project step first asks which mode your first
task uses — **Work** or **Code** (only Code when Work is turned off) — then
**Choose a folder…** opens the same create surface the empty Work and Code
pages use. Making the folder a Git repository is a separate, explicit choice
there. The folder you create becomes your first task's Project; if you
already have Projects, pick one on the step instead.

- **Work Projects** bind one OS-confined folder for local knowledge work.
- **Code Projects** bind one folder for engineering work; Git tools activate
  when it is a repository.
- **Chat Projects** are virtual containers with scoped memory and no
  filesystem authority. They have no folder, so first run does not ask for
  one; create them from the sidebar.

## Choose a model

The Model step lists the models the providers you set up actually offer for
the selected mode. Your choice becomes what new tasks in that mode start with:
Work's default model in Work settings, or the model the Code composer
remembers. You can change the model for any task in the composer.

On an empty Code screen, **Add a folder** opens Project setup. If threads
without a Project are disabled, the screen explains this and links directly
to **Code settings**. Choosing a folder does not change access permissions.

The selected root is validated to exist. The renderer receives an opaque,
single-use receipt rather than the raw path.

## Start a task

When the readiness view shows a provider, a Project, and a mode-valid model,
press **Start a task**. Octant records first run as completed and opens the
new-task composer in that Project. Nothing is sent until you send it.

The thread starts in the authority mode you selected: **Full access**,
**Approval-gated**, or **Plan** (read-only). Code threads start approval-gated
unless you explicitly remember Full access.

Destinations that this host cannot back — Navigator without a model, a Work
board that is not wired, GitHub pull requests without a working GitHub
capability — stay absent rather than advertised. Agents is available on an existing thread even before the first child exists.

## Provider and access settings

Choose the provider, model, and access posture in the new-thread composer.
Execution profiles are no longer offered in Settings or the command palette
and do not supply new-thread defaults. Existing saved profile records remain
available for historical thread labels and automation configuration; removing
the Settings page does not change an existing thread's authority.

## Next steps

Explore the three modes in detail:

- [Chat](/guide/chat) for conversations and virtual Projects
- [Work](/guide/work) for local knowledge work
- [Code](/guide/code) for repository engineering
