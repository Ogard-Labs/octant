# Provider runtimes

This topic specification owns runtime-specific wire behaviour that the provider
boundary normalizes: OpenCode's version-selected routes, the Pi release
gate, the local-server adapter, and the vendor sign-in dialects of the host OAuth runner. Architecture
owns the driver interface, honest capability, credentials, and confinement
([Architecture: providers](../architecture.md#providers) and
[security and authority](../architecture.md#security-and-authority)).

## Claude Code

For a selected Haiku model in Plan, the adapter supplies a query-local
`availableModels` list containing only that selection, on both fresh and resumed
queries. Claude Code otherwise silently upgrades Haiku to Sonnet in Plan
(observed with 2.1.301 and documented in
[Claude Code model configuration](https://code.claude.com/docs/en/model-config)).
The restriction keeps the displayed selection and the answering model aligned;
it does not persist user settings or change permissions, tools, or confinement.
Other model selections and execution policies keep their existing behaviour.

Claude Code's result `total_cost_usd` is cumulative for the session, including
cost restored on resume (observed with 2.1.301). Before each prompt, the adapter
asks the runtime's existing `get_usage` control for the session total and
reports only the nonnegative increment on the final result. It consumes that
baseline once. It never subtracts only the previous successful turn: failed or
interrupted turns can also have spent money. Those turns keep their own reported
tokens and the usual estimate/unpriced treatment; their spend is not charged
again on resume.

A missing, invalid, or timed-out baseline, a falling total, or overlapping
prompts leaves provider cost absent. After a missing or timed-out control answer,
the query stops requesting snapshots so later prompts do not repeat the wait.
A new query tries again. The ordinary token-based estimate or
unknown-spend rules still apply; no cumulative total is presented as a turn's
cost. This control adds no credential-file access or confinement exception.

A Claude Plan turn may report an attempted `Write` or `Edit` before the runtime
returns its disabled-tool error (observed with Claude Code 2.1.301). The adapter
recognizes those two unoffered file tools only in Plan and records their failed
activity without treating their inputs as an applied file change. A success
result for either disabled tool, a changed tool correlation, or a successful
turn that omits the refusal fails closed. Other unoffered tools and malformed
messages remain protocol failures. Recognition grants no tool authority: the
launch tool list, permission hooks, OS confinement, and Keychain policy remain
as specified in [Security and authority](../architecture.md#security-and-authority).

The runtime's `Artifact` tool (declared in the Agent SDK's `sdk-tools.d.ts`,
0.3.211: `action` `publish` or `list`, with `publish` the default when the
field is absent; `file_path`, `title`, `description`, `favicon`, `label`,
`url`, `force`, `scope`, `limit`) is named in the launch tool list for Work and
Code sessions outside Plan, so the port's allowlist refuses it elsewhere. The
driver reads the action from the hook's input: `publish` must name a file at
or inside the Project root (a relative path is resolved against the root, which
is the runtime's working directory), and its approval is raised from the
`PreToolUse` hook and answered `allow` or `deny` only once the person has
decided, with the approval never recorded for reuse; `list` is allowed only
with no `scope` or `scope: "mine"` and follows the posture through "ask";
every other action is denied, including `read`, which the installed runtime
(Claude Code 2.1.304) offers beyond the SDK's declaration. The result the
runtime returns to the model names the page's address as
`claude.ai/artifact/{id}` or `claude.ai/code/artifact/{uuid}` (the runtime's
own tool description names both shapes); the decoder reads that address out
of the `tool_result` block's text and nothing else, and the mapper reports a
successful publish as `Published: <address>`, a successful publish whose
result names no address as published without a link, and an error result as
a refusal in fixed words. The approval prompt reads
`Artifact · publish <path> to your Anthropic account as "<title>"`, with the
title redacted like a shell command, or
`Artifact · list the pages on your Anthropic account`.

The Canvas "Share to Claude" export destination runs the same tool outside a
thread (`apps/server/src/providers/claudePagePublisher.ts`). It opens one query
through the SDK port with `tools: ["Artifact"]` as the whole launch tool list,
the `approval-gated` posture (the runtime's `default` permission mode, with the
sandbox settings a thread of that posture carries, bound to the one-shot's
folder), the `sonnet` alias the readiness probe already proves, and the account
environment of the chosen Claude provider, which is the first enabled instance
whose observation is `ready` with `artifactPublish: "supported"` and whose
authentication is `subscription`. The `PreToolUse` hook answers `allow` only
for an `Artifact` call whose action is `publish` (or absent) and whose
`file_path`, resolved against the folder, is the approved file, and answers it
with `updatedInput: { file_path, title }` so the runtime publishes the approved
file under the approved title and nothing else the model asked for; every other
call, including `list`, `read`, and any other tool, is denied, and the
permission callback denies whatever reaches it. The prompt names the file and
the title and asks for that one call. The outcome is read from the decoded
stream: a `tool-results` entry for an `Artifact` call that carries an address
is `published`; one that is an error is `refused`; a `result` that reports a
permission denial is `refused`; a `result` without a publish, or a session that
does not finish within 120 seconds, is `unavailable`; and an `unauthenticated`
failure opening the query is `not-signed-in`. The folder and the page are
removed when the session closes, on every path.

## OpenCode

The installed OpenCode binary's
version selects its routes: 1.x keeps the legacy session API and its
per-session permission ruleset. 2.x accepts no per-session ruleset, so each
launch writes its session posture — the same rules in 2.x action names
(`shell`, `subagent`), every namespaced tool and skill denied, and only that
connection's app-managed tool bridge allowed — into the private
configuration, where OpenCode appends it after every agent's built-in rules
(its default agent otherwise allows everything); a launch that names no
posture denies all. 2.0.22 answers the 1.x `POST /mcp` registration with
405 and has no per-launch MCP flag; it registers runtime MCP servers through
`PUT /api/experimental/mcp/{server}` (removed with `DELETE`), which Octant
uses for the bridge. A config-file `mcp` entry also works but connects
lazily after the first turn has started, so it is not used. Registration
turns Code Mode off for the bridge, so each tool is offered by name as
`<server>_<tool>` and matches the bridge allow rather than OpenCode's own
`execute` tool, and it waits until `GET /api/mcp` reports the server
`connected`, because the add answers while the server is pending and its
tools join a session only once connected; any other status fails the
registration closed. 2.0.22 names the calling session in the call's
`ai.opencode/sessionID` metadata, and the bridge refuses a call that names
another session. App-managed tools are reported only for 2.0.22 and 2.0.27 exactly,
the 2.x releases the hostile-configuration check was repeated against (2.0.27
passed the same check and the same app-tool round trip through a real launch
as 2.0.22, with no change to routes or events), and
only on macOS, where the probe registers an empty bridge and OpenCode lists
its tools. Project resolution
starts Git, which the Chat, Plan, and Work jail refuses; on macOS those
launches get the failing `git` stand-in described under
[Security and authority](../architecture.md#security-and-authority), so 2.x offers turns in
every mode there; on Linux the probe fails closed and the runtime is listed
without turns. 2.0.22 names its turn events without the `session.next.`
prefix earlier 2.x builds used (`session.text.*`, `session.reasoning.*`,
`session.tool.*`, `session.step.*`, `session.execution.*`), identifies a
tool call by `id`, and names the tool only on `session.tool.input.started`;
Octant folds them onto the earlier names, so 1.x, earlier 2.x, and 2.0.22
share one mapping. `session.execution.succeeded` completes the turn, its
`failed` and `interrupted` outcomes fail or interrupt it (a `shutdown`
interruption holds it, below), and a scheduled retry reports nothing, so
the turn keeps running while OpenCode retries. Queueing, lifecycle, part start and end, and running
usage totals report nothing (each step reports its own usage); any other
event fails the turn closed with an error naming it. Approvals map
through 2.0.22's `permission.asked` event and its reply route, whose body
is `{decision}`. An approval is answered
`once`, never `always`, even when approvals are remembered for the Project:
`always` would save a grant in OpenCode's data directory, which it shares
with the person's own use, outside Octant's revocation. Approval-gated on
2.x honours permission grants the person saved in OpenCode itself for the
same repository: OpenCode keys them by the repository's root commit, keeps
them in its own data store (shared with the person's own use because
provider credentials live there), and applies them as allow after Octant's
rules. Octant's denies still win, so Plan and the Work shell and subagent
denials hold, and Octant itself never writes such a grant because it
answers approvals `once`. An edit allowed this way still fails the turn
through the file-change check, after the write; a shell command allowed
this way runs without an approval card. Clearing the saved grants in
OpenCode restores the prompts. A 2.x reject settles every pending request
in the session, so each settled request is forgotten. Questions are
unsupported: 2.0.22 serves no question routes and asks through forms, which
are not mapped, so the written posture denies `question` and a form that
still arrives fails the turn. Resume,
interruption, and tool activity are reported. A Stop the person asked for
(`user`) and OpenCode's own `superseded` and `inactivity` interruptions stay
ordinary interruptions; a `shutdown` interruption, or the OpenCode process
exiting under a running turn, is nobody's Stop, so the turn ends `waiting`
with a reason naming what happened, and nothing sends it again on its own
(Work, like Chat and Code, ends a turn on `waiting`); each allowed or approved edit
request admits one reported change to each file it names (resolved against
the project root; `*` admits one change to any file), rejecting one request
never withdraws another's grant, and a change to a file no remaining grant
names fails the turn; and anything not mapped fails
closed. The probe also asks the confined 2.x server to answer for a
directory carrying a Git marker, made in the launch's own scratch directory
because every launch profile denies the host temporary directory beneath
`/private`; it attests by creating a session there and then deletes that
session, best effort, because OpenCode keeps sessions in the data directory
it shares with the person's own use and their provider credentials. A
failed delete leaves one empty session and does not change the result. A
runtime that cannot answer (observed with 2.0.22 on macOS as HTTP 500
without the stand-in) reports `incompatible` with its models listed and
every capability unsupported, and no turn is offered.

## Pi

Octant launches Pi in RPC mode with `--no-extensions`, which since Pi 0.99
also turns off its built-in extensions (the MCP client, codemode, and tool
search), and loads only Octant's own extension by path. A user-level or
project-level `mcp.json` therefore starts no server and no inherited command
is registered. App-managed tools are reported only for the releases whose
tool attestation, approval bridge, and confinement Octant verified: 0.85.1 and
1.1.0, exactly; any other release lists its models and reports app tools
unsupported, and a session that offers tools on it is refused. Only 0.85.1 is
verified for warm reuse of a settled process; other releases close it and
cold-resume the native history. Pi 1.1.0 adds `aborted` to `agent_settled`:
an aborted run is reported as interrupted, never as completed. Pi 1.0.3
renamed the Azure provider from `azure-openai-responses` to `azure` and kept
its `AZURE_OPENAI_*` variables, so a thread holds them under either name.

## Local-server provider adapter

The local-server provider adapter owns a separate process for each acquired
connection and allows one live session per connection. Its MCP protocol does
not reliably carry native session identity, so the private endpoint binds calls
to that connection's immutable session and exact offered catalogue. Complete
permission rules are updated before each prompt; the deprecated tool toggle
payload is omitted because it replaces those rules. App tools require a process
receipt attesting that external MCP, plugins, and skills cannot enter the
runtime. Ordinary inherited configuration does not supply that attestation and
continues to report app tools as unsupported. Process exit, stream failure,
interruption, and scope cleanup retire pending tool requests.

## Subscription sign-in dialects

The host OAuth runner speaks vendor wire
dialects beside the standard PKCE path. The OpenRouter dialect exchanges the
code for a user-controlled API key (no refresh token, no expiry). The
ChatGPT plan dialect ("Sign in with ChatGPT") registers the host as a
user-defined agent on first sign-in: the authorize request carries the
placeholder client id `dynamic_agent_client`, an `agent_name_hint`, and the
host's stable id as `ext_agent_host_id` (derived once from the host's data
directory and bound by the server before the first sign-in — never invented
by the catalog). The loopback callback returns the issued `oaiapp_…` client
id, which is stored and used for the exchange and every refresh — never the
placeholder. The exchange and refresh send `resource=https://api.openai.com/v1`
and no client secret. The identity token from the authorization-code exchange
is validated against the issuer's JWKS (RS256 signature, issuer, audience,
expiry, and the per-attempt OIDC nonce) before the grant is stored; the
verified `sub`/`email`, the issued client id, the retained identity token
(for `id_token_hint` on reauthorization), and the stable host id live on the
stored grant. Reauthorization is addressed by the instance's stored
credential ref — the host does not scan the credential store, because
production stores cannot list their entries. It reuses the issued client id,
sends `id_token_hint`, and omits the agent name hint. The reauthorization
callback may omit `client_id`; the issued id used in the authorize request
is retained, and a different `client_id` is refused. A refresh that returns
no identity token keeps the prior identity. A refresh that returns one is
checked for signature, issuer, audience, expiry, and subject equal to the
stored subject — not for a nonce, because refresh does not send one.
When the granted scopes omit `chatgpt.tokens.use.direct`, the sign-in is
still valid as identity-only and the access result reports
`subscriptionUsageGranted: false`, the provider-neutral seam field drivers
use to refuse subscription-billed turns. A refresh answered with
`invalid_client` means the issued client is gone, so the grant is dropped
and the person signs in again. Sign-out revokes the refresh token at the
issuer's discovery `revocation_endpoint` before the local grant is dropped;
the endpoint must share the issuer's origin, and only a 2xx answer counts
as revoked. When the issuer does not confirm, the grant is kept and the
person is told the sign-in is still active; they can retry or sign out on
this computer only, which deletes the local grant and says the issuer was
not told. A re-sign-in that replaces a grant always deletes the replaced
grant's local material, revoking it first when the issuer answers, so no
refresh token is left in the credential store without a pointer. The plan
route's request profile is enforced before send: `store:false` and
`stream:true` are mandatory, `input` is an array carrying the full
history, system text travels as
`instructions` (an explicit system-role message item is rejected), a fixed
parameter set is omitted entirely, and only function tools are allowed —
hosted tools are refused. A request that cannot be expressed is refused
with a typed reason, and the route's `subscription_sharing_*` error codes
map to user-facing states (usage limit with a manage-usage link, bounded
backoff on unavailability, unauthenticated on 401/403). The plan contract
accepts an empty `response.completed.output` array after every streamed item
has completed: the plan endpoint observed on 2026-10-19 omitted the repeated
items there. Item completion must still reconcile text, reasoning, and tool
arguments against the deltas, and output slots must be distinct and contiguous.
A nonempty terminal array must fully match the stream; other Responses profiles
retain their existing terminal coverage checks. Reasoning items may omit the
optional `status` field: their added/done event supplies the phase, and a
completed response may repeat such an item without status. Explicit status
values still have to agree with the phase; missing status never bypasses item
identity, index, ordering, completion, or content reconciliation. Message and
function-call status requirements are unchanged. The plan contract
covers Responses turns, not model enumeration, so Check connection reads
the route's `/models` answer through the profile: a model list is reported
as discovered, whether the OpenAI `{data:[{id}]}` shape or the plan's own
`{models:[…]}` listing (id from `slug`, then `id`, then `name`; display
name, a positive integer context window, and `input_modalities` kept when
present; unmappable
items skipped); a body that is not a model list, no mappable item, a route-not-served status, a
403, a missing model-read scope, or an empty list is a degraded, worded
"models can't be listed" state carrying the manual model IDs, never a
protocol failure. Credential, usage-limit, and availability answers keep
failing the check with their typed states.

## Verification

- Claude Code: `apps/server/src/providers/claudeDriver.test.ts` (tool list by
  mode and posture, the publish gate under Full access, the refused actions),
  `claudeAgentSdkPort.test.ts` (allowlist and the address read out of a tool
  result), and `claudeEventMapper.test.ts` (the prompt and result wording).
  A publish against a real account has not been run from Octant; the result
  wording the decoder reads is taken from the runtime's own tool description.
  The Canvas one-shot: `claudePagePublisher.test.ts` (the tool list, the
  folder and sandbox, the pinned hook decision, and each outcome); a share
  against a real account has not been run either.
- OpenCode: `apps/server/src/providers/openCodeDriver.test.ts`,
  `openCodeClient.test.ts`, `openCodeEventMapper.test.ts`,
  `openCodeProcess.test.ts`, `openCodeConformance.test.ts`, and the
  `openCode2AppToolsSmoke.integration.test.ts` real-runtime smoke.
- Pi: `apps/server/src/providers/piDriver.test.ts`, `piProcess.test.ts`,
  `piConformance.test.ts`, and the `piSmoke.integration.test.ts` real-runtime
  probe (verified release attestation and the hostile MCP configuration).
- Sign-in dialects: `apps/server/src/providers/directEndpointSubscriptionOAuth.test.ts`,
  `chatGptPlanProfile.test.ts`, `packages/domain/src/subscriptionOAuthCatalog.test.ts`,
  and `packages/provider-sdk/src/subscriptionOAuthConformance.test.ts`.
