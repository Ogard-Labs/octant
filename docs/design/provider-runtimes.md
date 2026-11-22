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
`~/.claude/CLAUDE.md`. 2.x reads `<global config>/AGENTS.md` from the same
folder, resolved the same way (`OPENCODE_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/opencode`; opencode 2.0.22 and 2.2.0,
`core/src/config/plugin/instruction.ts` and `util/src/global.ts`), so it too
found only the private folder's, which holds none. Outside Strict, with the
person's own setup on, a 2.x launch links the person's global `AGENTS.md`
into the private folder as a 1.x launch does, and reads it as it does on its
own; under Strict a 2.x launch links nothing, as before. Below Full access
the launch's wall opens that one `AGENTS.md` for reading and nothing else in
its folder (the person's `opencode.json`, plugins and agents stay out): a
literal Seatbelt rule on macOS and a read-only bind on Linux, as for
`CLAUDE.md`. A protected file, a link, or a file reached through a linked
folder is not linked or opened. Below Full access the 1.x
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
(maintainer decision, 2026-11-14). In Plan, with tool servers off, a session
whose person marked some of the account's servers "Read-only — allowed in
Plan" also starts with `strictMcpConfig: false` and `user`, under a flag
`allowedMcpServers` list of those servers and Octant's own and
`disableClaudeAiConnectors`, so only the marked servers start; Codex switches
every unmarked server off by name in a Plan thread's config, and OpenCode's
Plan launch carries only the marked servers
([Plan and Chat tool parity](../architecture.md#security-and-authority)). A Project's `.mcp.json` stays held until
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

Plan's read-only rule and Chat's withheld filesystem and shell stay at every
level, and the provider's telemetry and self-update follow the person's two
provider switches ([Provider channel switches](#provider-channel-switches)),
which no native feature turns on. The provider's own memory is on by default in Work and Code outside
Plan, as in the provider's own app, and the person turns it off per
provider account (maintainer decision, 2026-11-14; the account stores only
the off, as `ownMemory: false`, and an older stored `true` reads as on).
With it on, Claude Code launches without `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
in Plan and Chat too with its memory read-only (Octant's gate refuses a file
write into the account's `CLAUDE.md` or a `projects/<folder>/memory/` folder
there, since Claude Code's own check allows one unasked), and Codex's
app-server starts without the `features.memories=false` override, on a
process of its own: outside Strict in every mode, Plan and Chat included, as
in Codex itself (maintainer decision, 2026-11-21); under Strict in Work and
Code outside Plan only, because Codex writes `~/.codex/memories` by itself
after a turn (maintainer decision, 2026-11-16;
[architecture](../architecture.md#security-and-authority));
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
updates are consumed from the verified 3.0.3 release on (a later release
unverified), as specified below.
Native review remains unimplemented. Supplementary file-review
reads have a candidate integration behind an empty verified-version allowlist:
no production profile declares the read capability until signed-in 3.0.3
read and genuine same-task cold-resume evidence pass. Revisit `vibe-app-server` when it negotiates a
version or is documented. Vibe's questions reach the shared questionnaire as
a session-form elicitation on 3.0.3, the one release in its verified-version
list, and on every later release, unverified (maintainer decisions,
2026-11-14: Octant adds to a provider and does not take its core features
away; 2026-11-21: release ranges). An older release reports questions
`unavailable`. The signed-in 3.0.3 question, answer and cancellation check
stays a maintainer live check.

The adapter advertises only ACP `elicitation.form`, never URL elicitation,
on 3.0.3 and later releases. Only an active originating
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
Later valid updates cannot repair an invalidated turn. A turn that fails
before its reply (a rejected prompt or a failure raised mid-turn) reports the
counters its latest valid snapshot added since the baseline, with that
snapshot's context, before the failure. Late snapshots update
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
next turn, and a running turn keeps the limit it started with. Outside Strict,
reaching the limit does not cut the turn off: the host journals
`turn-stall-noticed` and the thread shows one quiet line with a **Stop**
button ([Thread view: Loop and stall notices](thread-view.md#loop-and-stall-notices)).
Under Strict, a turn cut off by the limit ends as it did under the fixed
limit. With the setting Off, only Stop and Force stop end a silent turn. The
tool-call pause limit (`providerToolCallPauseLimitMinutes`, `null` for Off)
is stored, changed and read the same way.

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
apart from the stalled-turn limit; it does not follow the setting. The
deadline counts only the call's running time: it stands still while an
approval the call asks before it is dispatched waits for its person, and runs
on from where it stood once the person answers. An unanswered approval waits
in Needs you and never turns into a refusal by timing out; Stop still ends the
wait. For the same reason an MCP session with a call waiting for approval
does not idle out under it, while an authentication change still retires the
session and refuses the call. Work and Code have no per-call deadline; their
app-managed calls pause the stalled-turn limit instead.

### Loop detection and provider tool inputs

Chat, Work and Code track consecutive identical tool calls within a turn using
canonical sorted-key JSON comparison of the tool input (same tool name, same
normalized JSON input, no other tool call in between; pure policy in
`@octant/domain`).

- **Early warning on Octant's own tools.** On the 3rd identical consecutive
  call to one of Octant's own app-managed tools (`tool-request`), the tool
  still runs normally and its result adds one informational sentence noting
  that it has been called the same way three times. It is information, never a
  refusal, and has no setting.
- **Loop threshold (6 consecutive calls).** Outside Strict, at every level,
  Octant does not stop the turn: it journals `turn-loop-noticed` (tool name
  and count) once for that streak and the thread shows one quiet line with a
  **Stop** button. Under Strict, Octant stops the turn immediately, interrupts
  the provider session, journals `turn-loop-stopped`, and settles the turn so
  the thread accepts the next message straight away.
- **Which providers carry tool inputs on normalized runtime events:**
  - **Octant Harness and direct model endpoints** (OpenAI-compatible,
    Anthropic-compatible, Ollama, Amazon Bedrock, Azure Foundry): every tool
    call emits `tool-request` with `toolName` and full `inputJson`, so all
    calls are loop-checked and receive the 3rd-call early warning.
  - **Claude Code:** provider-native tools emit `tool-start` paired with
    `tool-call-content` (`part: "input"`), so they are loop-checked except
    `Edit`, `Write`, and `NotebookEdit` (whose `tool-call-content` intentionally
    omits file contents and keeps only the path, marked `partial: true`, so
    each call resets the consecutive streak instead of falsely matching on path
    alone) and inputs truncated past `MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS`.
    Octant's app-managed tools bridged into Claude emit `tool-request` and are
    checked with the 3rd-call early warning.
  - **Codex, OpenCode, Pi, Oh-My-Pi, and ACP agents:** provider-native tools
    emit `tool-start` (at most a redacted one-line display `argument` on Codex)
    without JSON input on normalized runtime events, so their native tools are
    not loop-checked and completing one resets any consecutive streak. Octant's
    app-managed tools bridged into them emit `tool-request` with full
    `inputJson` and are checked with the 3rd-call early warning.
  - **Outside provider drivers:** checked for calls emitted as `tool-request`
    or `tool-start` paired with un-truncated, non-partial `tool-call-content`
    (`part: "input"`).

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

Under [Octant adds no restrictions of its own unless Strict is on](../architecture.md#security-and-authority)
(maintainer decision, 2026-11-16; designed, not built), the account switch
alone decides whether a Work or Code launch offers `Artifact`; the thread's
Canvas or artifacts choice only points Octant's delivery instructions. The
tool keeps every action, so Claude Design's `/design` and `/slides` run as
in Claude Code: `quickstart`, publishing from a type with no local file,
`read`, `list` and updates. A publish naming a local file follows the
thread's file rules. Chat and Plan launches offer the read-only actions and
refuse publishing. The telemetry guard follows the person's provider
telemetry switch outside Strict (built: with it off, the default, the launch
carries Octant's telemetry guards and lifts only `DISABLE_TELEMETRY`, as under
Strict, the host's own opt-out still kept as `DO_NOT_TRACK=1`; with it on, the
launch carries no telemetry guard of Octant's, the switch only opts the runtime
in with `CLAUDE_CODE_ARTIFACT`, and a host's own telemetry opt-out keeps the
tool off). Built too (`claudeOffersArtifacts` and
`claudeArtifactCallRefusal` with Strict off): the offer on the switch alone in
every mode, every action in Work and Code, a publish naming a local file asking
outside the session's folders below Full access as a `Write` would (the login
keychain folder always refused), and Chat and Plan holding only `read`, `list`
and `quickstart`. A publish from a type with no local file is judged at the
Project root and its approval says it sends a page Claude made. Under Strict
the thread's choice still decides and the tool publishes one Project file only.

**Bedrock and AWS profiles outside Strict.** Provider runtimes that support
Amazon Bedrock natively (including Claude Code with `CLAUDE_CODE_USE_BEDROCK=1`
and Codex's Bedrock providers) read the person's AWS profile, environment, and
own refresh settings exactly as in their own CLIs (maintainer decision,
2026-11-19). Octant never resolves, copies, or replaces AWS credentials for a
provider runtime. Outside Strict, the launch environment preserves the person's
AWS variables (`AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`,
`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_ROLE_ARN`,
`AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_CREDENTIALS_*`,
`CLAUDE_CODE_USE_BEDROCK`, and the rest), confined Plan and Chat launches
narrow protected files to other providers' sign-ins and keep read access to
existing `~/.aws` and configured AWS config/credential/token files, and Claude
Code admits Bedrock account routing (`apiProvider: "bedrock"`) on both probe
and session start. Under Strict, each runtime keeps its fixed environment list,
protected-file wall, and first-party routing rule.

**Several Claude accounts.** Each Claude account is its own provider
instance with its own `CLAUDE_CONFIG_DIR` and secure-storage folder, its own
claude.ai sign-in and its own artifacts switch. A thread runs on one
account at a time, and its `Artifact` calls publish to, read from and list
that account's claude.ai gallery and design systems only; Octant never
lends one account's sign-in to another's session. The published page's
address and the account that published it are journaled on the call
(`ThreadPublishedPage.account`, the provider instance id), with the Claude
artifact type the call named (`artifactType`, read from the last segment of its
`type_url`; absent for a plain page). A `read` or `list` answer carries a page
address too and journals no page: the driver reads each Artifact call's action
at its `PreToolUse`, which every call passes. When
a thread later runs on a different account, it may still update a page an
earlier account published only where claude.ai gives the new account
access, and claude.ai's refusal reaches the model as the call's result.
An account with the switch off offers no `Artifact`, whatever another
account allows, and an API-key account never offers it.

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

Decided under [the provider's own permission system decides](../architecture.md#security-and-authority)
(maintainer decision, 2026-11-15; built outside Strict): outside Plan and Chat
Octant offers Claude Code's full built-in tool preset with no Octant deny
list, and maps its levels onto Claude Code's own permission modes (Ask first
`default`, Accept edits `acceptEdits`, Auto `auto`, Full access
`bypassPermissions`, Plan `plan`). Claude Code's permission engine and the
person's Claude Code rules then decide each call; Octant no longer
second-guesses a call those rules allow, and an ask Claude Code raises
reaches the person as an Octant approval, decided and journaled on the
server. Plan stays read-only and Chat has no shell. The withheld list and the
gate's own rules described in this section, and Octant's in-root edit waiver
at Accept edits, are Strict's, and Plan's and Chat's at every setting. Outside
Strict the withheld list holds only what the person's own setup turned off
(`Agent` and `Workflow`, the web tools, `Skill`); the mode switches, the
wake-up tools and `Artifact` are offered and the gate refuses a mode switch or
a wake-up the host does not answer with a reason the model reads
(`CLAUDE_LEVEL_CHANGE_REFUSAL`, `CLAUDE_WAKEUP_UNAVAILABLE`). The hook leaves
every other call to Claude's engine and the person's rules, Octant keeping its
own ask only for a command leaving Claude's sandbox and a path outside the
session's folders; Octant sends Claude no sandbox settings, so Claude's own
sandbox runs as the person's settings configure it.

That hand-over needs the person's settings loaded. Their sandbox and their
`permissions.allow`, `ask` and `deny` rules live in the account's home
settings, which Claude Code reads only with the `user` setting source, and
that source cannot be read for those alone: it also brings the plugins,
agents and commands the person's own Octant switches keep out. So a launch
outside Strict whose setup reads no home settings (none of skills, hooks,
tool servers or the Project's code on; subagents and web tools alone read
none) keeps Octant's gate, as under Strict (`claudeOwnPermissions`, which
`claudeReadsPersonSettings` gates). The SDK port refuses a launch asking for
Claude's own permissions that would read no person's settings, so the rule
fails closed at both ends. Such a launch in Work or Code outside Plan carries
no sandbox settings either (maintainer decision, 2026-11-21; built,
`claudeOctantConfiguresSandbox` on the shared
`providerHoldsLevelWithoutSandbox`): as on Windows, Claude's own permission
mode and the gate hold the level, and the gate keeps every per-call rule (the
secret guard's protected paths, the folders the session holds, its own ask
for a command, a publish, a workflow start or a level change). Chat, Plan, a
Full access thread that kept its sandbox, and a legacy chosen sandbox policy
keep Octant's configured sandbox; Strict keeps it as described above.

A Work or Code session outside Plan launches with Claude Code's own tool
preset (`tools: { type: "preset", preset: "claude_code" }`) rather than a
fixed list, so it holds what Claude Code holds in its own app (maintainer
decision, 2026-11-14). `disallowedTools` withholds only what would break a
rule the server enforces, and the decoder refuses a runtime or a call that
names a withheld tool:

| Withheld                                                 | Why                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnterPlanMode`, `ExitPlanMode`                          | The thread's mode and level are the server's: both in a session whose host does not answer level changes (child runs), and `ExitPlanMode` outside Plan everywhere; Plan's read-only list holds `ExitPlanMode` (see below) |
| `Agent`, `WebSearch`, `WebFetch`, `Skill`                | Only while the person's own setup has that feature off                                                                                                                                                                    |
| `Workflow`                                               | Only while the person's own setup has subagents off: a workflow starts agents                                                                                                                                             |
| `ScheduleWakeup`, `CronCreate`, `CronList`, `CronDelete` | Only in a session the host keeps no wake-up schedule for (a single-use session); Octant answers them everywhere else (below)                                                                                              |
| `Artifact`                                               | Unless the session offers Claude artifacts                                                                                                                                                                                |

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

Outside Strict, when Claude loads the person's settings, Octant passes no
command-sandbox settings and Claude follows the person's native configuration.
When those setting sources are all off, the configured sandbox and gate remain
as the fallback described above. Disabled account hooks and memory stay off.
Legacy sessions retain their previous behavior until explicitly migrated.
Strict configures Claude's native command sandbox, since macOS cannot nest
Seatbelt: Project and granted folders, recorded Network limits and
`autoAllowBashIfSandboxed: false`. Plan retains Octant's read-only wall.

Strict binds a standalone trusted native CLI outside writable roots to an
owned lifetime scope. Native startup hooks, MCP servers and Project startup
code run outside the command sandbox and are withheld under Strict. The
runtime can still read enabled skills with hooks disabled and strict MCP
configuration. Native web tools are withheld when tool networking is filtered;
Octant's brokered tools retain their own checks. In-process REPL/Workflow scripts, native worktree startup and unreviewed native
execution tools are also withheld; Strict uses an explicit supported tool list.
These are withheld features,
not claims of OS confinement for the parent CLI. The effective-policy panel
reports this boundary. Ordinary Strict-off native features remain available.

A Strict command-read folder overlapping a required protected-file rule is
refused before opening the native query, including a protected name not yet
created. The native route does not claim that a file-tool hook confines shell
commands, and leaves the rule selected for a supported backend.

Strict's native read rules re-allow public system toolchains, loader and
resolver files beneath the root read deny; the effective-policy details list
the exact paths. This grants no home/account folder and no system write.
On Linux the private lifetime root materializes top-level directory aliases
so merged-`/usr` symlinks do not break Claude's native read-deny mounts. Each
selected folder is mounted from its admitted object using the trusted pinned
launcher. This wrapper owns lifetime and folder bindings; the native command
sandbox enforces command effects, and an approved escape still leaves it.
A real bundled runtime test requires an allowed Project write to succeed and
the same outside write to fail, with both writes succeeding in its control.

Each native command escape under Strict, including Full access and Auto,
requires a new **human** answer. Its approval discloses personal-file and
host-service access outside the command sandbox and journals the one-command
exception. No reviewer or remembered answer can authorize it. A real bundled
CLI test with an offline model forces two identical escape asks, denies one,
permits the other, and checks exactly one command ran; a matching control
proves bypass mode would otherwise run both. Missing required native sandbox
prerequisites fail before inference or tool execution. Credentialed model and
signed-package acceptance remain separate checks.

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
the next turn as it does for any running turn whose runtime does not steer.
A Work or Code person's turn is never held (it completes with its reply), so
a message sent into a running Claude Code turn there always waits for the
next turn. A `Monitor` call that asks for a WebSocket (opened by the
runtime process, outside the command sandbox and its network rules) or a
watch for the whole session is refused before the gate. Plan keeps its
read-only commands in the foreground: `run_in_background` is refused there.

#### Subagents sent to the background or messaged

A running Claude subagent's child run row offers Background and a message
beside Stop, at every Strict setting (maintainer request, 2026-11-16; built).
Background calls the SDK's `backgroundTasks(toolUseId)` with the id of the one
`Agent` call that started it, never without one (which would background every
foreground task); the call returns at once and the parent's turn goes on while
the subagent keeps running as a background task. A message is queued on the
session by the runtime's task id and delivered once, framed as the person's,
as the `additionalContext` of that subagent's next `PreToolUse` hook, matched by
the hook's `agent_id`; a subagent that makes no further tool call before it
finishes never reads it, and the row says so when the message is sent. Both
reach only the running turn's own session, under Stop's authority
([Architecture: provider-started subagents](../architecture.md#person-memory)).

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
2026-11-14) and in Work (maintainer decision, 2026-11-16). The thread's
level stays the server's: the runtime never switches its own permission
mode. A Work or Code session starts with `levelChanges`, and then outside
Plan holds `EnterPlanMode`; a Plan
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
then ends the turn that asked, unless it entered Plan in place (see
**Changing the level inside the running turn** below): Plan's read-only
rule otherwise rests on the tool set and sandbox profile a session launches
with, so the new level applies from the next turn's session. A kept session
started at the old level is stopped before that turn too. The level an
approval applies is worked out when the person answers, from the thread as
it is then, so a level lowered while the ask was open is the one a plan
returns to. Entering Plan
records the level it left as the thread's `planReturnPolicy` (Full access
is recorded as approval-gated, because only the person chooses Full access),
and an approved plan returns the thread there, or to approval-gated when the
person put the thread in Plan. A declined ask leaves the level and the turn
as they were. Chat and child runs do not answer level changes yet, so their
sessions hold neither tool.

A Work thread answers them through its pending-request card. The ask is
recorded as a Work approval whose detail carries a structured `levelChange`:
the level it would move to (Plan, or the guarded level the thread returns
to) and, on leaving Plan, the plan whole. Unlike the request's own text,
which keeps refusing paths and links, the plan keeps the paths it names,
with known secret formats redacted before it is recorded, so the person
approves exactly the plan the agent wrote. Octant Shield never screens a
level change, and a provider's own reviewer never sees one. On approval the
host moves the thread through the same rule as the Code access command,
journaled as the person or paired device that answered, before the
provider hears the answer; a change the host cannot make leaves the request
pending. The turn that asked then ends, and the next one launches at the
new level, unless it entered Plan in place, as below. Entering Plan records the level the thread left as its
`planReturnAccess` (Full access is recorded as Ask first), whether the
agent asked or the person chose Plan from the mode picker, and an approved
plan returns the thread there, never to Full access.

**Changing the level inside the running turn** (maintainer decision,
2026-11-14; resolved 2026-11-18; built). An approved change is applied
without ending the turn only when two things hold: the provider can change
the level inside its session, and Octant can hold that session to the new
level's rules without launching it again. A driver says it can through the
driver port's optional `changeLevelInPlace`, which answers `applied`,
`refused` or `failed`; anything but `applied`, or no such call, and the turn
ends as before.

- _Entering Plan in place_ (Claude Code, in Work and Code). The host first
  moves the thread's level. It then asks the driver to change in place: the
  Claude driver turns its gate to Plan for the session and calls the
  runtime's `setPermissionMode("plan")`, and only after that does the agent
  hear the answer, which tells it the thread is in Plan for the rest of the
  turn. From then on the gate judges every call at Plan rather than the
  session's launch level (a read runs unasked, a marked server asks, a path
  outside the Project is refused, the person's own rules decide nothing),
  and refuses what a Plan session would not hold:
  - every file write and edit tool;
  - every `Bash` call and every tool that manages commands, because the
    session's sandbox is the old level's and can write, so a command cannot
    be judged by it;
  - every command that would leave the sandbox;
  - every MCP server the person did not mark read-only;
  - every subagent or `Workflow` start;
  - every other tool outside Plan's list (reads, the session's task tools,
    a question, a skill's text, web reads, artifact reads and Octant's own
    tools, which the host judges at the thread's current level), so a tool
    the gate does not know fails closed.

  Each refusal carries Plan's sentence, and an approval the person answers
  afterwards for a call asked about before the change is refused too. If
  `setPermissionMode` fails, the gate stays at Plan and the turn ends as
  before, so the level never moves without its rules. A session whose
  account directory overlaps the checkout, which a Plan launch refuses
  because the task tools write there, is refused the change and its turn
  ends. The running turn's own ceiling, a Code turn's and a Work turn's,
  reads Plan from then on, before the agent hears the answer, so a level
  the person raises again meanwhile applies only from the next turn and
  Octant's own tools judge the rest of the turn at Plan. The next turn launches with Plan's
  read-only profile and tool set as usual.

- _A journaled record._ The approval's answer records which way the change
  applied: Code's `approval-answered` and Work's resolved request carry
  `levelChangeApplied`, `in-place` or `next-turn`.

- _Leaving Plan always ends the turn._ A Plan session holds Plan's tool set
  and a read-only sandbox. No runtime control adds a tool or widens a
  sandbox in place, and Octant never applies inside a session a widening it
  cannot hold to its rules.
- _Codex_ sets its approval policy and sandbox on each `turn/start`, so it
  has no change inside a session. Its approval ends the turn as today, and
  the next turn starts at the new level.
- _Every other provider_ keeps ending the turn until its driver reports an
  in-place change it can enforce. The driver reports this capability
  honestly (an in-place `enter-plan`, or nothing), and the host ends the
  turn whenever it is absent.

Rationale: Claude Code's own CLI switches modes inside a turn in both
directions. Octant matches it in the narrowing direction. There, the gate
can refuse what the old launch profile would still allow. In the widening
direction the session has neither the tools nor the sandbox, and handing
the agent a level its session cannot honour would be a silent mismatch.

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

#### Imported history

A thread started from a session begun outside Octant shows that session's
earlier conversation in its own history (maintainer decision, 2026-11-20;
built): the person's messages and the agent's replies, each tool call named
rather than replayed. The driver reads it through the provider SDK's optional
`nativeSessions.history`, from what its runtime already stores, read-only,
after `adopt` claims the session and before the commit checks, which do not
yield. The host bounds it (`nativeSessionHistory.ts`): the newest 200
messages within 256 KiB of text, each message clipped to 8 KiB and marked
when clipped, at most 16 tool names a message; the earlier messages it leaves
out are counted (`omittedMessages`) and the thread says how many. The read
never refuses an adoption: a driver without the read imports none as
`unsupported`, a session with no messages as `empty`, and a read that fails,
dies, or runs past 30 seconds as `unreadable`, and the thread says which.

The host journals what it keeps once, in the same unit as the adoption
(Code's two operation events; Work's `work.thread-updated@1`), as
`native-session.history-imported@1` under an aggregate of its own,
`native-session-history`, keyed by the thread id. No turn, handoff, fork,
compaction, or usage read folds that aggregate, so the imported messages are
the thread's record only: the provider already holds them and is never sent
them again, they cost nothing, and a provider-switch handoff or a fork does
not carry them (a recorded gap). Replay reads the journaled record: the
thread's native-session read (`adopted.history`) answers it after the same
access checks as the session id, and the thread shows it above the composer
in the details row as "Imported from the provider's session", collapsed, each
message marked by speaker. Thread search indexes it as the thread's prompt,
reply, and tool text under a turn of its own with no anchor, so a hit opens
the thread and is marked Imported; it is journaled before any turn, so a
rewind never removes it, and a thread purge erases it with the thread's other
records (its payload names the thread).

| Runtime                                           | What the history read uses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                                       | The session transcript the resume record names, through the Agent SDK's `getSessionMessages` under the account's configuration folder; tool results and subagent messages left out                                                                                                                                                                                                                                                                                                                                                  |
| Codex                                             | `thread/read` with `includeTurns` on a catalog app-server, which reads the stored rollout without loading the thread; a server that returns no turns imports none as `unsupported`. The protocol has no tail or limit for this read, so a session whose reply exceeds the RPC reader's 1 MiB line limit imports none as `unreadable` and the adoption still records                                                                                                                                                                 |
| OpenCode                                          | The session's messages (`session.messages`) on the folder's catalog server; OpenCode 2's message shape is not one Octant reads, so it imports none as `unsupported`                                                                                                                                                                                                                                                                                                                                                                 |
| Pi                                                | The person's own JSONL that adopting copied, the current branch from its last entry back to the root; tool results left out                                                                                                                                                                                                                                                                                                                                                                                                         |
| ACP agents that list sessions (`importsSessions`) | `session/load` in a readiness-check process of its own, collecting the replayed `user_message_chunk`, `agent_message_chunk`, and `tool_call` updates, then closing it; it drops every other update (thoughts, plans, tool-call progress) before counting, so a tool-heavy session keeps its recent conversation, keeps the newest 20,000 of those updates, counts the earlier messages as omitted (a message cut by that bound is left out whole), and an agent that does not advertise `loadSession` imports none as `unsupported` |

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
while `DISABLE_TELEMETRY` is set, which every Claude launch of Octant's under
Strict sets, and a launch outside Strict only while the person keeps
**Let providers send their own telemetry** off (under Strict the one lift is the
Claude artifacts launch above, which the person chooses because it sends usage
telemetry). Octant adds no terminal mode to carry it. A person-operated
[provider terminal](workspace.md) (maintainer decision, 2026-11-21) opens Claude
Code's own interface in a Code thread with the environment that thread's turns
launch with: under Strict Code Mode still does not start there, and outside
Strict the terminal does not read that switch yet and keeps Octant's telemetry
guard, so it does not start there either. Once the Agent SDK supports Code Mode, Octant offers it under the
same gate and level as Claude's other tools. The `REPL` tool, which runs code
in Claude's own process, is already offered outside Plan under the shell's
rules (see [Native plan capture](#native-plan-capture)).

## Codex

Under
[Providers run in their own sandbox](../architecture.md#security-and-authority)
(maintainer decision, 2026-11-15; built for Codex), a Work or Code thread at
Guarded or Reviewed outside Strict runs Codex's native workspace-write sandbox
and escalation in place of Octant's profile. The shared rule for every
provider decides it (`providerHoldsLevelWithoutSandbox`, maintainer decision,
2026-11-21; `codexRunsNativeSandbox`): a thread that chose a sandbox policy,
or kept the sandbox at Full access, stays in Octant's profile, as Strict,
Plan and Chat do. The mapping per level is Ask first `untrusted`, Accept
edits `on-request` with Octant answering in-root file changes, Auto
`on-request` with Codex's reviewer, each with `workspace-write`; Full access
keeps `danger-full-access`. Accept edits runs `on-request` here (maintainer
decision, 2026-11-21): Codex decides when to ask, as in its own CLI, and
Codex's own sandbox refuses what leaves the Project's folders, raising its
escalation. Under Octant's profile (Strict, a chosen sandbox policy) Accept
edits stays `untrusted`, since under an external sandbox `on-request` would
run every command unasked (below).

- The app-server runs unwrapped, as Codex runs on its own; macOS refuses a
  Seatbelt profile inside another, so the native sandbox replaces Octant's.
  `thread/start` sends `sandbox: "workspace-write"` and every `turn/start`
  sends `sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess }`
  with the Project's folders as the writable roots. `networkAccess` is true
  unless the launch took the egress proxy (Network limits on), which then
  carries the runtime's own traffic while a command reaches no network
  unless it is approved to leave the sandbox. The approval policies are those
  above: Auto `on-request` with Codex's reviewer, so a command runs unasked
  inside Codex's sandbox as in Codex's own Auto; Accept edits `on-request`
  with the person as reviewer, so Codex asks when it would on its own; Ask
  first `untrusted`.
- Codex's ask to run one command outside its sandbox arrives as an ordinary
  command approval and reaches the person, or Reviewed's reviewer, as an
  Octant approval. An approval is answered `accept`, never `acceptForSession`,
  so it runs that one command, and denied or unanswered stays refused.
- The lease key carries Strict, so a Strict and a non-Strict session never
  share a process, and the launch takes the account's open environment: the
  host's less Octant's variables and other providers' keys. A Plan or Chat
  lease outside Strict keeps Octant's read-only profile, with only other
  providers' sign-ins refused among the protected files.
- Octant's protected paths become Codex deny rules. Codex's built-in
  workspace-write policy has no deny field (`SandboxWorkspaceWrite` in codex-rs
  `config/src/types.rs` holds writable roots, network and temp exclusions
  only), so from 0.169.0, outside Windows, the sandbox runs as a named
  permissions profile instead (`codexNativePermissionProfile`): the thread's
  `config` defines `permissions.octant-workspace` as `:workspace` with the
  Project's folders `write`, other providers' sign-ins `deny` (the Provider
  sign-ins group the person has not removed, as the host resolves it at its
  composition boundary and hands the driver as a plain list, less the
  account's own Codex home, which stays `write` inside Octant's provider
  folder), and the network
  `enabled` only without Octant's egress proxy. `thread/start` and
  `thread/resume` select it with `permissions` in place of `sandbox`, and each
  turn restates it by name in place of `sandboxPolicy`, which would replace
  it. Measured on codex-cli 0.169.0 (Linux): a thread started this way reports
  the profile as active, a denied file fails with `Permission denied` inside
  Codex's own sandbox while the Project stays writable, a denied folder with
  one account home re-allowed reads that home and refuses its sibling, and a
  denied path that does not exist is accepted without being created. An
  earlier release keeps the built-in workspace-write policy without deny rules.
  The runtime's own `ssh` uses the person's own setup, so such a launch gets
  no server folder.

Under Strict, in Plan and in Chat, every Codex app-server below Full access
runs under Octant's profile, and the
[confinement matrix](../architecture.md#security-and-authority) owns what that
profile allows and why. The wire mapping that follows from that profile:

Every turn restates its sandbox policy and writable roots after resume; the
process lease also includes the admitted policy scope. Required unsupported
Strict confinement refuses by name. Metadata is read independently and cannot
authorize a Strict launch.

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
- Under Strict a command that needs to leave Octant's wall still fails there.
  Codex cannot raise that ask under an external sandbox: `exec_policy.rs` prompts for a `require_escalated`
  command only under a restricted sandbox and allows it unasked under an
  external one, its sandbox bypass removes only Codex's own sandbox, which is
  not running, and `orchestrator.rs` never retries a denied command without
  the sandbox under `on-request` (rust-v0.169.0, unchanged on the main
  branch read 2026-11-15). Such a command fails at the wall; outside Strict
  Codex's own sandbox carries the ask instead (above).
- Under Octant's profile, Ask first (approval-gated without the reviewer)
  and Accept edits (auto-accept-edits) send `approvalPolicy: "untrusted"`,
  the strictest mode Codex has, matching the strictest mode elsewhere
  (outside Strict, in Codex's own sandbox, Accept edits sends `on-request`;
  above). Under an external sandbox
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
  telling the model Octant does not collect secrets in chat. Outside Strict
  such a set is shown to the person as Codex shows it, its answer kept out of
  the journal, logs and evidence, in a Code, Work or Chat thread and in an
  Octant subagent of one (maintainer decisions, 2026-11-21; built): each
  secret question carries `secret` on its `user-input-request` and on the
  surface's question record, the question card takes the answer in a masked
  field with a reveal control, and the answer travels in the surface's own
  answer command as `secretAnswer` (at most 4,096 characters), so it reaches
  the Codex process in memory and the record holds only that a secret answer
  was given:
  - Code: `answer-provider-input` carries `secretAnswer` in place of a
    `response` put as evidence; the journaled `input-requested` is marked.
  - Chat: `answer-chat-turn-question` carries `secretAnswer` in place of
    `answer`; the attempt's `pendingQuestion` is marked and its answered
    question keeps `secret: true` with no `answer`.
  - Work: the request's `user-input` detail is marked, and
    `resolve-work-request` carries the resolution `{ kind: "user-input",
secret: true }` with `secretAnswer` beside it, so neither the delivery
    intent nor the settled request holds the value.
  - A subagent: its question is asked on the parent thread's harness session
    marked `secret`, answered with `secretAnswer` on the session's
    `questions` route, and settles answered with no `answer`; the child's
    transcript notes the question with the answer left out. A child session
    carries no `strict` of its own, so the host starts it with
    `asksSecretQuestions` exactly when its parent thread resolves outside
    Strict (the parent Strict every child policy reads); the child keeps
    every other Strict protection, and a parent whose Strict cannot be read
    keeps the refusal.

  Only the person answers one: each surface refuses a `secretAnswer` from
  anyone but a window on this host or a device they paired, refuses one for a
  question not marked secret, and refuses an ordinary answer to a question
  that is; a Needs you or Inbox row for it finds the thread rather than
  answering. The other questions of the set are asked and recorded as usual.
  A Strict session, and a session whose surface did not say it keeps the
  answer out of its record, still refuses the set unseen. A Codex subagent's set
  (Codex offers the form to the root thread only) is answered empty. The
  capability is reported `supported`.

**Codex's own review** (maintainer decisions, 2026-11-16 and 2026-11-18;
built). Codex's built-in `/review` works in Octant as it does in Codex on its
own: in every Work and Code mode, Plan and Strict included, Octant starts
Codex's review run (`review/start` on the app-server) on the thread's
checkout and never refuses it there. Its findings show in the thread as a
review result, not as edits or a plan. Chat, which has no Project, does not
start one, and only a release without `review/start` reports it unsupported.
The probe lists `/review` among Codex's commands, and a turn whose prompt
opens with it starts the review instead of a turn; text after the name
becomes the review's instructions (`custom`), and none reviews the
uncommitted changes, as Codex's own default.

The review runs inline on an `ephemeral` thread of its own, started with
`approvalPolicy: "never"` and the session's config overrides, at the
session's level. Codex's review agent always runs with no approvals and the
sandbox of the thread it runs on (`AskForApproval::Never` in codex-rs
`core/src/tasks/review.rs`). Outside Octant's profile (a Work or Code thread
outside Strict below Full access, or Full access without the sandbox) the
review thread starts `read-only`, Codex's own read-only sandbox. Inside it
(Strict, Plan, Full access that keeps the sandbox) Codex's own sandbox
cannot start, because macOS refuses a Seatbelt inside another, so the
review thread starts `danger-full-access`, which inside Octant's profile
means no sandbox of Codex's own, as every turn's external sandbox tells
Codex (codex-rs matches `danger-full-access` against an external sandbox as
the same mode, `collect_resume_override_mismatches`); Octant's profile holds
the level, read-only in Plan and the Project at the guarded levels, and the
review asks nothing, as Codex's own review asks nothing. Windows Strict at
Full access is the exception: there no Octant profile wraps the process, so
the review thread starts under the session's own Codex permissions profile,
the one admitted at session start with the protected files denied, and is
refused when no such profile was admitted
([Codex's own sandbox on Windows](../architecture.md#codexs-own-sandbox-on-windows)). Rationale for a
thread of its own over running inline on the session's thread, as Codex's
terminal client does: `thread/start` takes the level at once, whereas the
session's thread holds whatever its last turn stated; a Strict thread before
its first turn still holds the `read-only` it was started with, which names
Codex's own sandbox and would fail inside Octant's, and a thread resumed into
another level holds the previous one until its next turn.

Its `exitedReviewMode` item becomes the reply's own paragraph under a
**Codex review** heading, and the completed turn names the session's own
thread in its resume cursor, with no native anchor. The review takes only a
target, so what the turn carries reaches the session's own thread instead:
Octant's context, pending Work agent messages, a provider-switch handoff and
the images the person attached are appended there with `thread/inject_items`
(raw Responses messages that start no turn, codex-rs
`ThreadInjectItemsParams`, rust-v0.169.0) before the review starts, Octant's
rules as a developer message, the rest as a user message, and the images as
`input_image` items of one more user message. A release without
`thread/inject_items` still reviews: the reply opens with a note that the
message's context and attachments did not go with the review, and the driver
holds them, by the session's thread, and sends them with that thread's next
turn (held in memory, so a server restart in between loses them). That
turn's own context and attachments always go; held ones fill the room the
block and attachment limits leave and the rest stays held for the turn after.
A held standing block is left out once a later turn restates Octant's context
or carries a newer version of it, so a block withdrawn meanwhile does not
return; waiting messages always go. When the
review reports its findings, the request and the findings are appended to
the session's thread as the user and assistant messages Codex records after
an inline review (`exit_review_mode` in `core/src/tasks/review.rs`) before
the turn reports completed, so a follow-up such as "fix those findings" sees
them; where they cannot be appended the turn still completes, after a note
that a follow-up turn will not see them.

**Codex's own Project configuration** (maintainer decisions, 2026-11-16 and
2026-11-18; built). Adding a Project, or an extra folder, in Octant is the
person's trust decision for every agent on its threads, so outside Plan
every Codex Work and Code thread's `thread/start` and `thread/resume` config
records the Project folder and each extra folder as
`projects.<folder>.trust_level = "trusted"` (`codexProjectTrustConfig`),
which Codex reads before it loads Project layers (`project_trust_context`).
Codex then reads the Project's `AGENTS.md` and loads its own Project
configuration as it does on its own (the project-local configuration
codex-rs's loader reads for a project Codex trusts, less the keys codex-rs
refuses from a Project, `PROJECT_LOCAL_CONFIG_DENYLIST` in
`config/src/loader/mod.rs`, rust-v0.162.1), and Octant reports `projectCode`
supported. Measured on codex-cli 0.169.0: a `read-only` thread loaded the
Project's `model` with the override and not without it, and nothing was
written to the account's `config.toml`.

This resolves the earlier gap: without a decision, Codex's app-server trusts
a Project folder by itself, and records it in the account's Codex
`config.toml`, when a thread starts with a sandbox that can write the folder
(`workspace-write` or `danger-full-access`; measured on 0.169.0,
`thread_processor.rs` `thread_start`). With the trust stated per thread it
never needs to, and Octant never marks a folder `untrusted`, because Codex
then also skips the Project's `AGENTS.md` (`load_project_instructions`).
Plan records no trust: its thread starts `read-only`, so Codex trusts no
folder by itself, still reads `AGENTS.md` of a folder with no decision, and
loads no Project configuration, as Plan loads no Project code. Under Strict
the trust is recorded the same way, so a Strict thread whose Project root
holds `.codex/config.toml` is refused before its thread starts until the
person allows the Project's code (`codexStrictProjectConfigRefusal`, category
`incompatible`, naming **Allow Project code**); the trust cannot leave the
file out without marking the folder untrusted. A folder the person trusted
in their own Codex CLI keeps that record, so in Plan such a folder's
configuration loads, inside Plan's read-only profile.

**Codex sessions started outside Octant** (maintainer request, 2026-11-18;
built). An empty Work or Code thread can continue one of the person's own
Codex sessions in its folder, under the same rules as a Claude Code session
([Sessions started outside Octant](#sessions-started-outside-octant)): only
the person adopts, the host journals it and marks the thread as carrying
outside content, and a claim the thread cannot record is given back.
Octant's Codex runs on the account's own Codex home, so the person's sessions
and Octant's share Codex's thread store. The driver's `nativeSessions`
(`codexNativeSessions.ts`) lists them with `thread/list` on a catalog
app-server, filtered to the thread's folder (`cwd`), newest first by
`updated_at`, at most 50, from the `cli`, `vscode`, `exec` and `appServer`
sources; a listing loads no thread. It leaves out a subagent's or ephemeral
thread, every thread an Octant thread holds, and every thread whose
`originator` is `Octant`, the client name Octant's connections send at
`initialize`, which Codex records on each thread it creates (from codex-cli
0.154.0; such a thread was started by another Octant host on the same Codex
home). Each carries its name, else the first line of its first
request, and its branch, for the picker only. Adopting reads the thread with
`thread/read`, which does not load it either (measured with codex-cli
0.170.0), refuses one whose folder is not the thread's, and resumes the
person's own thread: nothing is copied, so the history is the one their
Codex shows, and the thread's next turn resumes it with `thread/resume`
through the ordinary checks, which refuse a thread whose folder is not the
Project's. Which threads an Octant thread holds is the host's own journal,
read through the provider SDK's `ProviderSessionOwnership` port for every
Codex account (accounts may share one Codex home): every thread an Octant
thread starts, takes up or forks is journaled with its resume cursor. A held
thread is neither offered again nor adopted by a second Octant thread.
Between the driver's claim and the host's record the claim is held in the
driver, the check and the claim are one step, so two adoptions of one session
take turns, and `release` gives the claim back only while it names the
adoption's own session. Codex fixes a thread's app tools when it
starts it and a resume cannot add any, so an adopted thread runs with Codex's
own tools and none of Octant's: its cursor is marked `adopted`, a turn that
offers Octant's tools resumes it rather than asking for a text handoff, and
no rule about an Octant tool reaches its model. A session still open in the
person's own Codex keeps its writer there, and the resume reports that
another Codex process is using the thread until it closes.

**Codex fork and rewind** (maintainer request, 2026-11-18; built for fork and
rewind, maintainer decision 2026-11-19). A Code fork or rewind continues a copy
of Codex's own thread rather than a text handoff where it can, as Claude Code's
does ([Fork and rewind](#fork-and-rewind)). Each completed turn journals its
Codex turn id as its native anchor, and the driver's `forkSession` calls
`thread/fork` with `lastTurnId` set to it, `cwd` set to the Project's folder
and `excludeTurns`. The copy keeps the source's app tools (measured with
codex-cli 0.170.0), so its cursor carries the source's tool record and
`adopted` mark. Codex leaves the copy loaded in the app-server that made it,
and another app-server's resume refuses a loaded thread, so the copy is made on
a short-lived catalog process of its own that closes as soon as the copy
exists; the fork's first turn or the rewound thread's next turn then resumes it
on its own lease, leaving the source thread untouched, and the journal holds
the copy from then on. Each copy has a process of its own, so two concurrent
copies never leave one loaded while the other is made. Codex reports
`sessionRollback` supported from `0.143.0` (the first release whose
`thread/fork` cuts at `lastTurnId`) and `unsupported` on older releases; the
rewind preview promises a native copy only when Codex is `0.143.0` or later,
the folder and mode match the kept turn's session binding, and the last kept
turn journaled its Codex turn anchor. A fork onto its own worktree, a different
folder or mode, a turn with no anchor, a Codex release older than `0.143.0`, or
a failed copy goes back cleanly with the text handoff. Files come back only
through Octant's checkpoints.

**Codex skills and plugins in `@`** (maintainer requests, 2026-11-18 and 2026-11-19; built).
The composer's `@` menu lists Codex's own skills and plugins after Octant's,
labelled as Codex's. The probe reads the account's skills with `skills/list`
(no folder: the `user`, `system` and `admin` scopes; a Project's skills are
not the account's) and its installed, enabled plugins with
`plugin/installed` (codex-cli 0.135.0 and later), into the observation's
`mentions`; a release that lists neither offers none, and a failed read never
fails the probe. In a local Work or Code thread (or draft), opening `@` also
queries `skills/list` for the thread's own folder (`cwd` / checkout / working
directory, bypassing Codex's cache) **only when the thread's launch actually
loads Project skills** (`nativeSetup.skills === true`). Project skills are
marked `scope: "project"` and labelled **Project** beside the account's skills
(winning deduplication if a Project skill shares a name with an account skill);
when Project skills are off (`nativeSetup.skills !== true`), or for a Chat
thread or server Project with no local folder, no Project skills are listed
and no disabled or greyed rows appear. Choosing one writes Codex's own
reference into the draft:
`$name` for a skill, `@name` for a plugin. At send the driver reads the
prompt's `$name` and `@name` references and resolves each against Codex's
own listing for the thread's folder, never a path the client sent: a skill
becomes a `skill` input item with the `SKILL.md` path `skills/list`
reported, a plugin a `mention` item naming `plugin://<name>@<marketplace>`,
beside the text, which keeps the reference. A Project skill Octant switched
off for the thread, a disabled skill or plugin, plugins on a thread whose
plugins are off (Chat), and a name two skills or two plugins share are never
sent as items; a listing that fails sends none, and Codex still reads a
`$name` in the text by itself. At most 16 items go with one turn.

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
access, as plain paths; the driver only picks one by level and by Strict
(`openCodeProtectedPathsFor`) and imports no host policy. Outside Strict the
Full access list applies at every level, so OpenCode's own tools use the
other protected files as on their own, and its wall drops the same files
(`protectedFiles: "provider-sign-ins"`); Strict keeps the whole list below
Full access ([Architecture: Octant adds no restrictions of its own unless
Strict is on](../architecture.md#security-and-authority)). A Full access launch
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
as 2.0.22, with no change to routes or events), on macOS and Linux, where
the probe registers an empty bridge and OpenCode lists its tools (Linux
built under [Provider reach Octant no longer narrows](../architecture.md#security-and-authority),
maintainer decision, 2026-11-16). A Linux launch reaches the bridge as Pi's
does: on the shared host network a provider launch has by default, or, when
Network limits proxy the launch, through the egress forwarder's loopback
relay, which opens only the bridge's port; Windows is not offered the tools.
Those two exact releases are a launch-confinement attestation (the
hostile-configuration check proves no other tool enters the launch), not a
feature claim, so the release-range rule under
[Probe before a profile ships](#probe-before-a-profile-ships) does not widen
them: on any other 2.x release a Full access thread is offered the tools as
mixed, as on 1.x. OpenCode's other 2.x floors (question forms and command
routes from 2.0.22, native file-change and compaction routes from 2.2.0) are
the earliest releases whose server was read for those routes, and every later
release keeps them. Project resolution
starts Git, which the Chat, Plan, and Work jail refuses; on macOS those
launches get the failing `git` stand-in described under
[Security and authority](../architecture.md#security-and-authority), so 2.x offers turns in
every mode there. On Linux 2.x runs turns in every mode too (maintainer
decision, 2026-11-16, replacing the 2026-11-14 refusal of Chat and Plan): its
Chat and Plan launches start processes inside a read-only capsule with the
same stand-in first on `PATH`, and the probe attests that capsule
([Plan and Chat tool parity](../architecture.md#security-and-authority)). On Windows
2.x runs turns in every mode outside Strict without an Octant jail (below). A
host that is neither macOS, Linux, nor Windows refuses a 2.x Chat or Plan launch before
it starts with a sentence naming why and reports `turnModes` with Chat and
Plan unsupported (`host-confinement`), which the provider's Settings page
shows as where it runs turns. Rationale: there the jail Chat and Plan need can
start no process, so it cannot give them the `git` the runtime starts. 2.0.22 names its turn events without the `session.next.`
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
admitted by the file-change check while the native process that earned them
runs; the admission is a ledger of that process's generation, retired with
it, so a later connection of the same Project admits nothing the earlier
process remembered, and after a host restart or process exit such an edit
fails the turn until it is approved again. The ledger holds at most 1,024
file names per process and fails closed: a request whose new names would not
fit whole is answered `once` instead of being remembered by half, and a
request OpenCode settles by itself cannot be re-answered, so the same full
ledger leaves it the one-use admission a `once` answer gives rather than
nothing. Approval-gated on
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
what they run. Today `task` follows the level like any other call: it asks
at Guarded, goes to the reviewer at Reviewed, runs at Full access and is
denied in Plan. Decided (maintainer decision, 2026-11-15; designed, not built;
[the provider's own permission system decides](../architecture.md#security-and-authority)):
`task` is always allowed outside Plan, and Plan still denies it. Sessions OpenCode's `task` tool delegates to are followed from
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
this host process), so the thread starts on a new session. The denial is a
tombstone the driver keeps for the host's whole life rather than a list it
can evict, and a `session.deleted` the provider reports clears the session's
own tombstone — a deletion is an ending, not a doubt. The tombstones are
bounded to 4,096; a 4,097th distinct denial cannot be represented, so
refusal latches for every resume — an id the cap dropped or one never seen
— until the host restarts, while a new session may still start. The tool catalogue a
session's resume may reuse is bounded to 128 catalogues held for 30 minutes
each, dropped oldest-first past that; a resume that misses simply installs
no app tools rather than another session's, and a deleted or stale session's
catalogue is dropped with it. Such a turn runs
in every mode, Chat and Plan included (maintainer decision, 2026-11-16;
built). A command may run a shell before the model sees it: a configured
command's template expands `` !`…` `` through OpenCode's shell, which asks no
approval, inside the launch's own confinement, so in Chat and Plan, whose
launch allows no process and binds the root read-only, that expansion fails
and the command cannot write, as the level's tool rules require. 1.x lists none: its `POST /session/{id}/command`
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

### OpenCode subagents, Strict and sessions

OpenCode's `task` (2.x `subagent`) starts without asking at every level
outside Plan, as OpenCode's own default agent starts it (maintainer decision,
2026-11-15). Starting one changes nothing by itself: the child session runs
under the same rules, and each edit, command or outside folder it asks for
reaches the person through the parent's approval path
(`openCodeChildSessions.ts`). Plan still denies both names, and a person's
own OpenCode rule denying `task` still wins, since their rules come after
the level's allows.

OpenCode serves every session of a connection from one process, whose wall
and permission rules are fixed at its start, so the process is keyed on
Strict as on the level: a session asking for the other Strict value than the
running process was started with is refused, as a wider level is, and the
next start launches a fresh process.

An empty Work or Code thread can start from one of the person's own
OpenCode sessions in its folder (`openCodeNativeSessions.ts`), and a Code
fork continues OpenCode's own fork of the source session. OpenCode keeps
every session in one store, which a launch shares with the person's own use,
so the sessions it lists for a folder are the person's and Octant's alike.
Listing, taking up and forking run against a server for the folder started
outside any thread: the readiness check's launch (Chat's posture, or Work's
at Ask first where OpenCode 2's Chat and Plan jail starts no process), held
as its own lease per folder so its confinement binds that folder. 1.x lists
through `GET /session?directory=`, 2.x through `GET /api/session` with the
folder as `directory` (opencode 2.0.22 and 2.2.0, `protocol/src/groups/session.ts`).

Which OpenCode sessions an Octant thread holds comes through the provider
SDK's `ProviderSessionOwnership` port, which the host hands any driver that
takes up its own sessions, first-party or not, and answers from its own
journal (`providerSessionHolds.ts`): every session an Octant thread starts,
takes up or forks is journaled with its resume cursor (its driver kind, the
session id as its value), so any journaled cursor of the kind naming a
session holds it. A session is held for every instance of the kind, not only
the one whose thread holds it: two OpenCode accounts keep the person's one
data folder, so a session one account's thread holds is not another's to
take up. The record is the journal itself rather than a copy that could
drift from it; it is read once per kind and then from where the last read
stopped, so a session a purged thread held stays held until the host
restarts. The list offers the newest 50 sessions
whose folder is the thread's exactly, leaving out every held session and
every session OpenCode started inside another (a subagent's or a fork's,
which carries a parent), with the title OpenCode keeps for each. Adopting
refuses a held session, then reads the session from OpenCode and refuses one
in another folder or one OpenCode does not have, and claims it for the
thread; the cursor it answers names OpenCode's own session, which the
thread's next turn resumes through the ordinary checks. The check and the
claim are one step for each session, so two threads adopting one session at
once take turns and the second is refused; the claim lasts until the host
journals the adoption (which then holds it) or the driver's `release` gives
it back. Without the journal record a driver offers no sessions to start
from. The person's own OpenCode keeps working on the session, which Octant
never copies; continuing it in both places writes one conversation from two
sides, as with Claude Code.

A completed OpenCode turn names its last assistant message as its native
anchor: 1.x reports it on `message.updated` with the message's role, 2.x on
each step and output event as `assistantMessageID`; a delegated session's
messages are not counted. The driver's `forkSession` uses OpenCode's own
fork, which copies a session's history before a message (1.x `POST
/session/{id}/fork` with `messageID`, 2.x `POST /api/session/{id}/fork` with
`before`) and leaves the source alone: it finds the message after the anchor
(1.x reads the session's messages, 2.x reads them newest first a page at a
time, at most 50 pages of 200) and forks before it, or forks the whole
session when the anchor is the newest message. The source's own thread may
add a message between that read and the fork, so a whole-session fork reads
the source again afterwards, and a message after the anchor then removes the
copy and sends the text handoff instead. Only a session this instance
opened for the fork's own folder and mode is forked; another folder or mode,
an anchor OpenCode no longer holds, or a runtime without the routes goes
back with the text handoff.

A Code rewind continues the same kind of copy: OpenCode reports
`sessionRollback` supported, and the rewound thread's next turn resumes
OpenCode's fork of the kept turn's session cut at that turn's anchor, under
the same folder and mode checks, so the removed turns never reach the model
and the source session stays as it was. A kept turn with no anchor, or a
copy that fails, goes back with the text handoff. Rationale: OpenCode's own
undo (1.x and 2.x `POST /session/{id}/revert` with a `messageID`, and
`unrevert`) is not used. It rolls the session back in place and also puts
files back from OpenCode's own snapshots (the session's `revert.snapshot`
and `diff`), while a rewind's files come back only through Octant's
checkpoints, and only when the person chose files; a second restore beside
the checkpoint's would disagree with the journal, and a conversation-only
rewind would change files. Rolling the source back in place would also
change a session that earlier turns' anchors and a fork made from it still
name.

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
driver reports `nativeAttachments` supported when any listed model does. In
Work and Code any other file is named by its path in the thread's attachments
folder, which Pi's launch confinement reads and never writes, at every level;
in Chat it follows Chat's rule. An image to a text-only model is refused unless
Sees images describes it. Octant reviewed Pi's tool attestation, approval
bridge, and confinement on 0.85.1 and from 1.1.0; app-managed tools are
reported for every release from 0.85.1 whose probe attests the tool bridge,
and one between 0.85.1 and 1.1.0 keeps them unverified, as its runtime card
says (maintainer decision, 2026-11-21). A newer Pi therefore needs no Octant
release; a release older than 0.85.1, or one whose probe does not attest,
lists its models and reports app tools unsupported, and a session that
offers tools on it is refused with a message that names 0.85.1. Warm reuse
of a settled process was reviewed on 0.85.1 and holds from that release on;
an older release closes the process and cold-resumes the native history. Pi 1.1.0 adds `aborted` to `agent_settled`:
an aborted run is reported as interrupted, never as completed. A Pi session
runs on the model it was opened with, so a resume that names another is refused
as `stale-resume` rather than run on the old model unseen. Pi 1.0.3
renamed the Azure provider from `azure-openai-responses` to `azure` and kept
its `AZURE_OPENAI_*` variables, so a thread holds them under either name.

A message the person sends into a running Pi turn is steered into it with
Pi's RPC `steer`, which Pi delivers after the current step finishes its tool
calls and before the next model call (Pi's RPC command reference); a steer Pi
declines leaves the turn as it was and reads as not steered. The person may
compact a Pi session between turns: Pi's RPC `compact` compacts it in any
mode, and the reply's `tokensBefore` and `estimatedTokensAfter` are reported
with the requested compaction, which may take up to ten minutes. A refusal
from Pi is reported as a failed compaction that may have changed the session,
since its reply does not say how far it got.

An empty Work or Code thread can start from one of the person's own Pi
sessions in its folder (`piNativeSessions.ts`). Pi keeps each session as a
JSONL file under `<sessions>/--<folder>--/<timestamp>_<id>.jsonl`, where
`<sessions>` is `PI_CODING_AGENT_SESSION_DIR`, else the agent folder's
`sessions`, and the first line is its header naming its id and folder (Pi's
session file format reference). The list offers the newest 50 whose header
names the thread's folder, with the name the person last gave each. Adopting
copies the session into Octant's own Pi session folder under the thread's
session id, with `parentSession` naming the file it came from, as Pi's own
fork records its source, and the thread then resumes the copy through the
ordinary checks. The person's file is never written, so their own Pi keeps
working on it; the copy's `parentSession` is the record that a thread holds
that session, which is then neither offered again nor adopted by a second
thread. A `sessionDir` set in Pi's settings file is not read.

A Code fork continues a copy of the source's Pi session, made as Pi's own
fork makes one (`forkPiSession`). A completed Pi turn names the id of the
last entry Pi wrote to the session as its native anchor, read from the
session file's tail when the run settles. The driver's `forkSession` writes
a new session file under the fork's session id whose header records the
file it came from in `parentSession`, holding the source's entries up to and
including the anchor, so Pi resumes it with the anchor as its leaf; the
source is never written. Only a session this instance opened for the fork's
own folder, mode and model is copied (Pi keeps the model a session was opened
with and refuses a resume onto another); any other fork, an anchor the file
no longer holds, a file over 64 MB, or a fork session that already has a
history goes back with the text handoff.

A Code rewind continues the same kind of copy: Pi reports `sessionRollback`
supported, and the rewound thread's next turn resumes a new session file
copied through the kept turn's anchor entry, under the same folder, mode and
model checks. Pi's own way back in a session (moving the leaf to an earlier
entry of its tree) changes the source session, which earlier turns' anchors
and any fork made from it still name, so it is not used; the source file is
never written. A kept turn with no anchor, a thread now on another model, or
a copy that fails goes back with the text handoff. Files come back only
through Octant's checkpoints, as for every provider.

### OpenCode and Pi without Octant's sandbox

On macOS and Linux a Work or Code launch of OpenCode or Pi below Full access
outside Strict starts with no Octant sandbox, as every Windows launch does,
and the provider's own approvals hold the thread's level (maintainer
decision, 2026-11-21; built). The rule is the domain's
`providerHoldsLevelWithoutSandbox` (`guardrailPolicy.ts`), shared with the
ACP agents; `openCodeStartsUnconfined` (`openCodeProcess.ts`) and
`piStartsUnconfined` (`piProcess.ts`) apply it.

- **OpenCode** keeps its session permission rules unchanged: below Full
  access `edit` asks at Ask first, `bash` and every other tool ask at Ask
  first and Accept edits, and `external_directory` asks for any folder
  outside the Project, each ask answered and journaled on Octant's server.
  Its read refusals for other providers' sign-ins still hold for its own
  tools. A verified release on Octant's private configuration (no Project
  config loaded) is attested `privateConfiguration`, which admits Octant's
  app-managed tools without claiming OS confinement, as on Windows; a
  release the probe did not verify, or a launch that loads a trusted
  Project's own configuration, gets them only as before.
- **Pi** has an approval channel of its own: Octant's bridge extension asks
  Octant, by the thread's level, before every tool call but `read`, `grep`,
  `find`, `ls` and Octant's app tools, so `bash`, `edit` and `write` and an
  extension's own tools all ask. The launch is otherwise the one the
  sandbox wrapped: the same arguments, the same environment, approvals on.
- **Still wrapped:** Chat, Plan, Strict, a Full access thread that keeps its
  sandbox, a chosen sandbox policy, and the readiness check and version
  read. Open Full access stays unwrapped as before.
- **No wall:** an unwrapped launch takes no egress proxy and no
  registered-server folder, as Full access does, so Network limits and the
  Project's server folder do not bind it.

Cost, accepted with the decision: below Full access the process may read and
write anything the person can, and only the approvals it asks for bind it.
Pi's `read`, `grep`, `find` and `ls` ask nothing inside the launch's folders
(the Project root, its extra folders and the thread's attachments); unwrapped,
Octant's approval bridge asks before one reaches any other path, links
resolved (`OCTANT_PI_READ_ROOTS`), so another provider's sign-in is never read
without the person's yes. OpenCode asks for an outside folder and refuses
those sign-ins by rule. The person's own Pi extensions and OpenCode plugins
in a trusted Project run unwrapped too. A person who wants the wall turns
Strict on. Rationale: both providers already carry every side effect to
Octant as an approval, the same rule that holds the level for them on
Windows, so outside Strict the wall below Full access only added a limit of
Octant's own ([Architecture: Octant adds no restrictions of its own unless
Strict is on](../architecture.md#security-and-authority)).

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
trusted Project loads that Project's own files in Work and Code outside
Plan. Every Project the person added is trusted outside Strict; under Strict
only one whose code the person allowed (maintainer decision, 2026-11-18). Each profile's `nativeSetup` releases what its launch
otherwise holds back, and its `nativeSetupSupport` reports only those
features:

- **A trusted Project.** The profile's `forbiddenRootEntries` become
  readable, so the agent loads the Project's skills, settings, MCP servers,
  hooks, plugins, and agent files as it does on its own, under its own folder
  trust where it keeps one. Each agent's entries are listed in
  `PROJECT_CODE_ENTRIES` (`packages/domain/src/projectCodeTrustPolicy.ts`),
  so the Strict prompt names them; a test holds the two lists together, and
  another that no profile holds back a Project instruction file.
  Gemini CLI and Qwen Code start in a trusted Project instead of refusing it.
  Grok Build's `trusted_folders.toml` becomes readable, so its own trust list
  decides; Grok reads a Project's instructions only in a folder that list
  trusts, so a folder the person never trusted in Grok gets none (not
  built: telling Grok the folder is trusted at launch).
- **Nothing held back outside Strict.** Outside Strict a session that carries
  the person's setup holds back none of the profile's `forbiddenRootEntries`,
  `hostDeniedEntries` or home `forbiddenEntries`, in every mode, Plan and
  Chat included, and Gemini CLI and Qwen Code start in every Project
  (`acpLoadsAllOwnSetup` in `apps/server/src/providers/acpProfiles.ts`,
  maintainer decision, 2026-11-21, as Google Antigravity's profile already
  did). Plan stays read-only through its OS wall. The profile's environment
  guards still follow its `nativeSetup`. Under Strict, in Plan, in Chat and
  in a thread whose Project's code is not allowed, every entry the setup does
  not release stays held, and the two refusals stay; so they do outside
  Strict for an account or thread whose person turned the setup off.
- **The person's own home.** Kimi Code reads its home `AGENTS.md` with any of
  the setup, `skills` with skills, `mcp.json` and `plugins` with tool servers,
  and `hooks` with hooks (never in Chat or Plan). Kilo unsets
  `KILO_DISABLE_EXTERNAL_SKILLS` with skills.
- **Instruction files.** A Project's instruction text is never held back:
  fx reads the Project's `AGENTS.md`, and Mistral Vibe its Project context
  (no `VIBE_INCLUDE_PROJECT_CONTEXT` guard), in every mode, with or without
  the person's setup, Strict and Plan included.
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

Kimi Code's own slash commands run in every mode, Chat and Plan included, as
in its own app (maintainer decisions, 2026-11-14 and 2026-11-16; built). No
reviewed command inventory gates a release (maintainer decision, 2026-11-21;
built): whatever commands a release lists, the readiness check keeps the
listing and passes, and a prompt opening with `/` runs a command the session
listed, or the readiness check listed until the session lists any, at every
level (`listedCommandsOnly`); an unlisted one is refused before it reaches the
agent. In
Plan and Chat the session's own mode, set for the level, decides what a
command such as `update-config` may do. The earlier refusal everywhere was
Octant's default, not a protocol limit: ACP carries the command as prompt
text.

### Approvals kept for the session, and steering

Decided (maintainer decision, 2026-11-21; built): both apply to every ACP
agent, shipped profile or added.

- **Allow always.** Where a permission request offers the agent's own
  `allow_always` option and the person keeps approvals for the session
  (permission persistence `current-session`), an approval chooses it, so the
  agent stops asking for that call as Octant itself would. A one-call answer
  (`scope: "once"`: an automatic reviewer's, or one on a child run's behalf)
  and persistence `project-default` choose `allow_once`. The driver reads
  the host's default persistence, which every ACP driver (shipped profile or
  added agent) is given; one built without it fails closed to
  `project-default`. A Code thread keeps its own persistence: one set to
  `project-default` sends each answer as a one-call answer, so a host
  default of `current-session` cannot widen it. The reverse, a
  `current-session` thread under a `project-default` host default, still
  chooses `allow_once` and the agent may ask again; carrying the thread's
  setting on each answer needs a provider SDK change. Offered
  `allow_always` with no `allow_once`, any other approval is refused and
  nothing is sent, and a helper run denies such a request on arrival, as
  described for [Google Antigravity](#google-antigravity). Before this, only
  Google Antigravity chose it.
- **Steering.** A profile whose agent folds a second `session/prompt` into
  the turn already running (`steersMidTurn`; Google Antigravity, per
  Google's ACP guide) offers the provider SDK's `steer`: the note goes as
  another `session/prompt` on the same session, as text only, while the
  first is still open, and its events continue on the same Octant turn.
  The turn ends when the last open prompt answers: an earlier prompt's
  answer, whatever its stop reason (the agent may end it `cancelled` once
  the note takes over), is part of the turn, and the last answer decides
  completed, interrupted or failed and settles the turn's usage (its token
  counts stand for the turn; an earlier answer's are not added, while a
  cost read from the session's running total still covers both). A prompt
  that fails ends the turn at once. `steer` answers `unsupported` with no
  turn running, while compacting, for an empty note, and for a note that
  opens with `/`, which would run an agent command no review admitted.
  The host steers through it where it steers any runtime: a person's note
  to a running child run, a finished child's result into a running parent
  turn, and a message the person sends into a running Work or Code thread
  (maintainer decision, 2026-11-21; the queue offers it,
  [Architecture](../architecture.md#persistence)). Every other ACP agent
  offers no `steer`, so those wait for a turn of their own, and a prompt
  `send` delivers while a turn runs is refused for every ACP agent; a
  person's message to such an agent's running thread waits in the host's
  queue for the next turn. Rationale: other ACP
  clients either steer this way or cancel the turn and resend; cancelling
  would discard the work under way, and an agent that does not take a
  second prompt would fail the turn, so the flag is per profile.

### Own sandboxes checked and not switched

Under [Providers run in their own sandbox](../architecture.md#security-and-authority)
an agent's own sandbox replaces Octant's profile only where it keeps other
providers' sign-ins unreadable: one provider never reads another's
credentials, Strict or not, as OpenCode's launch outside Strict keeps the
Provider sign-ins group refused (`protectedFiles: "provider-sign-ins"`).
Each agent below keeps Octant's profile below Full access, and Strict and
Full access are as they were.

- **Gemini CLI** 0.68.0 runs each tool command in its own sandbox when
  `security.toolSandboxing` is set (Seatbelt on macOS, Bubblewrap on Linux),
  and a command that needs more raises a `sandbox_expansion` confirmation
  its ACP server sends as `session/request_permission`. Its sandbox reads
  every file but the Project's `.geminiignore` entries: no setting takes a
  deny list Octant could write (`tools.sandboxAllowedPaths` only widens),
  and an expansion can widen reads to any path, so `~/.codex/auth.json` or
  another provider's managed home would be readable.
- **Qwen Code** 0.27.4 relaunches itself, ACP included, under `sandbox-exec`
  when `QWEN_SANDBOX` names it, but every built-in Seatbelt profile it ships
  allows all reads (`permissive-*` allow everything, `restrictive-*` keep
  `(allow file-read*)`), and a custom profile is read only from the
  Project's `.qwen` folder, which Octant does not write. On Linux its sandbox
  is Docker or Podman, which Octant does not start.

- **Copilot CLI** 1.0.112 has a command sandbox (its MXC layer: Seatbelt on
  macOS; Bubblewrap with a private network namespace on Linux, needing
  `slirp4netns`, `iptables` and `/dev/net/tun`) and a per-command bypass.
  Its help says `--sandbox` enables it for one session, but `copilot --help`
  on 1.0.112 does not list that flag, the setting otherwise lives in the
  person's own `settings.json`, which Octant does not write, and whether a
  bypass reaches an ACP client as a permission request needs a signed-in
  probe. It keeps Octant's profile.
- **Cursor** has no probed release on this stack, so it keeps Octant's
  profile wherever it is added as [any ACP agent](#any-acp-agent).
- **Grok Build** 1.0.77 applies its own sandbox to its own process
  (Seatbelt on macOS, Landlock on Linux), so inside Octant's Seatbelt profile
  it would nest one Seatbelt profile in another, which macOS refuses:
  `GROK_SANDBOX=off` keeps the person's `[sandbox] profile` from making it
  try. Switching to Grok's own sandbox outside Strict was checked and not
  done: its built-in profiles log a warning and run unenforced where the
  kernel cannot apply them, write only the folder Grok starts in (not the
  Project's extra folders), and the custom profiles that refuse to start
  when they cannot be applied live only in the person's `~/.grok/sandbox.toml`
  or the Project's `.grok/sandbox.toml`, neither of which Octant writes; no
  per-command grant reaching an ACP client could be read from the release.

### Usage an ACP agent reports

Every ACP agent records its usage in Octant (maintainer decision,
2026-11-20). A profile that names a reviewed reading (`usageVersions`:
Mistral Vibe 3.0.3, whose figures are cumulative, under
[Mistral Vibe surface](#mistral-vibe-surface)) is read only by that rule,
on those releases and, unverified, on every later one
([Probe before a profile ships](#probe-before-a-profile-ships)). Every other agent, built-in or added, is read
by ACP's standard usage, and its probe declares `usage: "supported"`
(`acpTurnUsage` and `finishAcpReportedTurn` in
`apps/server/src/providers/acpUsage.ts`). The schema is ACP's unstable
`Usage`, `UsageUpdate` and `Cost` as published in
`@agentclientprotocol/sdk` 2.8.0 (`schema/v1/schema.unstable.json`).

- **Tokens.** The `session/prompt` reply's `usage` is "token usage for this
  turn" and is the turn's figure, emitted once, before the turn's terminal
  event. Its `totalTokens` is the "sum of all token types", and the schema
  does not say whether `inputTokens` already counts `cachedReadTokens` and
  `cachedWriteTokens`, or whether `outputTokens` already counts
  `thoughtTokens`. The total decides: Octant takes the first reading whose
  parts add up to it, every type disjoint first (as the schema's sum
  describes), then cache inside input and thought inside output, then each
  mixed nesting. Octant's input is all input, cached or not, kept also as
  cache reads and writes, and its output counts thinking, with
  `thoughtTokens` kept as its reasoning part (`reasoningTokens`), as every
  provider's usage reads it: a spend reservation settles at input plus
  output and never adds reasoning a second time. A reply whose
  parts fit no reading, or with no total (the schema requires one) and no
  reviewed rule for that (`turnUsageWithoutTotal`), reports nothing.
- **Context.** A `usage_update`'s `used` of `size` during the turn becomes
  the turn's context reading; an update from an earlier turn is not carried
  into a later one.
- **Cost.** `cost` is the session's cumulative cost. A turn is charged what
  it grew by since the last settled turn, so an update that arrives after a
  reply is charged to the next turn rather than lost. A turn with no cost
  update since the last settlement is left without a provider cost rather
  than charged zero, so the ledger estimates it. The next cost update then
  grows across that turn as well, and charging it to one turn would count
  the estimated turn twice: that turn is left without a provider cost too
  (it is estimated), its update only resets the baseline, and exact
  charging resumes on the turn after it. An update restating the same
  total charges zero. A
  session Octant opened
  with `session/new` starts from zero; one it loaded or resumed is priced
  from the second cost it sees, and a cost the agent reports while
  `session/load` or `session/resume` runs counts as the first (Octant reads
  usage updates from before it opens the session). Only `currency: "USD"` becomes `costUsd`;
  another currency or unit ("credits"), a cost that fell or a changed unit
  leaves the turn without a provider cost, so the ledger estimates it or
  refuses a money ceiling as unknown spend.
- **No report.** A reply without whole counts records the turn as
  unreported. Because the capability is supported, a money or token
  ceiling refuses after such a turn as unknown spend, as for any measuring
  provider, where it used to leave ACP turns out as Not measured.
- **Failed turns.** A turn's consumer stops reading at its failure, so a
  failure the driver raises mid-turn (a protocol fault, a refused question,
  an undeliverable form answer) or a rejected prompt first offers the usage
  observed so far. Only a pinned reading has any before the reply (its
  cumulative snapshots since the turn began, and none until the agent sends
  a snapshot after the turn began, so a turn that failed first records
  unreported rather than zero); a standard agent's failed
  turn records unreported, and its reply, if one still comes, settles the
  session cost so the next turn is charged only its own share.

Not verified: the schema also calls these figures "total ... across all
turns", and Mistral Vibe's reply is cumulative. An unpinned agent whose
reply is cumulative would be over-counted, and the usage contracts carry no
confidence marker to flag that per row; a profile pins its reading once a
probe shows otherwise. Each built-in profile's reply shape remains a
live-probe check.

### What an ACP agent cannot do

The protocol leaves two things to the agent, and the driver reports them as
absent rather than imitating them:

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
(or the profile names a reviewed release that accepts it unadvertised, and
the running release is that one or later) and the
host is macOS, Linux or Windows (Linux built under
[Provider reach Octant no longer narrows](../architecture.md#security-and-authority),
maintainer decision, 2026-11-16; Windows under
[Windows launches](#windows-launches)). A Linux launch reaches the bridge on the
shared host network, or through the egress forwarder's loopback relay for
the bridge's port alone when Network limits proxy it; a Windows launch has no
Octant sandbox and reaches it directly.
Otherwise the session reports app-managed tools `unsupported`,
and a session that is offered tools is refused before `session/new` rather
than started without them.

An ACP agent takes a file natively only as a prompt block its own
`initialize` result advertises (maintainer decision, 2026-11-14; any-type
attachments, 2026-11-16). With `promptCapabilities.image` every listed model
takes images, and each image goes as an ACP `image` content block after the
prompt text. With `promptCapabilities.embeddedContext` every listed model
takes documents (text, PDF and office files), and each goes as an embedded
`resource` block: its text as `TextResourceContents` when its bytes are UTF-8
text and it is not a PDF or office file, otherwise its bytes as
`BlobResourceContents` (a PDF stays bytes even when they decode), under an
`attachment:<id>/<name>` URI that names the attachment, not a path. ACP states
these for the agent, not per model. With `promptCapabilities.audio` every
listed model takes audio, and each recording goes as an ACP `audio` block
with its bytes in base64 (built, 2026-11-20). The probe reports
`nativeAttachments` supported when any of the three is advertised. In Work and Code any other file (an
archive, a binary, or a document to an agent without embedded context) is
named by its path in the thread's attachments folder, which the agent's launch
confinement reads and never writes, at every level; an ACP `resource_link`
block is not sent, since the path in the message already reaches every agent.
In Chat a file the agent does not take natively follows Chat's rule
([Plan and Chat tool parity](../architecture.md#security-and-authority)). An
attachment of a kind the agent advertised no block for is refused rather than
dropped; audio to an agent without the `audio` block goes as an embedded
resource where it advertises embedded context.

A turn's `session/prompt` has a budget of silence, not of total time (built,
2026-11-20; 15 minutes and the tool-call pause by maintainer decision,
2026-11-22): 15 minutes, restarted by every message the agent sends, and
standing still while the agent waits on an answer from Octant (an approval,
a question, a client request) or while a tool call it started in that
session is still running (a `tool_call` or `tool_call_update` that is
`pending` or `in_progress`; a native subagent runs as such a call). The clock
restarts from zero when the last running call completes or fails, and the
turn ending or being cancelled forgets calls left running. A turn that keeps
streaming is never cut; before, a fixed ten minutes failed long agentic turns
that were still working. It stays a hard cut-off in every mode, Strict or
not, because ACP agents do leave `session/prompt` pending forever after their
last output; the pause exists because a long build or subagent can be silent
for longer than any quiet budget while it is still working. The stalled-turn
limit is separate and unchanged. A session config option that is not a `select` (ACP also defines a
boolean toggle) is left out of what Octant reads, since Octant sets none,
instead of failing the whole `session/new`, load or update reply that
carried it.

### Registry coverage

Snapshot of the official ACP registry
(`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
read from its source repository `agentclientprotocol/registry` at commit
`814a241`, 2026-10-25). **Shipped** has a profile; **probe next** needs the
live probe below before a profile ships; **blocked** will not ship as an ACP
profile for the stated reason. The registry command is its macOS
distribution. Since the 2026-11-21 maintainer decision a probe next agent may
also ship as an unverified profile without the live probe (below).

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
| `antigravity-acp`         | Google Antigravity | `agy_acp_server.par` (binary)                          | Shipped as `antigravity` on the official `agy` CLI; adding the registry server points to it         |
| `junie`                   | Junie              | `junie --acp=true` (binary inside `junie.app`)         | Listed for adding as any ACP agent; profile needs the probe                                         |
| `amp-acp`                 | Amp                | `amp-acp` (binary)                                     | Listed for adding as any ACP agent; profile needs the probe                                         |
| `auggie`                  | Auggie CLI         | `npx @augmentcode/auggie --acp`                        | Listed for adding as any ACP agent; profile needs the probe                                         |
| `factory-droid`           | Factory Droid      | `npx droid exec --output-format acp-daemon`            | Listed for adding as any ACP agent; profile needs the probe                                         |
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
| `cursor`                  | Cursor             | `cursor-agent acp` (binary)                            | Listed for adding as any ACP agent; profile needs the probe                                         |
| `github-copilot`          | Copilot            | `npx @github/copilot-language-server --acp`            | Blocked: Copilot ships through the Copilot CLI entry; the language server is not a coding-agent CLI |
| `agoragentic-acp`         | Agoragentic        | `npx agoragentic-mcp --acp`                            | Blocked: registry quarantine (postinstall script)                                                   |
| `crow-cli`                | crow-cli           | `crow-cli acp` (binary)                                | Blocked: registry quarantine (initialize fails)                                                     |
| `deepagents`              | DeepAgents         | `npx deepagents-acp`                                   | Blocked: registry quarantine (missing dependency)                                                   |
| `fast-agent`              | fast-agent         | `uvx fast-agent-acp -x`                                | Blocked: registry quarantine (initialize times out)                                                 |
| `minion-code`             | Minion Code        | `uvx minion-code acp`                                  | Blocked: registry quarantine (Python dependency)                                                    |
| `qoder`                   | Qoder CLI          | `npx @qoder-ai/qodercli --acp`                         | Blocked: registry quarantine (initialize fails)                                                     |
| `vtcode`                  | VT Code            | `vtcode acp` (binary)                                  | Blocked: registry quarantine (missing Windows builds) until it is lifted                            |

Decided (maintainer decision, 2026-11-16; Google Antigravity built, the
rest designed, not built): the probe
next agents Google Antigravity, Factory Droid, Junie, Amp and Auggie, and
Kiro, Trae and Muse (not in the snapshot above), are to become first-class
profiles, each through the probe below; Cursor's block is to be rechecked
against the current release and lifted if its reason no longer holds. Every
other agent can be added as [any ACP agent](#any-acp-agent).

Rechecked against the registry's source at commit `131167e` (2026-11-16):
apart from Google Antigravity (below), none of these has a profile yet, because none has the signed-in probe below
on record and the registry entry gives only a command, not the
`agentInfo.name`, modes, sign-in folder or Project entries a profile pins.
They are listed for adding as any ACP agent instead (`ACP_REGISTRY_AGENTS`),
with the registry's macOS command: Google Antigravity (`agy_acp_server.par`,
1.5.0), Factory Droid (`npx droid@1.12.1 exec --output-format acp-daemon`),
Junie (`junie --acp=true` inside `junie.app`, 4020.10.0), Amp (`amp-acp`
0.13.0, a third-party wrapper), Auggie (`npx @augmentcode/auggie@0.37.0
--acp`), Kiro CLI (`kiro-cli acp --agent-engine=v3`, 3.0.0) and Muse Code
(`muse acp`, 1.4.14). Trae is not in the registry at that commit, so a
person adds it as a local command. Cursor's block was that its
compatibility probe through this stack never ran (registry 2026.11.13,
`cursor-agent acp`); that still holds for a profile, so Cursor too is listed
for adding as any ACP agent rather than kept out. Each listing carries the
registry's `darwin-aarch64` distribution at that commit: the archive address
and, where the entry has one, its `sha256` (Google Antigravity, Amp, Kiro
CLI, Muse Code), or the npm package at its exact release (Factory Droid,
Auggie), with the entry's environment. Junie and Cursor list no checksum,
so they install as unverified downloads.

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

### Google Antigravity

Built (maintainer decision, 2026-11-20): Google Antigravity is a shipped ACP
profile, `antigravity`, on Google's official CLI, `agy`, run unmodified as
`agy acp --process-per-session` with `AGY_CLI_DISABLE_AUTO_UPDATE=1`, in the
project directory. `--disable-telemetry` is added under Strict and while the
person keeps provider telemetry off, and the self-update guard is left out only
when the person lets providers update themselves outside Strict
([Provider channel switches](#provider-channel-switches)).

It stays inside Google's terms. Official sources, read 2026-11-20 and again
2026-11-21:

- **The ACP guide** (`antigravity.google/docs/ide/extensions/acp`, "Other
  editors (ACP)") is the sanctioned path: any editor that supports ACP can run
  `agy acp`, which "talks JSON-RPC over stdin and stdout"; "Every client
  except Android Studio registers the same command: agy with the single
  argument acp", and "The agent, its tools, and your settings come from
  Antigravity CLI". Its flag list is `--add-dir`, `--agent`, `--sandbox`,
  `--dangerously-skip-permissions`, `--process-per-session`,
  `--ide-mcp-port`, `--login`, `--log-file` and `--disable-telemetry`; Octant
  passes only `--process-per-session` ("Required for HTTP MCP servers that
  your editor configures", which is how Octant offers its tools) and
  `--disable-telemetry`, both listed, and never
  `--dangerously-skip-permissions`. "Gemini models are available in every
  client. Third-party models are only offered to JetBrains IDEs (including
  JetBrains Air), Android Studio, Android Performance Analyzer, Zed, and
  Xcode", so Octant gets Gemini models alone and sends no other client's
  identity. Its sign-in methods are `oauth-personal` (a personal Google
  account), `oauth-business` (Gemini Enterprise), `gemini-api-key`
  (`GEMINI_API_KEY` in the agent's environment), `agent-platform` (formerly
  Vertex AI, Application Default Credentials) and `terminal-login`; `agy acp`
  reuses the credentials cached by an interactive `agy` session.
- **The FAQ** (`antigravity.google/docs/faq`): "Using third-party software,
  tools, or services to access Antigravity is a violation of our Terms of
  Service ... Such actions can result in suspension or termination of your
  account", recommending "a Gemini Enterprise or Google AI Studio API key"
  for a third-party coding agent; and headless mode (`agy -p`) "is intended
  for direct scripting and CI workflows. Wrapping agy inside third-party
  coding agents or applications, or automating account rotation, is not
  supported under consumer plans".
- **The Antigravity Additional Terms of Service** (`antigravity.google/terms`):
  "Using third party software, tools, or services to access the Service ...
  is a breach of this Agreement" that "may be grounds for suspension or
  termination"; access "through Gemini Enterprise (Google Cloud), Gemini
  Enterprise for Business or a Google Workspace subscription ..., or with an
  API Key in Gemini for business" is governed by "the terms of use accepted
  or signed by your administrator".

Octant is the ACP client the guide describes and does nothing outside it: it
never reads, copies or replays the CLI's OAuth credentials. One knob is not
in Google's documentation: `AGY_CLI_DISABLE_AUTO_UPDATE=1` (absent from the
ACP guide, the CLI reference, settings, install, troubleshooting and
changelog pages read 2026-11-21, which document other `AGY_CLI_*`
variables). It is kept because it only stops the CLI updating itself
mid-session, which the person controls through the provider's self-update
switch. Following the FAQ's headless answer, Octant never runs `agy -p` (not
even for `/usage`) and never rotates or switches Antigravity accounts by
itself; one person's own sign-in serves their own threads. Discovery finds
`agy` on the PATH. It speaks standard ACP over stdio, and Octant does nothing to the CLI's
identity or sign-in: no spoofed `clientInfo`, no faked environment that moves
where the CLI keeps its sign-in, and no call to Google's internal endpoints
with the person's token. The CLI talks to Google itself.

**Interactive use on a personal sign-in only** (maintainer decision,
2026-11-21, reversing the same day's decision that Antigravity runs in
Automations as in a thread). Answers on Google's Antigravity developer forum
(`discuss.ai.google.dev`, read 2026-11-21) draw the consumer-plan line at one
person, on their own computer, signed in through the CLI's own flow, driving
an unmodified `agy acp` themselves. Unattended or background automation, task
queues and multi-agent "teammates", `agy` as a sub-agent inside another agent
loop or a multi-provider orchestration, serving several users, and sharing or
rotating credentials are not supported there; automated or multi-agent runs
belong on a Gemini API key (AI Studio) or Vertex AI. The profile declares the
runs its sign-in does not cover (`personalSignIn` in the contracts profile
table), each with the sentence a refused run shows, and the server refuses by
that declaration, never by the profile id:

- **Routines and every other turn no person sent** (`refusesUnattendedRuns`).
  Every Automation dispatch on an `antigravity` instance (scheduled,
  triggered, Run now, a follow-up, and a Chat follow-up proposal, which runs
  through the same dispatch) is refused by the dispatcher as
  `provider-capability-mismatch`, after its authority revalidation and before
  a thread is created or the CLI starts: the run is journaled as refused with
  the sentence below and the routine is paused with that reason. The
  provider is read live at dispatch, so a routine saved earlier is refused at
  its next run. The refusal is not part of the revalidation itself, which
  source polling and file arming share, so an integration or file routine on
  Antigravity keeps observing until its first run is refused, which pauses
  it with the reason, rather than going quiet with no reason; later
  occurrences make no runs while it is paused. Every other turn the host starts
  as itself runs under the host's own scope (`ROUTINE_HOST_SCOPE_ID`), which
  no window or device can claim, and is refused at that mode's turn
  admission: a Work turn (`startFirstTurn`) and a Code turn
  (`start-provider-turn`) under that scope, and a Chat send, retry, resume or
  child-result delivery that carries no window, the host's scope, a
  usage-limit recovery or another thread's coordination depth. That covers a
  message or wake-up waking an idle thread, a coordinator's worker, a pull
  request's Auto-fix rounds, goal-loop rounds, a
  usage-limit resume, a restart continuation, a child's result delivered into
  the thread, a peer's delegated task, a
  benchmark cell, and one Chat thread messaging another. A person's own send
  carries their window (a queued message keeps the window that queued it), so
  it, and steering their own turn, still run. Fan-out a person starts (the
  linked threads one prompt creates, a side task's send) carries the person's
  window and counts as their own send. Each refusal shows: "Google doesn't
  support unattended runs of Google Antigravity on a personal Google sign-in,
  so Octant did not start this run. Choose a provider that uses a Gemini API
  key, such as Gemini CLI with an API key."
- **The provider a turn resolves to.** The check reads the provider a turn
  would actually run on, not only the thread's own. In Chat a model pool or
  the Chat provider fallback can route a turn onto Antigravity from a thread
  on another provider, and a retry or resume runs on its attempt's provider,
  so a Chat send, retry, resume or child-result delivery is checked before
  anything is probed: the thread's own provider and each of this host's pool
  candidates before a route is computed (routing probes every candidate),
  the routed provider or retry's attempt provider before it is probed, and
  the Chat provider fallback before it is probed, so no Antigravity session
  opens for a turn that is refused. A pooled thread with an Antigravity
  candidate therefore takes no unattended turn, even one the route might
  have sent elsewhere. A turn the person sends themselves that their own
  pool or fallback routes onto Antigravity still runs (maintainer decision,
  2026-11-21); an outside agent's send that could be routed there is refused
  with the outside-agent sentence (below). Work and Code have no pool or provider
  fallback: a turn runs on the thread's own provider, and a coordinator's
  continue-on-fallback move changes that provider before it starts its host
  turn, which admission then refuses. A helper's resolved provider (its role
  slot, its fallback or its pool route, as `effectiveAgentRunExecutionTarget`
  reads the routing receipt) is the one checked when the child starts or
  resumes.
- **Helper runs** (`refusesHelperRuns`). Antigravity is never a helper
  target: the target list names it unavailable as `helper-runs-refused`, so an
  explicit target, a role slot and a follow-up on it are refused, and a child
  that would start or resume on it is refused at launch. A thread running on
  Antigravity starts no helper on any provider, here or on another hub member,
  including a Chat thread whose running turn a pool or fallback moved onto
  Antigravity (the running turn's provider, from the live-turn registry, is
  read; with no turn running, the thread's own provider is, so a retry or
  resume of an earlier helper after the person moved off Antigravity runs),
  and the person's retry or resume of an earlier child is refused too (its
  capabilities report delegation blocked as `helper-runs-refused`). A hub
  member whose Work default is Antigravity refuses a peer's delegated task as
  `provider-unavailable`, and so does a member taking delegated Code work
  whose first provider for the Project is Antigravity, before any thread or
  worktree exists (both are a turn another agent started, which no person on
  that member sent). The message: "Google doesn't support Google
  Antigravity as a helper agent, or starting helpers from it, on a personal
  Google sign-in. Use a provider that uses a Gemini API key, such as Gemini
  CLI with an API key, for helper work." The CLI's own built-in subagents
  inside `agy` are unaffected, and the driver keeps its helper-run handling
  (`answersOncePerCall`, below) as a fallback that still fails closed.
- **Outside agents** (`refusesOutsideAgents`). An agent grant's session (an
  outside agent, which is never the person) may not send a prompt or an answer
  to a thread on Antigravity: "Google doesn't support another agent driving
  Google Antigravity on a personal Google sign-in. Continue this thread
  yourself in Octant, or use a provider that uses a Gemini API key." The
  grant's check reads every provider the turn could run on (the thread's
  own and its running turn's; for Chat also each of this host's pool
  candidates and the Chat provider fallback) and refuses before the thread
  is marked as having read outside content, so a refused send leaves no mark
  to gate the thread's later helpers. The Chat service checks again on the
  provider a routed send resolves to and, for an answer, on the attempt's own
  provider. A turned-off provider is skipped only among pool candidates and
  the Chat fallback, in these checks and the Chat host-turn checks above:
  routing and fallback probing never send a turn to one, so a pool entry or
  fallback that still names a disabled Antigravity instance blocks no turn.
  The thread's own provider, the running turn's provider, a routed turn's or
  retry's provider and an answered attempt's own provider are checked
  whether on or off.
- **Who else can drive it.** No other principal than the host's own person
  can. Hub members are the person's own devices by scope
  ([Hub and spokes](hub-and-spokes.md#outcome): teams, shared machines and
  other people's computers are out of scope), so a paired phone, browser or
  owner device driving a thread is the same person at their own host, and a
  hub-introduced device acts only as an owner device after a fresh unlock.
  A Code thread a person starts and follows on a directly paired computer
  from their own window reaches that computer as a device they paired, so its
  turns are their own interactive use; a turn that computer's host starts on
  it by itself runs under the host's own scope and is refused as above.
  Agent grants are the one non-person caller that sends turns, and they are
  refused above.
- **No copy without the limits.** An added ACP agent that is Antigravity
  under another name (the registry's `antigravity-acp` server, which lists
  `shippedAs: "antigravity"`, or a local command whose executable is `agy` or
  `agy.exe`, whatever its arguments) is refused when added, refused when
  turned on, and never started if it was added earlier: "Google Antigravity
  runs only as its built-in provider, which keeps it to the use its vendor
  supports on a personal sign-in. Add Google Antigravity in Settings ›
  Providers & Models instead." The registry entry stays listed so the person
  finds that pointer: Settings' registry picker shows that sentence for it in
  place of the install line, offers no Add, and starts on the first entry that
  can be added.
- **Every sign-in.** The limits bind every `antigravity` instance whatever
  sign-in the CLI has cached: Octant cannot verify which method the cached
  credentials use, and the profile offers no posture of its own. A Gemini API
  key, Gemini Enterprise or Agent Platform sign-in is governed by the
  organization's terms rather than the consumer line, so lifting the limits
  for those is a possible follow-up once a verifiable signal of the sign-in
  method exists.

- **No sandbox in Work and Code outside Strict.** There the CLI starts as the
  person's own terminal would start it, at every level: no Octant sandbox, no
  network allowlist, the person's whole environment, and its own sign-in read
  as it reads it. Every ACP agent now runs this way
  (`providerHoldsLevelWithoutSandbox`, maintainer decision, 2026-11-21), the
  rule Windows already applied to ACP agents below Full access: the CLI's
  `default` mode asks Octant before every edit and command, so the thread's
  level holds through Octant's approvals rather than the OS. Rationale: other
  ACP clients of the CLI run it this way, and the person asked for the same
  reach. Cost: below Full access the process itself may read and write
  anything the person can, and Octant's protected files and network limits do
  not bind it; only the approvals it asks for do.
- **Where the sandbox stays.** A readiness check, Chat (which has no folder),
  Plan (which writes nothing), Strict, an explicit sandbox policy, and a Full
  access thread that keeps the sandbox start inside Octant's deny-default
  sandbox. Under Strict, Network limits still reach only Google's sign-in and
  model hosts (`cloudcode-pa.googleapis.com`,
  `daily-cloudcode-pa.googleapis.com`, `oauth2.googleapis.com`,
  `www.googleapis.com`, `accounts.google.com`, `antigravity.google`).
- **Sign-in.** The person runs `agy` in a terminal and signs in with their
  own Google account; Octant reuses that sign-in as the CLI reads it, in the
  person's own threads only (turns no person sent, helper runs and outside agents are
  refused, above). On macOS the CLI keeps it in the login
  keychain and reads it by running `/usr/bin/security`. Unconfined, that read
  needs nothing from Octant. A sandboxed launch sets `readsLoginKeychain`: the
  grant Claude Code's runtime measured as the least that reads a keychain
  sign-in (exec of `/usr/bin/security`, the `com.apple.SecurityServer` and
  `com.apple.securityd.xpc` lookups, a literal read of
  `~/Library/Keychains/login.keychain-db`, and process-fork, which Chat and
  Plan otherwise deny). The rules follow the built-in secret-file denials, so
  a path the person protects in Settings still wins; nothing grants a Keychain
  write, no other file in that folder is readable, and no other profile gets
  the grant. Unlike Claude Code's, it is not held to the runtime alone:
  commands the agent runs in-process share its sandbox. Octant never reads the
  keychain item itself.
- **Own setup.** Nothing of the CLI's own setup is held back, at any level or
  under Strict: it reads and writes `~/.gemini` (`GEMINI_HOME` names it), and
  loads the person's `AGENTS.md`, `GEMINI.md` and skills there and a Project's
  `.agents/skills` and `.gemini/skills` as it does on its own. Its own-setup
  switches report nothing, and Strict has no Project code to ask about for it.
- **Release and identity.** The version is the first `x.y.z` anywhere in
  `agy --version`; releases before 1.5.0 are refused, as other ACP clients of
  the CLI refuse them. Any `agentInfo.name` is accepted (1.1.x reported
  `antigravity-acp`, 1.5.x `Antigravity ACP Server`), and `initialize` may
  report protocol version 1 or 2 (1.1.1 reported 2 with version 1 shapes);
  every other profile accepts exactly 1.
- **Modes, approvals and questions.** The CLI offers `default`, `auto_edit`,
  `yolo` and, for some accounts, `auto`, and refuses `auto_edit` and `yolo`
  from an ACP client. The profile selects no mode (`selectsNoMode`): the
  session keeps `default` and Octant answers its approvals for the thread's
  level, Full access included. Its own `allow_always` is chosen as for
  [every ACP agent](#approvals-kept-for-the-session-and-steering). Its
  questions arrive as permission requests whose tool call id starts with
  `interaction_`: one with no allow option is asked as a question whose
  answers are its other options, and a reject option among them is not an
  answer but what skipping the question sends. An allow option beside a
  reject is an approval, so Plan and the approval policy apply to it. An
  allow option is never a question's answer, and allow options with no
  reject fail the turn. Offered `allow_always` with no
  `allow_once`, an approval chooses it only where approvals hold for the
  session. Any other approval is refused as unsupported and nothing reaches
  the CLI, so no approval is recorded that the CLI never got: the request
  stays pending, and Code keeps the ask open for a denial, which sends the
  reject; Work keeps the request pending and shows the person the agent's
  reason. A helper run's answers hold for one call (its sessions start with
  `answersOncePerCall`), so no answer could approve such a request there: it
  is denied on arrival, the agent gets the reject and carries on, no one is
  asked and nothing is recorded approved, and the call shows "<agent> only
  offers Always allow, which a helper run can't grant; denied."
- **Turns that do not fail on stray updates** (`toleratesStrayUpdates`).
  Updates after the prompt answered (usage, background-command replies,
  scheduled wakes), a subagent's updates under its own session id, a repeated
  tool start, a repeated finish and an update for a call never started are
  ignored or read as the start they imply, as other ACP clients of the CLI
  accept them; a call still running when the turn ends (a subagent's read
  the CLI never finishes) is marked done with it. A late update that
  reaches the process parked between turns is dropped rather than closing
  it; a request there still closes it. Every other profile keeps the strict
  mapper and closes a parked process on any message. A turn the CLI ends with `refusal` says the account's
  usage limit may be reached (`refusalMessage`).
- **Prompts.** A prompt that opens with `/` is one of the CLI's own commands
  (`/plan`, `/goal`, `/compact`), which it runs only from the start of the
  prompt: the command goes as the first text block and Octant's context as
  the next (`commandLeadsPrompt`). Octant does not offer it `fs/write_text_file`
  (`withholdsClientWrites`): offered it, the CLI rewrites whole files through
  it instead of making its own edits, which its edit approvals already ask
  for. Octant's instructions reach it in the prompt as they reach every
  agent, not through the `_meta.antigravity.systemPrompt.append` it
  advertises, because Octant's context arrives with each turn, after
  `session/new`.
- **Sessions.** A follow-up reattaches with `session/resume`, because
  `session/load` replays the whole history; no `session/close` is sent, since
  `initialize` does not advertise it. The process stays open between turns on
  every release (`retainsSessions`), as other clients keep it, since each
  launch unpacks the CLI again before it answers. A thread may start from
  one of the CLI's own sessions for its folder, listed through `session/list`
  when `initialize` advertises it, leaving out any an Octant thread holds
  (`importsSessions`). Octant follows the list's `nextCursor` through its
  pages, up to 20 pages and 2,000 sessions and stopping at a cursor it has
  already followed, before it filters by folder and held sessions and offers
  the newest 50. A read that stops at one of those bounds with sessions left
  unread cannot tell a missing session from one it never reached, so
  adopting a session it did not find then says the session is past what
  Octant can read and to open it in the CLI, rather than that it is not the
  folder's. Its earlier conversation is imported by loading it once in a
  separate readiness-check process over `agy acp`, which replays it, and
  closing that process ([Imported history](#imported-history)).
- **Usage and limits.** The `session/prompt` reply's `usage` is that turn's
  own, read as [any ACP agent's](#usage-an-acp-agent-reports); a reply
  without `totalTokens` is read by the reviewed rule that its `inputTokens`
  leaves out cached reads, so Octant's input is input plus
  `cachedReadTokens`, kept also as cache reads (`turnUsageWithoutTotal`). The
  account's 5-hour and weekly windows are not read: the CLI answers `/usage`
  only through headless mode, which Google does not support wrapping inside
  another application on consumer plans, so its limits report as
  `runtime-does-not-report`.

Kept, where other ACP clients of the CLI differ: the self-update guard (other
clients both set and leave it), `--disable-telemetry` where the launch keeps
telemetry closed, Strict and Network
limits as the person sets them, and Chat and Plan, which those clients do not
have. Google's guide says a prompt sent while a turn runs steers that turn
instead of starting a new one, so the profile steers (`steersMidTurn`, see
[Approvals kept for the session, and steering](#approvals-kept-for-the-session-and-steering)).

Not built yet, each pending the signed-in probe on a Mac with a personal
subscription: whether the sandboxed keychain read signs in as measured for
Claude Code, the model and thinking option ids, the exact shape of a question
and of `session/list`, the `/usage` answer on a real account, and a pinned
compaction release. Steering is built from Google's guide; how the CLI
answers the first prompt once a second one takes over its turn (the driver
accepts any stop reason) remains part of that probe. Google's guide says the
server speaks protocol version 1, offers elicitation forms for questions, and
supports `session/close`; Octant asks questions through the permission
channel and sends no `session/close` until each is built against a live run.

### Any ACP agent

Decided (maintainer decision, 2026-11-16; built, except the profile
promotions below; this replaces
the rule that only a reviewed profile runs): a person may add an agent from
the public ACP registry, or their own local command, through the plugin
model ([Architecture: extensions and skills](../architecture.md#extensions-and-skills)).
Installation, trust and enablement stay separate steps, and discovering an
agent in the registry grants it nothing. A custom agent runs on the shared
stack above with no runtime profile of its own: every capability is what its
own `initialize` reports, and nothing is claimed that a probe would have to
show. Until the person trusts it, it starts in Octant's sandbox at the
thread's level, nothing about it is remembered (no remembered approvals, no
Project trust for it), and Octant's tools reach it only as the transport rules
above allow. Trusting it lifts the sandbox outside Strict, as for a shipped
profile. A reviewed profile stays the way an agent gets Octant's deeper fit
(mode mapping, managed home, usage and the probe's evidence).

Built: the launch policy, `decideAcpAgentLaunch` in
`packages/plugin-host/src/acpAgents.ts`, pure like the rest of the
activation policy there:

| Steps the person took                  | Strict or level                 | Starts                                      |
| -------------------------------------- | ------------------------------- | ------------------------------------------- |
| None (found in the registry, or typed) | Any                             | Nothing (`not-installed`)                   |
| Installed, not enabled                 | Any                             | Nothing (`disabled`)                        |
| Installed and enabled, not trusted     | Any, Full access included       | In Octant's sandbox, remembering none       |
| Trusted                                | Full access                     | With no sandbox                             |
| Trusted                                | Plan, or Strict (or unresolved) | In Octant's sandbox                         |
| Trusted                                | Outside Strict, below Full      | As a shipped profile outside Strict (`own`) |

An untrusted agent at Full access gets the wall Accept edits has, since it
is not yet trusted to run open. `own` is the launch every shipped ACP
profile gets outside Strict below Full access: the agent's own settings
decide what Strict would fix (its channels, the fixed environment, Octant's
protected files inside its folders). An added agent has no checked sandbox
of its own, so on macOS that launch still keeps Octant's Seatbelt wall, as
it does for every shipped profile that has none
([Own sandboxes checked and not switched](#own-sandboxes-checked-and-not-switched)); on Windows it starts unconfined with the
agent's own approvals. A command is an absolute executable path with
literal arguments, never run through a shell; a relative path, a control
character, more than 32 arguments, or an argument that names a key, token,
secret or password is refused before the agent is added
(`acpAgentCommandRefusal`), because the arguments are journaled with the
agent. Under Octant's sandbox the home folder is unreadable, so an agent
that keeps its sign-in there reaches its provider only through a key in its
environment or at Full access.

Built, the host side: one driver kind, `acp-agent`, for every added agent,
outside the closed rows of `ACP_AGENT_PROFILES` and admitted by one bundled
plugin ("Added ACP agents"). Its instance configuration
(`AddedAcpAgentConfiguration` in `@octant/contracts/providers`) holds the
source (a registry id, the exact release the host's listing pinned and its
distribution kind, or a local absolute command), the arguments and, for a
registry agent, the registry entry's environment, the install record (the
executable and how it was checked), and the trust; the instance's own
`enabled` is the third step. Settings' Providers page has an **Any ACP
agent** section: **Add ACP agent** picks a registry entry or a local
command, then each agent shows **Install**, **Trust** and **Turn on** in
that order, with **Stop trusting**, **Turn off**, **Reinstall** and
**Remove**. The commands are `add-acp-agent`, `install-acp-agent` and
`set-acp-agent-trust`, beside the existing `set-provider-enabled` and
`remove-provider`, and each step is journaled as its own instance event.
The host decides every step:

- **Add.** A registry agent is named by its registry id alone; its name,
  release, distribution, arguments and environment come from the host's own
  listing (`ACP_REGISTRY_AGENTS`), so no client can point an install at
  another package, address or checksum, and a request carrying any of them
  fails to decode. A local agent carries no environment, so no key travels
  in it. An added agent starts not installed, untrusted and off.
- **Install** (`acpAgentInstall.ts`). Nothing the install puts on disk is
  run. See the rationale below for how each distribution is checked.
- **Trust.** Shows what trusting grants and how the install vouched for the
  bytes; an unverified download is said plainly. Trust is refused before an
  install, and a reinstall drops it. When an installed npm package declares
  deferred install scripts (`preinstall`, `install`, `postinstall`, or
  `binding.gyp`) that have not yet completed for that install, clicking
  **Trust** runs them (`npm rebuild --prefix <folder> --ignore-scripts=false`)
  with no further prompt (maintainer decision, 2026-11-19): natively outside
  Strict, and inside Octant's sandbox with writes limited to the agent's own
  install folder under Strict. Each run is journaled as
  `provider.acp-agent-install-scripts-ran@1` with its outcome, actor, timestamp
  and whether it was sandboxed. A failed script journals the failure, returns a
  clear failure value and leaves the agent untrusted so the person can retry or
  reinstall; non-package agents and packages with no install script stay clean
  no-ops. Before Trust, if Connection Check fails because a package's install
  script has not run yet, Octant reports: `"This package needs its install
script, which runs when you trust it."`
- **Enable.** Refused until the agent is installed and trusted
  (`acpAgentEnableRefusal`). Stopping trust later leaves the agent on; its
  next launch is held as an untrusted one.
- **Authority.** Adding, installing and trusting are steps of admitting a
  program Octant did not review, so the route refuses them from any client
  that does not act as the host's own person, as for an outside driver.
- **Remove** deletes what the install put in Octant's managed folder; a
  local command is the person's and stays.

The launch (`withAddedAcpAgentLaunch` in `addedAcpAgent.ts`) holds the
driver to `decideAcpAgentLaunch`: an agent that is not installed or not on
starts nothing, and an untrusted one is started under Strict, with the
sandbox kept at Full access, with none of the person's own setup, with
Octant's tools taken out (its probe reports app tools unsupported) and with
every approval answered for one call. An added agent is not a key provider:
Octant holds no switch for its own setup, so no Project trust is recorded
for it. Its network below Full access reaches the common model providers,
the endpoints its environment names and the Project's own rules, since its
vendor's hosts are not known.

The generic profile (`addedAcpAgentProfile`) claims nothing a probe would
have to show. Its identity is the configured command, so any
`agentInfo.name` is accepted while ACP's protocol version must still be 1.
Its version is read from `--version` where the agent answers and is
otherwise taken from the `initialize` reply's `agentInfo.version`
(`versionProbe: "best-effort"`). Every capability is what `initialize`
advertises. The model is set in the spelling the session reported
(`modelSelection: "follow-session"`): its `model` config option, or else
`session/set_model` when it reports `models`, and not at all when the
session already opened on that model. No mode is selected (`selectsNoMode`), since no mapping of
Chat, Work, Code and Plan onto the agent's own modes was read; Plan's
read-only wall and the level's approvals are Octant's sandbox and approval
bridge. It names no reviewed-release feature (compaction, file review,
forms, warm reuse, unadvertised HTTP tools), so none is offered at any level,
and the release-range rule has nothing to offer it. Its usage is read as
[any ACP agent's](#usage-an-acp-agent-reports). An
agent whose session lists no model has nothing to select and cannot start a
thread.

Rationale (lead decision, 2026-11-18; Trust install-script rule, maintainer
decision, 2026-11-19), install integrity: an `npx` or `uvx` distribution
installs the exact pinned release with the package manager into Octant's
managed folder for that agent (`<data>/acp-agent-installs/<instance>`), relying
on the package manager's own lockfile and integrity checks; npm runs with
`--ignore-scripts` and uv with `--no-build`, so no package code runs at install
time. Before Trust, a package that needs its install script to fetch its real
binary fails Connection Check with `"This package needs its install script,
which runs when you trust it."` Clicking **Trust** then runs its install
scripts with no further prompt (natively outside Strict, and inside Octant's
sandbox with writes limited to the agent's install folder under Strict) and
journals the run. A binary distribution downloads only over HTTPS
(a redirect included) from the URL the listing names, capped at 1 GiB. The
registry schema's `sha256` is optional: an archive that carries one is
checked and refused on a mismatch, leaving nothing on disk; one without is
installed as an unverified download, which the Trust step says plainly.
A download that cannot be written (a full or unwritable disk) is refused and
its partial file removed. Archives are unpacked with the system's `tar` or `unzip` after every entry
is listed and the archive refused when one is absolute or climbs out with
`..`; the executable must resolve inside the install folder. Downloads
follow the Marketplace fetches switch. Each install goes into a fresh
folder and the earlier ones are removed only once it is on disk, so a
failed reinstall leaves the agent as it was. Rejected: verifying only what
HTTPS gives for every binary (it would hide the registry's checksum where
one exists), and refusing every binary without a checksum (it would leave
out Cursor and Junie, whose entries carry none).

Rationale, driver kind: one generic `acp-agent` kind, whose instance
configuration holds the source, the trust and (in `enabled`) the switch,
keeps `ProviderDriverKind` closed, as `outside-harness-endpoint` does for
outside driver packages. Rejected: a driver kind per added agent, which
would turn the vocabulary into `string`.

Not built: the probe next agents' first-class profiles and the recheck of
Cursor's block (below). Each may ship as an unverified profile without a live
probe (maintainer decision, 2026-11-21); until one does, each is added as any
ACP agent.

### Probe before a profile ships

A profile states compatibility as a range, not as exact releases
(maintainer decision, 2026-11-21; built). A feature a profile reviewed on
named releases (`usageVersions`, `elicitationVersions`,
`compactionVersions`, `fileReviewVersions`, `retainedSessionVersions`,
`unadvertisedHttpMcpVersions`; `acpReleaseClaim` in
`apps/server/src/providers/acpProfiles.ts`) is kept, at every level alike,
on each of those releases and on every later one; a later release that is
not one of them keeps it unverified, and the probe's runtime card names
what it keeps that way ("Mistral Vibe 3.0.4 keeps usage, forms, Octant's
tools, its process open between turns, unverified: Octant reviewed them on
another release."). A release older than the earliest of them, or one whose
version cannot be read, never inherits newer evidence. Compaction and file
review stay limited to Mistral Vibe, the one agent whose dialect for them
was read. Capabilities carry no separate Full access value for such a
release, since every level reads the same one, so a spend ceiling counts
such a release's turns as measured at every level.

A release found to break with Octant is refused by name: a profile's
`process.brokenVersions` (empty for every profile today) lists it, and
Connection Check and every launch on it fail as `runtime-incompatible` with
"`<agent> <version>` is known to break with Octant. Install another
release." Nothing else refuses a release at or above the profile's
`minimumVersion`. That floor is the earliest release the profile was probed
on, kept because nothing shows an older one speaks the wire the profile
reads; Mistral Vibe's 2.24.1 is also a protocol requirement, since its mode
ids moved in 2.23.3 and 2.24.1. Pi keeps the same shape: Octant's tools run
from 0.85.1 on where the probe attests them, unverified between 0.85.1 and
1.1.0, and warm reuse of a settled process holds from 0.85.1 on, while
the `+name` tool list stays from 1.1.0, the release that added that syntax.

Rationale: an exact pin turned every agent update into an Octant release and
kept features off on releases nobody had found broken; at Full access the
person already ran the agent open, and below it the sandbox and the
approval bridge, not the release number, bound what the agent reaches.
Rejected: keeping the pin below Full access (the 2026-11-16 rule), which
left a guarded thread without usage, forms or Octant's tools on every
update.

A profile is reviewed once a live probe against a signed-in install on Apple
Silicon shows each of the following, recorded as a smoke test beside
`devinSmoke.integration.test.ts` and a case in `acpConformance.test.ts`.
A profile may ship before that probe as an unverified profile (maintainer
decision, 2026-11-21; designed, not built: no profile ships this way yet):
it claims only what its `initialize` reply and its sessions show, names no
reviewed release, and says on its runtime card that it is unverified.
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

For the shortlist the probe must also settle: for Google Antigravity, the
signed-in items listed under [Google Antigravity](#google-antigravity); for Junie,
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
and Linux, so both report mixed. Every reader of the tool
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

## Provider channel switches

Two host switches in Settings › Providers & Models decide, outside Strict,
whether a launch carries a provider's own telemetry and self-update guards
(maintainer decision, 2026-11-21). The host stamps them on every session start
and resume (`withProviderOwnChannels`, read from `providerTelemetry` and
`providerSelfUpdate` in the shell settings), and each driver resolves them
against Strict with `launchOwnChannels`: Strict keeps both closed whatever the
switches say, as do an explicit sandbox and a Full access thread that keeps the
sandbox. A version read always keeps every guard. A process kept warm across
turns keeps the guards it started with; ACP and Pi runtimes do not reuse a warm
process across a change, and an OpenCode 1.x server takes the change at its
next start.

| Runtime             | Telemetry guards (set while telemetry is off)                                                                                            | Self-update guards (set while self-update is off) |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude Code         | `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`, `DISABLE_FEEDBACK_COMMAND`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `DISABLE_AUTOUPDATER`                             |
| Kimi Code           | `KIMI_DISABLE_TELEMETRY`                                                                                                                 | `KIMI_CODE_NO_AUTO_UPDATE`                        |
| Grok Build          | `GROK_TELEMETRY_ENABLED`, `GROK_TELEMETRY_TRACE_UPLOAD`, `GROK_TELEMETRY_MIXPANEL_ENABLED`, `GROK_FEEDBACK_ENABLED`                      | `GROK_DISABLE_AUTOUPDATER`                        |
| Mistral Vibe        | `VIBE_ENABLE_TELEMETRY`                                                                                                                  | `VIBE_ENABLE_UPDATE_CHECKS`                       |
| Kilo                | `KILO_TELEMETRY_LEVEL`                                                                                                                   | `KILO_DISABLE_AUTOUPDATE`                         |
| Google Antigravity  | the `--disable-telemetry` argument                                                                                                       | `AGY_CLI_DISABLE_AUTO_UPDATE`                     |
| fx                  | none                                                                                                                                     | `FX_AUTO_UPGRADE`                                 |
| OpenCode (ACP, 1.x) | none                                                                                                                                     | `OPENCODE_DISABLE_AUTOUPDATE`                     |
| Pi                  | `PI_TELEMETRY`                                                                                                                           | `PI_SKIP_VERSION_CHECK`                           |

Telemetry is off by default, for every provider and for a store saved before
the switch existed (maintainer decision, 2026-11-21), so a launch outside Strict
keeps its telemetry guards as every launch did before the switch; self-update
is off by default, since Octant
installs and updates provider CLIs itself through **Update CLI** below, which
the switch does not touch. Marketplace auto-install, memory and the built-in
subagents keep their own rules. Codex's app server takes neither kind of guard
from Octant, and an added ACP agent's registry environment (Factory Droid's and
Auggie's update switches) is the registry entry's own, so the switches change
nothing for either. Telemetry guards that were set outside Strict before the switch existed,
Kilo's and Antigravity's `--disable-telemetry` among them, stay set by default
and are lifted only when the person turns the switch on.

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

## Windows launches

On a Windows host every provider family launches with no Octant sandbox,
decided per launch from that launch's own mode, level and Strict value
(`windowsProviderLaunch` in the domain's `guardrailPolicy.ts`); the rule and
its status are in
[Architecture: Windows below Full access](../architecture.md#current-release-boundary).

- **Full access** with the sandbox off starts unconfined and asks nothing, as
  on every platform.
- **Below Full access outside Strict** starts unconfined with the provider's
  own approvals: Claude's permission modes (`default`, `acceptEdits`,
  `plan`), Codex's own sandbox and approvals (`untrusted` in
  `workspace-write` at Ask first, `on-request` in `workspace-write` at Accept
  edits and Auto, `never` in `read-only` in Plan; never the
  external sandbox Octant names when its own wall holds the process),
  OpenCode's permission rules, Pi's approval bridge and an ACP agent's own
  mode. Each ask reaches Octant's server, which answers and journals it.
  Whatever the provider's own sandbox does on Windows is what its own CLI
  does there. Claude Code has no command sandbox on Windows, so a Windows
  launch carries no sandbox settings at all (the SDK port refuses one that
  does): one asking for that sandbox with `failIfUnavailable` would leave
  every command unable to run.
- **Chat** outside Strict starts unconfined on every provider family (maintainer
  decision, 2026-11-19: outside Strict, the provider's own rules apply and
  Octant adds none of its own; the one exception is an ACP agent whose person
  turned its own setup off while it holds back setup in the home folder,
  refused as the setup-off bullet below says): Codex with no execution environment and its
  shell, image, plugin and app features off; Pi with `--no-tools`, no extension
  and none of the person's resources; Claude with no file or shell tool in its
  session's tool list (`claudeExecutionOptions` leaves out `Read`, `Grep`,
  `Glob`, `LS`, `Edit`, `Write`, `NotebookEdit`, `Bash` and the task tools on
  Windows); OpenCode with a deny-everything Chat permission ruleset of its own
  (`*` denied, keeping only Octant's session tool bridge and 2.x `question`
  open, with no Octant isolation); and ACP agents on their own permission
  handling with no Octant isolation. Both the provider card and Settings
  capability wording state honestly that outside Strict on Windows OpenCode's
  own permission rules, not Octant, keep its file and shell tools off in Chat
  (and its command templates and plugins run as they do in OpenCode itself),
  and that an ACP agent's own permission handling, not Octant confinement,
  applies in Chat.
- **Refused by name:** Strict at every level, Chat included ("Strict needs a
  sandbox Windows doesn't have yet"), and Full access with the sandbox kept. A
  launch that does not carry its Strict value is Strict.
- **An ACP agent's own setup turned off** (maintainer decision, 2026-11-22;
  built). Below Full access, a launch whose person turned the agent's own
  setup off refuses before its version is read wherever the profile holds
  setup back (`forbiddenRootEntries`, `hostDeniedEntries` or the sign-in
  folder's `forbiddenEntries`; in Chat, which has no Project folder, only the
  host's entries count), naming the agent and offering to turn its setup on,
  switch to Full access (Work and Code only, since Chat turns run at Ask
  first), or use a Mac or Linux host (`acpWindowsLaunch` in
  `acpProcess.ts`). On macOS and Linux the sandbox's deny rules are that
  hold-back ([ACP agents outside Strict](../architecture.md#security-and-authority));
  Windows has no sandbox to hold it, and unwrapped Kimi Code 0.38.0 started
  a trusted Project's `.mcp.json` server at `session/new` with no approval
  asked. Full access, a session with the person's own setup on, and a
  profile that holds nothing back start as above. Rationale: refusing fails
  closed; loading the setup the person turned off would break
  [the setup-off rule](decisions.md#key-providers-run-as-themselves)
  silently.
- **Version and catalog reads.** An admitted launch reads its version
  unconfined. A read that serves no one thread (Codex's catalog lease,
  OpenCode's or an ACP agent's readiness check) runs unconfined only while the host's new
  threads run with no Octant sandbox (`hostReadsProviderCatalogUnconfined`).
- **Reuse.** A Codex lease or OpenCode server started outside Strict below
  Full access is its own process: a Strict session at the same level never
  reuses it.
- **Programs.** A configured npm `.cmd` shim is read, not run
  (`process/windowsProviderProgram.ts`): the program it names starts directly,
  a `.js` script with the `node.exe` beside the shim or on `Path`; a shim with
  no readable program, or a script with no `node.exe`, is refused naming the
  `.exe` to point Settings at.
- **Stop and receipts.** Every family's stop ends the whole process tree with
  `taskkill /T /F`, and each launch keeps its ownership receipt (pid and
  creation time), as on every platform.
- **App-managed tools.** OpenCode and the ACP agents are offered them as on
  macOS and Linux (`appToolBridgeReachesLaunchOn`): a Windows launch has no
  Octant sandbox, so it reaches the host's loopback tool bridge, opened only
  with its per-bridge bearer token, directly.
- **No wall.** A Windows launch takes no egress proxy or registered-server
  folder, having no Octant sandbox to hold them to.

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
- Windows launches: `packages/domain/src/guardrailPolicy.test.ts`,
  `apps/server/src/process/windowsProviderProgram.test.ts`, the Windows cases
  in each family's process or driver test (run on Linux with the host's
  platform set to Windows), and `codexProcess.windows.test.ts` and
  `providerFamilies.windows.test.ts`, which the `server-windows` CI job runs
  against compiled fake runtimes on `windows-2025`.
- Sign-in dialects: `apps/server/src/providers/directEndpointSubscriptionOAuth.test.ts`,
  `chatGptPlanProfile.test.ts`, `packages/domain/src/subscriptionOAuthCatalog.test.ts`,
  and `packages/provider-sdk/src/subscriptionOAuthConformance.test.ts`.
