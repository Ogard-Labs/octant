---
description: "Complete the first-run flow: configure a provider, create a Project, and start your first thread."
---

# First Run

After launching Octant for the first time, you need to configure at least one AI provider and create a Project before you can start a thread.

## Configure a provider

Octant is provider-neutral. No core capability requires a specific provider. Go to **Settings** and add a provider instance:

1. Open the Settings panel from the app menu.
2. Navigate to the **Providers** section.
3. Create a new provider instance (for example, OpenCode, Codex, Claude, or an OpenAI-compatible endpoint).
4. Provide the required configuration:
   - **OpenCode**: absolute path to the `opencode` binary. Run `opencode login` outside Octant if authentication is required.
   - **Codex**: absolute path to the `codex` binary. Run `codex login` outside Octant if authentication is required.
   - **Claude**: absolute path to the Claude Code binary and an authentication mode (subscription or API key).
   - **OpenAI-compatible**: endpoint URL, Bearer credential, and optional model IDs.
5. Run **Connection Check** to verify readiness. The check reports normalized readiness, detected version, models, and capabilities without sending a prompt or exposing account identity.

Credentials are stored in macOS Keychain and resolved through the authenticated desktop broker. They are never written to the event journal or returned to the renderer.

## Create your first Project

Projects organize your work and determine the authority available to threads. The mode determines the Project type:

- **Chat Projects** are virtual containers with scoped memory and no filesystem authority.
- **Work Projects** bind one OS-confined folder for local knowledge work.
- **Code Projects** bind one folder for engineering work; Git tools activate when it is a repository.

To create a Project:

1. Click the **New Project** button in the sidebar.
2. Select the mode (Chat, Work, or Code).
3. For Work and Code, use the native picker to select a directory.
4. Name the Project.

The selected root is validated to exist. The renderer receives an opaque, single-use receipt rather than the raw path.

## Start a thread

With a Project and provider configured:

1. Select your Project.
2. Open the composer in the workspace.
3. Choose the provider and model for the thread.
4. Send your first prompt.

The thread starts in the authority mode you selected: **Full access**, **Approval-gated**, or **Plan** (read-only). Code threads start approval-gated unless you explicitly remember Full access.

## Local profile and execution settings

Octant supports persisted execution profiles that capture settings, provider defaults, and effective context. Create, edit, and restore profiles through Settings to avoid reconfiguring each thread.

## Next steps

Explore the three modes in detail:

- [Chat](/guide/chat) for conversations and virtual Projects
- [Work](/guide/work) for local knowledge work
- [Code](/guide/code) for repository engineering
