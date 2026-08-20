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

### Marketplace

The **Marketplace** tab searches the extension catalog. Each entry can be
**Inspected** before install with a **"Review before installing"** panel
covering publisher, source, upstream commit, source review, license, digest,
platforms, modes, providers, capabilities, component list, and diagnostics.
Install requires **Confirm install** and always starts disabled.

The same tab also searches **standalone skills** from
[skills.sh](https://skills.sh/) and npm packages that ship `SKILL.md`. Preview
a skill, then **Confirm install**. Installed skill packages still start
disabled — trust and enable them from **Installed**.

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

### Structured references

In a composer, typing `@` opens a searchable plugin palette. Selections
become structured reference chips backed by the stable extension ID —
`@plugin-name` selects the primary capability when unambiguous, and
`@plugin-name/component-name` selects an explicit component. References can
only select installed, trusted, enabled, policy-allowed components. They
**never install, trust, enable, elevate, or grant credentials**. Stale or
revoked references block with an actionable explanation at send or resume.

## Skills

Skills are prompt-only, non-executable instruction content that still
requires source and content review before enablement. They are discovered
from `<directory>/.agents/skills/<skill-name>/SKILL.md` in the working
directory and each parent up to the Project or repository root, plus the
user-global `~/.agents/skills/`. Octant does not scan arbitrary files
elsewhere under `.agents/`.

Every discovered skill gets a source-qualified identity, content digest,
provenance, and diagnostic state. New or changed skills are indexed
**disabled** until review and desired-enabled state allow use. Invocation is
explicit with **`$skill-name`** in the composer, or `@plugin-name/skill-name`
for a plugin-contributed skill. Unambiguous discovery must hold; an
ambiguous unqualified invocation opens a chooser or fails closed.

## Core Apple independence

An extension with a `trusted-extension` authority is **denied** core Apple
discovery, build, run, and test — those are app-managed and require core
authority, never an extension. Core Apple development never depends on an
optional extension.

## Next steps

- [Browser and computer use](/advanced/browser-and-computer-use) for related host-owned surfaces
- [Apple Development Workbench](/advanced/apple-workbench) for the extension-independent core path
- [Privacy and security](/advanced/privacy-and-security) for quarantine and provenance
