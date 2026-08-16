# 0011. Extensions and skills: the activation ladder

**Status:** Accepted

## Context

Octant ships one provider-neutral Extensions system for skills, MCP servers,
hooks, apps, and agent definitions instead of per-provider marketplaces. The
recurring failure in agent ecosystems is that "installed" quietly means
"active": a downloaded MCP server starts contributing tools, a skill folder in
a repository injects instructions, and a mention in a prompt turns something on.
Octant needs installation, trust, enablement, compatibility, policy, and
effective activation to be separate, server-resolved states, and needs to be a
conformant client of the vendor-neutral Agent Plugins package format without
adopting its lack of trust semantics.

## Decision

- A package has a stable Octant extension id, source, version or content
  digest, provenance, compatibility range, and declared components. Each
  component has a kind, declared capabilities, supported modes, providers, and
  platforms, an entry point, integrity data, and its own desired-enabled state.
  Package files are immutable per installed version; updates stage a new
  version.
- The store records six independent dimensions: installed, desired enabled
  (plugin master switch and per-component switch, both required), trusted,
  compatible, allowed by host, mode, Project, and thread policy, and
  effective. Installing never enables. Trust never bypasses sandbox, approval,
  tool, or credential policy.
- Effective activation resolves fail-closed in a fixed order: host prohibition,
  mode safety policy, Project policy, source trust, plugin master state,
  component state, provider and platform compatibility, then effective. A lower
  rung cannot override a prohibition above it. Every non-effective component
  carries a structured block reason.
- Prompt-only skills are non-executable but still need source and content
  review before enablement. MCP servers, hooks, apps, and agents are executable
  and stay quarantined until the source is explicitly trusted; when they run,
  it is in supervised, sandboxed processes with the narrowest declared
  capability, no broker coordinates or provider credentials, and drain-on-
  disable semantics.
- Disabled components contribute nothing: no prompt text, schema, tool, route,
  or projection subscription. Disabling preserves package files, component
  choices, settings, and credential references so re-enabling restores the
  prior selection; only uninstall removes files.
- Skills are discovered only from valid `.agents/skills/<name>/SKILL.md`
  packages between the working directory and the Project or repository root,
  plus the user-global `~/.agents/skills/`. Nothing else under `.agents/` is
  interpreted. Discovery is not activation: new or changed skills index as
  disabled until reviewed. Name collisions stay visible with source labels;
  ambiguous invocation opens a chooser rather than guessing.
- Composer addressing is structured: `@plugin` and `@plugin/component` chips
  and `$skill` invocations resolve only to already installed, trusted, enabled,
  and policy-allowed components. A reference can never install, trust, enable,
  elevate, or grant credentials; a reference that becomes unavailable blocks
  with an explanation instead of falling back. Unknown `@` text stays text.
- Octant is a conformant Agent Plugins client: it loads `plugin.json` against
  a locally bundled schema, bounds every visited path to the resolved plugin
  root, ignores unknown fields non-fatally, discovers `skills/` and `mcp.json`,
  expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, and normalizes the result
  into the same package and component model. Older provider-specific package
  layouts are handled by a compatibility adapter. Distribution, trust,
  enablement, sandboxing, and presentation stay Octant-owned.
- Manifests and archives reject absolute paths, traversal, unsafe symlinks,
  duplicate normalized paths, unsupported executable kinds, and undeclared entry
  points. Secrets live in the Keychain or provider-native storage; only
  indirect references appear in extension state.
- Bundled catalog entries are listed with provenance and fetched from their
  declared source; they are not activated by default. Core capabilities
  (Apple development, browser and computer use, tests, approvals, memory,
  subagents) never depend on an optional extension.

## Consequences

- Users can install freely and review deliberately; nothing runs or speaks
  until they say so, and the reason for a blocked component is always visible.
- Third-party skills and MCP servers work without any particular provider
  installed because resolution and context contribution are provider-neutral.
- Executable extensions cost a review step and a sandboxed process; that is
  intended.
- The same manifest, ladder, and switches are the foundation the plugin host
  in 0001 extends to product surfaces and provider drivers.

## Related

- 0001 Plugin architecture
- 0008 Context budget and capacity scheduling
- 0009 Sandbox confinement, approvals, and Plan mode
