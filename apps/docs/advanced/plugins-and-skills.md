---
description: How plugin packages and standalone skills install, become trusted, enable, and contribute context in Settings.
---

# Plugins and Skills

Plugins and skills extend Octant through one provider-neutral extension
system. The core rule: **installation never implies trust, activation,
enablement, or authority.**

## The trust model

Each installed package tracks several separate state dimensions:

- **Installed** — verified files exist
- **Desired enabled** — you want it
- **Trusted** — you approved the source and its declared executable kinds
- **Compatible** — the host, app, provider, and platform support it
- **Allowed** — mode, Project, thread, and host policy permit it
- **Effective** — every condition above resolves enabled

Installing an extension never enables it. Trusting never activates it. A
package becomes usable only when every dimension resolves, and a trusted
extension still passes ordinary approval, mode, Project, host, provider,
root, worktree, and confinement checks. A trusted MCP server does not receive
shell, filesystem, network, or credential authority just because its source
is trusted.

Disabled, untrusted, and unselected components contribute **zero** prompt,
schema, or tool context.

## Settings → Skills & Extensions

The **Skills & Extensions** section has two tabs.

### Installed

The **Installed** tab lists **Extension packages** and **Standalone skills**.
Package cards offer **Trust source** / **Revoke trust**, an **Enable plugin**
master switch, per-component **Enable component** switches, and **Uninstall**.
Each component shows an effective state of **Effective** or **Blocked —**
with a specific reason such as Host prohibited, Mode prohibited, Project
prohibited, Thread prohibited, Not installed, Untrusted, Plugin disabled,
Component disabled, Incompatible, Quarantined, Draining, Broken,
Unavailable, Interrupted, or Waiting.

Standalone skills show name, availability, source label, qualified identity,
review and desired state, effective state, content bytes, description, and
diagnostics. A **Name collisions** section appears when the same skill name
exists from multiple sources; you choose the exact source before use — a
collision is never silently merged or shadowed.

A reviewed and enabled standalone skill can be selected with `$skill` in Chat,
Work, or Code. Octant checks the exact source, content digest, and current
thread scope before adding its instructions to the provider context. A changed,
disabled, or unavailable selection refuses the turn instead of silently dropping
the skill. Selected Work instructions also count toward the turn's input budget.

### Marketplace

The **Marketplace** tab searches the extension catalog: the curated package
the host ships metadata for and published Agent Plugins packages on npm. Each
entry can be **Inspected** before install with a **"Review before installing"**
panel covering publisher, source, upstream commit, source review, license,
digest, platforms, modes, providers, capabilities, component list, and
diagnostics. Install requires **Confirm install** and always starts disabled.

Agent Plugins discovery on npm uses the publisher-adopted `agent-plugin` /
`agent-plugins` keywords. The keyword is a discovery convention, not trust: the
host fetches each candidate with bounded bytes, requires a root `plugin.json`
whose `$schema` is the canonical 1.0.0 URL, and lists the package's real
identity and digest. A package that does not validate is not listed.

The same tab also searches **standalone skills** from
[skills.sh](https://skills.sh/) and npm packages that ship `SKILL.md`. Preview
a skill, then **Confirm install**. Installed skill packages still start
disabled — trust and enable them from **Installed**.

Opening the tab does not contact a registry. Search, inspect, preview, and
install are explicit buttons. Importing a local Agent Plugins folder uses the
native folder picker and never reaches a catalog.

### What a marketplace fetch discloses

These are the second kind of HTTPS call Octant makes on its own behalf. They
are not telemetry: they carry no account, install identifier, Project,
thread, configuration, or cookie, and they do not use your GitHub or npm
credentials. They do disclose an IP address, as any network request does, and
a catalog or skill search discloses the query you typed. See
[Privacy and security](/advanced/privacy-and-security#host-initiated-network)
for the companion update-check posture.

**Extension catalog.** **Run search** filters the curated catalog the host
holds in memory. When marketplace fetches are on, it also searches npm for
published Agent Plugins: your query plus `keywords:agent-plugin` and
`keywords:agent-plugins` as two requests to
`https://registry.npmjs.org/-/v1/search` with a page size of 25. **Inspect**
then validates and reviews the listed package; the exact `name@version` bytes
are cached at listing time, so **Confirm install** uses the inspected package
rather than re-fetching. If the host no longer holds the cached bytes, inspect
re-fetches that exact version's metadata and tarball from
`registry.npmjs.org`. Curated entries instead fetch the pinned package from
GitHub (`api.github.com` for the tree, then `raw.githubusercontent.com` for
the blobs at the exact commit the catalog named). Whoever operates those
endpoints sees your IP address, the query text or package path, and the time.

**Standalone skills.** **Search skills** contacts both registries in
parallel, even if only one will match:

- `https://skills.sh/api/search` with your query as `q` and a page size of 25.
- `https://registry.npmjs.org/-/v1/search` with your query plus
  `keywords:agent-skills` and a page size of 25.

Whoever operates those endpoints sees your IP address, the query text, and
the time. An empty query is not sent. **Preview** and **Confirm install**
then fetch the package: skills.sh entries from GitHub's API and
`raw.githubusercontent.com` (User-Agent `octant-skill-marketplace`), npm
entries as package metadata and a tarball from `registry.npmjs.org` (the
same User-Agent on every marketplace request).

**Off switch.** Turn marketplace fetches off in
**Settings → Skills & Extensions → Marketplace**. Off means no request is made: catalog
search falls back to the in-memory curated entries, and Search skills,
Inspect, preview, and install refuse rather than calling out. Opening the
Marketplace tab still does not fetch on its own. Skills already on disk under
`.agents/skills/` or `.claude/skills/` and plugins imported from a local folder
never contact a registry.

Every marketplace and catalog HTTPS request uses User-Agent
`octant-skill-marketplace` with no app or runtime version — the same
minimum-necessary style as an update check's `Octant` User-Agent.

## Plugins

A plugin is an extension package that can contribute prompt-only skills, MCP
servers, and declared renderer surfaces (sidebar destinations, settings
sections, workspace tabs, thread panes, preview viewers, appearance presets,
and board views). The host rejects unknown contribution points, and a
disabled component contributes no surface. Octant is a conformant
[Agent Plugins](https://agent-plugins.org/) 1.0.0 client: portable packages use
root `plugin.json`, `skills/`, and `mcp.json`. Codex-compatible
`.codex-plugin/plugin.json` packages remain supported through a compatibility
adapter.

Every package carries a stable extension ID, source, source version and content
digest, manifest version, provenance record, compatibility range, and
declared components. Package files are immutable per installed version;
updates stage a new version rather than mutating in place.

Agent Plugins MCP servers receive `PLUGIN_ROOT` and a dedicated persistent
`PLUGIN_DATA` directory. Octant expands only those two placeholders in
`args`, `env` values, and `cwd`, connects with the declared stdio or Streamable
HTTP transport when a component becomes effective, and isolates invalid skills
or MCP entries so siblings continue loading. Marketplace supports importing a
local Agent Plugins folder from disk through the native folder picker. The
selected absolute path remains in the desktop/server boundary; Settings receives
only a short-lived, single-use receipt bound to the exact native window.

MCP discovery does not authorize execution. Every tool call must pass an
action-specific approval bound to the exact thread, Project, package,
component, tool identity, and input before Octant sends `tools/call` to the
server. Missing or denied approval fails closed. A selected MCP component whose
catalog contains no provider-compatible tools is unavailable rather than an
empty successful selection.

Installation is transactional: stage, validate (size, manifest, normalized
paths, symlinks, integrity, compatibility, provenance, components), persist
as installed-but-disabled, and atomically promote. A failure before promotion
leaves no visible partial package. Updates preserve desired-enable choices
for unchanged components; new or capability-expanded executable components
are **quarantined** until reviewed, and rollback selects only retained,
integrity-verified earlier versions.

### Starting an MCP server

On macOS an MCP server runs in a sandbox that cannot follow a `#!` line to its
interpreter. Declare the interpreter as the `command` and the script as an
argument, with the script's absolute path or `${PLUGIN_ROOT}`:

```json
{ "type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/server.mjs"] }
```

A `command` that is itself a script, either one shipped in the plugin or a
launcher such as `npx`, `npm`, or `uvx`, is refused before it starts, with this fix in
the message, and the server is never shown as ready. The server reads only the
plugin's own folder, so a package installed globally on the Mac is out of reach.
Put the package inside the plugin when you build it, for example
`npm install --prefix "${PLUGIN_ROOT}" <package>`, and point `node` at
`${PLUGIN_ROOT}/node_modules/<package>/<entry>.js`. `uvx` and `uv tool run` /
`uv run` are refused the same way. For Python, build a virtual environment
inside the plugin, for example
`uv venv "${PLUGIN_ROOT}/.venv"` and `uv pip install --python "${PLUGIN_ROOT}/.venv/bin/python" <package>`,
and set `"command": "${PLUGIN_ROOT}/.venv/bin/python"` with the package's script
or `["-m", "<module>"]` as `args`. A virtual environment built from Homebrew
Python runs under the sandbox.

### Add an MCP server by hand

**Settings → Skills & Extensions → Add MCP server…** connects a server
without a package. Give it a name and choose how Octant reaches it:

- **Command**: a program on this computer, by name or full path, its
  arguments one per line, and environment variables. Octant starts it
  confined, the way it starts a plugin's own server.
- **Address**: an `https` address (or `http` on this computer) and headers.

Mark a value **Secret** to keep it in this Mac's credential store instead of
the package; Octant cannot show it again. The server appears under Extension
packages as **Added by you**, installed, trusted and switched on, and its tools
ask for approval on every call like any plugin's. Removing it deletes the
package and its secrets. Adding a server works only from the Octant window on
this host, not from a paired device, and a browser-hosted Settings cannot keep
secrets.

### Sign in to a hosted server

A server you added by its address can ask you to sign in instead of taking a
key. Its component in **Extension packages** then shows **Sign in**. Octant
reads where the server sends people to sign in, registers itself there,
opens that page in your browser, and keeps the grant in this Mac's
credential store; the row says **Signed in through** the issuer, with
**Sign out**. If the grant stops working you see **Sign in again**. A server
whose sign-in needs a client id Octant cannot register for itself says so;
you can still add that server with a key in a header. Signing in and out work
only from the Octant window on this host.

### Found on this Mac

Below the extension packages, **Found on this Mac** lists the MCP servers
and plugins Claude Code and Codex already use on this computer: the servers
in Claude Code's configuration (yours, and the ones kept for a Project folder
Octant knows), a Project's `.mcp.json`, Codex's configured servers, and the
plugins each tool has installed. Looking changes nothing. **Add to Octant**
copies one server in, the same way Add MCP server does: a value whose name
reads like a credential goes to the credential store. A variable the other
tool reads from its environment is filled in, into a variable or header
value only, when this Mac has it. A server that uses a variable in its
command, arguments or address, or needs one this Mac lacks, cannot be added
from here: its row says which, and you add it by hand with the value
entered. **Review and import** reads one plugin for
the usual review and Install; a Claude Code plugin keeps its skills and MCP
servers, and its commands, agents and hooks are left out, which the review
says. Octant never writes to the other tools' files. The section appears
only in the Octant window on this host.

### Structured references

In a composer, typing `@` opens a searchable plugin palette. Selections
become structured reference chips backed by the stable extension ID —
`@plugin-name` selects the primary capability when unambiguous, and
`@plugin-name/component-name` selects an explicit component. References can
only select installed, trusted, enabled, policy-allowed components. They
**never install, trust, enable, elevate, or grant credentials**. Stale or
revoked references block with an actionable explanation at send or resume.

The palette works the same in Chat, Work, and Code. Selecting a plugin's MCP
server offers its tools to that turn only. Each call shows an approval card
above the composer of the thread that asked; nothing runs until you approve
it. A model that cannot use Octant's tools refuses the turn instead of quietly
dropping the server.

The card names the plugin, its server, and the tool. **Approve once** runs that
one call. **Always allow in this Project** also makes Octant run that one tool
in that one Project without asking; other tools of the same plugin, and the
same tool in other Projects, still ask. It appears only where Octant can
remember the answer: not in a thread with no Project, not in Plan, not for a
network tool in a thread that has already read outside content, not for a
turn sent from a paired device, and not from a paired device. A plugin update,
or a change to how the server describes the tool, makes Octant ask again, and
removing the plugin forgets every answer about it.

A turn you send from a paired device, such as the phone, shows the card on that
device with **Approve once** and **Deny**. A window on the host that has the
thread's Project open shows the same card and may answer it instead. Whoever
answers first settles the call; if nobody answers within five minutes, the
call is denied.

To see or take back what you allowed, open **Settings → Data & privacy →
Remembered tool approvals**. It lists each tool under its Project with a
**Revoke** button; after revoking, the next call of that tool asks again. The
list is available at a window on the host, not from a paired device.

## Skills

Skills are prompt-only, non-executable instruction content that still
requires source and content review before enablement. They are discovered
from `<directory>/.agents/skills/<skill-name>/SKILL.md` and
`<directory>/.claude/skills/<skill-name>/SKILL.md` in the working
directory and each parent up to the Project or repository root, plus the
user-global `~/.agents/skills/`. Octant does not scan arbitrary files
elsewhere under `.agents/` or `.claude/`, and never reads the `.claude` folder
in your home folder. A `.agents/skills` or `.claude/skills` folder that is a
symlink, or that leads outside the Project, is ignored without a message.

A skill at a Project's root is available to every thread in that Project and
to no other Project. A skill in a subfolder is available only to a thread
working in that folder or below it. Chat threads see only your user-global and built-in
skills, because a Chat Project has no folder.

Every discovered skill gets a source-qualified identity, content digest,
provenance, and diagnostic state. New or changed skills are indexed
**disabled** until review and desired-enabled state allow use. Only one
same-named skill can be on where a thread could see it: turning one on turns
off the others with that name in the same Project, plus your user-global and
built-in ones, and leaves other Projects' skills alone. If two such skills are
ever on together (left by an older version, or because one came back after a
branch switch or an archived worktree while you turned the other on), Octant
turns both off and lists the name under **Name collisions** so you choose
again. `$skill-name` resolves to the single enabled skill
(or `@plugin-name/skill-name` for a plugin-contributed skill). Unambiguous
discovery must hold; an ambiguous unqualified invocation opens a chooser or
fails closed. A skill installed from the marketplace is switched on and off
with its package under **Extension packages**.

Some agent runtimes load skills from a Project by themselves, from
`.agents/skills`, `.claude/skills`, or a folder of their own such as
`.github/skills` or `.gemini/skills`. Octant blocks each such runtime from
reading and writing those folders at the Project root, so a skill there reaches
a turn only through the steps above. The folders around them, such as the rest
of `.claude`, stay readable.

Several runtimes also start code from a Project by themselves: MCP servers from
`.mcp.json` or their own config file, hook scripts, and plugins. Octant keeps
these out the same way, file by file, or with the runtime's own switch where
one works:

- OpenCode runs with its Project config switched off.
- Grok Build loads a Project's hooks, MCP servers, plugins, skills, and
  instructions only in a folder you trusted in Grok. Octant hides Grok's trust
  list from the runtime, so every Project is untrusted there. Your trust
  decisions stay in place for Grok itself, and Octant keeps Grok's folder trust
  switched on even if you turned it off in Grok's settings. A side effect is
  that Grok in Octant does not read the Project's `AGENTS.md`.
- GitHub Copilot, Devin, Kimi Code, Mistral Vibe, Cline, Goose, and Kilo are
  blocked from the specific files and folders that carry those servers, hooks,
  and plugins, such as `.mcp.json`, `.github/hooks`, `.devin/config.json`,
  `.vibe/tools`, or `.cline/plugins`. GitHub Copilot also reads
  `.claude/settings.json` and `.claude/settings.local.json` as repository
  settings, so those two files are blocked for it. Instruction files such as
  `AGENTS.md` and `.github/copilot-instructions.md` stay readable for these
  runtimes. They are text the runtime adds to its context, not code.

Gemini CLI and Qwen Code are the exception. They start the MCP servers and
hooks declared in a Project's own settings by themselves, and trust every
folder unless you turned folder trust on in their own settings. Blocking those
files would stop them from starting a session at all, so Octant refuses to
start either runtime in a Project that holds `.gemini/settings.json`, a
`.gemini/agents` or `.gemini/extensions` folder with files in it (Gemini CLI),
or `.qwen/settings.json`, `.mcp.json`, or a `.qwen/agents` or `.qwen/extensions`
folder with files in it (Qwen Code). The message names the entry. Remove or
rename it, or use another provider in that Project. Other Projects, and Chat,
are not affected, and a file in a parent folder does not count because neither
runtime reads settings from there.

Because the block covers writing too, an agent's own `git` commands on those
runtimes warn about tracked files in a blocked folder or file, and a
`git checkout`, rebase, or pull across commits that touch one fails with a
misleading "local changes would be overwritten" error. Nothing is lost, and
Octant's own Git features are unaffected. This is the accepted cost of keeping
unreviewed skills and code out of the runtime; fx and Kimi Code have always
worked this way for `.agents`.

Codex finds `.agents/skills` by itself and has no setting that stops it, so
Octant switches off each Project skill Codex finds whenever a Codex thread
starts or resumes. A skill added to the Project during a Codex thread is
available to that thread until it is next resumed. Codex releases from 0.66.0
up to 0.108.0 cannot switch a Project skill off for one thread, so Octant
refuses to start a Codex thread on them and asks you to update Codex.

Some gaps remain:

- A folder above the Project, when the Project is a subfolder of a repository,
  is not blocked for the runtimes that look upward (GitHub Copilot, Devin,
  Kimi Code, Mistral Vibe). Grok Build's trust rule covers every level.
- MCP servers, hooks, and plugins you set up in a runtime's own profile, such
  as `~/.copilot/mcp-config.json` or Grok's `~/.grok/config.toml`, still load,
  because Octant reuses that profile for your sign-in. Codex also loads the
  skills in your own `~/.agents/skills` and Codex skills folders by itself.

Type `/` in a Chat, Work, or Code composer — including Chat's first message — to find commands and enabled skills. Browser and Computer entries appear only when those capabilities are available.
Choosing a skill creates a visible selection that can be removed before sending;
it does not enable a disabled skill. Chat, Work, and Code resolve selected skill
instructions through the extension service before provider execution. Unavailable
selections are refused; retrying an accepted Work request with different skill
selections is an identity conflict rather than a new turn.

## Core Apple independence

An extension with a `trusted-extension` authority is **denied** core Apple
discovery, build, run, and test — those are app-managed and require core
authority, never an extension. Core Apple development never depends on an
optional extension.

## Next steps

- [Browser and computer use](/advanced/browser-and-computer-use) for related host-owned surfaces
- [Apple Development Workbench](/advanced/apple-workbench) for the extension-independent core path
- [Privacy and security](/advanced/privacy-and-security) for quarantine, provenance, and host-initiated network
