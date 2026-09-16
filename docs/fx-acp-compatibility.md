# fx ACP compatibility

This note records a bounded Agent Client Protocol probe of Vercel's fx harness.
It is the compatibility evidence behind 0130, which ships fx as a managed-home
provider. It authorizes no Octant-owned OAuth flow, no new transport, and no
exception to 0009's confinement.

## Pin

- **Live binary:** `fx v0.0.10`, `fx-macos-aarch64.tar.gz` from
  `vercel-labs/fx` release `v0.0.10` (published 2026-09-14), sha256
  `b3f0121e46f8227690def72b920d9d1fc299f0b73dd7eb91382bd83674219876`. Probed
  on macOS 27.0 arm64.
- **Docs:** the ACP, configuration, sessions, permissions, skills, MCP, and
  authentication pages at `fx.sh/docs`, compared with `vercel-labs/fx` at
  `v0.0.10` and with the shipped ACP stack (`acpDriver.ts`, `acpProcess.ts`,
  `acpProtocol.ts`, `acpProfiles.ts`).

ACP availability is not attestation. The earlier probe returned NO-GO for two
reasons: no documented way to relocate the interactive `~/.fx` profile, and
workspace instructions, skill roots, and approved project `.mcp.json` servers
entering the session uninvited. The live probe answered the first, and the
shared ACP profile answers the second with the same root denials it already
applies elsewhere.

## Verdict

**GO**, scoped exactly to 0130: fx is selectable as an ACP host-profile
provider, runs with `HOME` in a per-instance managed home, authenticates with a
brokered Vercel AI Gateway key, and denies the workspace surfaces it would
otherwise merge.

### Managed-home isolation

`fx acp` exposes no profile-path variable, and its documented environment list
still has no `FX_HOME` or XDG config-home override. `$HOME` is therefore the
seam, and the probe proved it works:

- With `HOME` set to a temp directory, `fx acp` wrote
  `.fx/sessions/<id>/{session.json,permissions.json,usage-v2.json,events.jsonl,session.lock}`
  under that directory.
- The real `~/.fx` was not created, and no fx process read it.
- The confined process is also under the profile's private-home denial, so even
  without the relocation the interactive profile would stay unreadable.

### Workspace surfaces

`fx acp` merges the workspace `AGENTS.md`, approved project `.mcp.json`
servers, project `.fx.json`, and workspace skill roots on its own. Octant
denies all four to the confined process. The probe confirmed this does not
break the provider: with `AGENTS.md`, `.mcp.json`, `.fx.json`, and `.agents`
unreadable, `initialize` and `session/new` both returned exactly as they did
with the files readable.

### Modes

`session/new` reports `mode` as a select of `ask` and `code`, where `code`
carries `permissionMode: "auto"`. Octant therefore never maps an approval-gated
turn onto `code`, and refuses Chat and Plan before a session process starts.

## Matrix

Each row is `proven` (live binary), `documented-only` (published docs and/or
pinned source, no live round trip), or `missing` (required contract absent).

| Surface                                           | Status          | Evidence                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initialize                                        | proven          | `initialize` returns protocolVersion `1`, `agentInfo {name: "fx", version: "0.0.10"}`, `loadSession: true`, `sessionCapabilities {list, resume, close}`, `mcpCapabilities {http, sse}`, `promptCapabilities {image, embeddedContext}`, and an empty `authMethods`. Stdio newline-delimited JSON-RPC. `fx acp` flags: `--model`, `--log-file`. |
| auth gate                                         | proven          | Without any AI Gateway credential, `initialize` fails with JSON-RPC `-32600` naming `fx login`, `fx setup`, and `AI_GATEWAY_API_KEY`. With a syntactically present key it succeeds, so the handshake gates on credential presence and the first model call is where validity is judged.                                                       |
| session identity                                  | proven          | `session/new` creates saved state and returns an opaque 12-character `sessionId` plus `configOptions` (provider, model, mode, effort) and `modes`. Each connection has one active session.                                                                                                                                                    |
| resume                                            | proven          | Both `session/load` and `session/resume` reattach an exact `sessionId` across processes. An unknown id returns `-32602 Session not found`. Octant selects `session/resume` so its own transcript is not replayed.                                                                                                                             |
| cancel, tool-result correlation, streamed updates | documented-only | `session/cancel` cancels the active prompt; clients receive streamed user and agent messages, tool status updates, and permission requests. Correlation of tool results to calls is implied by ACP session updates, not live-proven.                                                                                                          |
| permissions                                       | documented-only | Modes `ask` (request approval for unresolved sensitive calls) and `code` (auto-review). Both expose runtime tools. Session "Allow for this session" grants are not restored on load. No live permission round trip was run.                                                                                                                   |
| MCP merge                                         | documented-only | ACP combines client `mcpServers` with approved workspace `.mcp.json`, and never inherits `~/.fx/mcp.json`. The workspace path is denied to the process under 0130.                                                                                                                                                                            |
| managed-home isolation                            | proven          | Session state lands under `$HOME/.fx` for a relocated `HOME`, and the real `~/.fx` stays untouched. See above.                                                                                                                                                                                                                                |
| mode mapping                                      | proven          | `ask` / `code` are permission behaviors, not Octant Chat / Plan / Work / Code. Octant maps an approval-gated turn to `ask`, Full access to `code`, and refuses Chat and Plan.                                                                                                                                                                 |
| auth                                              | documented-only | Provider-native: `fx login`, `fx setup`, `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`. OAuth lives in `~/.fx/auth.json`; macOS Keychain holds API keys. Under 0130 Octant grants neither, and supplies only a brokered `AI_GATEWAY_API_KEY`. `FX_AUTH_MODE=host-managed` is a libfx embedding switch, not an `fx acp` CLI contract.              |

## Residual risk

- The model list was read with a placeholder key. A real key was not available
  during the probe, so no model call, no permission round trip, and no
  cancellation were executed against fx's backend.
- Managed-home relocation depends on fx resolving its profile through `$HOME`
  rather than a platform home API. The probe proves it for `v0.0.10`; a future
  release that changes that resolution is a new probe, not an assumption.
- `FX_PERMISSION_MODE=ask` and the ACP session mode are both set. `permission_mode`
  is a profile-owned key that a project `.fx.json` cannot raise, so the two
  cannot disagree in fx's favour.
