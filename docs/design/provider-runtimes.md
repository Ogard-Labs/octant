# Provider runtimes

This topic specification owns runtime-specific wire behaviour that the provider
boundary normalizes: OpenCode's version-selected routes, the Pi release
gate, the shared ACP stack and its registry coverage, the local-server adapter, and the vendor sign-in dialects of the host OAuth runner. Architecture
owns the driver interface, honest capability, credentials, and confinement
([Architecture: providers](../architecture.md#providers) and
[security and authority](../architecture.md#security-and-authority)).

## Key providers

Claude Code, Codex, Mistral Vibe, and OpenCode run as themselves inside
Octant ([Architecture: key providers run as themselves](../architecture.md#providers)).
The switch-offs in the sections below are today's build. Each key provider's
target wire behaviour, gated by the thread's
[guardrail level](../architecture.md#security-and-authority) (off at Guarded
and Reviewed until the person turns it on, on at Trusted and Off):

| Provider     | Switched off today                                                                                                                   | Target                                                                                                                                                                                                   | Built                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Claude Code  | `settingSources: []`, `skills: []`, no subagent tool, `WebSearch` and `WebFetch` left out and refused                                | The person's setting sources (home and trusted Project), skills, plugins, hooks, and MCP servers; its subagent tool; `WebSearch` and `WebFetch`; `permissionMode: "auto"` as Reviewed's default reviewer | Reviewed with its own reviewer, in Code only |
| Codex        | Its subagents; Project skills disabled by path; in Chat each named MCP server switched off                                           | Its subagents; Project skills; the person's MCP servers in Chat; `approvalsReviewer: "auto_review"` as Reviewed's default reviewer                                                                       | Reviewed with its own reviewer, in Code only |
| Mistral Vibe | `VIBE_SKILL_PATHS="[]"`, `VIBE_DISABLED_SKILLS='["*"]'`, `VIBE_INCLUDE_PROJECT_CONTEXT="false"`                                      | Its own skills and Project context; a trusted Project's tools and MCP servers; its auto-approve mode as Reviewed's default reviewer, reported `unsupported` until mapped                                 | No                                           |
| OpenCode     | Skills and project config off, `skill` denied; Work `shell` and `subagent` denied; Octant's denies outrank saved grants; `once` only | The person's own permission rules; "always" answers; its `subagent` delegation; its skills; `bash` and `task` in Work as in Code; Reviewed through Octant Shield                                         | No                                           |

Plan's read-only rule, Chat's withheld filesystem and shell, and the
provider's memory, telemetry, and self-update channels stay off at every
level. Work and Code share one capability set, so each runtime starts a Work
session with its shell at the thread's level exactly as it starts a Code
session, as the
[architecture's Work rules](../architecture.md#modes-chat-work-and-code)
state per provider (allowed; not built yet: today every driver withholds the
shell in Work). A native child run, a native
web read, and a provider's review verdict are journaled where the runtime
reports them; where it does not, the capability report says so.

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

A model writing one very large tool call streams its input for minutes with
nothing a person can see (observed with a Canvas document on Opus). The stream
still moves: `input_json_delta` chunks arrive, and the API interleaves `ping`
keep-alives. The adapter turns both into the normalized `liveness` event, at
most one every five seconds per turn. The Chat, Work, and Code runners count it
as activity, so their idle timeout measures a session that stopped producing
anything rather than one that is still writing. Every other consumer ignores
it: it carries no content and reaches no transcript, journal, usage figure, or
turn event budget. A session that goes fully silent still times out.

Codex sends nothing while the model streams a tool call's arguments: the
installed 0.163.0 app-server schema has no argument-delta notification, and
`item/started` arrives only after the arguments are complete. Once a tool runs,
the app-server reports progress, and the adapter turns `item/commandExecution/outputDelta`,
`item/mcpToolCall/progress`, and `item/fileChange/patchUpdated` into the same
throttled `liveness` event. It decodes only their thread, turn, and item
correlation, never the output, message, or patch. The legacy
`item/fileChange/outputDelta` is never emitted, and the `process/*`,
`command/exec/*`, and `model/safetyBuffering/updated` notifications are not tied
to a turn item, so they stay ignored. A single Codex tool call whose arguments
take longer than the idle timeout to write can therefore still end as timed out.

The launch environment sets no `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
umbrella and names each channel it keeps off, as
[Architecture: security and authority](../architecture.md#security-and-authority)
lists them (maintainer decision, 2026-10-20: the blanket block was stricter
than Octant needs); a person's own `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
in the host environment still passes through, and a host that exports a
truthy `DISABLE_TELEMETRY` or `DO_NOT_TRACK` keeps it as `DO_NOT_TRACK=1`, a
switch the Claude artifacts launch never removes (maintainer decision,
2026-10-28: the person's own opt-out always wins over the artifacts setting). The decision changes no
session's tool list. Measured with the Agent SDK (`query({ tools: ["Read",
"Artifact"] })`, reading the `system/init` message's `tools`) on Claude Code
2.1.211 (bundled) and 2.1.304 (on `PATH`), 2026-10-20, the runtime offers its
`Artifact` tool only when launched by Anthropic's own desktop app (it keys on
the launching entrypoint), so a query from Octant lists `["Read"]` with the
umbrella and without it alike. Reading the bundled 2.1.211 binary
(2026-10-27) found the opt-in that measurement did not set: an Agent SDK
launch lists `Artifact` once `CLAUDE_CODE_ARTIFACT` is set, and then only for
a claude.ai sign-in on a Pro, Max, Team, or Enterprise plan whose
organization allows it, on the first-party API, with nonessential traffic
allowed, and while claude.ai's own feature switch is on.

Which launch variables gate that feature switch was measured from the bundled
2.1.211 binary (2026-10-28) by evaluating its own gate functions, copied
verbatim from the binary, under each launch environment. The switch is read by
`et("tengu_cobalt_plinth")` through `rRc`, which returns the shipped default
(off) when `!Yee() && !$Fh()`. `Yee()` is `!DISABLE_GROWTHBOOK && !lY()`, and
`lY()` is true when the provider is not first-party, a gateway sign-in is in
use, or `wve()` is true; `wve()` is true when `kol()` reads
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, or a truthy
`DO_NOT_TRACK`. (`$Fh()`, a disk-cache path for telemetry-off launches, needs
`CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF`, which Octant never sets.) Of
Octant's guards only `DISABLE_TELEMETRY` is read on that path: removing any
other one from the full set leaves the service off, and removing
`DISABLE_TELEMETRY` alone turns it on. `DISABLE_ERROR_REPORTING` gates error
reports (`xe()`) and the issue explainer on its own, not the flag service, so
it stays set. `Yee()` also gates the runtime's usage telemetry (first-party
event logging, its metrics exporter, and Datadog batches), which is why the
one lifted guard turns telemetry on; the feedback survey keeps its own switch.
The umbrella keeps the service off and, through `V7c()`, the tool too.

So Octant lifts exactly `DISABLE_TELEMETRY` (`CLAUDE_ARTIFACT_LIFTED_GUARD`)
and sets `CLAUDE_CODE_ARTIFACT=1` and adds `Artifact` to the tool list, all
three only for a launch that offers the tool: a Work or Code session outside
Plan, on a claude.ai sign-in, on an account whose person enabled
[Claude artifacts](model-endpoints.md#claude-artifacts), for a thread that
chose them, on a host that does not export the umbrella. Every other launch
of every account keeps the full guard set, and a host's umbrella is never
removed. The decision rests with the person, because that launch sends the
runtime's usage telemetry to Anthropic
([Architecture: security and authority](../architecture.md#security-and-authority)).
The launch environment is fixed when the runtime starts, and Octant starts
it once per turn (start or resume, then stop when the turn ends), reading
the account setting and the thread's choice at each start, so turning either
off reaches the next turn with every guard; nothing restarts a running turn,
and its next publish is refused at once. `CLAUDE_CODE_ARTIFACT` is an internal
switch of the runtime, not a documented interface: a runtime that ignores or
renames it leaves the tool out, and Octant never admits a tool its own list
did not request.

The account reports `nativeArtifacts` per mode from the setting and the
probe's launch: supported in Work and Code once enabled on a claude.ai
sign-in, otherwise unsupported with `unsupportedReason` (`turned-off`,
`no-publishing-account` for an API key, `host-traffic-disabled` for the
host's own umbrella or telemetry opt-out), and unsupported in Chat everywhere; the provider service reports a
change of the setting at once, without a probe. No probe can read claude.ai's
own plan checks without a turn, so a session whose runtime still leaves the
tool out delivers as a Canvas. The tool publishes a local `.html` or `.md`
file and answers with the page's claude.ai address; the decoder keeps that
address and title from the structured result (an `https` claude.ai address
only), the driver adds the snapshot it read when the person approved the
publish, the mapper attaches both to the call's `tool-success` as
`published`, and the call is reported as outside
content (`hosted-tool`), because claude.ai's answer reaches the model. The
same probe showed that
`strictMcpConfig: true`, which every Octant query sets, keeps the account's
claude.ai connectors (listed by 2.1.304 with `settingSources: []` when the
option is absent) out of the session. The decoder tolerates the narrower list
(the runtime may drop a requested tool, never add one), so a launch that lacks
a requested tool still runs.

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
is `{decision}`. Today an approval is answered
`once`, never `always`, even when approvals are remembered for the Project:
`always` would save a grant in OpenCode's data directory, which it shares
with the person's own use, outside Octant's revocation. The rule is that the
person may answer `always` ([Key providers](#key-providers); allowed, not
built yet): the answer is journaled, and the approval says that the grant
lives in OpenCode's own store, where clearing it is the way to revoke it. Approval-gated on
2.x honours permission grants the person saved in OpenCode itself for the
same repository: OpenCode keys them by the repository's root commit, keeps
them in its own data store (shared with the person's own use because
provider credentials live there), and applies them as allow after Octant's
rules. Today Octant's denies still win, so Plan and the Work shell and
subagent denials hold (the Work shell denial lifts in a Project with Shell
and tools on; allowed, not built yet), and Octant itself never writes such a grant because
it answers approvals `once`. The rule is that the person's OpenCode rules
apply over Octant's level rules, with Plan and a mode's withheld tools still
Octant's denies (allowed; not built yet). An edit allowed this way still fails the turn
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

Every OpenCode prompt names its model, so a resumed session runs on the
thread's model, the one its cursor's binding records. The session record is
only a fallback: 1.x does not report a model on it, and the adapter once sent
each prompt of such a resumed session to a placeholder model that does not
exist. When neither the resume, its binding, nor the session names a model,
the resume is refused as `stale-resume` rather than guessed. The same rule
makes `modelSwitch` supported: a follow-up on another model of the same
instance resumes the same native session on the thread's current model and
re-records it on the cursor's binding, instead of refusing the session it can
carry.

## Pi

Octant launches Pi in RPC mode with `--no-extensions`, which since Pi 0.99
also turns off its built-in extensions (the MCP client, codemode, and tool
search), and loads only Octant's own extension by path. A user-level or
project-level `mcp.json` therefore starts no server and no inherited command
is registered. App-managed tools are reported only for the releases whose
tool attestation, approval bridge, and confinement Octant verified: 0.85.1 and
every release from 1.1.0 whose probe attests the tool bridge. A newer Pi
therefore needs no Octant release; a release below 1.1.0 (other than 0.85.1), or
one whose probe does not attest, lists its models and reports app tools
unsupported, and a session that offers tools on it is refused with a message
that names the floor. Only 0.85.1 is
verified for warm reuse of a settled process; other releases close it and
cold-resume the native history. Pi 1.1.0 adds `aborted` to `agent_settled`:
an aborted run is reported as interrupted, never as completed. A Pi session
runs on the model it was opened with, so a resume that names another is refused
as `stale-resume` rather than run on the old model unseen. Pi 1.0.3
renamed the Azure provider from `azure-openai-responses` to `azure` and kept
its `AZURE_OPENAI_*` variables, so a thread holds them under either name.

## ACP agents

Every ACP agent runs on one shared stack: `acpDriver.ts`, `acpProcess.ts`,
`acpProtocol.ts`, `acpEventMapper.ts`, and `acpManagedTools.ts` in
`apps/server/src/providers`. A vendor is a profile in two halves. Its row in
`ACP_AGENT_PROFILES` (`packages/contracts/src/acpAgentProfiles.ts`) says what
the rest of Octant knows before it runs: name, executable, version probe,
authentication postures, key label, sign-in guidance, update command, and
bundled-plugin serial. Its runtime profile in `acpProfiles.ts` holds its
version contract, launch argv, environment guards, managed-home layout,
host-profile reads and denials, project-root denials, mode mapping, and
capability quirks. A new agent is those two halves, its logo, and
conformance evidence: the driver kind, schemas, commands, discovery,
bundled plugin, labels, and Settings forms are derived from the row, and the
compiler asks for the runtime profile and for the agent's entries in the
provider matrix and `acpProcess.test.ts` fixtures. It never adds a transport,
process supervisor, protocol client, or event mapper. Claude Code (Agent SDK), Codex
(app-server), OpenCode (native routes, ACP turns on 2.x), and Pi (RPC) keep
their own runtimes and do not move onto this stack, although the registry
lists ACP wrappers for them.

### What an ACP agent cannot do

The protocol leaves three things to the agent, and the driver reports them as
absent rather than imitating them:

- **No usage window.** A prompt result carries only a stop reason, so the
  driver declares `usage: "unsupported"`. The runtime card reads **Context
  window: Not reported**, a Code, Work, or Chat thread's context meter says
  the runtime reports no usage instead of waiting for a figure, and a spend
  ceiling leaves the turns out.
- **No compaction request.** The driver declares no `sessionCompaction`, so
  the host refuses compaction as `runtime-cannot-compact`. The runtime card
  reads **Compaction: Not available**, and the context popover and inspector
  show a line saying Octant has no compaction request for it where the
  **Compact session** button would be.
- **Opaque history.** The agent keeps its own conversation and says nothing
  about what it keeps or drops, so `promptRetention` is absent and Octant
  never estimates the window. Resume is `precise` only where the agent
  advertises `loadSession` or session resume.

These are read from `ProviderRuntimeIntegration.context`, which the host
derives from the driver's reported capabilities
(`packages/domain/src/providerRuntimeIntegration.ts`); a renderer never
infers them from the driver kind.

Octant's tools reach an ACP session only through the session MCP bridge, and
only when the agent's `initialize` result advertises `mcpCapabilities.http`
(or the profile names an exact release that accepts it unadvertised) and the
host is macOS. Otherwise the session reports app-managed tools `unsupported`,
and a session that is offered tools is refused before `session/new` rather
than started without them.

### Registry coverage

Snapshot of the official ACP registry
(`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
read from its source repository `agentclientprotocol/registry` at commit
`814a241`, 2026-10-25). **Shipped** has a profile; **probe next** needs the
live probe below before a profile ships; **blocked** will not ship as an ACP
profile for the stated reason. The registry command is its macOS
distribution.

| Registry id               | Agent              | Registry command                                       | Octant status                                                                                       |
| ------------------------- | ------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `cline`                   | Cline              | `npx cline --acp`                                      | Shipped (`cline`)                                                                                   |
| `devin`                   | Devin              | `devin acp` (binary)                                   | Shipped (`devin`)                                                                                   |
| `gemini`                  | Gemini CLI         | `npx @google/gemini-cli --acp`                         | Shipped (`gemini`)                                                                                  |
| `github-copilot-cli`      | Copilot            | `npx @github/copilot --acp`                            | Shipped (`copilot`)                                                                                 |
| `glm-acp-agent`           | GLM Agent          | `npx glm-acp-agent`                                    | Shipped (`glm`)                                                                                     |
| `goose`                   | goose              | `goose acp` (binary)                                   | Shipped (`goose`)                                                                                   |
| `grok-build`              | Grok Build         | `npx @xai-official/grok agent stdio`                   | Shipped (`grok`; Octant adds `--no-leader`)                                                         |
| `kilo`                    | Kilo               | `kilo acp` (binary or `npx @kilocode/cli`)             | Shipped (`kilo`)                                                                                    |
| `kimi`                    | Kimi CLI           | `kimi acp` (binary, Apple Silicon only)                | Shipped (`kimi-code`)                                                                               |
| `mistral-vibe`            | Mistral Vibe       | `vibe-acp` (binary)                                    | Shipped (`mistral-vibe`)                                                                            |
| `qwen-code`               | Qwen Code          | `npx @qwen-code/qwen-code --acp --experimental-skills` | Shipped (`qwen`; Octant does not pass `--experimental-skills`)                                      |
| `opencode`, `opencode-v2` | OpenCode           | `opencode acp` (binary)                                | Shipped as the native OpenCode driver, not an ACP profile                                           |
| `antigravity-acp`         | Google Antigravity | `agy_acp_server.par` (binary)                          | Probe next (shortlist)                                                                              |
| `junie`                   | Junie              | `junie --acp=true` (binary inside `junie.app`)         | Probe next (shortlist)                                                                              |
| `amp-acp`                 | Amp                | `amp-acp` (binary)                                     | Probe next                                                                                          |
| `auggie`                  | Auggie CLI         | `npx @augmentcode/auggie --acp`                        | Probe next                                                                                          |
| `factory-droid`           | Factory Droid      | `npx droid exec --output-format acp-daemon`            | Probe next                                                                                          |
| `autohand`                | Autohand Code      | `npx @autohandai/autohand-acp`                         | Probe next                                                                                          |
| `bob`                     | Bob                | `npx @ibm/bob acp`                                     | Probe next                                                                                          |
| `codebuddy-code`          | Codebuddy Code     | `npx @tencent-ai/codebuddy-code --acp`                 | Probe next                                                                                          |
| `cortex-code`             | Cortex Code        | `cortex acp serve` (binary)                            | Probe next                                                                                          |
| `corust-agent`            | Corust Agent       | `corust-agent-acp` (binary)                            | Probe next                                                                                          |
| `dimcode`                 | DimCode            | `npx dimcode acp`                                      | Probe next                                                                                          |
| `dirac`                   | Dirac              | `npx dirac-cli --acp`                                  | Probe next                                                                                          |
| `harn`                    | Harn               | `harn serve acp` (binary)                              | Probe next                                                                                          |
| `kimchi`                  | Kimchi             | `kimchi --mode acp` (binary)                           | Probe next                                                                                          |
| `minimax-code`            | MiniMax Code       | `npx @minimax-ai/code acp`                             | Probe next                                                                                          |
| `nova`                    | Nova               | `npx @compass-ai/nova acp`                             | Probe next                                                                                          |
| `poolside`                | Poolside           | `pool acp` (binary)                                    | Probe next                                                                                          |
| `sigit`                   | siGit Code         | `sigit` (binary or `npx @smbcloud/sigit`)              | Probe next                                                                                          |
| `stakpak`                 | Stakpak            | `stakpak acp` (binary)                                 | Probe next                                                                                          |
| `claude-acp`              | Claude Agent       | `npx @agentclientprotocol/claude-agent-acp`            | Blocked: Claude Code stays on the Agent SDK driver                                                  |
| `codex-acp`               | Codex              | `npx @agentclientprotocol/codex-acp`                   | Blocked: Codex stays on the app-server driver                                                       |
| `pi-acp`                  | pi ACP             | `npx pi-acp`                                           | Blocked: Pi stays on the RPC driver                                                                 |
| `cursor`                  | Cursor             | `cursor-agent acp` (binary)                            | Blocked: kept out of production                                                                     |
| `github-copilot`          | Copilot            | `npx @github/copilot-language-server --acp`            | Blocked: Copilot ships through the Copilot CLI entry; the language server is not a coding-agent CLI |
| `agoragentic-acp`         | Agoragentic        | `npx agoragentic-mcp --acp`                            | Blocked: registry quarantine (postinstall script)                                                   |
| `crow-cli`                | crow-cli           | `crow-cli acp` (binary)                                | Blocked: registry quarantine (initialize fails)                                                     |
| `deepagents`              | DeepAgents         | `npx deepagents-acp`                                   | Blocked: registry quarantine (missing dependency)                                                   |
| `fast-agent`              | fast-agent         | `uvx fast-agent-acp -x`                                | Blocked: registry quarantine (initialize times out)                                                 |
| `minion-code`             | Minion Code        | `uvx minion-code acp`                                  | Blocked: registry quarantine (Python dependency)                                                    |
| `qoder`                   | Qoder CLI          | `npx @qoder-ai/qodercli --acp`                         | Blocked: registry quarantine (initialize fails)                                                     |
| `vtcode`                  | VT Code            | `vtcode acp` (binary)                                  | Blocked: registry quarantine (missing Windows builds) until it is lifted                            |

fx ships as an ACP profile (`fx`) but is not in the registry; see
[fx-acp-compatibility.md](../fx-acp-compatibility.md).

fx is also withheld from users. `WITHHELD_BUNDLED_PROVIDER_DRIVERS` in
`packages/plugin-host/src/bundledProviderDrivers.ts` holds its driver out of
the activation ladder, so discovery does not offer it, a new instance cannot be
created, and no `fx` process starts, not even a version probe. A stored fx
instance and its threads stay: it reports `unavailable` with reason
`driver-not-admitted` and a message that names why. Measured 2026-10-28 on fx
0.0.15, under the deny-default Seatbelt profile (System Keychain reads
denied), fx's HTTP pool aborts certificate loading instead of falling back to
`/etc/ssl/cert.pem`, so it cannot reach the Vercel AI Gateway and its model
catalog drops to one model. Octant does not grant fx Keychain reads. Removing
the table entry offers fx again; do that at the first stock fx release that
falls back to `/etc/ssl/cert.pem`, and raise `minimumVersion` in `fxProfile` to
that release at the same time.

### Probe before a profile ships

A profile ships only after a live probe against a signed-in install on Apple
Silicon shows each of the following, recorded as a smoke test beside
`devinSmoke.integration.test.ts` and a case in `acpConformance.test.ts`.
Nothing is inferred from the registry entry alone.

1. **Locate and version.** The binary is found where the registry
   distribution or the vendor installer puts it, `--version` (or the npm
   `package.json`) matches the profile's pattern, and an older release is
   refused as incompatible by Connection Check.
2. **Authentication.** Sign-in happens in the agent's own flow (registry
   Agent Auth or Terminal Auth), outside Octant. The probe names the profile
   directory or credential file the agent reads and the variable that points
   it there, and shows a signed-out install fails Connection Check as
   unauthenticated before any session starts.
3. **Initialize.** The `agentInfo.name` the profile pins, and the advertised
   `loadSession`, session resume, `promptCapabilities`, and
   `mcpCapabilities.http`.
4. **Session.** `session/new` in the project root, the models and modes or
   config options it returns, and the mapping of Chat, Work, Code, and Plan
   to them; a mode with no safe mapping is refused by the profile.
5. **Prompt.** A streamed reply, tool calls with their declared kinds, a
   permission request answered once, an `execute` request refused at the
   agent, and the stop reason.
6. **Cancel.** `session/cancel` during a running turn ends it as cancelled
   and leaves the process usable for the next prompt.
7. **Confinement.** Below Full access the agent runs under the deny-default
   Seatbelt profile: it cannot write outside the root and managed home, the
   project and home skill, MCP, and configuration roots it would load are
   denied (and added to the architecture's skill-root table), and any child
   server it spawns is declared.
8. **Tools and resume.** Where `mcpCapabilities.http` is advertised, an
   Octant tool round-trips through the session bridge; where it is not, the
   integration reports tools unavailable. Where resume is advertised, a
   follow-up reopens the agent's session.

For the shortlist the probe must also settle: for Google Antigravity, how
`agy_acp_server` authenticates outside its IDE extension and whether it runs
without the IDE (the registry's Linux entry passes `--uid=`); for Junie,
whether the executable inside `junie.app` launches under Seatbelt from its
bundle path, and which JetBrains account state it reads.

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

## Runtime updates

Octant tells the person when a newer release of a runtime exists and runs the
runtime's own updater only when they click **Update CLI**. Discovery still never
installs or updates anything.

- **Who may check.** The host, for an enabled instance whose CLI Octant can
  already update and whose official distribution is an npm package: Codex
  (`@openai/codex`), Claude Code (`@anthropic-ai/claude-code`), Grok Build
  (`@xai-official/grok`), GitHub Copilot (`@github/copilot`) and Cline
  (`cline`). The package table lives with `providerLatestVersionNpmPackage`
  in `@octant/domain`. A runtime without an official npm package (Devin,
  Mistral Vibe, Kimi Code) and runtimes with no provider-owned updater (Pi,
  OpenCode's managed copy aside) show no "update available".
- **What is sent.** One plain `GET` of the package's `dist-tags` on the npm
  registry, with the constrained marketplace User-Agent and an `Accept` header:
  no task data, thread, Project, account, instance or host identifier. The
  answer's `latest` tag must be a plain version string or it is ignored.
- **When.** Never at discovery. The renderer asks when Providers settings loads
  an enabled instance, once per instance per session; the host caches the
  answer for a day (a failure for an hour). It follows the Marketplace fetches
  switch: off means no request is made, and a failed or refused lookup is
  silent.
- **What it does.** Settings shows "Update available (installed → newest)" next
  to **Update CLI** when the newest is strictly newer than the probed version.
  It changes nothing by itself: the click runs the provider's own updater as
  before, with no automatic update. After the updater exits the host probes
  again, so a release that no longer passes a version floor or capability check
  shows its refusal reason instead of failing turns.

## Verification

- OpenCode: `apps/server/src/providers/openCodeDriver.test.ts`,
  `openCodeClient.test.ts`, `openCodeEventMapper.test.ts`,
  `openCodeProcess.test.ts`, `openCodeConformance.test.ts`, and the
  `openCode2AppToolsSmoke.integration.test.ts` real-runtime smoke.
- Pi: `apps/server/src/providers/piDriver.test.ts`, `piProcess.test.ts`,
  `piConformance.test.ts`, and the `piSmoke.integration.test.ts` real-runtime
  probe (verified release attestation and the hostile MCP configuration).
- ACP agents: `apps/server/src/providers/acpDriver.test.ts`,
  `acpProcess.test.ts`, `acpProtocol.test.ts`, `acpEventMapper.test.ts`,
  `acpManagedTools.test.ts`, `acpConformance.test.ts`, the `devinSmoke`,
  `grokSmoke`, `kimiSmoke`, and `vibeSmoke` real-runtime smokes,
  `packages/domain/src/providerRuntimeIntegration.test.ts` for the derived
  context facts, and `apps/web/src/providers/ProviderRuntimeIntegrationFacts.test.tsx`
  and `apps/web/src/context/ComposerContextMeter.test.tsx` for how they show.
- Held standing context, before and after on a real Claude Code or Codex Code
  session: `apps/server/src/providers/heldTurnContext.benchmark.test.ts`
  (opt-in through `OCTANT_HELD_CONTEXT_MEASURE_CLAUDE=1` or
  `OCTANT_HELD_CONTEXT_MEASURE_CODEX=1`, run with `bun run test:evidence`).
- Sign-in dialects: `apps/server/src/providers/directEndpointSubscriptionOAuth.test.ts`,
  `chatGptPlanProfile.test.ts`, `packages/domain/src/subscriptionOAuthCatalog.test.ts`,
  and `packages/provider-sdk/src/subscriptionOAuthConformance.test.ts`.
