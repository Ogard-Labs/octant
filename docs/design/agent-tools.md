# Agent tools

Every tool Octant itself gives an AI agent, with what it does, where it is
offered, and how its authority works. This page is a lookup, like
[Host reads and commands](host-reads-and-commands.md): each rule here is stated
by the specification it links to, and where the two differ, the owner wins.
Provider-native tools (a runtime's own shell, file edits, or subagents) and
tools from plugins or MCP servers the person added are not listed.

## How tools reach a model

- **Transport.** Each runtime receives the same definitions through the channel
  its adapter verified: Claude Code through Octant's in-process MCP server,
  Codex as dynamic tools when a thread starts, OpenCode and ACP agents through
  a private bridge, Pi through Octant's extension, and Octant Harness and model
  endpoints in the request itself. See
  [Architecture: Process topology](../architecture.md#process-topology).
- **Availability.** Only a provider that carries app-managed tools receives
  them: `capabilities.appManagedTools` is supported, or the model is verified
  for tools. A family whose grant or capability is off is omitted rather than
  offered and refused, decided per session where the runtime keeps its own
  tool list. A Codex thread keeps the tools it started with.
- **What tells the model about them.** Each tool's description, and a `help`
  operation on the capability families. Octant's instructions add the Canvas
  delivery rule when Canvas is offered, and one-line notes for Browser and
  Computer. Octant Harness alone also gets a one-line purpose for each offered
  tool (`nativeHarnessToolGuide` in
  `apps/server/src/harness/nativeHarnessInstructions.ts`).
- **Authority.** No definition and no instruction grants anything. The host
  decides each call: Plan mode, the thread's access level, per-act approval,
  the thread's tool constraints, and outside-content taint. See
  [Architecture: Security and authority](../architecture.md#security-and-authority)
  and [Tool calls in Chat and Work](../architecture.md#tool-calls-in-chat-and-work).

"Code + tools" below means a Code thread on a provider that carries
app-managed tools, subject to the thread profile's tool constraints.

## Browsing, devices, and processes

| Tool              | What it does                                                                                     | Offered                                                                                                                                          | Authority                                                                                                                                                                                                                                | Owner                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `octant_browser`  | Drives Octant's built-in browser: navigate, read, click, type, tabs, flows, uploads, screenshots | Work and Code with tools; Code only when the host lends a browser; a CLI in a Code thread terminal through `octant mcp`; never Chat              | The first effect on each origin asks; uploads and saved downloads ask every time; `run-script` needs Full access on a local native Code page; Plan refuses everything but `stop`; results mark the thread as having read outside content | [Browser for agents](browser-agent-tool.md)                                                                   |
| `octant_computer` | Operates apps on this Mac, or on the thread's disposable Linux desktop                           | Chat (not Side Chat), Work, and Code with tools, when Computer is enabled, a screen bridge or leased desktop exists, and the turn is not in Plan | The first action on each app asks, even at Full access; on a tainted thread every action asks; sending a file asks per file                                                                                                              | [Disposable desktops](disposable-desktops.md); [Process topology](../architecture.md#process-topology)        |
| `octant_terminal` | Runs long-lived processes such as dev servers and reads their output                             | Code + tools                                                                                                                                     | `read` is a read; `run`, `write`, and `stop` ask per command below Full access; Plan refuses                                                                                                                                             | [Process topology](../architecture.md#process-topology)                                                       |
| `octant_apple`    | Builds, tests, and runs Apple apps and drives the iOS Simulator in Octant's pane                 | Code + tools, when the host lends an Apple toolchain                                                                                             | `discover`, `status`, `screenshot`, and opening a running Simulator are reads at any level; every other operation is an effect that Plan refuses and an approval-gated thread asks for                                                   | [Device workbench](device-workbench.md); [Device transport](../architecture.md#device-transport-and-evidence) |
| `octant_android`  | Boots, inspects, and drives Android emulators in Octant's pane                                   | Code + tools, when the host lends an Android toolchain                                                                                           | As `octant_apple`; `install` takes only an APK inside the checkout                                                                                                                                                                       | [Device workbench](device-workbench.md)                                                                       |

## Documents and images

| Tool                  | What it does                                             | Offered                                                                                                 | Authority                                                                                                                                                                                                                     | Owner                                                   |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `octant_canvas`       | Creates, reads, revises, and previews Canvas documents   | Chat (not Side Chat), Work, and Code with tools, Plan included, and managed child runs in Work and Code | `describe`, `list`, `read`, and `preview` are reads; `create` and `revise` change only the document and are offered in Plan, where [Canvas](canvas.md#agent-tool-and-recipes) keeps the Canvas delivery rule (see Known gaps) | [Canvas](canvas.md)                                     |
| `octant_create_image` | Generates or edits an image, only on an explicit request | Chat (not Side Chat), when an eligible image profile exists                                             | Enqueues a paid image job; no approval; refuses credential, endpoint, and path keys; never in Plan, since Chat has no Plan posture                                                                                            | [Architecture: Providers](../architecture.md#providers) |

## Repository and delivery

| Tool                                                | What it does                                                                                                   | Offered                                                | Authority                                                                                                                                                                                                                                                                                | Owner                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `octant_pull_request`                               | Opens or changes this thread's own pull request: create, update, comment, merge; `help` returns its full usage | Code + tools                                           | `help` is a read in any posture and touches no forge; every other operation is an effect and Plan refuses; approval-gated threads ask before GitHub is touched; `comment` asks at every level; `merge` asks unless a stored choice allows it, and refuses a moved head or failing checks | [Modes](../architecture.md#modes-chat-work-and-code) |
| `octant_github`                                     | Reads the delivery repository's issues, pull requests, and projects                                            | Code + tools, when the GitHub integration is effective | Read only, re-authorized on every call; results mark the thread as having read outside content                                                                                                                                                                                           | Not yet in the architecture                          |
| `octant_code_diagnostics`, `octant_code_definition` | The language server's errors for a saved file; where a name is defined                                         | Code + tools, Plan included                            | Project file reads; no approval                                                                                                                                                                                                                                                          | [Language services](language-services.md)            |

## Threads, agents, and planning

| Tool                     | What it does                                                             | Offered                                                                                   | Authority                                                                                                                                                                    | Owner                                                   |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `octant_agents`          | Delegates part of the task to child runs the host owns and supervises    | Chat (not Side Chat), Work, and Code with tools                                           | `capabilities`, `status`, `wait` are reads; `delegate`, `follow-up`, `cancel` are effects; delegation is refused on a tainted thread, with subagents off, or a paused parent | [Modes](../architecture.md#modes-chat-work-and-code)    |
| `octant_agent_message`   | Sends a bounded message to another thread of this Project                | Code + tools, not in Plan or to managed children                                          | An effect without approval; journaled; marks the recipient as having read outside content                                                                                    | [Person memory](../architecture.md#person-memory)       |
| `octant_threads`         | Lists, reads, or waits on the Project's other active threads             | Code + tools, Plan included                                                               | Reads only, bounded per turn; `list` and `read` mark the caller as having read outside content                                                                               | [Person memory](../architecture.md#person-memory)       |
| `octant_thread_message`  | Sends one instruction to a mentioned Chat thread and waits for its reply | Chat (not Side Chat), when the turn mentions a thread                                     | Starts a turn in the target; at most three per turn, one hop                                                                                                                 | [Person memory](../architecture.md#person-memory)       |
| `octant_offer_side_task` | Offers the person a separate task outside this request                   | Chat (not Side Chat), Work, and Code with tools, Plan included                            | Only records the offer on the caller's own thread; the person starts it, and a Code thread starts approval-gated. Offered in Plan because every turn's tool set includes it  | [Native harness](../architecture.md#native-harness)     |
| `octant_propose_routine` | Proposes a scheduled routine                                             | Work and Code with tools; never Chat                                                      | Waits for the person to confirm; refused in Plan and in turns the host started                                                                                               | [Person memory](../architecture.md#person-memory)       |
| `octant_board`           | Reads the Project's board, as its designated planner                     | The designated planner Code thread                                                        | Read only; any posture                                                                                                                                                       | [Process topology](../architecture.md#process-topology) |
| `octant_propose_thread`  | Proposes a new Code task, as the planner                                 | The designated planner Code thread                                                        | Records a pending proposal; only the person confirms                                                                                                                         | [Process topology](../architecture.md#process-topology) |
| `octant_past_threads`    | Searches what Octant remembers of earlier threads                        | Chat (not Side Chat), Work, and Code turns from a local window, while memory search is on | Read only                                                                                                                                                                    | [Person memory](../architecture.md#person-memory)       |

## Credentials

| Tool                 | What it does                                                                             | Offered                                                    | Authority                                                                                            | Owner                                                               |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `request_credential` | Asks the person for a credential in a private card and performs one registered operation | Code + tools, not in Plan, when an operation is registered | Asks every time; the value stays in host memory for one operation and is never returned              | [Security and authority](../architecture.md#security-and-authority) |
| `octant_command`     | Lists the person's saved credential commands, or requests one by name                    | Code turns from a local window                             | `list` is a read; `run` needs its own one-use approval and the ordinary command policy; Plan refuses | [Security and authority](../architecture.md#security-and-authority) |

## Chat-only tools

| Tool                                                                                                                                                                                                 | What it does                                                      | Offered                                                                                                       | Authority                                                                              | Owner                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `octant_web_research`                                                                                                                                                                                | Searches the web through the configured search backend            | Chat, while the thread's research is on and its route is ready                                                | Read; results mark the thread as having read outside content                           | Not yet in the architecture                                         |
| `octant_side_chat_list_files`, `octant_side_chat_read_file`, `octant_side_chat_search_files`                                                                                                         | Read-only file access for a Side Chat about a Work or Code thread | Side Chat; search only for a Code source. Beyond the harness advice tools, these are a Side Chat's only tools | Reads; the link and the window's right to open the source are re-checked on every call | [Security and authority](../architecture.md#security-and-authority) |
| `octant_zen_search_threads`, `octant_zen_list_widgets`, `octant_zen_create_widget`, `octant_zen_preview_recipe`, `octant_zen_place_element`, `octant_zen_update_appearance`, `octant_zen_pin_thread` | Search and pin threads, and arrange widgets in a Zen space        | The Chat thread that is the active Zen space's assistant                                                      | Searches and lists are reads; the rest change the Zen space, guarded by its version    | Not yet in the architecture                                         |

## Octant Harness tools

Model endpoints run through Octant Harness, which supplies its own core tools.
Plan mode drops every tool whose approval class it refuses.

| Tool                                           | Modes                                              | Authority                                                                                      |
| ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`, `grep`, `glob`                         | Work, Code                                         | Project file reads; no approval                                                                |
| `edit`, `write`                                | Work, Code                                         | Project file writes; ask per the thread's level; `edit` needs a prior read of the file         |
| `bash`                                         | Work, Code                                         | Shell commands at the thread's level                                                           |
| `web-fetch`, `web-search`                      | All; Chat only while research is on                | Network access; mark the thread as having read outside content                                 |
| `todo-write`, `context-remaining`, `goal`      | All but Side Chat (`context-remaining` everywhere) | Thread-local                                                                                   |
| `journal-lookup`, `second-opinion`, `ask-user` | All but Side Chat                                  | Thread-local; `second-opinion` is refused without an advisor model; `ask-user` asks the person |
| `delegate`                                     | All but Side Chat and server Projects              | Creates child runs; their results mark the thread                                              |
| `goal-check`                                   | Work, Code                                         | Runs the goal's checks as shell commands; refused in Plan                                      |

See [Architecture: Native harness](../architecture.md#native-harness) and
[Harness tool egress rules](../architecture.md#harness-tool-egress-rules).

## ACP client bridge

An ACP agent in Code reaches files and terminals through Octant's client
capabilities rather than model-visible tools: `octant_acp_fs_read_text_file`,
`octant_acp_fs_write_text_file`, and `octant_acp_terminal_create`, `_output`,
`_wait_for_exit`, `_kill`, and `_release`. Paths stay inside the checkout and
its extra folders, under the secret guard; Plan offers only reads; at most
eight terminals live at once, each for at most ten minutes. See
[Provider runtimes](provider-runtimes.md).

## Known gaps

- `octant_github`, `octant_web_research`, and the seven `octant_zen_*` tools
  are described to the model but not yet in the architecture.
- `octant_canvas` `create` and `revise` are offered in Plan.
  [Canvas](canvas.md#agent-tool-and-recipes) says Plan keeps the Canvas
  delivery rule, which tells the model to deliver documents as a Canvas, while
  the architecture defines Plan as read-only. Neither says whether a new
  Canvas version is a write Plan refuses; the maintainer decides.

## Keeping this page current

A change that adds, removes, renames, or re-gates an agent tool updates its row
here in the same pull request, beside the owning specification.
