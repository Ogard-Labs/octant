# Provider runtimes

This topic specification owns runtime-specific wire behaviour that the provider
boundary normalizes: OpenCode's version-selected routes, the Pi release
gate, the shared ACP stack and its registry coverage, the local-server adapter, and the vendor sign-in dialects of the host OAuth runner. Architecture
owns the driver interface, honest capability, credentials, and confinement
([Architecture: providers](../architecture.md#providers) and
[security and authority](../architecture.md#security-and-authority)).

## Provider cloud sessions

The first remote-job adapter uses the official OpenAI Agents API beta protocol
`openai-agents-v1`, independently of Codex subscription sessions. Eligibility
requires an enabled bearer API-key endpoint at exactly
`https://api.openai.com/v1`, without an OAuth identity, a configured model and
separate cloud opt-in. Compatible gateways and subscription identities are not
treated as that API. An outside driver may declare the same published codec;
it must also pass activation and observed capability checks. Unsupported
protocols remain unavailable, rather than receiving an arbitrary HTTP plan.

The host seals each operation with the shared public SDK codec. Create is
`POST /v1/agents/sessions` with `OpenAI-Beta: agents=v1`, the reviewed input
string and exact model, `review:none`, `stream:false`, and a fresh small
`openai_hosted` environment. Tools, multi-agent execution, desktop, network,
initial files, environment additions, setup commands, plugins and capability
directories are disabled or empty. No local tool callback is implemented.
Read uses the owned session, latest turn and bounded item list. Idle is not
terminal turn evidence. Unexpected required local actions are unsupported and
cause a cancellation request. Cancel posts an
`agent.session.input.cancel` event to the owned session with a stable job
idempotency key; success means requested, not stopped. Initial create has no
assumed idempotency or automatic retry.

Each host request has an exact method/path/body permit, no redirect, a
thirty-second transport deadline and a 2 MiB response limit. Create is one-use,
including through outside RPC. The host records the actual response's remote
ID before replying to the driver, so an outside lost reply cannot replace it
with another job or discard known recovery authority. The driver sees bounded
responses, never the credential. Normalized text is escaped, capped at 32,000
characters and marked truncated when the bounded list or text is incomplete.

Public documentation checked on 2026-11-04:
[sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions),
[hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted),
and [create-session fields](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create).
Account/model/API-key permissions, actual provider sandbox enforcement, billing
and a live remote turn require a separately authorized provider check. Synthetic
HTTP, outside RPC, journal, route, client and rendered tests establish local
behavior only. No hard per-job spend enforcement is claimed; the
[cloud-job authority rule](../architecture.md#provider-cloud-jobs) refuses any
current thread or Project spend ceiling.

## Key providers

Claude Code, Codex, Mistral Vibe, OpenCode, and every other ACP agent run as
themselves inside Octant ([Architecture: key providers run as themselves](../architecture.md#providers);
the other ACP agents are in [ACP agents run as themselves](#acp-agents-run-as-themselves)).
The person's own setup is on by default, so the switch-offs below apply only
where the person turned the setup off for an account or a thread. Each key
provider's wire behaviour, gated by the thread's
[guardrail level](../architecture.md#security-and-authority) (on by default at
every level; the person turns it off per account or per thread):

| Provider     | With the setup off                                                                                                                                  | With the setup on                                                                                                                                                                                        | Built                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `settingSources: []`, `skills: []`, no subagent tool; `WebSearch` and `WebFetch` only in Work and Code outside Plan                                 | The person's setting sources (home and trusted Project), skills, plugins, hooks, and MCP servers; its subagent tool; `WebSearch` and `WebFetch`; `permissionMode: "auto"` as Reviewed's default reviewer | Reviewed with its own reviewer, in Code                                                                                                                                                                                                                                                                                                                                                                    |
| Codex        | Its subagents; Project skills disabled by path; in Chat each named MCP server switched off; `web_search = "disabled"`                               | Its subagents; Project skills; the person's MCP servers in Chat; `approvalsReviewer: "auto_review"` as Reviewed's default reviewer                                                                       | Reviewed with its own reviewer, in Code                                                                                                                                                                                                                                                                                                                                                                    |
| Mistral Vibe | `VIBE_SKILL_PATHS="[]"`, `VIBE_DISABLED_SKILLS='["*"]'`, `VIBE_INCLUDE_PROJECT_CONTEXT="false"`, `VIBE_DISABLED_TOOLS='["web_search","web_fetch"]'` | Its own skills and Project context; a trusted Project's tools and MCP servers; its auto-approve mode as Reviewed's default reviewer                                                                      | Reviewed with `auto-approve`, in Code (`harnessAutoReview` supported); with the setup on, the skill (registry skills included), Project context, MCP server, connector, and hook guards unset, and in a trusted Project `VIBE_TOOL_PATHS` unset and the `.vibe` entries readable; `accept-edits` at Accept edits; questions on 3.0.3 through the questionnaire                                             |
| OpenCode     | Skills and project config off, `skill` denied; `websearch` and `webfetch` denied at every level; Octant's denies outrank saved grants; `once` only  | The person's own permission rules; "always" answers; its `subagent` delegation; its skills; `bash` and `task` in Work as in Code; Reviewed through Octant Shield                                         | With the setup on: `skill` asked rather than denied with the three skill switches unset, a remembered 2.x approval answered `always`, its delegation followed as child runs, the MCP servers and permission rules in the person's own configuration, and in a trusted Project outside Plan `OPENCODE_DISABLE_PROJECT_CONFIG` unset; outside folders at Full access; Reviewed through Octant Shield at Auto |

OpenCode reads its instruction files as it does on its own, at every level
and with the setup on or off: no launch sets `OPENCODE_DISABLE_CLAUDE_CODE`
or `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` (maintainer decision, 2026-11-15).
Read from the opencode 1.18.21 source, either switch drops `CLAUDE.md` from
its instruction files: the global `~/.claude/CLAUDE.md`, read when no global
`AGENTS.md` exists, and the Project's `CLAUDE.md`, read when no Project
`AGENTS.md` exists. The broad switch also turns off `.claude` skills, so the
launch keeps `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` for that alone, unset only
with the person's own setup on. OpenCode 2.x (2.0.22, 2.2.0 and 2.3.0 read)
reads only `AGENTS.md` and has no prompt switch; the 2.2.0 and 2.3.0
servers gate `.claude` skills on either switch, which the skills switch
still covers, and 2.0.22 reads neither switch. The 1.x
server reads the Project's instruction files only without
`OPENCODE_DISABLE_PROJECT_CONFIG`, so in Plan, Chat and an untrusted Project
it reads the global file alone. 1.x reads the first of
`<global config>/AGENTS.md` and `~/.claude/CLAUDE.md` that exists, where the
global config folder is `$OPENCODE_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (opencode 1.18.21,
`src/session/instruction.ts` and core `global.ts`). A launch sets
`OPENCODE_CONFIG_DIR` to its private folder, so with the person's own setup
on (OpenCode runs as itself) a 1.x launch links the person's global
`AGENTS.md`, found where their own environment names that folder, into the
private one, and OpenCode then prefers it over `CLAUDE.md` as it does on its
own. With the setup off no `AGENTS.md` is linked and 1.x reads
`~/.claude/CLAUDE.md`. Below Full access the 1.x launch's wall opens that
one `AGENTS.md` for reading and nothing else in its folder (the person's
`opencode.json`, plugins and agents stay out): a literal Seatbelt rule on
macOS and a read-only bind on Linux, as for `CLAUDE.md`. A protected file, a
link, or a file reached through a linked folder is not linked or opened. A
2.x launch links nothing. Below Full access the 1.x
launch's wall opens that one file for reading and nothing else in
`~/.claude`: a literal Seatbelt rule on macOS, under the `~/.claude` denial
that stays whole, and a read-only bind on Linux. The file is found at
`~/.claude/CLAUDE.md` in the launch's home, as OpenCode looks for it
(`CLAUDE_CONFIG_DIR` is not consulted); a protected file, a link, or a file
reached through a linked `.claude` is not opened. A 2.x launch opens nothing
there. The text grants nothing: Plan stays read-only, and the protected-file
rules and the account's sign-in file exemptions apply to reads as before.

With the setup on, Claude Code starts with `settingSources: ["user"]` (plus
`project` and `local` in a trusted Project), `skills: "all"`, and the `Agent`,
`WebSearch`, `WebFetch`, and `Skill` tools, with every hook off by flag in Chat
and Plan. With its tool servers on (every level but Plan) it starts with
`strictMcpConfig: false` in every Project, so the account's own MCP servers,
its claude.ai connectors, and its plugins' servers start
(maintainer decision, 2026-11-14). A Project's `.mcp.json` stays held until
the person trusts the Project: Claude Code 2.1.211 reads `.mcp.json` only
while the `project` setting source is on, its home servers only while `user`
is, and its per-folder servers only while `local` is (read from the bundled
binary, 2026-11-14). The `enabledMcpjsonServers`, `disabledMcpjsonServers`,
and `enableAllProjectMcpServers` settings are not the hold: a launch with no
terminal approves every pending Project server once the `project` source is
on, so leaving that source off is what keeps them out. The plugins the
person installed and enabled in home settings load whenever the launch reads
them: the SDK's `plugins` option, which Octant leaves empty, only adds
session plugin folders, and Claude Code loads every plugin its merged
settings enable. A plugin's hooks follow the hooks switch (`disableAllHooks`
holds them in Chat and Plan), and its MCP servers follow the tool-server
switch. Codex starts
with no `skills.config` rules, no per-name `mcp_servers` switch-off,
plugins and apps on in Chat, and an app-server that has no subagent
switches, at every level; a subagent's requests come back on its own thread
id and are answered through the parent's session. With Run as itself off for
the account, the resolved setup has `subagents` off in Chat, in Plan, and at
Guarded, Accept edits, and Reviewed, unless the thread chose On or the Project
trusts Codex; Full access in Work and Code still turns it on, and a thread's
Off keeps it off everywhere. Where `subagents` is off, Codex's app-server is
leased with `features.multi_agent=false`, `features.multi_agent_v2=false`, and,
from 0.145.0, `agents.enabled=false` (`codexAppServerArgs`), so Codex's own
subagents never start. Each runtime's own web
search and fetch run only where the setup has `webTools` on: Claude Code gains
`WebSearch` and `WebFetch`, Codex starts without `web_search = "disabled"`,
OpenCode stops denying `websearch` and `webfetch`, and Mistral Vibe launches
without `VIBE_DISABLED_TOOLS`. The web search data policy does not change
`webTools`: it governs Octant's own backends only
([Web search backends](web-search-backends.md#in-a-vendor-runtime)). Mistral Vibe unsets
`VIBE_ENABLE_SUBAGENTS` in Work and Code outside Plan, so its subagents
follow the person's setup at every level there (maintainer decision,
2026-11-14). Read from the 3.0.3 source on 2026-11-14, a subagent's
approval reaches `session/request_permission` on the parent's session as
`ToolCallUpdate(tool_call_id=related_entry_id)` alone, with no title, kind,
or input, and the child's entries never reach the parent's updates. The
maintainer accepted that: such a request, one naming a tool call Octant
never saw and carrying no title, is shown through the ordinary approval path
as "A Mistral Vibe subagent asks to run a tool. Vibe doesn't say which." with
Allow and Deny, and the thread's level decides it as any other request
(`unnamedPermissionDescription` on the profile; another agent's such request
still fails the turn). Wherever the subagents run, `VIBE_AGENT_PATHS`,
`VIBE_INSTALLED_AGENTS`, and `VIBE_ENABLED_AGENTS` are unset too, so a
subagent runs as one of the person's own agents at every level outside
Plan. Such an agent may approve its own tools, as it does in Vibe itself;
the maintainer accepted that (2026-11-14). Its calls stay in the child's
history, which Octant never sees, so `unseenChildCalls` on the profile makes
each child run name the agent it ran as (from the call's `agent`) and say
that Octant cannot see its tool calls and that the agent may approve them
itself; a run as any agent but Vibe's read-only built-in `explore` (grep,
read_file and skill in 3.0.3) also marks the thread as having read outside
content, under `hosted-tool`, since it may have done so unseen. In Plan and
Chat the allowlist keeps a session opening and switching only on the modes
Octant selects: `ask`, `plan`, `accept-edits` (Accept edits in Work and
Code; it approves Vibe's own writes and edits and asks for the rest, inside
the Accept edits wall), and `auto-approve` (maintainer decision,
2026-11-14). With the allowlist unset, a person whose own agent lists leave
out a mode Octant selects gets a refused session start, not a different
mode.

OpenCode in a trusted Project outside Plan loads the Project's own
configuration exactly as it does on its own: the launch leaves
`OPENCODE_DISABLE_PROJECT_CONFIG` unset, so OpenCode reads the Project's
`opencode.json(c)` and its `.opencode` agents, commands, plugins, and tools
(maintainer decision, 2026-11-14). In Plan, in Chat, and in a Project not
trusted for OpenCode the variable stays set and none of it loads, so Plan
stays read-only. Rationale: OpenCode loads a Project's files after the
launch's private configuration (v1.18.21 `config/config.ts:401-475`; v2.0.27
`packages/core/src/config.ts:230-237` and `config/plugin/agent.ts:84-123`),
and a rule decides by last match, so a Project agent's `*: allow` or a Project
agent made the default can override Octant's level rules in that Project. The
maintainer accepted that: trusting a Project for OpenCode is trusting its own
rules, as OpenCode's own users do, and Plan, where the variable stays set, is
the hard line. The earlier build read only the files' rules and MCP servers
into the private configuration under the level's denies and kept plugins,
agents, and commands off; it is removed. Because a Project's plugins and MCP
servers then share the process, such a launch is never attested as isolated,
and Octant's app-managed tools are offered beside them below Full access, as
at Full access, instead of being refused.

Claude always reads the person's global `CLAUDE.md` and the Project's, in
every Project and in Work, even before the Project is trusted (maintainer
decision, 2026-11-14). Claude Code loads them only through the `user` and
`project` setting sources, and the `project` source also loads the Project's
settings and hooks, so it still waits for trust. Where a source is off,
Octant reads the files itself (`claudeSessionInstructions` in
`apps/server/src/providers/claudeDriver.ts`), as text with no authority,
and appends them to Claude Code's own system prompt. Every Claude launch
sends `systemPrompt: { type: "preset", preset: "claude_code" }`, with
Octant's additions only in `append`: agent-sdk 0.3.211 reads a missing
`systemPrompt` as the custom prompt `""`, which the runtime put in place of
its default prompt (output styles, commit and pull-request guidance,
environment details), so until 2026-11-14 Claude ran without its own prompt.
The appended text is fixed for the session, so it never moves a turn's
cached prefix. The account's file is
`CLAUDE.md` in its config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`);
the Project's are the files Claude Code's loader reads at its root
(`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`)
and the files they import with `@path`, expanded as below. Ancestors above
the Project root are outside the Project and are not read, and Claude Code
loads a nested folder's file only once it reads inside it, so neither is
added. Where the source is on, Claude Code loads the files itself and Octant
adds nothing, so nothing doubles. A file over 64 KiB, past 256 KiB in all,
not UTF-8 text, or resolving through a symlink outside its folder, or
through an import outside the account's and the Project's folders, is skipped
and the reason logged. The host reads these files outside every
gate, so below Full access a file or import the secret guard protects (the
check a `Read` of it meets) is skipped as `protected` before it is opened,
and at every level so is the account's own sign-in (`.credentials.json`,
`.claude.json` and its backups, a secure-storage folder of its own); at Full
access the secret guard does not apply, as for Claude's own tools. Chat (no folder) and single-use sessions
read none.

The setup is on by default for every key provider account at every level;
the person turns it off per account or per thread
([Architecture: providers](../architecture.md#providers)). An account the
person turned off carries none of it below Full access, and never the
runtime's own web search and fetch: `webTools` resolves off in every mode and
at every level, Full access, a trusted Project, and the thread's On included
(maintainer decision, 2026-11-15). Each driver honors it with the web-tools
switch in the table above.

Plan's read-only rule, Chat's withheld filesystem and shell, and the
provider's telemetry and self-update channels stay off at every
level. The provider's own memory is on by default in Work and Code outside
Plan, as in the provider's own app, and the person turns it off per
provider account (maintainer decision, 2026-11-14; the account stores only
the off, as `ownMemory: false`, and an older stored `true` reads as on).
Plan and Chat keep it off. With it on, Claude Code launches
without `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and Codex's app-server starts
without the `features.memories=false` override, on a process of its own;
OpenCode and Mistral Vibe have no such memory and no setting
([architecture](../architecture.md#modes-chat-work-and-code)). Work and Code share one capability set, so each runtime starts a Work
session with its shell at the thread's level exactly as it starts a Code
session, as the
[architecture's Work rules](../architecture.md#modes-chat-work-and-code)
state per provider. A native child run, a native
web read, and a provider's review verdict are journaled where the runtime
reports them; where it does not, the capability report says so.

Codex reports each finished review of its own reviewer as
`item/autoApprovalReview/completed` (observed in the codex-cli 0.164.0
app-server schema, where it is marked unstable, so the adapter reads only the
ids, the status, the reviewed item, the risk grade, and the rationale, and
treats the rest as optional). `approved` and `denied` are verdicts; `timedOut`,
`aborted`, and `inProgress` are not. Claude Code reports a refusal by its
automatic-mode reviewer as a `permission_denied` system message with the reason
type `classifier` (Agent SDK 0.3.211), and nothing for a call it approved. A
denial for any other reason keeps being an unsupported message. Mistral Vibe's
`auto-approve` mode sends no per-call verdict over ACP.

### Mistral Vibe surface

Mistral Vibe stays on the ACP bridge (`vibe-acp`). Read 2026-11-01 from the
installed 3.0.3 package, Vibe ships a second stdio surface, `vibe-app-server`
(JSON-RPC, one object per line), with structured turn history, token and
price figures, `session/compact`, per-file review diffs, and approval and
question callbacks. Octant does not adopt it. Rationale: its `initialize`
negotiates no version, its messages reject any field they do not know, and
its own model module says client and server ship together, so any Vibe
release could break a separate client without notice; it is published as an
entry point but documented nowhere. `vibe-acp` is a projection over the same
in-process host, so it loses no capability by comparison: the 3.0.3 source
sends ACP usage updates with context size and cost, a `/compact` command,
`review/*` extension methods, and questions as elicitation. Usage and context
updates are consumed for the verified 3.0.3 release, as specified below.
Native review remains unimplemented. Supplementary file-review
reads have a candidate integration behind an empty verified-version allowlist:
no production profile declares the read capability until signed-in 3.0.3
read and genuine same-task cold-resume evidence pass. Revisit `vibe-app-server` when it negotiates a
version or is documented. Vibe's questions reach the shared questionnaire as
a session-form elicitation on 3.0.3, the one release in its verified-version
list (maintainer decision, 2026-11-14: Octant adds to a provider and does not
take its core features away). Another release reports questions
`unavailable`. The signed-in 3.0.3 question, answer and cancellation check
stays a maintainer live check.

The adapter advertises only ACP `elicitation.form`, never URL elicitation,
for an explicitly verified exact 3.0.3 release. Only an active originating
native session may ask; one form callback is pending at a time. It maps the
runtime's bounded string/array choice schema to the shared questionnaire,
refusing unsupported constraints, oversized asks, duplicate choices and
mismatched sessions rather than shortening the ask. Single and multiple
selections and written alternatives return to the original property names and
choice values only after validating the complete answer. The adapter keeps the native callback/property mapping privately; public
question and option identities are generated by Octant. A global comment
is unavailable because this wire has no place to return it. Invalid answers
leave the question pending; accepted answers are one-use. Interrupt, turn end
and scope closure cancel the owned callback, and late answers are refused.
Chat, Work and Code use their existing questionnaire surface. Work additionally
sanitizes displayed text and accepts a structural response under its existing
no-path/no-URL boundary before private SDK serialization. No account call,
source fixture or empty-history probe constitutes signed-in acceptance.

Requested compaction has a separate gated ACP adapter through the existing
provider SDK `compact` port and host compaction service. Its verified-version
allowlist is empty: production remains unsupported until signed-in nonempty
3.0.3 compaction and same-task cold-resume semantics pass. The installed
command must also advertise `compact` for the exact native session. The host
never replaces the chosen ACP driver or sends ordinary history as a workaround.

The command runs only while the session is idle, exclusively from ordinary
turn traffic. Its private connection stays quarantined until the owning host
closes it; a later turn resumes the saved native history on a fresh connection.
It sends `/compact` once and requires one structured start and
one completed update with the same native tool-call identity. `end_turn`,
English progress/refusal text, duplicate or mismatched receipts, another
session's updates, failed status and unexpected client requests cannot prove
compaction or prove that history was unchanged. Ambiguous outcomes fail with
`sessionMayHaveChanged`; the owning host service closes the runtime. A proved
completion emits one requested `context-compacted` boundary, with no invented
turn/tool activity, token figures, cost or command exit status. Native usage
updates retain their existing accounting rules. The command has the host's
five-minute operation bound; cancellation addresses only its owned native
session and removes the temporary observers before scoped process cleanup.
This request adapter does not implement an automatic-compaction policy.

The provider SDK's optional file-review read port returns bounded checkpoint
text, observed edit scopes, per-scope text comparisons and line anchors. It
never approves or reverts edits and does not report approval-review verdicts.
The host can offer this supplementary detail from current checkout Changes
only; historical turn and run comparisons keep their retained Git evidence.
Git owns baseline, changed-file counts and discard. An empty checkpoint is
valid content, distinct from no saved session or a refused cold resume.

Each explicit file read resolves window/Project/checkout authority and the
thread's host-recorded cursor, provider, model and exact runtime root. It
refuses a running turn or compaction and holds the session against another
turn while acquiring, resuming, reading and closing its private connection.
It never creates a new session, prompts a model or takes over a live turn.
The read always resumes at Plan with no tools, extra folders, automatic
approval or native setup: subagents, web tools, skills, MCP/connectors,
hooks and Project code are explicitly off. It cannot inherit Full access
from the task. The existing Plan launch confines checkout writes and child
execution and retains guarded provider egress. Compatibility of this
restricted cold resume is part of the outstanding native gate.
Selected files pass the existing contained-path and protected-file checks;
a narrower working-folder session never gains the wider checkout root.
Authority and file identity are checked again before returning content.
Host preparation has a 20-second deadline and the runtime operation has a
12-second deadline. Cancellation interrupts owned process initialization and
native load/configuration waits; connection finalization cancels pending
starts before joining them. Stopping the session has a three-second wait;
scope finalization still joins its owned process cleanup. The native close
handshake gets at most 500 milliseconds, followed by transport closure and
the existing process-group termination (two two-second phases, plus the
25-millisecond transport-exit grace). Thus the read's configured operation
and process-cleanup budget is about 16.6 seconds after host preparation,
not a claim that the 12-second operation bound includes cleanup. A process
that survives the kill deadline reports cleanup failure and keeps its
registry ownership; it is never reported as a successful read. Unsupported versions,
malformed/oversized data, cancellation and stale identity refuse the read.

A read-only signed-in ACP probe on 2026-11-03 confirmed 3.0.3's
`usage_update` with `used`, `size` and cumulative `promptTokens`,
`completionTokens` and `cachedTokens` in `_meta`, including an initial
zero-token snapshot. Its installed source confirms that loading a session
restores these cumulative counters, while `used` measures the current context
independently of billed tokens. The adapter captures the new/load snapshot
before sending a prompt, then reports only the counters added since that
baseline. Accounting is emitted once when the prompt settles, using its final
cumulative `usage` receipt. The final receipt also seeds the next baseline, so
a delayed notification cannot charge the preceding turn again. Context is
included only when the latest valid snapshot's token totals match that receipt;
otherwise the older occupancy is omitted. A missing baseline or final receipt,
or a malformed, partial or regressing snapshot, leaves usage unavailable for that turn.
Later valid updates cannot repair an invalidated turn. Late snapshots update
the next turn's baseline without producing a turn event. Startup captures at
most one native identity; mixed or mismatched identities leave no baseline.
Other releases remain unsupported until their wire semantics are verified.

The runtime's `cost` reprices cumulative tokens at the current model's rates.
The adapter leaves provider cost absent because this is not a verified
turn-cost receipt. Ordinary token-based estimates and unknown-spend rules
still apply. Existing ceilings use the provider's current usage capability for
historical rows too. Once this release reports usage support, older unreported
Vibe turns in the active budget window can refuse further turns as unknown
spend; reported tokens with no applicable price also refuse a money ceiling.
No budget policy or historical ledger value is changed. It infers no compaction
event, review verdict or command exit
from a usage update. The probe sent no model prompt, so nonzero usage and
packaged-app turn accounting remain live-smoke scenarios.

Both surfaces run a short allowlist of read-only shell commands (`ls`,
`cat`, `grep`, `git status`, and the like) without a permission request in
its `ask` agent, as Vibe's own app does. Its profile does not set
`shellWithoutRequest`: every other command still reaches Octant as a request,
and below Full access the launch's Seatbelt profile confines those reads to
what the session may already read. Refusing Vibe at Guarded over them would
be stricter than Vibe's own app.

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
turn event budget. A session that goes fully silent still times out, at the
stalled-turn limit: a setting in Settings › Providers & Models, 30 minutes by
default, from 5 minutes to 8 hours, which may be turned off. A provider tool
call the runtime reports as running pauses that clock, as an app-managed call
does, for at most the tool-call pause limit: a second setting there, two
hours by default, from 5 minutes to 24 hours, which may be turned off
(maintainer decision, 2026-11-12). Force stop is unchanged (maintainer
request, 2026-11-12).

The limit is a host setting (`stalledTurnLimitMinutes`, `null` for Off),
journaled with the other shell settings and changed at a local window or a
device the host's own person paired, through `/api/shell/settings`, journaled
as the device (maintainer decisions, 2026-11-12 and 2026-11-13; built). A
device the hub introduced, and a restricted one, cannot change it.
Chat, Work and Code read it when a turn starts: a change applies from the
next turn, and a running turn keeps the limit it started with. A turn cut off
by the limit ends as it did under the fixed limit. With the setting Off, only
Stop and Force stop end a silent turn. The tool-call pause limit
(`providerToolCallPauseLimitMinutes`, `null` for Off) is stored, changed and
read the same way.

A provider tool call is running from its normalized `tool-start` until the
`tool-success` or `tool-failure` with the same `toolCallId`. Claude Code,
Codex, OpenCode, Pi and the ACP agents report these for their own tools.
Octant Harness and the direct model endpoints run no tools of their own:
their tools are app-managed calls, which already pause the clock. An outside
driver gets the pause when it emits the same events. A tool the model's
provider runs on its own servers is reported as outside content, not as a
tool call, so the clock keeps running through it.

One call pauses the clock for no longer than the tool-call pause limit,
counted from its start. When that passes the clock runs again from that
moment, so a turn whose provider stays silent is cut off one stalled-turn
limit later; an event from the provider, the call's late finish included, is
activity as usual, and another call that started later still pauses for its
own time. With the pause Off a call pauses the clock until it finishes.
Rationale: a runtime that reports a start and never the finish would hold its
turn open until the person stops it. Two hours covers a long build or test
run, and Off keeps the unbounded pause for work that runs longer; Stop and
Force stop still end such a turn.

An app-managed tool call in Chat keeps its own deadline of five minutes,
apart from the stalled-turn limit; it does not follow the setting.

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
renames it leaves the tool out, and Octant admits `Artifact` only in a session
that offers it ([full built-in tool set](#full-built-in-tool-set)).

Each Claude session owns its runtime process, so the connection implements
`forceStop`, reported as the `forceStop` capability: it sends `SIGKILL` to that
session's own process group, ends the session `interrupted`, and touches no other
session. Codex and OpenCode serve every thread from one process and report it
unsupported; their connections omit `forceStop` and a host fails closed.

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
`strictMcpConfig: true`, which a query sets while the account's tool servers
are off, keeps the account's claude.ai connectors (listed by 2.1.304 with
`settingSources: []` when the option is absent) out of the session; with the
tool servers on they start as the account's own servers. The decoder tolerates the narrower list
(the runtime may drop a requested tool, never add one the launch does not
allow), so a launch that lacks a requested tool still runs.

### Full built-in tool set

A Work or Code session outside Plan launches with Claude Code's own tool
preset (`tools: { type: "preset", preset: "claude_code" }`) rather than a
fixed list, so it holds what Claude Code holds in its own app (maintainer
decision, 2026-11-14). `disallowedTools` withholds only what would break a
rule the server enforces, and the decoder refuses a runtime or a call that
names a withheld tool:

| Withheld                                                 | Why                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnterPlanMode`, `ExitPlanMode`                          | The thread's mode and level are the server's: both in a session whose host does not answer level changes (Work, child runs), and `ExitPlanMode` outside Plan everywhere; Plan's read-only list holds `ExitPlanMode` (see below) |
| `Agent`, `WebSearch`, `WebFetch`, `Skill`                | Only while the person's own setup has that feature off                                                                                                                                                                          |
| `Workflow`                                               | Only while the person's own setup has subagents off: a workflow starts agents                                                                                                                                                   |
| `ScheduleWakeup`, `CronCreate`, `CronList`, `CronDelete` | Only in a session the host keeps no wake-up schedule for (a single-use session); Octant answers them everywhere else (below)                                                                                                    |
| `Artifact`                                               | Unless the session offers Claude artifacts                                                                                                                                                                                      |

Octant's gate keeps its own rules for the tools it names: reads run unasked
inside the Project, `Edit`, `Write`, and `NotebookEdit` are file edits judged
against the Project's folders and the secret guard below Full access (a path outside those folders asks; see below), and `Bash`, `Monitor`, `TaskOutput`,
and `TaskStop` take the shell's approval rules; a `Monitor` command, like a
`Bash` one, is named in its prompt and marks the thread when it reaches a
server. Session-internal tools that read
no file, write nothing, and reach no network run unasked at every level, as
in Claude Code: the checklist (`TodoWrite`), the task tools (`TaskCreate`,
`TaskUpdate`, `TaskList`, `TaskGet`), which read and write only the
session's task list in the account's configuration directory, and
`ToolSearch`, which only loads deferred tool definitions (the bundled 2.1.211
runtime marks it read-only; maintainer decision, 2026-11-14). A name joins that list only on
such evidence. Every other built-in tool is judged at the Project root and
asks below Full access, which runs without asking, so a tool a later Claude
Code release adds works from that release and fails closed; a path it names
still meets the secret guard. The account's claude.ai service tools
(`RemoteTrigger`, `PushNotification`, `Projects`, `ClaudeDesign`) are such
tools: they use the person's own claude.ai account, a `Projects` upload's
`local_path` meets the secret guard and, wherever the gate confines file
tools (below Full access and at sandboxed Full access), is held to the
Project's folders as an Artifact publish is, and each answer marks the thread as
outside content (`hosted-tool`), as an Artifact publish does (maintainer
decision, 2026-11-14). Because a
native build may serve searches through its shell, `Grep` and `Glob` are
also listed in `allowedTools`; the `PreToolUse` hook still answers each call
first. Plan keeps its explicit list (`Read`, `Glob`, `Grep`, the checklist,
`ExitPlanMode`, the task tools, and `Bash` where its sandbox confines it). The task tools
write nothing in the workspace, and Plan already refuses an account directory
that overlaps the checkout. Chat keeps the earlier explicit list at every
level and holds no part of the preset: its filesystem and shell stay
withheld, so it gains nothing from tools Octant has not named.

Claude Code's default replaces the checklist with the task tools, and Octant
leaves that default alone: `CLAUDE_CODE_ENABLE_TASKS` is not set (maintainer
decision, 2026-11-14). The task panel keeps reading whole lists. The driver
keeps each session's list across its turns and applies each task tool call
when its result arrives, because the runtime assigns a task's id and returns
it only in the structured result (`tool_use_result`): `TaskCreate` adds the
task it names, `TaskUpdate` applies a successful update (a `deleted` status
removes the task), `TaskGet` refreshes a task the list holds, and `TaskList`
replaces the list. After each change the mapper restates the whole list as
`task-progress` events and a closing `task-list`, the shape a `TodoWrite`
call produces, so the panel, the journal, and replay are unchanged. A failed
call, a result without its structured output, or an update to a task the
session never saw changes nothing; no id is ever guessed. The list itself
lives outside the transcript, in `<config>/tasks/<session id>/<id>.json`
(each file a task with `id`, `subject`, `description`, `status`, `blocks`,
and `blockedBy`), so a session that opens or resumes reads that folder and
its first turn opens with the whole stored list. The files are untrusted:
only that session's folder is read, symlinks are refused and task files are
opened without following one, a list holds at most 256 tasks of at most
64 KiB each and 1 MiB in all, and every task must match Claude's schema.
Anything else refuses the whole list with a logged reason, and the panel
starts empty until the next task tool call. A task Claude marks `_internal`
is left out, as `TaskList` leaves it out. Where the runtime still offers
`TodoWrite`, it maps as before, and threads journaled from it replay as
they did.

### Native plan capture

A Plan session runs in Claude Code's own `plan` permission mode, which ends a
plan by calling `ExitPlanMode` with the plan's text. Plan holds that tool and
nothing that changes mode: `EnterPlanMode` stays withheld, and so does
`ExitPlanMode` outside Plan (maintainer decision, 2026-11-14). When the call's
transcript block arrives, its `plan` becomes the reply's own paragraph under a
**Proposed plan** heading, with no tool row. The `PreToolUse` hook then
refuses the call with "The plan was captured and shown to the person; wait
for the person", and `canUseTool` refuses it too, since no grant was
recorded. Claude Code's own answer to an approved `ExitPlanMode` switches the
session to a mode that edits; refused, the session stays in `plan` and the
turn ends. The person accepts the plan by moving the thread out of Plan, so
Plan stays read-only throughout. Octant's thread plan (the person's
structured proposal) has no path from a provider, so the plan stays reply
text (not built yet: a provider-proposed thread plan).

`EnterWorktree`, `ExitWorktree`, and `REPL` left the withheld list
(maintainer decision, 2026-11-14) and take the rule for a tool the gate has
no rule of its own for, which is the shell's: Guarded asks, Reviewed's
reviewer decides, Full access runs without asking. Plan withholds all three.

- `REPL` runs code in Claude's own process, outside the command sandbox and
  the secret guard. Its start carries a journaled `tool-progress` note that
  marks the call unsandboxed.
- A worktree switch moves the session's working directory. Without `path`,
  Claude Code 2.1.211 creates the worktree under `.claude/worktrees/` of the
  repository that holds the working directory. The gate accepts a call from
  that directory when it lies inside the Project's folders, or inside a
  worktree outside them that the session was let into: once a switch into a
  worktree outside the Project's folders is allowed (the person or the
  reviewer below Full access, unasked at Full access), the session holds it,
  and calls there meet the same rules as the Project's, the secret guard
  included. A worktree a configured hook creates elsewhere is not known
  before the call, so calls from it are refused. The command sandbox's
  folders are fixed at launch, so below Full access a command cannot write in
  an outside worktree.
- The thread stays bound to its checkout. Octant's file views, diffs, and
  change review stay on the original checkout: the switch's start carries a
  journaled `tool-progress` notice that says so. A worktree inside the Project
  shows its files under the worktree's folder there; an edit in a worktree
  outside it is journaled as its tool step with no file change or diff.

At Full access the file gate allows any path, outside the Project's folders
and the secret guard's list included, as Claude Code does on its own
(maintainer decision, 2026-11-14); an edit outside the checkout is journaled
as its tool step with no file change or diff. Below it, a file tool call
(`Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, or any tool that
names a path) whose target is outside the Project's folders asks through the
gate at Guarded and Accept edits and goes to the reviewer at Reviewed, as
Claude Code asks on its own (maintainer decision, 2026-11-14): a read there
never runs unasked and Accept edits never waives an edit there, and an
approved edit there is journaled as its tool step with no file change. Every
secret-path refusal stays below Full access, so a protected file outside the
Project is refused, not asked. Plan refuses an outside path, since Plan cannot
approve anything; a Full access thread that kept its sandbox keeps the
Project's folders; and an Artifact publish stays held to the Project. A shell
command's folder is still checked against the Project's folders, and the
command sandbox keeps its own folders, so below Full access a sandboxed shell
command cannot reach an outside folder. Redaction of logs, the journal, and
exports applies at every level.

Below Full access Claude's command sandbox lets a command out the way Claude
Code does on its own (maintainer decision, 2026-11-14): the launch sets
`sandbox.allowUnsandboxedCommands: true` (the bundled SDK 0.3.211 and Claude
Code 2.1.211 name it so; when false the runtime ignores the flag), and a
`Bash` call with `dangerouslyDisableSandbox: true` runs outside it. Every
such command asks through the gate at Guarded and Accept edits and goes to
the reviewer at Reviewed, who sees the flag among the judged fields; a
remembered answer never covers one, so each asks again. Its start is
journaled with an "Unsandboxed" notice. Plan refuses it, since Plan's
commands never leave its sandbox: the flag is set only at Guarded, Accept
edits and Reviewed, a Plan launch carries no Claude sandbox at all (its
commands run inside Octant's own profile, where no flag reaches), and the
SDK port refuses a Plan or Full access launch whose sandbox would let a
command out, so the hook's refusal is not the only guard. Ordinary commands stay sandboxed, the
secret-path refusals still apply to the file tools, and at Full access
nothing changes: no command is sandboxed there, and a thread that kept its
sandbox at Full access keeps `allowUnsandboxedCommands: false`.

Below Full access outside Plan, a call the gate would ask about and that
passed every Octant refusal (the secret guard and folders the session does
not hold) is answered with no decision, so Claude Code's own
permission rules run first: the person's `permissions.allow`, `ask`, and
`deny` decide it, and only a call they leave to ask reaches `canUseTool`,
where Octant raises its approval or Reviewed's reviewer decides (maintainer
decision, 2026-11-14). In a Project the person trusted for Claude Code, the
allow rules committed in its `.claude/settings.json` count as the person's own
rules, as they do in Claude Code once its folder trust is accepted: trusting
the Project is the person adopting them. An untrusted Project's settings
never load, so its rules allow nothing. A question (`AskUserQuestion`), an Artifact publish,
and a wake-up keep Octant's own ask, because each needs an answer only Octant
gives, and so does a `Workflow` start, whose script runs as JavaScript in the
runtime process outside the command sandbox. So do a file tool naming a path outside the folders the session holds,
which asks as Claude Code does on its own and goes to Reviewed's reviewer, and
a switch into a worktree outside them, which the session holds only once
`canUseTool` sees the switch allowed. Plan keeps Octant's ask for everything. A call the person's rules
allow never meets `canUseTool`, so its grant is released when its result
arrives. Rationale: the bundled runtime skips its allow-rule check when a
hook forces "ask", so a call the person had allowed in their own settings
used to become an Octant approval anyway. The command sandbox keeps
`autoAllowBashIfSandboxed: false`, unlike Claude Code's default: running a
sandboxed command unasked would end Guarded's approval for each command and
Reviewed's review of it, which are built features; a person who wants a
command to run unasked writes an allow rule for it. Below Full access the
sandbox sets `allowUnsandboxedCommands: true`, so a command the sandbox
stopped (a push that needs `~/.ssh`, a `gh` call that needs its config) may
be retried outside it with `dangerouslyDisableSandbox`; the gate always
answers that retry with Octant's own ask, never the person's rules, and its
approval reads "Bash outside the sandbox". Full access with its sandbox keeps
the retry off. Each sandboxed launch carries the `user.name` and
`user.email` git resolves in the checkout (`git config --includes --get`, so
every scope and any `include` or `includeIf` file counts) as `GIT_AUTHOR_*`
and `GIT_COMMITTER_*`, since the sandbox cannot read `~/.gitconfig` ([Architecture: Git and pull requests](../architecture.md#modes-chat-work-and-code)).

A call's working directory follows the session, as it does in Claude Code:
after `cd apps/web` the hook names that folder, and the gate accepts any
working directory inside the folders the session holds (the Project root,
its extra folders, everything beneath them, and a worktree the session
was let into), judging a shell command or
a search with no folder of its own there. A working directory outside them
is refused (maintainer decision, 2026-11-14). Rationale: the port used to
refuse every hook whose working directory was not the Project root, so one
`cd` into a subfolder refused every later call of the turn.

Where Octant reads a `CLAUDE.md` itself (a Project the runtime may not read
because it is not trusted), it expands the file's `@path` imports as Claude
Code does (maintainer decision, 2026-11-14): a relative import resolves from
the importing file's folder and `@~/` from the home folder, an import in a
code span or fenced block stays text, a file is loaded once so a cycle ends,
and imports stop five hops from the first file, past 32 files, or past
256 KiB, the cut said as truncated. Only a file inside the Project's folders
or the account's config folders is read, judged at the path it resolves to,
so a symbolic link out of them is refused. The instruction-file reader above
expands every file it reads this way, each import meeting the same size,
text and secret-guard checks as the file that names it before it is opened.

A turn has no tool-call cap. The gate remembers at most 256 tool-use ids and
forgets the oldest settled ones past that; ids still pending or holding a
grant are never forgotten. At most four approvals are put to the person at
once, one question set at a time, and sixteen pre-tool grants are held; a
call past any of these waits in line for a free slot instead of failing the
turn (maintainer decision, 2026-11-14), and a call still waiting when the
session ends is refused with the rest. A grant frees when its call reaches
`canUseTool`, its result arrives, or it expires. The line is bounded by the
256 remembered ids. A repeat of a forgotten id passes the whole gate again.
Rationale: the earlier caps of 64 calls a turn and 256 a session failed long
turns that Claude Code runs to the end in its own app, and failing at the
fifth approval or the seventeenth waiting call let parallel subagents end a
turn.

#### Image input

Claude reports `nativeAttachments` as `supported` when its catalog has a model
that takes images, which every Claude model does (maintainer decision,
2026-11-14: it was `unsupported`). A turn's image attachments go to the
runtime beside the message text as base64 `image` content blocks in the
streamed user message; JPEG, PNG, GIF and WebP are the types the Messages API
takes, and a turn with any other image type is refused before it is sent.
Work, Code and Chat admit attachments by this capability as they do for
Codex and OpenCode.

#### Background commands and runtime-started turns

`Bash` with `run_in_background` and `Monitor` command watches run outside
Plan (maintainer decision, 2026-11-14: Octant adds capabilities to a
provider and never takes its core features away). Claude Code reports each
as a `local_bash` task: the decoder reads its `task_started`,
`task_updated`, `task_progress`, and `task_notification` frames (a
`skip_transcript` hint included) and the mapper shows each as a
`task-progress` row, as it does a subagent's. When such a task ends, or a
watch prints a line, the runtime wakes the model and starts a turn by itself.

In Work and Code the session outlives its turn (maintainer decision,
2026-11-14; Work, a maintainer request on 2026-11-15, under the shared
capability set). The turn completes when the model's reply is done; the
background tasks keep running and show as live tasks above the thread's
composer, with Stop. The host keeps the session (`OutlivingSessions`, one
keeper for Code threads and one for Work threads) and starts every Work and
Code session with `outlivesTurn`, which tells the driver not to hold the
turn. When the runtime then starts a turn by itself while the thread is
idle, the driver holds that turn's events, and every one of its tool calls
waits unanswered (Full access's unasked allow included, and refused if the
session stops first), until the host opens a runtime-started turn for the
thread: an ordinary turn of the thread's mode started as the host at the
thread's own level, whose recorded prompt says why it exists and is never
sent. That turn reattaches to the kept session with `attachRuntimeTurn`
instead of sending, reads the held events from their `runtime-turn-started`
event (`trigger: "background-task"`), and is journaled and replayed like any
other turn: in Code the frame keeps the runtime as its origin; in Work the
turn is journaled as the system's with the host's fixed prompt, carries no
sibling thread's messages, and is refused unless it takes up the session the
thread's last turn left. A Work session is kept per provider session, folder
and extra folders, and the Work request runtime answers a kept session's
approvals and Shield reviews for whichever turn holds it when the call
arrives. A turn the runtime finishes before the host attaches still waits,
its events held, and is read whole on attach; a second turn the runtime
starts before the first was attached stops the session, because one attach
reads one turn. A person's send is refused while such a turn waits to be
opened, and a turn needing a session started differently (another level,
model, or tool set) stops the kept one, and its tasks, first. Between turns the runtime's
own task frames are not shown in any turn; a task's end only changes the
live tasks.

The kept session is always stopped, never orphaned: when its last task has
ended and no turn runs (after up to 5 seconds for the turn the runtime
starts for that task's end, which reaches the host first), when the person
stops the thread (Stop on the live tasks, or in Code a Stop with no turn
running), when the person changes the thread so it would start a session on
other terms (its level or how asks are answered, its provider or model, its
checkout or folder, or for Work its Project binding, working folder or
working directory) or archives, moves, marks Done, or deletes it, or when the
thread's Project is relinked, archived, or loses an extra folder or the
thread's working folder, read from the journal (a Project change touches no
thread, so every kept session of that Project is judged again against the
Project as the append committed it; Work reads the thread from the committed
change itself, since its thread projection is applied only after the journal
tells its listeners and reading it there missed a level just lowered), so a
session never goes on acting at the level it launched with or reaching a
folder its Project no longer grants,
after the background work limit with no turn in the thread (a host setting:
2 hours by default, Off for no bound), when the host cannot open the
runtime's turn (the thread was archived, or stayed busy for 20 tries), when
the turn the host opened has not taken the session up within 60 seconds,
when a turn ends without settling its session, before a requested compaction
resumes the same native session on a connection of its own (so two processes
never write one history, and the next turn resumes what the compaction left),
and at shutdown. A session is held to the Project as it stood when its turn
took its folders, read in the same step, so a folder removed while the turn
starts makes the session's terms differ and it is not kept. A session being
stopped stays in the way until its runtime and tasks are gone: the thread's
next turn waits for it rather than resume the same history on a new
connection, and a second Stop answers once it has stopped; shutdown waits for
it too. A turn the person sends on a kept session carries the lifecycle of the
background tasks the earlier turns started, as a runtime-started turn does,
so a task's progress and end still name the row its start opened; the turn's
own call and checklist state starts afresh, and approvals, questions and the
task list live on the session. A runtime-started turn sends nothing, so it acknowledges nothing as
sent: it carries no fork merged back into the thread and journals no delivery
for one (the merge goes with the person's next turn), it leaves the
held-context record as the session's last sent turn left it, so no standing
block it would have carried counts as held, and it counts no context copy of
its own. It opens only on the session the thread's last turn left, as it
stands: a thread with no turn of its own yet, or one whose next turn would
need a provider switch, a rewind or a fork handoff, refuses it before
anything is journaled. A
runtime-started turn holds at most 1,024 events before it is opened; the
event past that stops the session at once and the host's attach is
refused. Rationale: settling the person's
turn keeps a dev server from holding it open forever, and opening the
runtime's turn through the thread's ordinary admission reuses the gate, the
journal, the stop and replay unchanged rather than adding a turn kind.

Other callers (a child run, a single-use session) still keep the earlier
lifecycle: a session lasts one person's turn, so the driver holds that turn
open instead of letting such a turn start after the runner has stopped the
session. When the runtime's result arrives while a background task the turn
started still runs, or before the runtime says it is idle, the completion is
held. Each turn the runtime then starts is folded into the person's turn,
opened by a `runtime-turn-started` event (`trigger: "background-task"`); its
tool calls pass the same gate at the same level, and its result replaces the
held completion. Its tokens and cost are added to what the person's turn used
before it, so each usage report still covers the whole turn; its cost is
measured from the session total at the result before it. A state the runtime
reports before it initializes is kept, so it still counts as reporting. The completion goes out once no background task runs and
the runtime has gone idle (`session_state_changed`, which the port asks for
with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`; a runtime that never reports
its state is taken as idle after each result, and only a task's end makes it
wait again). Code journals the event as the operation's
`runtime-turn-started` frame, and the transcript's summary line says the
turn continued after background work. Chat and child runs fold the runtime's
text, tool steps, and task rows into the person's turn without a separate
marker (not built yet).

The hold is bounded. The stalled-turn limit counts its silence as it counts
any other; the person's stop ends it, and on an idle runtime the driver
reports the turn interrupted and stops the session, which ends every
background task in it. Below Full access, past the person's count of turns
the runtime may start by itself (Settings › Permissions › Tool steps, **Turns
a runtime starts by itself**, `runtimeTurnsPerTurn`, 1 to 4,096, default 256;
a fixed 16 until the maintainer decision of 2026-11-14), the person's turn
completes and the session is stopped; at Full access there is no such count.
A held turn takes messages (maintainer decision, 2026-11-14): a message the
person sends while a turn is held, through the driver's `send` or `steer`,
is delivered into it, the runtime answers it in a turn folded in as
`runtime-turn-started` with `trigger: "person-message"` (never counted), and
the held completion waits for that answer. A message sent while a turn the
runtime started is still open marks nothing, since that turn was already
opened and counted as background work, so a later background start is never
labelled as the person's. A steered message goes in as text, the turn's
context inline as on a runtime without the prompt hook; one that carries
images is refused with a reason (send them once the turn ends) rather than
sent without them. `steer` answers `unsupported`
when no turn is held, and the thread's message queue keeps the message for
the next turn as it does for any running turn. A `Monitor` call that asks for a WebSocket (opened by the
runtime process, outside the command sandbox and its network rules) or a
watch for the whole session is refused before the gate. Plan keeps its
read-only commands in the foreground: `run_in_background` is refused there.

#### Workflows

`Workflow` runs outside Plan in a session whose person's setup has subagents
on (maintainer decision, 2026-11-14). The call returns at once and the
workflow runs in the runtime as a `local_workflow` background task, so the
held turn above holds the person's turn until it ends, and the runtime's turn
for its result is folded in the same way. The decoder reads its
`task_started` (`workflow_name`; the script in `prompt` is never kept) and
the `workflow_progress` list each `task_progress` restates, reading only each
`workflow_agent` entry's index, label, state (`start`, `progress`, `done`,
`error`), and last tool. The mapper shows the workflow as a child run whose
id is its `Workflow` call's, and each agent as a child of it
(`parentChildAgentId`), through the same child-run display a subagent
`Agent` starts; only an agent whose state or last tool moved is shown again.
Each agent's own tool calls reach the gate as a subagent's do (the runtime's
permission callback names the agent), at the thread's level. Starting a
workflow asks below Full access, unlike `Agent`: its script runs as
JavaScript in the runtime process (a Node `vm` context, Claude Code 2.1.211),
so the person sees the script before it runs. A `remote` workflow, which a
cloud session would run on a clone of the Project, is refused before the
gate, and a `remote_agent` task stays an unsupported frame. Rationale: a
workflow is a batch of subagents, so the subagent switch, display, and gate
cover it unchanged, and the held turn covers its background lifetime.

#### Fork and rewind

A Code fork or rewind continues a copy of Claude's own session rather than a
text handoff where it can (maintainer principle, 2026-11-14). Each completed
turn reports the transcript id of its last assistant message (the
`SDKAssistantMessage.uuid` the Agent SDK documents for `resumeSessionAt`),
which the host journals as the turn's native anchor. The driver's
`forkSession` calls the SDK's own `forkSession(sessionId, { dir,
upToMessageId })` under the account's directory, which copies the
transcript through that message with fresh ids and leaves the source alone,
records the copy's resume identity for the new Octant session, and returns
its cursor; the turn then resumes it as any session. Claude keeps a session
under its folder and resume looks there, so a copy is made only for the
source's own folder, mode and sign-in: a fork onto its own worktree, a turn
with no anchor, or a failed copy goes back with the text handoff
([Architecture: native session anchors](../architecture.md#native-session-anchors)).
`rewindFiles` is not used; files go back through Octant's checkpoints.

#### Plan mode as level changes

Claude Code's own plan-then-approve works in Code (maintainer decision,
2026-11-14). The thread's level stays the server's: the runtime never
switches its own permission mode. A Code session starts with
`levelChanges`, and then outside Plan holds `EnterPlanMode`; a Plan
session's `ExitPlanMode`, which Plan holds to hand its plan over (see
[Native plan capture](#native-plan-capture)), is then asked rather than only
refused. Each call is put to the person at every level, Full access
and Plan included, as an `approval-request` with `levelChange`
(`enter-plan`, or `exit-plan` with the plan, at most 32,768 characters);
the person's own permission rules never answer it, and Octant Shield never
reviews it. The call itself is always refused with what the person decided.
Code journals the ask as an `approval-requested` with action `level-change`,
the level it would move to, and the plan as evidence. On approval the host
changes the level through the thread's ordinary access command, for the
window that approved and journaled as the person's like any level change,
then ends the turn that asked: Plan's read-only rule rests on the tool set
and sandbox profile a session launches with, so the new level applies from
the next turn's session and never inside the one that asked. A kept session
started at the old level is stopped before that turn too. The level an
approval applies is worked out when the person answers, from the thread as
it is then, so a level lowered while the ask was open is the one a plan
returns to. Entering Plan
records the level it left as the thread's `planReturnPolicy` (Full access
is recorded as approval-gated, because only the person chooses Full access),
and an approved plan returns the thread there, or to approval-gated when the
person put the thread in Plan. A declined ask leaves the level and the turn
as they were. Chat and child runs do not answer level changes yet, so their
sessions hold neither tool. Work does not either, and by rule rather than as
a gap: both asks move a thread into or out of Plan, and Work has no Plan
([Guardrail levels](decisions.md#guardrail-levels)). Building them for Work
first needs a Plan level in Work, a change to that decision; until then a
Work session holds neither tool and the runtime cannot change its own mode. Changing the level inside the running turn, through the runtime's `setPermissionMode` as Claude Code does on its own, is decided and not built yet (maintainer decision, 2026-11-14): the port exposes the control, but a session's launch profile and tool set would still be the old level's, so the turn ends until a session can change them in place.

#### Sessions started outside Octant

An empty Code thread can continue a Claude Code session the person began
outside Octant, in the same folder on the same account (maintainer decision,
2026-11-14). The driver's `nativeSessions` lists the account's sessions
whose own folder is the thread's (the SDK's `listSessions` under the
account's configuration folder, as the resume lookup reads it), newest
first, at most 50, leaving out any session an Octant thread already resumes:
adopting one would point its resume record at another thread and strand the
first. The check and the resume record it then writes are one step for each
session: two threads adopting the same session at once take turns, and the
second is refused. Each carries its title (the name the person gave it, or the runtime's
summary of its first prompt) and branch for the picker only; a resume lookup
never reads the title, and nothing journals it. Adopting writes the same
resume record a session Octant started writes (`ClaudeResumeIdentity`, with
the thread's new Octant session id, the folder, the model and the sign-in)
and answers the bound resume cursor, so the thread's next turn resumes it
through the ordinary exact-resume checks. The host journals the adoption in
an operation of its own that holds no turn: `native-session-adopted`, naming
only the runtime's session id, then the `provider-session-ready` with the
cursor. The session read things Octant never saw, so the thread is marked as
carrying outside content (`adopted-provider-session`) before anything is
journaled; a thread that cannot be marked is not adopted. Only the person
adopts: a window on the host or the host's own paired device, over a Project
it can open, never the host acting for a routine; a client this host has not
paired is refused before anything is read. A thread with a message or a
session of its own is refused, and so is one with a turn admitted or
running. While the adoption runs, a message sent to the thread is refused
with a note to send again when it finishes, and the adoption checks again
that the thread is empty just before it journals: a turn let in meanwhile
would journal its own session, and the adopted one written after it would
be the one the next turn resumes, dropping that conversation. The driver
claims the session (its resume record) before the thread journals the
adoption, so an adoption the thread then refuses (it changed meanwhile, or
could not be marked) gives the claim back through the driver's `release`,
which removes the record only while it still names this adoption's Octant
session; the session is offered and adoptable again. The adoption's two
events are journaled as one unit, so a claim given back never leaves half an
adoption behind. Just before it journals, the adoption reads the thread again
and refuses (giving the claim back) when its provider, model, Project binding,
checkout or folder changed while the provider was asked: a session journaled
for a checkout the thread no longer has could be taken up by neither a send
nor another adoption. A session still open in a terminal is not
detected; continuing it in both places writes two branches of one
conversation.

An empty Work thread can continue such a session the same way (maintainer
request, 2026-11-15), under Work's own folder rules rather than a checkout:
the folder listed and adopted is the one the thread's turns run in, the
Project's approved folder for the thread with its working directory
resolved inside it, never a folder the caller names. Only an active Work
thread with no turn, not marked Done, on this computer (a server Project's
thread is refused), on its Project's current binding, in a Project the
caller holds, is adopted, and only by the person, as in Code. Work has no
operation journal, so the adoption is recorded on the thread
(`adoptedSession` in a `work.thread-updated@1`): the runtime's session id,
the new Octant session id and its resume cursor, and the provider, model,
binding, working folder and working directory it was adopted under, after
the thread is marked as carrying outside content (`adopted-provider-session`).
The thread's first turn resumes that session only while all of those still
match; a thread moved to another provider, model or folder before its first
turn is refused with a sentence saying so, rather than starting fresh and
dropping the conversation. While a Work adoption runs, a message sent to the
thread is refused with a note to send again, and the adoption checks again
that the thread is empty just before it journals. The driver claims the
session (its resume record) before the thread records the adoption, so an
adoption the thread then refuses (it changed meanwhile, or could not be
marked) gives the claim back through the driver's `release`, which removes
the record only while it still names this adoption's Octant session; the
session is offered and adoptable again. Just before it records, a Work
adoption also reads the Project again and refuses (giving the claim back)
when its binding, root or the thread's approved working folder changed while
the provider was asked; a change to the thread itself is refused by its
version. A rewind that removes every turn the thread ran also leaves it with
no turn, but its adopted session still holds them: that session is never
resumed again, and the thread's next turn starts a fresh one, as a Code thread
rewound to its first message does. Its picker and details row
are Code's, above the Work composer.

#### Wake-ups the model schedules

`ScheduleWakeup` (a delay, held to one minute to one hour), `CronCreate` (a
five-field cron expression in local time, once or recurring), `CronList`,
and `CronDelete` run in Work and Code outside Plan (maintainer decision,
2026-11-14), answered by Octant and never run by the runtime. A session
lasts one person's turn, so a wake-up the runtime keeps in memory would die
with it, and a `durable` one is written to the Project's
`.claude/scheduled_tasks.json` and fires in whatever later session opens
there. The host therefore hands each session a wake-up schedule for its
thread (`ProviderSessionStart.wakeups`), and the driver answers each call
from it: a wake-up passes the gate as any built-in tool does, asking below
Full access, and then the driver records it with the host and returns the
runtime's result fields (`scheduledFor`, `clampedDelaySeconds`, `wasClamped`;
or `id`, `humanSchedule`, `recurring`) in the refusal's text, because the
runtime's permission callback and `PreToolUse` hook can only allow or refuse
a call. The runtime runs none of these calls, so its scheduler never holds a
wake-up and no file is written. The mapper shows such a call as done, not
failed. Listing, deleting, and `ScheduleWakeup`'s `stop` act only on this
thread's own wake-ups and answer without asking. Rationale: importing a
`scheduled_tasks.json` the runtime wrote would leave a window in which a
later session could fire it before Octant read it, and a session-only
wake-up would still sit in the runtime's scheduler of a held turn; answering
the call leaves the runtime nothing to fire.

The host's side, a `thread-wakeup` aggregate of its own, owns everything
after that ([Architecture: wake-ups](../architecture.md#modes-chat-work-and-code)):
each wake-up is journaled, listed above the thread's composer with its next
fire time and Cancel, and starts a turn in its thread at its time. Chat runs
in Plan for Claude, so a Chat thread never holds these tools, and neither
does Plan or a single-use session.

#### Code Mode

Claude Code's Code Mode is a recorded gap, not a refusal (maintainer
decision, 2026-11-14; designed, not built). It runs only in an interactive
terminal session, which an Agent SDK launch is not, and it refuses to start
while `DISABLE_TELEMETRY` is set, which every Claude launch of Octant's sets
(the one lift is the Claude artifacts launch above, which the person chooses
because it sends usage telemetry). Octant adds no terminal mode to carry it
and makes no telemetry exception for it: provider telemetry stays off as a
hard line. Once the Agent SDK supports Code Mode, Octant offers it under the
same gate and level as Claude's other tools. The `REPL` tool, which runs code
in Claude's own process, is already offered outside Plan under the shell's
rules (see [Native plan capture](#native-plan-capture)).

## Codex

Below Full access every Codex app-server runs under Octant's profile, and the
[confinement matrix](../architecture.md#security-and-authority) owns what that
profile allows and why. The wire mapping that follows from it:

- A process carries one lease: a thread's root, mode, and posture, or a catalog
  lease for account and model reads. The driver leases it when a connection's
  first `thread/start` or `thread/resume` names the posture, and refuses a
  different posture on the same connection as `unauthorized`.
- `thread/start` keeps `sandbox: "read-only"`, and every `turn/start` sends
  `sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" }`.
  macOS refuses Codex's own Seatbelt inside Octant's, so Codex is told the
  sandbox is outside it.
- Auto (approval-gated with `autoApprove`) runs as Codex's own Auto:
  `approvalPolicy: "on-request"` with `approvalsReviewer: "auto_review"`
  (maintainer decision, 2026-11-14). Codex's own Auto pairs that with its
  workspace-write sandbox; here the sandbox is Octant's profile, named
  external. Under an external sandbox `on-request` runs a command without
  asking unless Codex flags it as dangerous, and applies an in-root patch
  without asking (codex-rs `exec_policy.rs`
  `render_decision_for_unmatched_command_for_platform` and `safety.rs`
  `assess_patch_safety`, rust-v0.169.0); whatever still prompts goes to the
  reviewer. So a command runs unasked inside Octant's wall, as it runs
  unasked inside Codex's own sandbox in Codex's own Auto. When delegation is
  withdrawn (outside content, capability), the turn runs as Ask first.
- Not built yet: a command that needs to leave Octant's wall asking for it,
  as Claude's sandbox escape does. Codex cannot raise that ask under an
  external sandbox: `exec_policy.rs` prompts for a `require_escalated`
  command only under a restricted sandbox and allows it unasked under an
  external one, its sandbox bypass removes only Codex's own sandbox, which is
  not running, and `orchestrator.rs` never retries a denied command without
  the sandbox under `on-request` (rust-v0.169.0, unchanged on the main
  branch read 2026-11-15). Such a command fails at the wall. Carrying the ask
  needs Codex to escalate under an external sandbox, or a launch where Codex
  sees a restricted sandbox without starting its own Seatbelt.
- Ask first (approval-gated without the reviewer) and Accept edits
  (auto-accept-edits) send `approvalPolicy: "untrusted"`, the strictest mode
  Codex has, matching the strictest mode elsewhere. Under an external sandbox
  `on-request` would run every command without asking; `untrusted` asks for
  each command Codex does not know to be read-only and for every patch. On an
  auto-accept-edits thread the driver answers each file-change request itself,
  so the person is asked for commands and not for patches; one that also
  carries `autoApprove` still reads as Accept edits, keeps `untrusted`, and
  hands its prompts to the reviewer. Plan and Chat keep `never`, so a write
  fails at the profile rather than at a prompt.
- Full access keeps `danger-full-access` and an unwrapped process.
- A Plan session runs in Codex's own Plan mode: every `turn/start` carries the
  experimental `collaborationMode` with `mode: "plan"` and settings naming the
  model, `reasoning_effort`, and `developer_instructions: null` (the
  connection opts into experimental fields at `initialize`; `null` asks for
  Codex's built-in Plan instructions, and the mode restates the model and
  effort because it takes precedence over both; read at `rust-v0.169.0`,
  present since `rust-v0.155.1`). Codex then plans as it does on its own: it proposes its
  plan in a `<proposed_plan>` block, reported as a plan item, and may ask
  through its question form, which Codex offers only in Plan mode. The mode
  only instructs the model, so Plan's read-only profile and its declined
  approvals are unchanged (maintainer decision, 2026-11-14). Codex keeps a
  mode for the thread's later turns, so a session outside Plan that resumes a
  thread whose `thread/resume` reports `collaborationMode.mode: "plan"` sends
  `mode: "default"`; any other session sends no mode and runs as before.
- A plan item becomes the reply's own paragraph under a **Proposed plan**
  heading when it completes; its deltas are not shown, so the plan reads once.
  The person accepts it by moving the thread out of Plan. Octant's thread plan
  (the person's structured proposal) has no path from a provider, so the plan
  stays reply text (not built yet: a provider-proposed thread plan).
- `item/tool/requestUserInput` reaches the person as the thread's
  questionnaire, one request per question with its choices, in order; when
  every question is answered Codex gets one reply mapping each question id to
  `{ answers: [text] }`. Codex adds a free answer to each question itself,
  so a typed answer passes through. A set with a question Codex marks
  `isSecret`, or that asks for a password, passphrase, API key, access token,
  or private key, is never shown: Codex is answered at once with a refusal
  telling the model Octant does not collect secrets in chat. A subagent's set
  (Codex offers the form to the root thread only) is answered empty. The
  capability is reported `supported`.

The installed OpenCode binary's
version selects its routes: 1.x keeps the legacy session API and its
per-session permission ruleset. 2.x accepts no per-session ruleset, so each
launch writes its session posture — the same rules in 2.x action names
(`shell`, `subagent`), every namespaced tool and skill denied, and only that
connection's app-managed tool bridge allowed — into the private
configuration, where OpenCode appends it after every agent's built-in rules
(its default agent otherwise allows everything); a launch that names no
posture denies all. File reads (`read`, `glob`, `grep`, `list`) are allowed
at every level on both versions, Plan included, so OpenCode reads inside the
Project and its extra folders without asking, as Octant's Claude Code file
gate does. `external_directory` asks for every other folder below Full
access, on 1.x, 2.x, and the ACP launch's configuration alike, is allowed at
Full access, as OpenCode allows it on its own, and stays denied in Plan, which
cannot approve anything (maintainer decision, 2026-11-14); the protected-file
refusals below still apply. Below Full access the launch's OS sandbox still
holds writes to the Project's folders, so an approved edit outside them fails
there. The outside-folder rules come after the person's own rules and the
namespaced-tool deny, whose `*_*` also matches `external_directory`. Under the
catch-all `ask` they had asked at Guarded and never ran in Plan, which
cannot approve anything (maintainer decision, 2026-11-14). Refusals come last
so nothing reopens them: OpenCode's own `.env` refusal (its default agent's
rules come before Octant's, so the read allow would otherwise lift it), and,
for `read` and `list`, each entry of Octant's protected-file list in force
(`openCodeProtectedReadRefusals`), a name pattern refused as its whole folder
since OpenCode's wildcards cannot say a regular expression. At Full access
the secret-path refusals do not apply, as for Octant's own file tools: only
the Provider sign-ins group stays refused there, on 1.x and 2.x alike, still
last, and the person's added paths and every other group are readable
(maintainer decision, 2026-11-15). The host narrows the list
(`protectedAtLevel`) and passes the driver both lists, below and at Full
access, as plain paths; the driver only picks one by level and imports no
host policy. A Full access launch
runs outside Octant's sandbox, so no OS rule narrows with it; one that kept
its sandbox keeps the Accept edits wall and its whole OS deny list. Plan also allows
OpenCode's other read-only tools without asking: `todowrite`, `todoread`,
`codesearch`, `lsp`, `webfetch`, and `websearch` (maintainer decision,
2026-11-14). A web read or code search still marks the thread as outside
content, as in Work and Code; edits, the shell, delegation, and outside
folders stay denied, and the person's own deny rules still apply. 2.0.22 answers the 1.x `POST /mcp` registration with
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
every mode there. On Linux (maintainer decision, 2026-11-14) 2.x runs turns
in Work and Code outside Plan, at Ask first, Auto, Accept edits and Full
access, where the launch already allows a shell; a Chat or Plan launch is
refused before it starts with a sentence naming why, and the probe attests
the Code jail at Ask first and reports `turnModes` with Chat and Plan
unsupported (`host-confinement`), which the provider's Settings page shows
as where it runs turns. Rationale: Linux confinement can only deny
fork outright, so it cannot give Chat and Plan the one `git` exec the
stand-in needs, while Work and Code outside Plan launch with a shell anyway. 2.0.22 names its turn events without the `session.next.`
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
is `{decision}`. An approval is answered `once` unless approvals are
remembered for the Project and the person let OpenCode run as itself
([Key providers](#key-providers)): `always` saves a grant in OpenCode's data
directory, which it shares with the person's own use, outside Octant's
revocation. Then it is answered `always` (built): the answer is journaled
like any other, and the approval's description says the grant lives in
OpenCode's own settings for the repository, where clearing it is the way to
revoke it. OpenCode then makes later matching edits without asking and
settles other pending requests the grant covers, so the files an `always`
answer names, and those of a request OpenCode settled by itself, stay
admitted by the file-change check for that Project root while the host runs;
after a host restart such an edit fails the turn until it is approved again. Approval-gated on
2.x honours permission grants the person saved in OpenCode itself for the
same repository: OpenCode keys them by the repository's root commit, keeps
them in its own data store (shared with the person's own use because
provider credentials live there), and applies them as allow after Octant's
rules. Octant's denies still win, so Plan's denials hold (Work's shell
and subagents follow the level as Code's do), and Octant itself never writes such a grant because
it answers approvals `once`. With the setup on, the person's OpenCode rules
apply over Octant's level rules, with Plan and a mode's withheld tools still
Octant's denies and the outside-directory ask below Full access still
Octant's (built). Octant reads the
`permission` rules (and the 2.x `permissions` list) from the person's
OpenCode configuration when a session starts, in the order they wrote them,
and places them ahead of the level's first deny. It drops a bare catch-all
rule, because only the guardrail level may lift a whole thread, and the
rules for `external_directory`, `question`, `skill`, and `*_*`, which Octant
owns. An edit their rules allow for a file is admitted by the file-change
check, as OpenCode itself would make it; a shell command allowed this way
runs without an approval card and without Reviewed's reviewer. Clearing the
saved grants or the rules in OpenCode restores the prompts. A 2.x reject settles every pending request
in the session, so each settled request is forgotten. With the setup on, the
MCP servers in the person's own configuration (local commands and remote URLs,
at most 32) are written into the launch's private configuration and their
tools follow the level instead of being denied outright; a server's environment and
headers keep only a reference to a variable the host has (`{env:NAME}`), and a
server whose command line or URL carries a credential is left out, so the
secret stays where the person keeps it. Plan keeps them off, and Chat's confinement still applies to
what they run. Sessions OpenCode's `task` tool delegates to are followed from
their `session.created` event, which names the parent: each is shown as a
child run (starting, running, completed or failed), its permission and
question requests are handled as the parent's own, so the person answers them
at the same level and the reply goes to the child's session, and a web read it
makes marks the thread. Nothing else a child says joins the parent's
transcript. Questions reach the person through the same questionnaire 1.x
questions use (maintainer decision, 2026-11-14: Octant adds capabilities to a
provider and never takes its core features away). 2.0.22 serves no question
routes; its `question` tool publishes a `form.created` form marked
`metadata.kind: "question"` with one field per question, keyed `q0`, `q1`, ...
(the question as the description, its header as the title, its choices as
options), and takes the answer at
`POST /api/session/{id}/form/{form}/reply` as `{ answer: { q0: ... } }`
(read from the v2.0.22 and v2.0.27 source). A subagent's form is asked the
same way and answered in the subagent's own session. From 2.0.22 the written posture
allows `question` at every level, Plan included, since a question changes
nothing, and the capability is reported `supported`. An earlier 2.x release
keeps `question` denied, as before, so the model is told no and carries on
instead of the turn failing on a form Octant cannot map. A question asking for
several answers (a multiselect field) fails the turn as an unsupported
format, as on 1.x. A form with a question that asks for a password,
passphrase, API key, access token, or private key is never shown or
journaled: each of its fields is answered at once with the refusal Codex
gets, telling the model Octant does not collect secrets in chat. Any other form (a sign-in, a server's own request)
still fails the turn rather than hang on an unanswerable form. Resume,
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

File changes and runtime compaction are claimed only from 2.2.0, the
release whose server was read for them; an older 2.x release reports no file
changes and compaction `unavailable`, and 1.x reports compaction
`unavailable` and reports no file changes (not built yet: no 1.x
server was read). Reading a local 2.2.0 server with no prompt sent showed
the `file.edited` and `session.diff` events, `GET /api/session/{id}/diff`,
and `POST /api/session/{id}/compact`. A reported file change is held to the
grants described above, so the capability adds no authority: a change no
grant names still fails the turn. Compaction sends the route with
`delivery: "queue"`, which returns the queued item at once; the compaction is
reported by `session.compaction.ended` or `session.compaction.failed` and then
the idle that closes its run. The adapter holds the request open until that
idle and keeps it out of the turn mapper, so a compaction is never read as a
completed turn. `ended` is a compaction that happened and emits a requested
`context-compacted`; a `compaction.unavailable` failure (a session with nothing
to compact yet) is refused `nothing-to-compact` and attests the history was
left alone; another named failure says the same; a run that closes without a
report, a stop, or a lost runtime may have changed the history. A missing
route (404 or 405) is refused as too old, a refusal from the server is a
failure that changed nothing, and a lost answer is a failure that may have.
A turn is refused while a compaction is pending, and a compaction is
refused while a turn is running. Rationale: the narrower reading holds the
claim to the one release read, because the route and the completion events
differ between 2.x releases and a later one that changes them would otherwise
be trusted unseen. The summary and token figures were read only as event
shapes, never from a model run, so no before-and-after figure is reported.
A session carried on to another of the instance's models needs no further
work: every prompt names the thread's model (`modelSwitch`).

OpenCode's own slash commands are listed and run from 2.0.22, the first
release whose server was read for them (read again at 2.2.0). `GET
/api/command` (with `location[directory]` set to the Project root) answers
`{location, data}`, each entry `{name, description?}`: the built-in `init` and
`review`, commands from the launch's configuration, and each MCP prompt as
`server:prompt`. The probe lists them into the observation's `commands`, and a
Work or Code session replaces that list when it starts or resumes, as Claude
Code's and an ACP agent's are ([Architecture: the composer's `@` and
`/`](../architecture.md#person-memory)). The answer is untrusted: a body over
256 KiB lists none, and an entry whose name Octant cannot send as `/name` is
dropped. The observation is the instance's, so it holds the list of
whichever Project's session started last; a turn whose prompt opens with
`/name` is routed by its own Project's list, read again before anything is
queued, so a command another Project lists, or one removed since, is
refused rather than run or sent to the model as text. A turn whose prompt
opens with a name listed there goes to `POST
/api/session/{id}/command` with `{name, text, files?}`, the text being what
follows the name, after the model switch every prompt makes; the turn's Octant
context goes first as a prompt with `resume: false`, which OpenCode admits
without starting a run, so the command's own text stays only its arguments.
The route answers 204 once the command's input is admitted, and the run
reports through the same events as a prompt. A command route that fails
after the context was admitted leaves that context queued in the session,
where the next run would read it stale beside the next turn's own; the turn
fails as `stale-resume` and the driver never resumes that session again (in
this host process), so the thread starts on a new session. The host refuses such a turn in
Plan and in Chat, and the driver refuses it again. A command may run a shell
before the model sees it: a configured command's template expands
`` !`…` `` through OpenCode's shell, which asks no approval, inside the
launch's own confinement; only Work and Code outside Plan run one, as
OpenCode's own client does. 1.x lists none: its `POST /session/{id}/command`
answers only once the whole run has ended (1.18.21), so no turn can start
from it, and it has no asynchronous form.

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
search), and loads Octant's own extension by path. A user-level or
project-level `mcp.json` therefore starts no server.

Pi runs as it does on its own (maintainer decision, 2026-11-14): the
person's own Pi setup in `~/.pi/agent` loads by default. Pi is not a key
provider, so no account or thread switch reaches its driver, and the default
lives in `piOwnSetup` (`piProcess.ts`); a switch would need Pi in the key
provider list and the contract, which this change leaves alone.

| Launch                         | The person's own Pi setup                                                                       | Tools                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Chat                           | None                                                                                            | None                                                                                    |
| Plan                           | Skills (`--skill`), prompt templates (`--prompt-template`), context files                       | `read`, `grep`, `find`, `ls`                                                            |
| Work and Code, any other level | As Plan, plus each top-level extension file or folder in `extensions`, named with `--extension` | Pi's seven built-ins, Octant's app tools, and, from Pi 1.1.0, the extensions' own tools |

Pi's own discovery stays off (`--no-skills`, `--no-prompt-templates`,
`--no-extensions`) and the person's resources are named by path, because
discovery would also start Pi's built-in extensions and read a Project's own
`.pi` resources, which are that Project's code. Context files are Pi's own
discovery: a Project's `AGENTS.md` or `CLAUDE.md` is instruction text every
runtime may read, and the person's global `AGENTS.md` is linked into the
managed home, Pi's agent folder here. The wall opens only the folders and
files a launch loads, read-only; the person's Pi sessions, settings and
installed packages stay out, so a package listed in their settings does not
load. Plan loads no extension, since an extension is code running in Pi's own
process. The tools an extension registers are offered on a release that
takes `+name` entries in `--tools` (1.1.0 and later; the release is read
before the launch is prepared): the launch names additions to Pi's own
defaults (`+grep,+find,+ls` and Octant's app tools) instead of an allowlist,
so every registered tool stays registered, as in Pi itself (maintainer
decision, 2026-11-14). A plain list is an allowlist that unregisters them,
so an older or unknown release keeps it and offers none. Octant's approval
bridge asks, by the thread's level, for every tool but `read`, `grep`,
`find`, `ls` and Octant's own app tools, which the host decides; Full access
runs them without asking and Plan has none. An extension that registers a
tool under a built-in read's name replaces that read unasked, as it would
in Pi; the extension is the person's own code. The person's extensions may talk to Pi's
interface: a notice, status line, widget, title, or editor text expects no
answer and is not shown, and any other question of theirs is answered as
dismissed. An error in one of them leaves the turn running; an error from
Octant's bridge, or one naming no extension, still fails it.

Pi's prompt carries images: a model whose `input` in Pi's own model list
names `image` takes image attachments, sent as the prompt's `images`, and the
driver reports `nativeAttachments` supported when any listed model does. Any
other attachment, and an image to a text-only model, is refused. App-managed tools are reported only for the releases whose
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

### Where an agent message ends

ACP gives an agent message no ID and no end, and a turn's text is stored as
one string. The mapper takes a tool call or tool call update as the end of
the agent's message: the first text after one starts a new paragraph, unless
the text so far ends in a line break or the new text starts with one.
Thought, plan, and usage updates end nothing. Rationale: without the break,
an agent's note before a tool step and its text after it read as one
sentence. Turns recorded before this rule keep their text as stored.

Claude Code and OpenCode follow the same rule from their own signals, because
neither puts a break between one agent message and the next. For Claude Code
a tool-use block or a tool result ends the agent's message. For OpenCode a
tool part or a tool event ends it, and text that continues a part already
streaming is never broken. Codex names each agent message, so its mapper
breaks between any two. The Octant Harness sends one request per agent
message, so the first text of a later request in a turn starts a new
paragraph, under the same line-break exception; the history the model reads
keeps each message as sent. Pi passes an agent's text on as sent.

### ACP agents run as themselves

Every ACP agent is a key provider (maintainer decision, 2026-11-14): its
account and thread switches work as the other key providers' do, and a
Project trusted for it loads that Project's own files in Work and Code
outside Plan. Each profile's `nativeSetup` releases what its launch
otherwise holds back, and its `nativeSetupSupport` reports only those
features:

- **A trusted Project.** The profile's `forbiddenRootEntries` become
  readable, so the agent loads the Project's skills, settings, MCP servers,
  hooks, plugins, and agent files as it does on its own, under its own folder
  trust where it keeps one. Each agent's entries are listed in
  `PROJECT_CODE_ENTRIES` (`packages/domain/src/projectCodeTrustPolicy.ts`),
  so the one trust prompt names them; a test holds the two lists together.
  Gemini CLI and Qwen Code start in a trusted Project instead of refusing it.
  Grok Build's `trusted_folders.toml` becomes readable, so its own trust list
  decides. In Plan, in Chat, and in an untrusted Project every entry stays
  held, and the two refusals stay.
- **The person's own home.** Kimi Code reads its home `AGENTS.md` with any of
  the setup, `skills` with skills, `mcp.json` and `plugins` with tool servers,
  and `hooks` with hooks (never in Chat or Plan). Kilo unsets
  `KILO_DISABLE_EXTERNAL_SKILLS` with skills. fx reads the Project's
  `AGENTS.md`, instruction text, with any of the setup.
- **Not lifted.** Kilo's and Devin's managed configuration stays, because it
  carries the level's permission and the agent or mode Octant selects, which
  the person's own configuration would replace; so their home configuration
  and Devin's own subagents stay off, and Kilo's other Project configuration
  stays off because no Kilo release was read for the files it would load.
  What an agent reads from its own profile folder by itself (Goose's, Gemini
  CLI's, GitHub Copilot's, Cline's, Qwen Code's, GLM Agent's, and Grok
  Build's) loads as before; the switch cannot hold it back, so it is not
  reported as a setup feature.

Each agent's own subagents run in Work and Code outside Plan, at every level
there, wherever the person's setup carries them (maintainer decision,
2026-11-14), as Mistral Vibe's do; Plan and Chat run none (`acpSubagentsRun`).
Octant releases the switch it holds: Grok Build's `GROK_SUBAGENTS` guard, and
Devin's `subagents_enabled` in its managed configuration; these two report the
`subagents` feature. The others keep no switch Octant sets, so their own
subagents run as they always did and are not reported as a setup feature. A
permission request that names a call Octant never saw is a subagent's: in a
session whose subagents run it is shown through the ordinary approval path as
"A <agent> subagent asks to run a tool. <agent> doesn't say which." with Allow
and Deny under the thread's level, instead of failing the turn; in Plan and
Chat it still fails the turn. No agent but Mistral Vibe names a child session,
so their subagents are not shown from the call that started them and
`nativeChildAgents` stays unavailable for every ACP agent. Instead, the first
such request for a call Octant never saw journals a child run keyed by that
call, before its approval card: it says "<agent> is running a subagent.
Octant cannot see its tool calls or when it ends, only the approvals it asks
for.", as a Mistral Vibe custom-agent run says what Octant cannot see, and it
marks the thread as having read outside content under `hosted-tool`, since
the subagent may have done so unseen (maintainer decision, 2026-11-14). A
later request naming the same call adds only its card. The run stays shown
as running, because nothing reports its end.

Kimi Code's own slash commands run in Work and Code outside Plan, as in its
own app (maintainer decision, 2026-11-14); the probe still pins the reviewed
command inventory, so a release with a new command fails closed. Plan and
Chat refuse a prompt starting with `/`, since a command such as
`update-config` writes. The earlier refusal everywhere was Octant's default,
not a protocol limit: ACP carries the command as prompt text.

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

An agent whose shell runs in-process and sends no `session/request_permission`
or `terminal/*` request before a command leaves Octant nothing to ask about.
Its profile sets `shellWithoutRequest`, and a Work or Code session at Guarded
or Reviewed is refused as `unsupported` before its process starts, with a
sentence pointing to Full access; Full access runs it, and Chat and Plan have
no shell. Rationale: an approval Octant never sees is no approval, and
running it anyway would put a weaker guard under the level than the level
names. No
shipped profile sets it.

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

An ACP agent takes image attachments only where its own `initialize` result
advertises `promptCapabilities.image` (maintainer decision, 2026-11-14). The
probe then reports `nativeAttachments` supported and every listed model as
taking text and images, since ACP states the capability for the agent and
not per model; each image goes as an ACP `image` content block after the
prompt text. Any other attachment, and any attachment to an agent that did
not advertise images, is refused rather than dropped. Audio and embedded
resources are not sent.

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

fx ships as an ACP profile (`fx`) but is not in the registry.

fx is offered. Measured 2026-10-28 on fx 0.0.15, under the deny-default
Seatbelt profile, fx's HTTP pool aborts certificate loading when its read of
`/Library/Keychains/System.keychain` is denied, instead of falling back to
`/etc/ssl/cert.pem`, so it cannot reach the Vercel AI Gateway. `fxProfile`
therefore sets `readsSystemKeychain`, and a sandboxed macOS launch below Full
access gets one extra rule, `(allow file-read* (literal
"/Library/Keychains/System.keychain"))`, emitted after the Keychain and built-in
secret-file denials so neither overrides it; a path the person protects still
does. No other profile sets it, nothing grants a
write there, and the rest of `/Library/Keychains`, `~/Library/Keychains`, and
`/var/db/SystemKey` stay denied. The file is world-readable on macOS and its
item secrets are encrypted with the root-only SystemKey, so the read yields no
secret. `WITHHELD_BUNDLED_PROVIDER_DRIVERS` in
`packages/plugin-host/src/bundledProviderDrivers.ts` holds no driver; an entry
there keeps a driver out of the activation ladder while stored instances and
threads stay.

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
   agent, and the stop reason. A shell command that runs with no request
   first sets `shellWithoutRequest` on the profile.
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
runtime. Ordinary inherited configuration does not supply that attestation and,
below Full access, continues to report app tools as unsupported. At Full access
such a runtime is still offered Octant's tools, labelled as mixed with tools
Octant did not supply (maintainer request, 2026-11-12). The adapter reports
this as a separate capability, `appManagedToolsAtFullAccess: "mixed"`, beside
`appManagedTools`, which keeps answering for every guarded level; the host
resolves the two against the thread's level, and the thread's access details
show "mixed with tools Octant did not supply". Full access launches the
runtime outside the sandbox the receipt rests on, so a release that proves
exclusivity below Full access is mixed there too, unless the thread keeps the
opt-in sandbox. The capability is reported only when the connection check saw
the runtime accept the tool endpoint's declaration; that check runs on macOS
only, so on Linux nothing is reported as mixed. Every reader of the tool
gate follows the level the turn runs at (maintainer decision, 2026-11-13): a
child agent session reads the level its own session runs at; a routine's own
Browser target reads its running turn's level; a saved flow, which runs
between turns, reads the level its thread holds then. While a person reviews
a routine's Browser permission no turn runs, so a routine opted into its
Project's level is read at Full access there and stays reviewable; a review
offers no tool, and each turn is still judged at its own level. Below Full
access all three read `appManagedTools` alone, as before.
Process exit, stream failure, interruption, and scope cleanup retire pending
tool requests.

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
