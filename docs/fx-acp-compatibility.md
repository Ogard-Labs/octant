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
- **Re-probe binary:** `fx v0.0.13`, same asset from release `v0.0.13`
  (published 2026-10-04), sha256
  `9dbed465d6c56e09a399576c98bfc804a67d1c2a24dfaef896a762565592f96e`, checked
  against the release's `.sha256` file before extraction. Probed on macOS 27.0
  arm64 on 2026-10-11. See [v0.0.13 re-probe](#v0013-re-probe).
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

## v0.0.13 re-probe

The release notes say ACP clients can now supply session instructions and
workspaces, steer running turns, and host MCP servers over the ACP connection,
and that profile MCP servers load only on explicit client opt-in. Every row
below ran against the live binary over stdio JSON-RPC with `HOME` set to a
temporary directory, a placeholder (non-credential) `AI_GATEWAY_API_KEY`, and a
scratch workspace. No model turn ran, so nothing reached any provider.

**Verdict: GO for v0.0.13**, with the same scope as above. Every check that can
run without a model turn passed. The checks that need a model turn remain open
(see the end of this section) and are gated on a brokered key, as before.

| Check                           | Result         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin integrity                   | proven         | The downloaded tarball's sha256 matched the release's `.sha256` file. `fx --version` printed `0.0.13`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| initialize and auth gate        | proven         | Without a key, `initialize` fails with `-32600` naming `fx login`, `fx setup`, and `AI_GATEWAY_API_KEY`. With a placeholder key it returns protocolVersion `1`, `agentInfo.version` `0.0.13`, empty `authMethods`, `sessionCapabilities {list, resume, close, systemPrompt}`, `mcpCapabilities {http, sse, acp}`, and `agentCapabilities._meta.fx.steering: true`.                                                                                                                                                                                                                                                                            |
| Managed-home isolation          | proven         | `session/new` wrote only `$HOME/.fx/sessions/<id>/{session.json,permissions.json,usage-v2.json,events.jsonl,session.lock}` under the temporary home. Before and after listings showed no `~/.fx`, `~/.config/fx`, `~/.local/share/fx`, or fx entry under `~/Library/{Application Support,Caches}`, and no new fx-named path in the real home. `fs_usage` needs root and was unavailable, so this is listing evidence, not a syscall trace.                                                                                                                                                                                                    |
| Denied workspace surfaces       | proven         | With `AGENTS.md`, `.mcp.json`, `.fx.json`, and `.agents` set to mode 000, `initialize` and `session/new` returned the same shape as with them readable, with the same default mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Project `.fx.json` cannot raise | proven         | A readable project `.fx.json` with `"permission_mode": "auto"` still produced `mode: ask` and `currentModeId: ask` on `session/new`. An unapproved project `.mcp.json` server was never spawned.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Session instructions            | proven         | `session/new` `systemPrompt` (text blocks) is stored verbatim at `sessions/<id>/client/system-prompt.txt`; `_meta.fx.systemPrompt` behaves the same. Both together: `-32602`. A non-text block (`resource_link` to `file:///etc/hosts`): `-32602 systemPrompt supports text content blocks only`. 65,537 bytes: `-32602` over the 64 KiB limit; 65,536 bytes accepted. A replace-mode object: `-32602`. Instructions are text only and pull in no file or tool surface.                                                                                                                                                                       |
| Workspaces                      | partly proven  | The documented workspace mechanism is the process flag `--add-dir`, not a `session/new` parameter, so Octant controls it through argv. `fx --add-dir <dir> acp` started and created a session; the added directory's `.mcp.json` server was never spawned and the path was not recorded in session state. `session/new` with `additionalDirectories`, `_meta.fx.workspaces`, or `_meta.fx.additionalDirectories` was accepted and ignored: the path appears nowhere under the home. Docs say an added directory contributes no `AGENTS.md`, skills, or configuration; that cannot be observed without a model turn and stays documented-only. |
| Profile MCP opt-in              | proven         | With a canary server in `$HOME/.fx/mcp.json`: `session/new` and `session/resume` without the flag, and with `_meta.fx.profileMcpServers: false`, did not spawn it. With `true` it spawned immediately and `session/new` blocked until the canary (which speaks no MCP) timed out. Octant must never send the flag.                                                                                                                                                                                                                                                                                                                            |
| MCP over ACP                    | proven (shape) | `mcpServers: [{type: "acp", name, serverId}]` is accepted; without `serverId` it fails `-32602 Each ACP MCP server requires serverId`. Hosting a working server needs a client-side MCP bridge and a model turn to call it, which did not run.                                                                                                                                                                                                                                                                                                                                                                                                |
| Modes and cancel without a turn | proven         | `session/set_mode` to `code` and `ask` succeeded. `session/set_mode` with an unknown mode id also returned success (`result: null`), so Octant must validate mode ids itself rather than rely on fx to refuse. `session/cancel` with no active prompt returned `result: null`. `session/list` returned saved sessions.                                                                                                                                                                                                                                                                                                                        |
| Resume                          | proven         | `session/resume` reattached a saved `sessionId` from a new process and replayed no history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Needs a model turn (not run)

- Permission round trip in `ask` mode, which fires only when a model requests
  a sensitive tool call, and its allow, deny, and cancel outcomes.
- `session/cancel` of an active prompt, and cancellation of pending permission
  input.
- Steering a running turn (`_meta.fx.steer: true`).
- Whether instructions appended through `systemPrompt` and `--add-dir`
  directories reach the model as documented, including that an added
  directory's `AGENTS.md` and skills stay out.
- Tool calls reaching a client-hosted `type: "acp"` MCP server.
- The brokered-credential test: that a key supplied only through the
  environment is accepted by the gateway, and that no fx credential store is
  read.

These need a brokered AI Gateway key, which this probe did not have.

## Residual risk

- The model list was read with a placeholder key. A real key was not available
  during the probe, so no model call, no permission round trip, and no
  cancellation were executed against fx's backend.
- Managed-home relocation depends on fx resolving its profile through `$HOME`
  rather than a platform home API. The probes prove it for `v0.0.10` and
  `v0.0.13`; any other release that changes that resolution is a new probe,
  not an assumption.
- `FX_PERMISSION_MODE=ask` and the ACP session mode are both set. `permission_mode`
  is a profile-owned key that a project `.fx.json` cannot raise, so the two
  cannot disagree in fx's favour.
