# fx ACP compatibility

This note records a bounded Agent Client Protocol probe of Vercel's fx
harness. It does not authorize a selectable provider, a reserved profile, a
new transport, or an Octant-owned OAuth flow. fx stays outside the production
provider surface until a later probe proves managed-home isolation against a
live `fx acp` binary.

## Pin

- **Live binary:** unavailable. `fx` was not on `PATH`; no local cache existed;
  nothing was installed.
- **Published version:** `v0.0.8` (`pub const version = "0.0.8"` in
  `vercel-labs/fx` `src/main.zig`; GitHub release 2026-09-07).
- **Docs:** [ACP server](https://fx.sh/docs/using-fx/acp) and the related
  configuration, sessions, permissions, skills, MCP, and authentication pages,
  retrieved 2026-09-09, compared with `vercel-labs/fx` at that tag and with the
  shipped ACP stack (`acpDriver.ts`, `acpProcess.ts`, `acpProtocol.ts`,
  `acpProfiles.ts`).

ACP availability is not attestation. The existing isolation pattern is Kimi
Code's `immutable-managed-profile` (`KIMI_CODE_HOME`, generated config,
forbidden `AGENTS.md` / `mcp.json` / `skills` / `plugins` / `hooks`).

## Verdict

**NO-GO.** Do not add a selectable fx provider. Do not add a reserved
unselectable profile. Isolation cannot be proven, and the documented ACP
runtime shares the interactive fx profile.

### Missing upstream guarantee

A documented, supported isolation contract for the `fx acp` CLI that:

1. Relocates settings, global `AGENTS.md`, managed skills, sessions, and
   permission rules away from the interactive `~/.fx` profile (an `FX_HOME` /
   equivalent, not an undocumented `HOME` rewrite).
2. Does not load workspace project instructions, workspace skill roots, or
   approved project `.mcp.json` servers unless the client admits them.
3. Does not auto-review or auto-allow tool calls (`code` mode /
   `permission_mode: auto`) in a way that would widen Octant approvals.

`home_override` exists on the libfx ACP `Config` and is used in tests. `fx acp`
does not expose it. The documented environment list has no `FX_HOME` or XDG
config-home override. Embedding libfx or rewriting `HOME` is not that
guarantee: the ACP docs state the server uses the same settings, project
instructions, skills, sessions, permissions, and tools as interactive fx, and
even a relocated profile still merges approved workspace `.mcp.json` and
workspace `AGENTS.md`.

## Matrix

Each row is `proven` (live binary), `documented-only` (published docs and/or
pinned source, no live `initialize`), or `missing` (required contract absent).

| Surface                                           | Status          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initialize                                        | documented-only | Client must call `initialize` first. fx reports ACP protocol version `1`. Methods: `initialize`, `session/new`, `session/load`, `session/resume`, `session/close`, `session/list`, `session/prompt`, `session/cancel`, `session/set_config_option`, `session/set_mode`. Stdio newline-delimited JSON-RPC; 8 MiB input limit. `fx acp` flags: `--model`, `--log-file`.                                       |
| session identity                                  | documented-only | `session/new` creates a saved session and returns an opaque `sessionId`. Source writes `{"sessionId":…,"configOptions":[…],"modes":{…}}`. New IDs are 12 characters as of `v0.0.8`; older IDs remain resumable. Each connection has one active session. ACP requests must target that session. Not live-proven.                                                                                             |
| resume                                            | documented-only | `session/load` takes an exact `sessionId` and replays history. `session/resume` reconnects without replay. Interactive `last` / `-c` aliases are not ACP methods. Child subagent sessions cannot be resumed directly. Ambiguous resume would stay Waiting under 0006; exact-id restore is documented, not live-proven.                                                                                      |
| cancel, tool-result correlation, streamed updates | documented-only | `session/cancel` cancels the active prompt. Clients receive streamed user and agent messages, tool status updates, and permission requests. `v0.0.8` changelog: cancelling an ACP prompt stops the work. Correlation of tool results to calls is implied by ACP session updates, not live-proven.                                                                                                           |
| permissions                                       | documented-only | Modes `ask` (request approval for unresolved sensitive calls) and `code` (automatically review them). Both expose runtime tools. Before the client selects a mode, fx uses the configured permission mode (default `auto`). Session "Allow for this session" grants are not restored on load.                                                                                                               |
| MCP merge                                         | documented-only | ACP combines client `mcpServers` with approved workspace `.mcp.json`. A client entry wins a same-name project entry. Pending or rejected project servers stay unavailable. ACP never inherits `~/.fx/mcp.json`. That last rule is not isolation: approved project MCP still enters the session.                                                                                                             |
| managed-home isolation                            | missing         | See [Missing upstream guarantee](#missing-upstream-guarantee). Profile state is `~/.fx/` (`settings.json`, `AGENTS.md`, `skills/`, `sessions/`, permission rules). Skills also scan other-agent user roots. `fx acp` shares that profile. `HOME` remapping is undocumented and was not live-proven.                                                                                                         |
| mode mapping                                      | documented-only | fx `ask` / `code` are permission behaviors, not Octant Chat / Plan / Work / Code. Octant server policy and OS confinement remain the authority. Unsupported Octant modes stay `unavailable`. Mapping Plan or approval-gated Code onto fx `code` (or default `auto`) would auto-review unresolved calls and widen 0009 approvals. Both fx modes still expose runtime tools, so they are not Plan-equivalent. |
| auth                                              | documented-only | Provider-native only: `fx login`, `fx setup`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`. OAuth lives in `~/.fx/auth.json` (macOS Keychain for API keys). No Octant-owned subscription OAuth. `FX_AUTH_MODE=host-managed` is a libfx embedding switch, not an `fx acp` CLI contract.                                                                                                                         |

## What a later GO still needs

A live `fx --version` pin plus a non-mutating `initialize` against a temp dir.
Proof that a managed home excludes inherited instructions, skills, and
executable MCP. An Octant mode map that keeps Chat and Plan unavailable unless
fx can run without process-spawn and without auto-review, and that never treats
fx `code` as Full access or as a substitute for Octant approvals.
