# 0130. fx runs in a managed home

**Status:** Accepted

## Context

`docs/fx-acp-compatibility.md` recorded a NO-GO for Vercel's fx harness, and
0006 listed it as unselectable. Two things blocked it. Its ACP entrypoint
exposes no profile-path variable, so no probe could show that settings,
sessions, skills, and permission rules were relocated away from the interactive
`~/.fx`. And `fx acp` merges the workspace `AGENTS.md`, approved project
`.mcp.json` servers, project `.fx.json`, and workspace skill roots on its own,
which is authority Octant never admitted.

0009 confines every provider process to a deny-default profile whose private
home is enumerated as denied, and 0121 requires a CLI provider to keep its own
profile rather than an Octant copy. For a provider with no profile-path
variable the two rules meet at `$HOME`, which the shared ACP process profile
already redirects to a per-instance managed home.

## Decision

- fx ships as an ACP host-profile provider: an `fx` driver kind, an `fx-acp`
  configuration, and a discovery descriptor for the `fx` executable.
- fx runs with `HOME` set to its managed home. No host authentication directory
  is granted, so the interactive `~/.fx` profile — settings, sessions, skills,
  permission rules, and the `fx login` credential — is never readable by the
  confined process. This is the private-home denial every ACP profile already
  runs under; fx receives no exception to it.
- fx has no provider-owned posture. Its authentication literal is `api-key`
  only, and the host credential broker supplies `AI_GATEWAY_API_KEY` for one
  process, which is the documented `fx setup` credential path. This is not a
  fallback: a provider-owned login cannot be relocated without an upstream
  profile-path contract, so offering one would promise isolation Octant cannot
  provide.
- Octant denies fx the workspace surfaces it would otherwise load on its own:
  `AGENTS.md`, `.mcp.json`, `.fx.json`, and `.agents`. A project `.mcp.json`
  starts executables outside the approval flow, and the other three are
  instructions, project config, and skill roots Octant did not admit.
- Chat and Plan are refused before a session process starts. fx always
  advertises runtime tools, and its ACP `code` mode maps to
  `permissionMode: "auto"`, which auto-reviews tool calls. An approval-gated
  turn selects fx's `ask` mode; only an explicit Full access turn selects
  `code`. `permission_mode` is one of fx's profile-owned settings keys, so the
  pinned managed environment is defence in depth rather than the authority.
- This supersedes 0006's "fx ... remains unselectable" bullet and the NO-GO
  verdict in `docs/fx-acp-compatibility.md`. Everything else in 0006 stands,
  including its other reserved candidates.

## Consequences

- A host with `fx` on `PATH` detects it like any other ACP CLI. It is not
  enabled by first run; 0112's enablement list stays Claude Code and Codex CLI.
- An fx instance is unusable until a Vercel AI Gateway key is stored for it, and
  reports needs-setup rather than degrading into another authentication path.
- A confined fx cannot read the repository `AGENTS.md` or a project `.mcp.json`.
  Admitting either later is a change to this record, not a profile tweak.
- The relocation rests on fx resolving its profile through `$HOME`. If a later
  fx release adds a profile-path variable, that variable is the better seam.

## Related

- 0006 ACP agent drivers (fx exclusion superseded)
- 0009 Sandbox confinement, approvals, and Plan mode
- 0121 Provider-owned CLI runtimes, profiles, and updates
- [fx ACP compatibility](../fx-acp-compatibility.md)
