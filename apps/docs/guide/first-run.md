---
description: "Complete the first-run flow: configure a provider, create a Project, and start your first thread."
---

# First Run

After launching Octant for the first time, the welcome surface walks through
who you are, how the workspace looks, which providers this Mac can reach, a
default Chat model, and whether Navigator is on. None of those setup steps
except your name is a gate. Skip, dismiss, or quit keeps every answer that
already landed; first run stays pending until an answer is accepted.

The last screen is a readiness view. It reports three facts separately:
whether a provider can answer, whether a Project exists for the mode you
selected, and whether that mode has a model it can actually use. One primary
action starts a real thread in that mode when those facts are true. A missing
prerequisite opens its exact setup surface — provider settings, Project
create, or the default-model step — and returns to the same draft when that
surface closes. Skip does not mark the host ready or start a thread.

## Configure a provider

Octant is provider-neutral. No core capability requires a specific provider.
From first run, **Set up a provider** opens Settings on the Providers section:

1. Create a new provider instance (for example, OpenCode, Codex, Claude, or an
   OpenAI-compatible endpoint).
2. Provide the required configuration:
   - **OpenCode**: absolute path to the `opencode` binary. Run `opencode login`
     outside Octant if authentication is required.
   - **Codex**: absolute path to the `codex` binary. Run `codex login` outside
     Octant if authentication is required.
   - **Claude**: absolute path to the Claude Code binary and an authentication
     mode (subscription or API key).
   - **OpenAI-compatible**: endpoint URL, Bearer credential, and optional model
     IDs.
3. Run **Connection Check** to verify readiness. The check reports normalized
   readiness, detected version, models, and capabilities without sending a
   prompt or exposing account identity.

Credentials are stored in the host secret store (macOS Keychain, or Linux
Secret Service on a headless host) and resolved through the authenticated
host broker. They are never written to the event journal or returned to the
renderer.

Closing Settings returns to first run with the answers you already gave.

## Create your first Project

A thread starts in a Project. The readiness view's Project fact opens the
same create surface the sidebar uses:

- **Chat Projects** are virtual containers with scoped memory and no
  filesystem authority. First run asks only for a name.
- **Work Projects** bind one OS-confined folder for local knowledge work.
- **Code Projects** bind one folder for engineering work; Git tools activate
  when it is a repository.

The selected root is validated to exist. The renderer receives an opaque,
single-use receipt rather than the raw path.

## Start a thread

When the readiness view shows a provider, a Project, and a mode-valid model:

1. Choose Chat, Work, or Code. Modes you turned off on the workspace step are
   absent.
2. Press the primary action. Octant records first run as completed and opens a
   real draft thread in that Project.

The thread starts in the authority mode you selected: **Full access**,
**Approval-gated**, or **Plan** (read-only). Code threads start approval-gated
unless you explicitly remember Full access.

Destinations that this host cannot back — Navigator without a model, a Work
board that is not wired, GitHub pull requests without a working GitHub
capability, Agents without child runs — stay absent rather than advertised.

## Local profile and execution settings

Octant supports persisted execution profiles that capture settings, provider
defaults, and effective context. Create, edit, and restore profiles through
Settings to avoid reconfiguring each thread.

Selecting a profile in the Code composer binds it to the thread you start. The
profile can only narrow that thread: if it defaults to Approval-gated and you
asked for Full access, the thread starts Approval-gated; if you asked for Plan,
Plan stands. It shortens the permission duration the same
way: a profile that keeps permissions to the current session starts the thread
that way even if you asked for the Project default. A profile written for
another mode, one that does not list the model you selected, and one that
belongs to a different Project or thread all refuse the thread rather than
starting it. A profile can
never grant authority the Project does not already give, and editing a profile
afterwards does not change a thread that is already running under it — the
thread shows which profile it started under beside its model and access
controls.

## Next steps

Explore the three modes in detail:

- [Chat](/guide/chat) for conversations and virtual Projects
- [Work](/guide/work) for local knowledge work
- [Code](/guide/code) for repository engineering
