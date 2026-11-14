import type { ManagedToolAnswer } from "./managedMcpTools";
import { providerApprovalCall } from "./providerApprovalCall";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  type ClaudeAuthentication,
  type CorrelationId,
  type PermissionPersistence,
  type ProviderCapabilities,
  type ProviderExecutionPolicy,
  type ProviderNativeSetup,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModel,
  type ProviderModelId,
  type ProviderModelOptionValues,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ThreadPublishedSnapshot,
  type UtcTimestamp,
  type ProviderApprovalCall,
  type ProviderContextBlock,
  type ProviderTurnInput,
} from "@octant/contracts";
import type {
  ProviderAcquireInput,
  ProviderCompactionPoint,
  ProviderConnection,
  ProviderDriver,
  ProviderSessionCompaction,
} from "@octant/provider-sdk/driver";
import type { ProviderContextFactsSource } from "@octant/provider-sdk/context-facts";
import {
  isOctantInstructionContext,
  renderContextBesideRequest,
  renderOctantInstructions,
  renderProviderTurnPrompt,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Fiber, Option, PubSub, Scope, Stream } from "effect";
import { claudeOffersTool, isSanitizedFailure } from "./claudeAgentSdkDecoder";

import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { claudeAuthorityInputDigest, waitForClaudeAuthorityValue } from "./claudeAuthority";
import {
  claudeNativeQueryOptions,
  isClaudeEffortLevel,
  type ClaudeAgentSdkPort,
  type ClaudeDecodedMessage,
  type ClaudeEffortLevel,
  type ClaudeModelInfo,
  type ClaudeOpenQueryInput,
  type ClaudePermissionMode,
  type ClaudeQueryPort,
  type ClaudePreToolDecision,
  type ClaudeSandboxSettings,
  type ClaudeToolDecision,
} from "./claudeAgentSdkPort";
import {
  CLAUDE_CHECKLIST_TOOL,
  CLAUDE_PLAN_EXIT_TOOL,
  CLAUDE_SUBAGENT_TOOL,
  claudeStoredTaskListEvents,
  mapClaudeMessage,
  mapClaudeToolRequest,
  claudeToolUseStepId,
  type ClaudeEventContext,
  type ClaudePendingApproval,
  type ClaudePendingQuestion,
} from "./claudeEventMapper";
import { CLAUDE_TASK_TOOLS, ClaudeTaskList, readClaudeStoredTaskList } from "./claudeTaskList";
import { providerOwnMemoryLaunches } from "@octant/domain";
import {
  canonicalClaudeAccountDirectory,
  claudeArtifactLaunchEnvironment,
  claudeOwnMemoryLaunchEnvironment,
  disablesNonessentialTraffic,
} from "./claudeAccountIsolation";
import {
  makeClaudeEnvironmentScope,
  type ClaudeEnvironmentScope,
  type ClaudeEnvironmentScopeOptions,
} from "./claudeEnvironment";
import {
  claudeLoginKeychainPath,
  claudePlanRunsCommands,
  CONFINED_CLAUDE_EXECUTION_POLICIES,
  type ClaudeProcessPort,
} from "./claudeProcess";
import { claudeProcessPlanUsageLimits, decodeClaudeProcessPlanUsage } from "./claudeProcessUsage";
import { claudeNativeArtifactsSupport } from "./claudeNativeArtifacts";
import { readClaudePublishedSnapshot } from "./claudePublishedSnapshot";
import { secretGuardRefusal, secretGuardSearchRefusal } from "../process/secretGuard";
import type { ProviderDriverRuntimeRegistry } from "./providerRuntimeRegistry";
import { providerResumeBinding, resumeBindingRefuses } from "./resumeBinding";
import { isAtLeastRelease } from "./releaseVersion";
import {
  acquireProviderRuntimeNetwork,
  type ProviderRuntimeNetworkPort,
  acquireProviderServerAccess,
  withServerAccess,
  type ProviderServerAccessPort,
} from "../network/providerRuntimeNetwork";

/**
 * The releases measured to pass `UserPromptSubmit` hook context to the model
 * as its own reminder beside the message, record it apart from the message,
 * and keep it across resume without changing the request prefix (2.1.211 and
 * 2.1.318 against a local stand-in endpoint). An older install keeps the
 * context framed inside the message.
 */
const CLAUDE_PROMPT_HOOK_RELEASE = [2, 1, 211] as const;

/**
 * Claude Code saves hook context longer than 10,000 characters to a file and
 * shows the model only a 2 KB preview (both releases above). Counted in UTF-8
 * bytes, which are never fewer than characters, so context under the limit
 * always arrives whole.
 */
const CLAUDE_PROMPT_HOOK_CONTEXT_BYTES = 10_000;

/**
 * The first release after those measured to run Octant's prompt hook while the
 * person's own hooks are off. Turning them off sets `disableAllHooks` in the
 * session's flag settings; on 2.1.211 that drops the hooks of settings files
 * (a shell `UserPromptSubmit` hook in the home settings did not run) and still
 * runs a hook passed through the SDK (its context reached the request), both
 * measured against a local stand-in endpoint. The source agrees: only a managed
 * policy's `disableAllHooks` skips every hook. A later release is not trusted
 * to keep that split, so its context stays inside the message.
 */
const CLAUDE_PROMPT_HOOK_UNMEASURED_WITH_HOOKS_OFF = [2, 1, 212] as const;

/**
 * Whether Octant's prompt hook is known to run in a session. A session that
 * turns the person's hooks off runs it only on a release measured to; any hook
 * can still be skipped by a policy Octant cannot see, which the delivery check
 * on each message catches.
 */
export function claudePromptHookRuns(
  setup: ProviderNativeSetup | undefined,
  runtimeVersion: string,
): boolean {
  if (claudeNativeQueryOptions(setup).settings.disableAllHooks === undefined) return true;
  return !isAtLeastRelease(runtimeVersion, CLAUDE_PROMPT_HOOK_UNMEASURED_WITH_HOOKS_OFF);
}

/**
 * The message for one turn and the Octant context the prompt hook adds beside
 * it. The message is only what the person typed whenever the context fits the
 * hook; when it does not, Octant's own rules still go to the hook if they fit,
 * and the rest stays framed inside the message, which keeps every block whole.
 * The hook context reaches the model at the same user level as the message, so
 * no block's authority changes.
 */
function claudeTurnMessage(
  input: ProviderTurnInput,
  runtimeVersion: string,
  promptHookRuns: boolean,
): { readonly text: string; readonly context?: string } {
  const context = input.context ?? [];
  if (
    context.length === 0 ||
    !promptHookRuns ||
    !isAtLeastRelease(runtimeVersion, CLAUDE_PROMPT_HOOK_RELEASE)
  ) {
    return { text: renderProviderTurnPrompt(input) };
  }
  const fits = (blocks: ReadonlyArray<ProviderContextBlock>) =>
    Buffer.byteLength(renderContextBesideRequest(blocks), "utf8") <=
    CLAUDE_PROMPT_HOOK_CONTEXT_BYTES;
  if (fits(context)) {
    return { text: input.prompt, context: renderContextBesideRequest(context) };
  }
  const instructions = context.filter(isOctantInstructionContext);
  if (instructions.length === 0 || !fits(instructions)) {
    return { text: renderProviderTurnPrompt(input) };
  }
  return {
    text: renderProviderTurnPrompt({
      prompt: input.prompt,
      context: context.filter((block) => !isOctantInstructionContext(block)),
    }),
    context: renderOctantInstructions(instructions),
  };
}

/**
 * The tools Octant's gate has its own rule for in a Work or Code session
 * outside Plan. The session holds Claude Code's whole built-in set beside
 * them (see {@link claudeWithheldTools}); any other built-in tool asks below
 * Full access, so a tool a new Claude Code release adds works from that
 * release on and is never run unasked by a posture that asks.
 */
const CLAUDE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash",
  "AskUserQuestion",
  CLAUDE_CHECKLIST_TOOL,
];
const CLAUDE_PLAN_TOOLS = ["Read", "Glob", "Grep"] as const;
/**
 * Claude's own tool that publishes an `.html` or `.md` file to the signed-in
 * claude.ai account. Claude Code 2.1.211 lists it for an Agent SDK launch only
 * when `CLAUDE_CODE_ARTIFACT` is set, and then only for a claude.ai plan its
 * service admits (read from the bundled binary, 2026-10-27).
 */
export const CLAUDE_ARTIFACT_TOOL = "Artifact";
/** Claude's claude.ai Projects tool, whose upload names a local file in `local_path`. */
const CLAUDE_PROJECTS_TOOL = "Projects";
const CLAUDE_READ_TOOLS = new Set<string>(CLAUDE_PLAN_TOOLS);
/**
 * Tools that change only Claude's own session state: no file, shell, network,
 * or person is involved, so every posture runs them unasked, as Claude Code
 * does. Plan holds the checklist and the task tools of these, its task panel.
 *
 * - `TodoWrite`: the checklist, the thread's task panel, where the runtime
 *   still offers it.
 * - `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`: the task tools that
 *   replace the checklist by default. Each reads or writes only the session's
 *   task list in the account's configuration directory (read from the bundled
 *   2.1.211 binary, 2026-11-14), never the Project, and Plan already refuses
 *   an account directory that overlaps the checkout.
 * - `ToolSearch`: loads the definitions of tools the session already holds
 *   but deferred; it calls no tool itself. Claude Code 2.1.211's own tool
 *   marks it read-only (`isReadOnly` true, read from the bundled binary,
 *   2026-11-14), and the SDK describes tool search as deferring tool
 *   definitions behind it.
 *
 * A name joins only on such evidence; every other tool keeps asking.
 */
const CLAUDE_SESSION_TOOLS = new Set<string>([
  CLAUDE_CHECKLIST_TOOL,
  ...CLAUDE_TASK_TOOLS,
  "ToolSearch",
]);
/**
 * The refusal a Plan session's plan tool gets once its plan is captured.
 * Claude Code's own answer to that tool leaves plan mode for one that edits;
 * Octant's thread stays in Plan until the person moves it, so the call is
 * refused and the model is told the plan reached the person.
 */
export const CLAUDE_PLAN_CAPTURED_MESSAGE =
  "The plan was captured and shown to the person; wait for the person. Plan stays read-only until they move the thread out of Plan.";
const CLAUDE_INCOMPATIBLE_FALLBACK = "Claude runtime policy is incompatible with Octant.";
const CLAUDE_INCOMPATIBLE_REASONS = new Set([
  "Claude probe did not initialize its runtime.",
  "Claude initialization version did not match the configured binary.",
  "Claude initialized an unsupported account routing policy.",
  "Claude returned no usable models.",
  "Claude initialized an unexpected runtime surface.",
  "Claude did not initialize its runtime stream.",
  "Claude returned an unsupported runtime message.",
  "Claude returned an invalid SDK response.",
]);
/** The tools that write files inside the Project, and nothing else. */
const CLAUDE_EDIT_TOOLS = new Set<string>(["Edit", "Write", "NotebookEdit"]);
/**
 * Claude Code's tools that run or manage its shell commands: each takes the
 * shell's approval rules, so it asks below Full access and runs in the
 * Project root, where the command sandbox holds it. `Monitor` keeps a command
 * running and reads each line it prints, so it is a shell command too.
 */
const CLAUDE_SHELL_TOOLS = new Set<string>(["Bash", "Monitor", "TaskOutput", "TaskStop"]);
/**
 * Claude Code's built-in tools a Work or Code session outside Plan does not
 * hold. Octant adds to Claude Code and does not take its core features away
 * (maintainer decision, 2026-11-14), so the session holds the runtime's whole
 * built-in set except this list, and each entry is here only because it
 * would break a rule the server enforces.
 */
const CLAUDE_WITHHELD_TOOLS = [
  // The thread's mode is the server's. Claude switching its own permission
  // mode would leave the posture Octant granted mid-session; Plan is a
  // thread mode with its own read-only tool set, not a runtime switch. A Plan
  // session holds the plan tool to hand its plan over; outside Plan there is
  // no plan to hand over and nothing to leave.
  "EnterPlanMode",
  CLAUDE_PLAN_EXIT_TOOL,
  // A workflow's agents report under the `Workflow` call, not an `Agent`
  // call, so the child-run display cannot show them and the decoder refuses
  // their task frames; offering it waits on that display.
  "Workflow",
  // Each of these wakes the model at a later time. A session lasts one turn,
  // so a wake-up kept in memory never fires and the call's success would be
  // untrue, and a durable one is written to the Project's own Claude files
  // and fires in whatever later session opens there, unseen by this thread.
  // Background commands and `Monitor` watches are held instead: the turn that
  // started them stays open until they end (see `ClaudeHeldTurn`).
  "CronCreate",
  "ScheduleWakeup",
] as const;
/**
 * Claude Code's tools that move the session's working directory into a git
 * worktree and back. They take the rule for a tool the gate has no rule of
 * its own for: each asks below Full access. A worktree outside the Project's
 * folders becomes a folder the session holds once the person (or Reviewed's
 * reviewer) allows the switch, so the calls Claude makes there are judged as
 * the Project's are. `REPL` takes the same rule, which is the shell's: it runs
 * code in the runtime process, outside the command sandbox and the secret
 * guard, so it asks at Guarded, goes to the reviewer at Reviewed, and runs at
 * Full access (maintainer decision, 2026-11-14).
 */
const CLAUDE_ENTER_WORKTREE_TOOL = "EnterWorktree";

/**
 * The folder an EnterWorktree call moves the session into, or undefined when
 * it cannot be known before the call. With `path` it is that folder. Without
 * one, Claude Code 2.1.211 creates the worktree under `.claude/worktrees/` of
 * the repository that holds the working directory (read from the bundled
 * binary, 2026-11-14). A worktree a configured hook creates may land
 * elsewhere; Claude's calls from there then fall outside every folder the
 * session holds and are refused.
 */
export function claudeWorktreeTarget(
  input: Readonly<Record<string, unknown>>,
  workingDirectory: string,
): string | undefined {
  if (typeof input.path === "string" && input.path !== "") {
    return resolve(workingDirectory, input.path);
  }
  let directory = resolve(workingDirectory);
  while (!existsSync(join(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  const managed = join(directory, ".claude", "worktrees");
  return typeof input.name === "string" && input.name !== ""
    ? resolve(managed, input.name)
    : managed;
}
const PROBE_MODEL = "sonnet";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const MAX_PENDING_APPROVALS = 4;
/**
 * How many turns the runtime may start by itself inside one person's turn.
 * A watch that keeps printing wakes the model on every line; past this the
 * person's turn completes and its session, with the watch, is stopped.
 */
const MAX_RUNTIME_TURNS = 16;
const MAX_PRE_TOOL_GRANTS = 16;
/**
 * How many tool-use ids a session remembers. Settled ids are forgotten oldest
 * first past this, so a long turn never runs out: a turn used to fail at its
 * 64th tool call. Only ids still pending or holding a grant are never
 * forgotten, and the caps above keep those few.
 */
const MAX_TRACKED_TOOL_USES = 256;
const PRE_TOOL_GRANT_TTL_MS = 30_000;
const USER_ANSWER_MAX_CHARACTERS = 4_096;
const USER_QUESTION_MAX_CHARACTERS = 1_024;
// Claude's AskUserQuestion schema carries at most this many questions in one
// tool call; a set is answered one question at a time and replied once.
const MAX_CLAUDE_QUESTIONS = 4;

export interface ClaudeExecutionOptions {
  readonly permissionMode: ClaudePermissionMode;
  readonly allowDangerouslySkipPermissions: boolean;
  readonly tools: readonly string[];
  /**
   * Whether the session holds Claude Code's whole built-in tool set beside
   * `tools`, less {@link claudeWithheldTools}. Plan holds exactly `tools`.
   */
  readonly fullToolSet: boolean;
}

export function claudeExecutionOptions(
  policy: ProviderExecutionPolicy,
  autoApprove?: boolean,
  mode?: ProviderAcquireInput["mode"],
  platform: NodeJS.Platform = process.platform,
): ClaudeExecutionOptions {
  // Work and Code share one capability set at the thread's level, so a Work
  // session starts with Bash exactly as a Code session at that level does.
  const policyOptions = claudePolicyOptions(policy, autoApprove);
  // Only Work and Code hold Claude Code's whole built-in set. Chat withholds
  // the filesystem and shell at every level, so it keeps the earlier list of
  // tools Octant names one by one rather than every tool a new runtime adds.
  const options: ClaudeExecutionOptions = {
    ...policyOptions,
    fullToolSet: policyOptions.fullToolSet && (mode === "work" || mode === "code"),
  };
  // A Code Plan turn may run read-only commands where its sandbox can hold the
  // shell to them (see `claudePlanRunsCommands`). Plan has no approvals, so
  // the sandbox, not a person, is what keeps those commands read-only.
  if (policy === "plan" && mode === "code" && claudePlanRunsCommands(platform)) {
    return { ...options, tools: [...options.tools, "Bash"] };
  }
  return options;
}

/** Claude Code's own web tools: each reads the web for the model, so each marks the thread. */
const CLAUDE_WEB_TOOLS = new Set<string>(["WebSearch", "WebFetch"]);
/**
 * Claude Code's own tools that act only inside the session: starting one of
 * its subagents, whose every tool call then passes this gate itself, and
 * reading a skill's text. Neither touches a file, the shell, or the network.
 */
const CLAUDE_NATIVE_SESSION_TOOLS = new Set<string>([CLAUDE_SUBAGENT_TOOL, "Skill"]);

/**
 * The built-in tools a session with the full tool set does not hold: the
 * fixed list above, the person's own setup features they turned off, and
 * Claude's Artifact tool unless the session offers it.
 */
export function claudeWithheldTools(
  setup: ProviderNativeSetup | undefined,
  offersArtifacts: boolean,
): readonly string[] {
  return [
    ...CLAUDE_WITHHELD_TOOLS,
    ...(setup?.subagents === true ? [] : [CLAUDE_SUBAGENT_TOOL]),
    ...(setup?.webTools === true ? [] : [...CLAUDE_WEB_TOOLS]),
    ...(setup?.skills === true ? [] : ["Skill"]),
    ...(offersArtifacts ? [] : [CLAUDE_ARTIFACT_TOOL]),
  ];
}

/** The tools a session adds for the person's own Claude setup. */
export function claudeNativeTools(setup: ProviderNativeSetup | undefined): readonly string[] {
  if (setup === undefined) return [];
  return [
    ...(setup.subagents ? [CLAUDE_SUBAGENT_TOOL] : []),
    ...(setup.webTools ? [...CLAUDE_WEB_TOOLS] : []),
    ...(setup.skills ? ["Skill"] : []),
  ];
}

/**
 * How the gate answers one of the person's own Claude tools: a subagent
 * start or a skill read goes through at every posture, as it does in Claude
 * Code itself; a web read and a call to a person's or Project's MCP server
 * reach the network or code Octant did not write, so they ask below Full
 * access like any other such call. Undefined for every other tool.
 */
function claudeNativeToolAnswer(
  toolName: string,
  setup: ProviderNativeSetup | undefined,
): "unasked" | "ask" | undefined {
  if (setup === undefined) return undefined;
  if (CLAUDE_NATIVE_SESSION_TOOLS.has(toolName)) {
    return (toolName === "Skill" ? setup.skills : setup.subagents) ? "unasked" : undefined;
  }
  if (CLAUDE_WEB_TOOLS.has(toolName)) return setup.webTools ? "ask" : undefined;
  if (
    (setup.toolServers || setup.projectCode) &&
    toolName.startsWith("mcp__") &&
    !toolName.startsWith("mcp__octant__")
  ) {
    return "ask";
  }
  return undefined;
}

/**
 * The launch environment for a session with subagents on: Octant's guards
 * keep the SDK's built-in subagents off, which is also what Claude Code's
 * own general-purpose and Explore subagents are, so that one guard goes.
 * Every channel switch (telemetry, error reports, self-update, memory)
 * stays as it was: memory follows the account's own setting, never this one.
 */
function claudeNativeLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
  setup: ProviderNativeSetup | undefined,
): NodeJS.ProcessEnv {
  if (setup?.subagents !== true) return environment;
  const { CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: _builtinAgentsOff, ...rest } = environment;
  return rest;
}

/**
 * Whether a session is offered Claude's Artifact tool. Only a Work or Code
 * session outside Plan, on a claude.ai sign-in, whose account the person
 * enabled Claude artifacts for and whose thread chose them, on a host that
 * does not turn the runtime's non-essential traffic off: publishing sends a
 * Project file to claude.ai, an outward side effect Plan's read-only rule
 * refuses, and Chat runs in Plan. Such a launch goes without the telemetry
 * guard ({@link claudeArtifactLaunchEnvironment}); every other launch keeps
 * every guard.
 */
export function claudeOffersArtifacts(input: {
  readonly authentication: ClaudeAuthentication;
  readonly artifactDelivery: boolean;
  readonly threadChoseArtifacts: boolean;
  readonly hostTrafficDisabled: boolean;
  readonly mode: ProviderAcquireInput["mode"];
  readonly executionPolicy: ProviderExecutionPolicy;
}): boolean {
  return (
    input.threadChoseArtifacts &&
    !input.hostTrafficDisabled &&
    claudeArtifactsAvailable(input) &&
    (input.mode === "work" || input.mode === "code") &&
    input.executionPolicy !== "plan"
  );
}

function claudeArtifactsAvailable(input: {
  readonly authentication: ClaudeAuthentication;
  readonly artifactDelivery: boolean;
}): boolean {
  return input.artifactDelivery && input.authentication === "subscription";
}

/**
 * Why an Artifact call is refused, or undefined when it may go on to the
 * thread's ordinary approval posture. Octant offers the tool to publish one
 * Project file and nothing else: `list` reads titles other people chose from
 * claude.ai into the conversation, and a file outside the Project would send
 * something the thread was never bound to, in Full access too.
 */
export function claudeArtifactCallRefusal(input: {
  readonly stillOn: boolean;
  readonly input: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
  readonly isProjectConfinedPath: (projectRoot: string, absolutePath: string) => boolean;
}): string | undefined {
  if (!input.stillOn) return "Claude artifacts are turned off in Settings.";
  const action = input.input.action;
  if (action !== undefined && action !== "publish") {
    return "Octant offers Claude's Artifact tool only to publish a page from the Project.";
  }
  const filePath = input.input.file_path;
  if (typeof filePath !== "string") {
    return "Claude tool request has no authoritative confined path.";
  }
  // A home folder opened as a Project contains the login keychain folder.
  if (claudeToolPathIsInKeychainFolder(filePath)) {
    return "Claude tool request is outside the Project.";
  }
  let confined = false;
  try {
    confined =
      filePath !== input.projectRoot &&
      input.isProjectConfinedPath(input.projectRoot, filePath) === true;
  } catch {
    confined = false;
  }
  return confined ? undefined : "Claude tool request is outside the Project.";
}

/**
 * The path a call is confined by. A tool that names no file (a question, the
 * checklist, or a built-in tool the gate has no rule of its own for) is judged
 * at the Project root and asks below Full access, so a new tool is neither
 * refused for lacking a path nor run unasked.
 */
function claudeConfinedTarget(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  projectRoot: string,
  workingDirectory: string,
): unknown {
  // A shell command and a search with no folder run in the session's working
  // directory: the Project root, or a worktree Claude moved the session into.
  if (CLAUDE_SHELL_TOOLS.has(toolName)) return input.cwd ?? workingDirectory;
  if (toolName === "Glob" || toolName === "Grep") return input.path ?? workingDirectory;
  if (toolName === "NotebookEdit") return input.notebook_path;
  // A Projects upload sends the local file it names to claude.ai, so it is
  // held to the Project's folders as an Artifact publish is; a call that
  // uploads nothing is judged at the Project root.
  if (toolName === CLAUDE_PROJECTS_TOOL) return input.local_path ?? projectRoot;
  if (
    CLAUDE_READ_TOOLS.has(toolName) ||
    CLAUDE_EDIT_TOOLS.has(toolName) ||
    toolName === CLAUDE_ARTIFACT_TOOL
  ) {
    return input.file_path;
  }
  return projectRoot;
}

/** Whether this call is a Plan turn's shell command, which its sandbox confines. */
function isPlanShellCommand(
  policy: ProviderExecutionPolicy,
  toolName: string,
  tools: readonly string[],
): boolean {
  return policy === "plan" && toolName === "Bash" && tools.includes("Bash");
}

function claudePolicyOptions(
  policy: ProviderExecutionPolicy,
  autoApprove?: boolean,
): ClaudeExecutionOptions {
  switch (policy) {
    case "full-access":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: [...CLAUDE_TOOLS],
        fullToolSet: true,
      };
    case "auto-accept-edits":
    case "approval-gated":
      // Both postures run Claude in its ordinary permission mode: Octant's own
      // gate decides every call, so auto-accepting edits stays a decision the
      // host records rather than one the provider makes for it. When the user
      // opts into harness-delegated approvals, the SDK's `auto` classifier
      // answers prompts Octant would otherwise surface; `canUseTool` and
      // `PreToolUse` stay registered regardless.
      return {
        permissionMode: autoApprove === true ? "auto" : "default",
        allowDangerouslySkipPermissions: false,
        tools: [...CLAUDE_TOOLS],
        fullToolSet: true,
      };
    case "plan":
      return {
        permissionMode: "plan",
        allowDangerouslySkipPermissions: false,
        tools: [
          ...CLAUDE_PLAN_TOOLS,
          CLAUDE_CHECKLIST_TOOL,
          CLAUDE_PLAN_EXIT_TOOL,
          ...CLAUDE_TASK_TOOLS,
        ],
        fullToolSet: false,
      };
  }
}

/** Whether this posture runs Claude's commands in its own sandbox. */
function claudeRunsSandbox(policy: ProviderExecutionPolicy, fullAccessSandbox = false): boolean {
  return (
    policy === "approval-gated" ||
    policy === "auto-accept-edits" ||
    (policy === "full-access" && fullAccessSandbox)
  );
}

/**
 * Claude's own sandbox for its commands. With `proxyPort` the sandbox's
 * network goes to Octant's egress proxy for the session, which reaches only
 * the Project's egress rules and the person's safe networks; without it (a
 * host that does not route runtimes) the sandbox keeps its own network rules.
 */
export function claudeSandboxSettings(
  policy: ProviderExecutionPolicy,
  projectRoot: string,
  extraFolders: ReadonlyArray<string> = [],
  proxyPort?: number,
  fullAccessSandbox = false,
): ClaudeSandboxSettings | undefined {
  if (!claudeRunsSandbox(policy, fullAccessSandbox)) return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ["/"],
      // An extra folder is granted exactly what the root is.
      allowRead: [projectRoot, ...extraFolders],
      allowWrite: [projectRoot, ...extraFolders],
    },
    ...(proxyPort === undefined ? {} : { network: { httpProxyPort: proxyPort } }),
  };
}

/** The configuration directory the runtime launched with this environment uses. */
function claudeConfigurationDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment.CLAUDE_CONFIG_DIR !== undefined && environment.CLAUDE_CONFIG_DIR !== ""
    ? environment.CLAUDE_CONFIG_DIR
    : join(environment.HOME ?? homedir(), ".claude");
}

/** The account's own state, which the secret guard leaves to this runtime. */
function claudeOwnAccountPaths(environment: Readonly<Record<string, string | undefined>>) {
  const configuration = claudeConfigurationDirectory(environment);
  return [configuration, environment.CLAUDE_SECURESTORAGE_CONFIG_DIR].filter(
    (path): path is string => path !== undefined && isAbsolute(path),
  );
}

/** Claude's tools that read every file beneath a folder. */
const CLAUDE_SEARCH_TOOLS = new Set<string>(["Grep", "Glob", "LS"]);

/**
 * Why a file tool call that touches a protected file is refused, at every
 * posture below Full access (see {@link claudeSecretGuardApplies}). Claude's
 * own file tools run in the runtime process, and below Full access that
 * process is not wrapped: its own sandbox holds only its commands,
 * and that sandbox cannot carry the list, because its `allowRead` (the Project
 * root) takes precedence over any `denyRead` beneath it. So this gate is what
 * keeps a Project that contains the home folder from handing over a key.
 *
 * A search reads every file beneath its root, and Claude's search tools take
 * no exclusion, so a search rooted at or above an existing protected file is
 * refused whole: Grep in content mode rooted at `~/.aws` read
 * `~/.aws/credentials` while only the folder was named. A search with no path
 * runs in the Project root and is judged there.
 */
export function claudeFileToolSecretRefusal(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  ownAccountPaths: ReadonlyArray<string>,
  projectRoot: string,
  searchesRunUnguarded: boolean,
  homeDirectory?: string,
): string | undefined {
  const options = {
    ownAccountPaths,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  };
  if (CLAUDE_SEARCH_TOOLS.has(toolName)) {
    // Under Plan the runtime runs inside Octant's profile, so
    // a search passes over a protected file the OS refuses to open.
    if (!searchesRunUnguarded) return undefined;
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const searchRoot = rootedClaudeFilePath(
      typeof input.path === "string" ? input.path : ".",
      projectRoot,
    );
    const roots = [
      searchRoot,
      // A relative Glob can leave its search folder through a fixed `..`
      // prefix; check that resolved location as well as the named root.
      ...(toolName === "Glob" ? [rootedClaudeFilePath(globFixedPrefix(pattern), searchRoot)] : []),
    ];
    for (const root of roots) {
      const refusal = secretGuardSearchRefusal(root, options);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }
  // Every built-in tool that names a file is checked, a tool the gate has no
  // rule of its own for included; an MCP server's tool runs in its own
  // process and its arguments are its own.
  if (toolName.startsWith("mcp__")) return undefined;
  // `local_path` is the local file Claude's Projects tool uploads.
  for (const key of ["file_path", "notebook_path", "path", "local_path"] as const) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const refusal = secretGuardRefusal(rootedClaudeFilePath(value, projectRoot), options);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Whether the gate's secret-path refusals apply at this posture. Full access
 * means everything for files (maintainer decision, 2026-11-14): Claude reads
 * and writes any file there, as it does on its own. Guarded, Accept edits,
 * Reviewed, and Plan keep every refusal. Octant still never journals a secret
 * value: redaction of logs, the journal, and exports is not a posture rule.
 */
export function claudeSecretGuardApplies(policy: ProviderExecutionPolicy): boolean {
  return policy !== "full-access";
}

/**
 * Whether the runtime process runs outside Octant's profile at this posture
 * (on its own sandbox, which holds only its commands, or with none at Full
 * access), so a search it runs in process is not held by the secret guard's
 * OS rule and Octant's gate has to refuse it.
 */
export function claudeSearchesRunUnguarded(policy: ProviderExecutionPolicy): boolean {
  return policy === "approval-gated" || policy === "auto-accept-edits" || policy === "full-access";
}

/** Keep `..` until the guard can check the kernel's symlink interpretation too. */
function rootedClaudeFilePath(path: string, root: string): string {
  return isAbsolute(path) ? path : `${root}/${path}`;
}

/** The fixed prefix before a glob’s first wildcard, relative or absolute. */
function globFixedPrefix(pattern: string): string {
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (/[*?[{]/u.test(segment)) break;
    segments.push(segment);
  }
  const prefix = segments.join("/");
  return prefix === "" ? (pattern.startsWith("/") ? "/" : ".") : prefix;
}

/**
 * The driver options a connection answers "inside the Project?" with: a path
 * in one of the Project's extra folders counts as inside the root, for every
 * check that asks about the root, and nothing else changes.
 */
function withProjectFolders(
  options: ClaudeDriverOptions,
  projectRoot: string,
  extraFolders: ReadonlyArray<string>,
): ClaudeDriverOptions {
  if (extraFolders.length === 0) return options;
  const inside = options.isProjectConfinedPath;
  return {
    ...options,
    isProjectConfinedPath: (root, absolutePath) =>
      inside(root, absolutePath) ||
      (root === projectRoot &&
        extraFolders.some((folder) => absolutePath === folder || inside(folder, absolutePath))),
  };
}

/** Whether a file tool's target resolves to the login keychain folder or a file in it. */
function claudeToolPathIsInKeychainFolder(candidate: string): boolean {
  const folder = dirname(claudeLoginKeychainPath());
  const target = canonicalClaudeAccountDirectory(candidate).path;
  return target === folder || target.startsWith(`${folder}/`);
}

function claudeAccountDirectoryBroadensPlan(
  projectRoot: string,
  configDirectory: string,
  isProjectConfinedPath: (projectRoot: string, absolutePath: string) => boolean,
): boolean {
  // Both sides resolve symlinks first. `/tmp` is `/private/tmp` on macOS, so
  // comparing a physical account path with a configured checkout path misses
  // an overlap.
  const root = canonicalClaudeAccountDirectory(projectRoot).path;
  const directory = canonicalClaudeAccountDirectory(configDirectory).path;
  if (directory === root || root.startsWith(`${directory}/`)) return true;
  try {
    if (isProjectConfinedPath(root, directory) === true) return true;
  } catch {
    return true;
  }
  try {
    return isProjectConfinedPath(directory, root) === true;
  } catch {
    return true;
  }
}

const availableCapabilities: ProviderCapabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unsupported",
  // Each query takes the person's compaction point as an `autoCompactWindow` flag setting.
  compactionPoint: "supported",
  harnessAutoReview: "supported",
  // Claude's reviewer reports a refusal and nothing for a call it approved.
  reviewVerdicts: { allow: "unsupported", deny: "supported" },
  modelSwitch: "supported",
  nativeSetup: {
    subagents: "supported",
    webTools: "supported",
    skills: "supported",
    // The account's own servers start with only its home settings read; a
    // Project's `.mcp.json` waits for that Project's trust.
    toolServers: "supported",
    hooks: "supported",
    projectCode: "supported",
  },
  // Each session owns its runtime process, so one can be killed alone.
  forceStop: "supported",
  ...unsupportedChatCapabilities,
  appManagedTools: "supported",
};

const unavailableCapabilities: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "unavailable",
  interruption: "unavailable",
  approvals: "unavailable",
  userQuestions: "unavailable",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unavailable",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unsupported",
  harnessAutoReview: "unsupported",
  ...unsupportedChatCapabilities,
};

type ClaudeEnvironmentFactory = (
  authentication: ClaudeAuthentication,
  options?: ClaudeEnvironmentScopeOptions,
) => Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope>;

export interface ClaudeDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly authentication: ClaudeAuthentication;
  /** Claude-owned directory for this account. */
  readonly configDirectory?: string;
  /**
   * The person's current "Deliver documents as Claude artifacts" switch for
   * this account, read when a session opens and again at every Artifact call
   * so turning it off holds for a session already running. Absent is off.
   */
  readonly artifactDelivery?: () => boolean;
  /**
   * The person's current switch for this account's own memory, read at each
   * launch. Absent is off.
   */
  readonly ownMemory?: () => boolean;
  readonly process: ClaudeProcessPort;
  readonly sdk: ClaudeAgentSdkPort;
  /** Where the command sandbox sends its network below Full access; absent keeps the sandbox's own rules. */
  readonly runtimeNetwork?: ProviderRuntimeNetworkPort;
  /**
   * The Project's registered servers, for the commands Claude runs outside
   * its own sandbox below Full access. Its sandbox reads only the Project and
   * reaches the network only through its proxy, so `ssh` stays out of reach
   * there, as in Claude's own app.
   */
  readonly serverAccess?: ProviderServerAccessPort;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly runtimeRegistry: ProviderDriverRuntimeRegistry;
  readonly resumeIdentityPort: ClaudeResumeIdentityPort;
  readonly permissionPersistence?: () => PermissionPersistence;
  readonly makeEnvironmentScope?: ClaudeEnvironmentFactory;
  readonly isProjectConfinedPath: (projectRoot: string, absolutePath: string) => boolean;
  readonly clock?: () => string;
  /**
   * The host's process authority clock, in milliseconds. A pre-tool grant
   * expires from it, so a wall clock set back cannot extend one. The host
   * always passes it; a standalone driver falls back to wall time.
   */
  readonly authorityNow?: () => number;
  /**
   * How many tool-use ids a session remembers; {@link MAX_TRACKED_TOOL_USES}
   * unless a test needs to reach the bound with a few calls.
   */
  readonly maxTrackedToolUses?: number;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
  readonly taskId?: () => string;
  readonly toolCallId?: () => string;
  readonly startupTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
}

export interface ClaudeResumeIdentity {
  readonly providerInstanceId: ProviderInstanceId;
  readonly octantSessionId: ProviderSessionId;
  readonly sdkSessionId: string;
  readonly projectRoot: string;
  readonly modelId: ProviderModelId;
  readonly authentication: ClaudeAuthentication;
}

export interface ClaudeResumeIdentityPort {
  /** Implementations must observe abort before mutation and must not complete a mutation afterward. */
  readonly lookup: (
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ) => Promise<ClaudeResumeIdentity | undefined>;
  readonly put: (identity: ClaudeResumeIdentity, signal: AbortSignal) => Promise<void>;
  readonly remove: (
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
}

interface DeferredValue<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
}

interface InFlightSetup {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface ClaudePreToolGrant {
  readonly workingDirectory: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly expiresAt: number;
}

interface ClaudePendingApprovalState extends ClaudePendingApproval {
  readonly decision: DeferredValue<ClaudeToolDecision>;
  readonly reuseKey: string;
  /** The pending call for an automatic reviewer; never published. */
  readonly call?: ProviderApprovalCall | undefined;
}

interface ClaudePendingQuestionState extends ClaudePendingQuestion {
  readonly answer: DeferredValue<Record<string, string> | undefined>;
  /** Answers keyed by question position, never by arrival order. */
  readonly received: Map<number, string>;
  /** The raw question texts, so the callback's answer map keys them verbatim. */
  readonly providerPrompts: ReadonlyArray<string>;
}

/**
 * A turn's usage says its prompts are kept only if they arrived whole: when
 * its context went to the prompt hook and the hook never handed it over, the
 * context is missing from the session, so the report says nothing about
 * retention and the session stops relying on the hook.
 */
function withHookDelivery(state: SessionState, event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (event.kind !== "usage" || event.promptRetention !== "kept") return event;
  const turn = state.hookDeliveries[0];
  if (turn === undefined || !turn.viaHook || turn.delivered) return event;
  state.promptHookRuns = false;
  const { promptRetention: _undelivered, ...withoutRetention } = event;
  return withoutRetention;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly modelId: ProviderModelId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly authentication: ClaudeAuthentication;
  readonly expectedClaudeSessionId?: string;
  readonly expectedRuntimeVersion: string;
  readonly correlationId: CorrelationId;
  readonly scope: Scope.CloseableScope;
  readonly query: ClaudeQueryPort;
  readonly initialized: DeferredValue<string>;
  terminalResult: DeferredValue<void>;
  readonly pendingApprovals: Map<string, ClaudePendingApprovalState>;
  readonly pendingAppTools: Map<
    string,
    { readonly answer: DeferredValue<ManagedToolAnswer>; readonly signal: AbortSignal }
  >;
  readonly pendingQuestions: Map<string, ClaudePendingQuestionState>;
  readonly preToolRequests: Map<string, ClaudePreToolGrant>;
  readonly approvalReuse: Set<string>;
  /** What each approved publish sent, by tool use, until its result arrives. */
  readonly publishedSnapshots: Map<string, ThreadPublishedSnapshot>;
  /**
   * Worktrees outside the Project's folders this session was let into: the
   * switch was allowed, so calls in them are judged as the Project's are.
   */
  readonly worktrees: Set<string>;
  /** The tool uses the gate has seen, oldest first; settled ones are forgotten past a bound. */
  readonly observedToolUseIds: Set<string>;
  readonly settledToolUseIds: Set<string>;
  /** The task list from Claude's task tools, kept across the session's turns. */
  readonly taskList: ClaudeTaskList;
  claudeSessionId?: string;
  context?: ClaudeEventContext;
  collector?: Fiber.RuntimeFiber<void, never>;
  outputAccepted: boolean;
  pendingTurns: number;
  /**
   * Whether this session's prompt hook can carry Octant's context. It turns
   * false for good once a message's context went undelivered, so later turns
   * frame their context inside the message instead.
   */
  promptHookRuns: boolean;
  /**
   * One entry per turn sent and not yet ended, in order: whether its context
   * went to the prompt hook, and whether the hook confirmed handing it over.
   * A turn whose hook context never arrived does not report its prompts as
   * kept, so the held record sends that context again.
   */
  readonly hookDeliveries: Array<{ readonly viaHook: boolean; delivered: boolean }>;
  appToolsEnabled: boolean;
  terminal: boolean;
  active: boolean;
  releasing: boolean;
  released: boolean;
  releasePromise?: Promise<void>;
  /** The compaction `compact` asked for, until the runtime reports how it ended. */
  compaction?: ClaudePendingCompaction | undefined;
  /** The runtime's background tasks still running, by its own task id. */
  readonly backgroundTasks: Set<string>;
  /** Whether the person's current turn started any background task. */
  startedBackgroundWork: boolean;
  /** Whether this runtime reports when it goes idle (`session_state_changed`). */
  reportsSessionState: boolean;
  heldTurn?: ClaudeHeldTurn | undefined;
  /** The person's turn's latest usage report as published, for a held turn to build on. */
  turnUsage?: ClaudeUsageEvent | undefined;
}

/**
 * A person's turn the runtime finished while background work it started
 * still runs (maintainer decision, 2026-11-14). A background command or a
 * `Monitor` watch wakes the model when it ends or reports, and the runtime
 * then starts a turn by itself. A session lasts one turn, so that turn would
 * otherwise start with nothing to journal it, after the runner had stopped the
 * session. Instead the completion is held: the runtime's turns are folded into
 * the person's turn, each opened by a `runtime-turn-started` event, and pass
 * the same gate at the same level. The completion goes out once no background
 * task runs and the runtime has gone idle; the stalled-turn limit, the
 * person's stop, and {@link MAX_RUNTIME_TURNS} end it sooner.
 */
interface ClaudeHeldTurn {
  /** The completion the runtime's last result made, without its envelope. */
  completion: Omit<
    Extract<ProviderRuntimeEvent, { readonly kind: "completed" }>,
    "sequence" | "occurredAt"
  >;
  /**
   * Nothing queued can wake the model: the runtime said it went idle after
   * that result, and no background task ended since.
   */
  idle: boolean;
  /** The runtime is running a turn it started itself. */
  runtimeTurnOpen: boolean;
  runtimeTurns: number;
  /**
   * What the person's turn used up to the last result, the runtime's earlier
   * turns included. Each runtime turn counts only its own requests and cost,
   * so its reports are added to this: a usage report covers the whole turn.
   */
  usageBase?: ClaudeUsageEvent | undefined;
}

type ClaudeUsageEvent = Extract<ProviderRuntimeEvent, { readonly kind: "usage" }>;

/** A runtime turn's own usage report, carried on from what the person's turn used before it. */
function foldedUsage(base: ClaudeUsageEvent, own: ClaudeUsageEvent): ClaudeUsageEvent {
  const sum = (first: number | undefined, second: number | undefined) =>
    first === undefined && second === undefined ? undefined : (first ?? 0) + (second ?? 0);
  const reasoningTokens = sum(base.reasoningTokens, own.reasoningTokens);
  const cacheReadInputTokens = sum(base.cacheReadInputTokens, own.cacheReadInputTokens);
  const cacheWriteInputTokens = sum(base.cacheWriteInputTokens, own.cacheWriteInputTokens);
  const providerExecutionDurationMs = sum(
    base.providerExecutionDurationMs,
    own.providerExecutionDurationMs,
  );
  const costUsd = sum(base.costUsd, own.costUsd);
  const {
    reasoningTokens: _reasoning,
    cacheReadInputTokens: _cacheRead,
    cacheWriteInputTokens: _cacheWrite,
    providerExecutionDurationMs: _duration,
    costUsd: _cost,
    ...rest
  } = own;
  return {
    ...rest,
    inputTokens: base.inputTokens + own.inputTokens,
    outputTokens: base.outputTokens + own.outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(providerExecutionDurationMs === undefined ? {} : { providerExecutionDurationMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** What the runtime sends while running a turn, which opens one when a turn is held. */
const CLAUDE_TURN_MESSAGE_KINDS: ReadonlySet<ClaudeDecodedMessage["kind"]> = new Set([
  "assistant",
  "stream-event",
  "tool-results",
  "tool-progress",
  "tool-summary",
  "child-assistant",
  "result",
]);

interface ClaudePendingCompaction {
  /** The runtime marked the cut, so the session holds the summary now. */
  boundary?: { readonly tokensBefore: number; readonly tokensAfter?: number } | undefined;
  /** The runtime's status said the compaction succeeded. */
  succeeded: boolean;
  readonly settle: (outcome: ProviderSessionCompaction) => void;
}

/**
 * Claude reports a compaction that did not finish only as `failed`, with no
 * word on whether the session was already rewritten, so a failure is always
 * one that may have changed it.
 */
const CLAUDE_COMPACTION_UNCERTAIN = {
  kind: "failed",
  message: "Claude did not finish compacting the session.",
  sessionMayHaveChanged: true,
} as const satisfies ProviderSessionCompaction;

interface ConnectionFactories {
  readonly clock: () => string;
  readonly authorityNow: () => number;
  readonly maxTrackedToolUses: number;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
  readonly makeTaskId: () => string;
  readonly makeToolCallId: () => string;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function connectionClosingFailure(): ProviderFailure {
  return failure("unavailable", "Claude connection is closing.");
}

function throwIfSetupCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw connectionClosingFailure();
}

function awaitSetupPromise<A>(promise: PromiseLike<A>, signal: AbortSignal): Promise<A> {
  throwIfSetupCancelled(signal);
  return new Promise<A>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => rejectPromise(connectionClosingFailure()));
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(promise).then(
      (value) =>
        finish(() => {
          if (signal.aborted) rejectPromise(connectionClosingFailure());
          else resolvePromise(value);
        }),
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

async function runSetupEffect<A>(
  effect: Effect.Effect<A, ProviderFailure>,
  signal: AbortSignal,
): Promise<A> {
  throwIfSetupCancelled(signal);
  const fiber = Effect.runFork(effect);
  const interrupt = () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (Exit.isSuccess(exit)) {
      throwIfSetupCancelled(signal);
      return exit.value;
    }
    if (signal.aborted) throw connectionClosingFailure();
    throw (
      Option.getOrUndefined(Cause.failureOption(exit.cause)) ??
      failure("provider-failed", "Claude request failed.")
    );
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}

function sanitizeFailure(
  error: unknown,
  fallbackCategory: ProviderFailure["category"] = "provider-failed",
  fallbackMessage = "Claude request failed.",
): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return failure(fallbackCategory, fallbackMessage);
  }
}

function deferred<A>(): DeferredValue<A> {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function approvalReuseKey(toolName: string, digest: string): string {
  return `${toolName}:${digest}`;
}

function denyClaudeToolRequest(
  state: SessionState | undefined,
  toolUseId: string,
  message: string,
): ClaudeToolDecision {
  if (state !== undefined) {
    state.preToolRequests.delete(toolUseId);
    if (state.observedToolUseIds.has(toolUseId)) state.settledToolUseIds.add(toolUseId);
  }
  return { behavior: "deny", message };
}

function expireClaudePreToolGrants(state: SessionState, now: number): void {
  for (const [toolUseId, grant] of state.preToolRequests) {
    if (grant.expiresAt > now) continue;
    state.preToolRequests.delete(toolUseId);
    state.settledToolUseIds.add(toolUseId);
  }
}

/**
 * Forgets the oldest settled tool-use ids once the session remembers as many
 * as it may. A settled id's decision is already made, so forgetting it gives
 * nothing new: a repeat of it passes the whole gate again, and `canUseTool`
 * still needs the grant `PreToolUse` records. An id still pending or holding
 * a grant is never settled, so it is never forgotten.
 */
function forgetSettledToolUses(state: SessionState, limit: number): void {
  if (state.observedToolUseIds.size < limit) return;
  for (const toolUseId of state.observedToolUseIds) {
    if (state.observedToolUseIds.size < limit) return;
    if (!state.settledToolUseIds.has(toolUseId)) continue;
    state.observedToolUseIds.delete(toolUseId);
    state.settledToolUseIds.delete(toolUseId);
  }
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function validatedClaudeQuestionPrompts(
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> | undefined {
  const questions = input.questions;
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > MAX_CLAUDE_QUESTIONS
  ) {
    return undefined;
  }
  const prompts: string[] = [];
  for (const question of questions) {
    if (typeof question !== "object" || question === null || Array.isArray(question)) {
      return undefined;
    }
    const prompt = (question as Readonly<Record<string, unknown>>).question;
    if (
      typeof prompt !== "string" ||
      exceedsCodePointLimit(prompt, USER_QUESTION_MAX_CHARACTERS) ||
      prompt.trim().length === 0 ||
      prompts.includes(prompt)
    ) {
      return undefined;
    }
    prompts.push(prompt);
  }
  return prompts;
}

function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "completed" ||
    event.kind === "failed" ||
    event.kind === "interrupted" ||
    event.kind === "waiting"
  );
}

/**
 * The runtime names a model by its family alias ("Sonnet", "Opus", "Default
 * (recommended)") and keeps the versioned name for the first clause of the
 * description ("Sonnet 5 · Efficient for routine tasks"; Claude Code 2.1.234).
 * A picker that says only "Sonnet" hides which generation a thread runs on,
 * so the versioned clause is the display name when it extends the alias, and
 * the default entry says what it resolves to.
 */
function versionedClaudeModelName(displayName: string, description: string): string {
  const versioned = description.split("·")[0]?.trim() ?? "";
  if (versioned.length === 0) return displayName;
  if (versioned.toLowerCase().startsWith(displayName.toLowerCase())) return versioned;
  if (displayName.toLowerCase().startsWith("default")) {
    // Newer runtimes describe the default as "Use the default model
    // (currently Opus 5.5)", so the model is the part after "currently".
    const resolved = /\(currently ([^)]+)\)/i.exec(versioned)?.[1]?.trim();
    return `Default (${resolved ?? versioned})`;
  }
  return displayName;
}

function modelFromClaude(source: ClaudeModelInfo): ProviderModel | undefined {
  const id = source.id.trim();
  const displayName = versionedClaudeModelName(source.displayName.trim(), source.description);
  if (id.length === 0 || displayName.length === 0) return undefined;
  const effort = source.supportsEffort
    ? [...new Set(source.supportedEffortLevels.map((value) => value.trim()))].filter(Boolean)
    : [];
  return {
    id: id as ProviderModelId,
    displayName,
    source: "discovered",
    verification: "verified",
    reasoning: source.supportsEffort ? "supported" : "unavailable",
    // Every model Claude Code offers takes images. Reporting text only made
    // the composer refuse a pasted screenshot on Sonnet with "does not
    // support images", which was Octant's claim, not the model's.
    inputModalities: ["text", "image"],
    options:
      effort.length === 0
        ? []
        : [
            {
              id: "effort",
              displayName: "Effort",
              kind: "selection",
              values: effort as [string, ...string[]],
            },
          ],
  };
}

/**
 * The `effort` value to hand the Agent SDK: only a level the verified model
 * observation declared for this model. Anything else (unknown option ids, a
 * level this model does not support) is dropped so the SDK default applies.
 */
function selectedEffort(
  model: ProviderModel,
  values: ProviderModelOptionValues | undefined,
): ClaudeEffortLevel | undefined {
  const requested = values?.["effort"];
  if (requested === undefined || !isClaudeEffortLevel(requested)) return undefined;
  const option = model.options.find((candidate) => candidate.id === "effort");
  return option?.kind === "selection" && option.values.includes(requested) ? requested : undefined;
}

function claudeIncompatibleMessage(message: string): string {
  return CLAUDE_INCOMPATIBLE_REASONS.has(message) ? message : CLAUDE_INCOMPATIBLE_FALLBACK;
}

function observation(
  options: ClaudeDriverOptions,
  input: {
    readonly readiness: "ready" | "unauthenticated" | "incompatible" | "unavailable";
    readonly version: string;
    readonly models?: readonly ProviderModel[];
    /** The runtime announced `compact` when the probe opened it. */
    readonly compactAnnounced?: boolean;
    /** The probe's launch carried the host's own non-essential traffic switch. */
    readonly hostTrafficDisabled?: boolean;
    readonly credentialStatus?: "stored" | "missing" | "unavailable";
    readonly message?: string;
  },
  clock: () => string,
) {
  const observedAt = clock() as UtcTimestamp;
  // Claude Code keeps every mode's session, so `/compact` reaches all of them
  // alike; an install that does not announce the command cannot be asked.
  const sessionCompaction = input.compactAnnounced === true ? "supported" : "unavailable";
  // Whether the runtime then lists the tool rests on claude.ai's own plan
  // checks, which no probe can read without a turn. The provider service
  // reports a change of the person's setting at once, without a probe.
  const nativeArtifacts = claudeNativeArtifactsSupport({
    authentication: options.authentication,
    artifactDelivery: options.artifactDelivery?.() === true,
    hostTrafficDisabled: input.hostTrafficDisabled === true,
  });
  const result = decodeProviderProbeResult({
    instanceId: options.instanceId,
    readiness: input.readiness,
    // The runtime's `auth status` only says logged in, so the account kind is
    // the one this instance is configured to sign in with.
    ...(input.readiness === "ready" ? { accountAuthentication: options.authentication } : {}),
    processState: "stopped",
    detectedVersion: input.version,
    ...(input.credentialStatus === undefined ? {} : { credentialStatus: input.credentialStatus }),
    models: input.models ?? [],
    capabilities:
      input.readiness === "ready"
        ? {
            ...availableCapabilities,
            sessionCompaction: {
              chat: sessionCompaction,
              work: sessionCompaction,
              code: sessionCompaction,
            },
            nativeArtifacts,
          }
        : unavailableCapabilities,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.readiness === "ready" ? { lastSuccessfulProbeAt: observedAt } : {}),
    observedAt,
  });
  options.runtimeRegistry.setObservedState(result);
  return result;
}

function brokerHas(options: ClaudeDriverOptions): Effect.Effect<boolean, ProviderFailure> {
  if (options.credentialResolver === undefined) {
    return Effect.fail(failure("provider-failed", "Claude credential broker is unavailable."));
  }
  return Effect.tryPromise({
    try: () => options.credentialResolver!.has(options.instanceId),
    catch: () => failure("provider-failed", "Claude credential broker is unavailable."),
  });
}

function brokerResolve(options: ClaudeDriverOptions): Effect.Effect<string, ProviderFailure> {
  if (options.credentialResolver === undefined) {
    return Effect.fail(failure("provider-failed", "Claude credential broker is unavailable."));
  }
  return Effect.tryPromise({
    try: async () => {
      const value = await options.credentialResolver!.resolve(options.instanceId);
      if (value.trim().length === 0 || looksLikeRetiredClaudeHelperToken(value)) {
        throw failure("unauthenticated", "Claude API-key credential is missing.");
      }
      return value;
    },
    catch: (error) => {
      const sanitized = sanitizeFailure(error);
      return sanitized.category === "unauthenticated"
        ? sanitized
        : failure("provider-failed", "Claude credential broker is unavailable.");
    },
  });
}

function looksLikeRetiredClaudeHelperToken(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { readonly kind?: unknown }).kind === "claude-helper-sign-in"
    );
  } catch {
    return false;
  }
}

/**
 * The folder a readiness probe binds as its project root.
 *
 * A probe is not a thread and has no project. It used to bind the server's
 * working directory, which a Plan launch now confines: started from `/`, the
 * shared builder refuses that root as an ancestor of the sensitive paths it
 * denies, so Claude readiness failed before authentication or model discovery,
 * and any other directory the server happened to be standing in became the
 * probe's readable root. An empty folder only this probe can name binds
 * nothing it did not create.
 */
const privateProbeRoot = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => realpath(await mkdtemp(join(tmpdir(), "octant-claude-probe-"))),
    catch: () =>
      failure("provider-failed", "Claude probe could not create a private working folder."),
  }),
  (directory) =>
    Effect.promise(() => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
);

function probeSdk(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  environmentOptions: ClaudeEnvironmentScopeOptions,
): Effect.Effect<
  { readonly models: readonly ProviderModel[]; readonly compactAnnounced: boolean },
  ProviderFailure,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const environment = yield* environmentFactory(options.authentication, environmentOptions);
    // Acquired before the query, so it is released after the query closes.
    const probeRoot = yield* privateProbeRoot;
    // A probe is a Plan launch of its own, on a listener of its own.
    const network = yield* acquireProviderRuntimeNetwork(options.runtimeNetwork, {
      runtime: "claude",
      root: probeRoot,
      executionPolicy: "plan",
      environment: environment.environment,
    });
    const query = yield* options.sdk.openQuery({
      binaryPath: options.binaryPath,
      projectRoot: probeRoot,
      authEnvironment: environment.environment,
      ...(network === undefined ? {} : { network }),
      model: PROBE_MODEL,
      executionPolicy: "plan",
      tools: CLAUDE_PLAN_TOOLS,
      canUseTool: async () => ({ behavior: "deny", message: "Probe cannot use tools." }),
      preToolUse: async () => ({ behavior: "deny", message: "Probe cannot use tools." }),
    });
    // The runtime initializes only once a user message arrives, so the probe
    // reads the catalogue and account through the SDK's control requests
    // and never consumes the message stream.
    const account = yield* query.accountInfo();
    if (!account.ready) {
      return yield* Effect.fail(failure("unauthenticated", "Claude authentication is required."));
    }
    if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
      return yield* Effect.fail(
        failure("protocol", "Claude initialized an unsupported account routing policy."),
      );
    }
    const models = (yield* query.supportedModels()).flatMap((model) => {
      const normalized = modelFromClaude(model);
      return normalized === undefined ? [] : [normalized];
    });
    if (models.length === 0) {
      return yield* Effect.fail(failure("protocol", "Claude returned no usable models."));
    }
    return { models, compactAnnounced: query.initialization.compactAnnounced };
  });
}

function makeProbe(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  clock: () => string,
) {
  return ({ instanceId }: { readonly instanceId: ProviderInstanceId }) => {
    if (instanceId !== options.instanceId) {
      return Effect.fail(
        failure("invalid-configuration", "Provider instance does not match driver."),
      );
    }
    return Effect.gen(function* () {
      const version = yield* options.process.probeVersion(options.binaryPath);
      let apiKey: string | undefined;
      let hostTrafficDisabled = false;
      if (options.authentication === "subscription") {
        const environment = yield* environmentFactory(
          "subscription",
          options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory },
        );
        hostTrafficDisabled = disablesNonessentialTraffic(environment.environment);
        const status = yield* options.process.probeSubscription(
          options.binaryPath,
          environment.environment,
        );
        if (status === "unauthenticated") {
          return observation(
            options,
            {
              readiness: "unauthenticated",
              version,
              message: "Authenticate Claude with the official Claude Code application.",
            },
            clock,
          );
        }
      } else {
        const presence = yield* Effect.either(brokerHas(options));
        if (presence._tag === "Left") {
          return observation(
            options,
            {
              readiness: "unavailable",
              version,
              credentialStatus: "unavailable",
              message: "Claude credential broker is unavailable. Restart Octant and try again.",
            },
            clock,
          );
        }
        if (!presence.right) {
          return observation(
            options,
            {
              readiness: "unauthenticated",
              version,
              credentialStatus: "missing",
              message: "Store an Anthropic API key for this Claude provider.",
            },
            clock,
          );
        }
        const resolved = yield* Effect.either(brokerResolve(options));
        if (resolved._tag === "Left") {
          return observation(
            options,
            resolved.left.category === "unauthenticated"
              ? {
                  readiness: "unauthenticated",
                  version,
                  credentialStatus: "missing",
                  message: "Store an Anthropic API key for this Claude provider.",
                }
              : {
                  readiness: "unavailable",
                  version,
                  credentialStatus: "unavailable",
                  message: "Claude credential broker is unavailable. Restart Octant and try again.",
                },
            clock,
          );
        }
        apiKey = resolved.right;
      }
      const sdkResult = yield* probeSdk(options, environmentFactory, {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.configDirectory === undefined
          ? {}
          : { configDirectory: options.configDirectory }),
      }).pipe(
        Effect.map((probed) => ({ kind: "ready" as const, ...probed })),
        Effect.catchAll((providerFailure) =>
          providerFailure.category === "protocol" || providerFailure.category === "unsupported"
            ? Effect.succeed({
                kind: "incompatible" as const,
                message: claudeIncompatibleMessage(providerFailure.message),
              })
            : Effect.fail(providerFailure),
        ),
        Effect.ensuring(Effect.sync(() => (apiKey = undefined))),
      );
      if (sdkResult.kind === "incompatible") {
        return observation(
          options,
          {
            readiness: "incompatible",
            version,
            ...(options.authentication === "api-key"
              ? { credentialStatus: "stored" as const }
              : {}),
            message: sdkResult.message,
          },
          clock,
        );
      }
      return observation(
        options,
        {
          readiness: "ready",
          version,
          models: sdkResult.models,
          compactAnnounced: sdkResult.compactAnnounced,
          hostTrafficDisabled,
          ...(options.authentication === "api-key" ? { credentialStatus: "stored" as const } : {}),
        },
        clock,
      );
    });
  };
}

function makeClaudeContextFacts(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  clock: () => string,
): ProviderContextFactsSource {
  return {
    observeModelLimits: () => Effect.succeed([]),
    observeServiceLimits: ({ instanceId, onDemand }) =>
      Effect.gen(function* () {
        if (instanceId !== options.instanceId) {
          return yield* Effect.fail(
            failure("invalid-configuration", "Provider instance does not match driver."),
          );
        }
        if (options.authentication === "api-key") {
          return yield* Effect.fail(failure("unsupported", "Plan limits do not apply."));
        }
        // This reading starts a `claude` process. That is worth it when a
        // person asks for it. On the five-minute schedule and before a Chat
        // turn it is not: the host keeps what a session or an earlier
        // request last reported.
        if (onDemand !== true) {
          return yield* Effect.fail(
            failure("unavailable", "Claude plan usage is read on request."),
          );
        }
        const environment = yield* environmentFactory(
          "subscription",
          options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory },
        );
        const probeRoot = yield* privateProbeRoot;
        const network = yield* acquireProviderRuntimeNetwork(options.runtimeNetwork, {
          runtime: "claude",
          root: probeRoot,
          executionPolicy: "plan",
          environment: environment.environment,
        });
        const query = yield* options.sdk.openQuery({
          binaryPath: options.binaryPath,
          projectRoot: probeRoot,
          authEnvironment: environment.environment,
          ...(network === undefined ? {} : { network }),
          model: PROBE_MODEL,
          executionPolicy: "plan",
          tools: CLAUDE_PLAN_TOOLS,
          canUseTool: async () => ({ behavior: "deny", message: "Plan usage cannot use tools." }),
          preToolUse: async () => ({ behavior: "deny", message: "Plan usage cannot use tools." }),
        });
        const payload = yield* query.readPlanUsage();
        const observedAt = clock() as UtcTimestamp;
        const decoded = decodeClaudeProcessPlanUsage(payload, observedAt);
        // A cold subscription process can report no limits before its first turn.
        // Only the configured API-key authentication above establishes no plan.
        if (decoded === undefined || !decoded.available) {
          return yield* Effect.fail(failure("unavailable", "Claude plan usage is unavailable."));
        }
        return claudeProcessPlanUsageLimits(instanceId, decoded, observedAt);
      }),
  };
}

export function makeClaudeDriver(options: ClaudeDriverOptions): ProviderDriver {
  const environmentFactory = options.makeEnvironmentScope ?? makeClaudeEnvironmentScope;
  const factories: ConnectionFactories = {
    clock: options.clock ?? (() => new Date().toISOString()),
    authorityNow: options.authorityNow ?? Date.now,
    maxTrackedToolUses: options.maxTrackedToolUses ?? MAX_TRACKED_TOOL_USES,
    makeCorrelation: options.correlationId ?? randomUUID,
    makeRequestId: options.requestId ?? randomUUID,
    makeTaskId: options.taskId ?? randomUUID,
    makeToolCallId: options.toolCallId ?? randomUUID,
  };
  return {
    kind: "claude",
    conversationOwnership: "provider",
    // The host switch is the one the last probe's launch carried; the
    // session's own launch reads it again before offering the tool.
    nativeArtifactTool: ({ mode, executionPolicy }) =>
      claudeOffersArtifacts({
        authentication: options.authentication,
        artifactDelivery: options.artifactDelivery?.() === true,
        threadChoseArtifacts: true,
        hostTrafficDisabled:
          options.runtimeRegistry.observedState(options.instanceId)?.capabilities.nativeArtifacts
            ?.unsupportedReason === "host-traffic-disabled",
        mode,
        executionPolicy,
      })
        ? CLAUDE_ARTIFACT_TOOL
        : undefined,
    probe: makeProbe(options, environmentFactory, factories.clock),
    contextFacts: makeClaudeContextFacts(options, environmentFactory, factories.clock),
    acquire: ({ instanceId, projectRoot, mode, extraFolders = [], workRequest }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      if (
        [projectRoot, ...extraFolders].some((root) => !isAbsolute(root) || resolve(root) !== root)
      ) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Provider Project root must be an absolute normalized path.",
          ),
        );
      }
      return makeConnection(
        withProjectFolders(options, projectRoot, extraFolders),
        environmentFactory,
        projectRoot,
        extraFolders,
        mode,
        factories,
        workRequest === undefined ? undefined : String(workRequest.threadId),
      );
    },
  };
}

function makeConnection(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  projectRoot: string,
  extraFolders: ReadonlyArray<string>,
  mode: ProviderAcquireInput["mode"],
  factories: ConnectionFactories,
  /** The Work thread this connection serves, which names it to the network reviewer. */
  workThreadId?: string,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const reservedSessionIds = new Set<ProviderSessionId>();
    const inFlightSetups = new Set<InFlightSetup>();
    let closing = false;

    const withSessionReservation = <A>(
      sessionId: ProviderSessionId,
      operation: (signal: AbortSignal) => Promise<A>,
    ): Effect.Effect<A, ProviderFailure> =>
      Effect.tryPromise({
        try: async (effectSignal) => {
          if (closing) throw connectionClosingFailure();
          if (sessions.has(sessionId) || reservedSessionIds.has(sessionId)) {
            throw failure("protocol", "Claude session is already active.");
          }
          reservedSessionIds.add(sessionId);
          const controller = new AbortController();
          const completed = deferred<void>();
          const setup: InFlightSetup = {
            controller,
            done: completed.promise,
          };
          const cancelForCaller = () => controller.abort();
          effectSignal.addEventListener("abort", cancelForCaller, { once: true });
          inFlightSetups.add(setup);
          try {
            return await operation(controller.signal);
          } finally {
            effectSignal.removeEventListener("abort", cancelForCaller);
            reservedSessionIds.delete(sessionId);
            inFlightSetups.delete(setup);
            completed.resolve(undefined);
          }
        },
        catch: (error) => sanitizeFailure(error),
      });

    const publish = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(events, event));
    };
    const deactivate = (state: SessionState) => {
      if (!state.active) return;
      state.active = false;
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) - 1),
      );
    };
    const clearAuthorityState = (state: SessionState) => {
      for (const pending of state.pendingAppTools.values()) {
        pending.answer.resolve({ resultJson: '{"error":"tool-interrupted"}', isError: true });
      }
      state.pendingAppTools.clear();
      const denial = {
        behavior: "deny",
        message: "Claude tool request is no longer active.",
      } as const;
      for (const pending of state.pendingApprovals.values()) {
        state.settledToolUseIds.add(pending.providerToolUseId);
        pending.decision.resolve(denial);
      }
      for (const pending of state.pendingQuestions.values()) {
        state.settledToolUseIds.add(pending.providerToolUseId);
        pending.answer.resolve(undefined);
      }
      for (const toolUseId of state.preToolRequests.keys()) {
        state.settledToolUseIds.add(toolUseId);
      }
      state.pendingApprovals.clear();
      state.pendingQuestions.clear();
      state.preToolRequests.clear();
      state.approvalReuse.clear();
    };
    const release = async (state: SessionState): Promise<void> => {
      if (state.releasePromise !== undefined) {
        await state.releasePromise;
        return;
      }
      if (state.released) return;
      state.releasePromise ??= (async () => {
        state.releasing = true;
        // A stop or teardown mid-compaction ends the request with it; the
        // runtime may already have rewritten the session.
        settleCompaction(state);
        clearAuthorityState(state);
        let releaseFailure: unknown;
        try {
          await Effect.runPromise(Scope.close(state.scope, Exit.void));
        } catch (error) {
          releaseFailure = error;
        }
        try {
          if (state.collector !== undefined) {
            await Effect.runPromise(Fiber.interrupt(state.collector));
          }
        } catch (error) {
          releaseFailure ??= error;
        } finally {
          state.released = true;
          state.releasing = false;
          deactivate(state);
          if (state.terminal && sessions.get(state.sessionId) === state) {
            sessions.delete(state.sessionId);
          }
        }
        if (releaseFailure !== undefined) throw releaseFailure;
      })();
      await state.releasePromise;
    };
    const scheduleRelease = (state: SessionState) => {
      queueMicrotask(() => {
        void release(state).catch(() => undefined);
      });
    };
    const settleCompaction = (state: SessionState) => {
      const pending = state.compaction;
      if (pending === undefined) return;
      state.compaction = undefined;
      if (state.context !== undefined) state.context.compactionRequested = false;
      pending.settle(
        pending.boundary !== undefined
          ? { kind: "compacted", ...pending.boundary }
          : pending.succeeded
            ? { kind: "compacted" }
            : CLAUDE_COMPACTION_UNCERTAIN,
      );
    };
    const terminal = (
      state: SessionState,
      value:
        | {
            readonly kind: "completed";
            readonly resumeCursor?: { readonly driverKind: "claude"; readonly value: string };
          }
        | { readonly kind: "failed"; readonly failure: ProviderFailure }
        | { readonly kind: "interrupted"; readonly message: string }
        | { readonly kind: "waiting"; readonly message: string },
    ) => {
      if (state.terminal) return;
      settleCompaction(state);
      state.terminal = true;
      if (state.context !== undefined) state.context.terminal = true;
      const sequence = state.context?.sequence ?? 1;
      if (state.context !== undefined) state.context.sequence += 1;
      publish({
        ...value,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence,
        correlationId: state.correlationId,
        occurredAt: factories.clock() as UtcTimestamp,
      } as ProviderRuntimeEvent);
      clearAuthorityState(state);
      state.terminalResult.resolve(undefined);
      deactivate(state);
      scheduleRelease(state);
    };
    const makeEventContext = (
      state: SessionState,
      claudeSessionId: string,
      sequence: number,
    ): ClaudeEventContext => ({
      instanceId: options.instanceId,
      sessionId: state.sessionId,
      correlationId: state.correlationId,
      occurredAt: factories.clock() as UtcTimestamp,
      projectRoot: state.projectRoot,
      isProjectConfinedPath: (absolutePath) => {
        try {
          return options.isProjectConfinedPath(state.projectRoot, absolutePath) === true;
        } catch {
          return false;
        }
      },
      writesOutsideCheckout: (absolutePath) =>
        state.executionPolicy === "full-access" ||
        [...state.worktrees].some((worktree) => {
          try {
            return (
              absolutePath === worktree ||
              options.isProjectConfinedPath(worktree, absolutePath) === true
            );
          } catch {
            return false;
          }
        }),
      claudeSessionId,
      sequence,
      terminal: false,
      ...(state.compaction === undefined ? {} : { compactionRequested: true }),
      ...(state.query.initialization.autoCompactThreshold === undefined
        ? {}
        : { autoCompactThreshold: state.query.initialization.autoCompactThreshold }),
      ...(state.query.initialization.contextWindow === undefined
        ? {}
        : { contextWindow: state.query.initialization.contextWindow }),
      callUsage: new Map(),
      requestIds: new Map(),
      taskIds: new Map(),
      todoTaskIds: new Map(),
      taskList: state.taskList,
      toolStates: new Map(),
      makeRequestId: factories.makeRequestId,
      makeTaskId: factories.makeTaskId,
      makeToolCallId: factories.makeToolCallId,
    });
    const admitToolUse = (state: SessionState, toolUseId: string): boolean => {
      if (state.observedToolUseIds.has(toolUseId)) return true;
      forgetSettledToolUses(state, factories.maxTrackedToolUses);
      if (state.observedToolUseIds.size >= factories.maxTrackedToolUses) {
        terminal(state, {
          kind: "failed",
          failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
        });
        return false;
      }
      state.observedToolUseIds.add(toolUseId);
      return true;
    };
    const closeAfterPublishedTerminal = (state: SessionState) => {
      if (state.terminal) return;
      settleCompaction(state);
      state.terminal = true;
      clearAuthorityState(state);
      state.terminalResult.resolve(undefined);
      deactivate(state);
      scheduleRelease(state);
    };
    /**
     * Holds the person's turn the runtime just finished while its background
     * work runs. The next events are numbered from the completion's own
     * number, which never went out, and the runtime's task ids carry over so
     * a background task's end still names the row its start opened.
     */
    const holdTurn = (
      state: SessionState,
      completed: Extract<ProviderRuntimeEvent, { readonly kind: "completed" }>,
    ) => {
      const previous = state.context;
      if (previous === undefined) return;
      const { sequence, occurredAt: _unsent, ...completion } = completed;
      state.heldTurn = {
        completion,
        // A runtime that never reports its state is taken as idle after each
        // result; only a background task's end then makes it wait again.
        idle: !state.reportsSessionState,
        runtimeTurnOpen: false,
        runtimeTurns: state.heldTurn?.runtimeTurns ?? 0,
        usageBase: state.turnUsage,
      };
      state.context = makeEventContext(state, previous.claudeSessionId, sequence);
      for (const [taskId, task] of previous.taskIds) state.context.taskIds.set(taskId, task);
      settleHeldTurn(state);
    };
    const releaseHeldTurn = (state: SessionState, held: ClaudeHeldTurn) => {
      state.heldTurn = undefined;
      state.turnUsage = undefined;
      state.startedBackgroundWork = false;
      const context = state.context;
      if (context === undefined) return;
      context.terminal = true;
      publish({
        ...held.completion,
        sequence: context.sequence++,
        occurredAt: factories.clock() as UtcTimestamp,
      });
      state.terminalResult.resolve(undefined);
      clearAuthorityState(state);
      state.pendingTurns = Math.max(0, state.pendingTurns - 1);
      state.hookDeliveries.shift();
      state.outputAccepted = false;
    };
    /** Sends the held completion once nothing the runtime runs can wake it again. */
    const settleHeldTurn = (state: SessionState) => {
      const held = state.heldTurn;
      if (
        held === undefined ||
        held.runtimeTurnOpen ||
        state.backgroundTasks.size > 0 ||
        !held.idle
      ) {
        return;
      }
      releaseHeldTurn(state, held);
    };
    const openRuntimeTurn = (state: SessionState, held: ClaudeHeldTurn) => {
      const context = state.context;
      if (context === undefined) return;
      // A runtime that keeps waking itself ends with the person's turn: the
      // completion goes out, and the session, with its background work, is
      // stopped rather than left running turns nobody reads.
      if (held.runtimeTurns >= MAX_RUNTIME_TURNS) {
        releaseHeldTurn(state, held);
        closeAfterPublishedTerminal(state);
        return;
      }
      held.runtimeTurns += 1;
      held.runtimeTurnOpen = true;
      held.idle = false;
      publish({
        kind: "runtime-turn-started",
        trigger: "background-task",
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        correlationId: state.correlationId,
        sequence: context.sequence++,
        occurredAt: factories.clock() as UtcTimestamp,
      });
    };
    const handleMessage = (state: SessionState, message: ClaudeDecodedMessage) => {
      if (state.terminal) return;
      if (state.context === undefined) {
        if (
          message.kind !== "initialized" ||
          message.projectRoot !== state.projectRoot ||
          message.requestedModel !== state.modelId ||
          message.runtimeVersion !== state.expectedRuntimeVersion ||
          (state.expectedClaudeSessionId !== undefined &&
            message.sessionId !== state.expectedClaudeSessionId) ||
          (state.claudeSessionId !== undefined && message.sessionId !== state.claudeSessionId)
        ) {
          const failed = failure("protocol", "Claude initialization did not match the session.");
          state.initialized.reject(failed);
          terminal(state, { kind: "failed", failure: failed });
          return;
        }
        state.claudeSessionId = message.sessionId;
        state.context = makeEventContext(state, message.sessionId, 1);
        state.initialized.resolve(message.sessionId);
        return;
      }
      const pendingCompaction = state.compaction;
      if (pendingCompaction !== undefined) {
        // `/compact` is answered by a boundary marking the cut and a status
        // saying how it went, and closed by a result. It is settled once both
        // the boundary and a successful status are in, on a failed status, or
        // at the latest by that result, so the boundary's event always goes
        // out before the answer does.
        if (message.kind === "status" && message.compactResult === "failed") {
          pendingCompaction.boundary = undefined;
          pendingCompaction.succeeded = false;
          settleCompaction(state);
          return;
        }
        if (message.kind === "status" && message.compactResult === "success") {
          pendingCompaction.succeeded = true;
          if (pendingCompaction.boundary !== undefined) settleCompaction(state);
          return;
        }
        if (message.kind === "compaction" && message.trigger === "manual") {
          pendingCompaction.boundary = {
            tokensBefore: message.preTokens,
            ...(message.postTokens === undefined ? {} : { tokensAfter: message.postTokens }),
          };
        }
      }
      if (message.kind === "session-state") {
        state.reportsSessionState = true;
        const held = state.heldTurn;
        if (held === undefined) return;
        if (message.state === "idle") {
          held.idle = true;
          settleHeldTurn(state);
        } else if (!held.runtimeTurnOpen) {
          openRuntimeTurn(state, held);
        }
        return;
      }
      if (state.heldTurn !== undefined && CLAUDE_TURN_MESSAGE_KINDS.has(message.kind)) {
        if (!state.heldTurn.runtimeTurnOpen) openRuntimeTurn(state, state.heldTurn);
        if (state.terminal) return;
      }
      if (message.kind === "result" && state.pendingTurns === 0) {
        closeAfterPublishedTerminal(state);
        return;
      }
      if (message.kind === "task" && message.background === true && state.pendingTurns > 0) {
        state.backgroundTasks.add(message.taskId);
        state.startedBackgroundWork = true;
      }
      // A resumed session's stored task list opens its first turn.
      const storedTaskList =
        state.pendingTurns > 0 && state.compaction === undefined
          ? claudeStoredTaskListEvents(state.context)
          : [];
      for (const mapped of [
        ...storedTaskList,
        ...mapClaudeMessage(state.context, withPublishedSnapshots(state, message)),
      ]) {
        if (mapped.kind === "ignored") continue;
        if (mapped.kind === "failure") {
          terminal(state, { kind: "failed", failure: mapped.failure });
          return;
        }
        if (mapped.kind === "approval" || mapped.kind === "question") {
          terminal(state, {
            kind: "failed",
            failure: failure("protocol", "Claude input callback bypassed its authority gate."),
          });
          return;
        }
        if (
          mapped.event.kind === "completed" &&
          state.pendingTurns > 0 &&
          (state.heldTurn !== undefined ||
            (state.startedBackgroundWork &&
              (state.backgroundTasks.size > 0 || state.reportsSessionState)))
        ) {
          holdTurn(state, mapped.event);
          continue;
        }
        let next = mapped.event;
        if (next.kind === "usage") {
          const base = state.heldTurn?.usageBase;
          if (base !== undefined) next = foldedUsage(base, next);
          state.turnUsage = next;
        }
        publish(withHookDelivery(state, next));
        if (isTerminalEvent(mapped.event)) {
          state.heldTurn = undefined;
          state.turnUsage = undefined;
          state.startedBackgroundWork = false;
          state.terminalResult.resolve(undefined);
          clearAuthorityState(state);
          state.pendingTurns = Math.max(0, state.pendingTurns - 1);
          state.hookDeliveries.shift();
          if (mapped.event.kind === "completed") {
            if (state.pendingTurns > 0) {
              state.context = makeEventContext(
                state,
                state.claudeSessionId!,
                state.context.sequence,
              );
              state.terminalResult = deferred<void>();
            } else {
              state.outputAccepted = false;
            }
            return;
          }
          state.terminal = true;
          deactivate(state);
          scheduleRelease(state);
          return;
        }
        state.outputAccepted = true;
      }
      if (
        message.kind === "task" &&
        (message.subtype === "task_notification" ||
          (message.subtype === "task_updated" &&
            (message.status === "completed" ||
              message.status === "failed" ||
              message.status === "killed")))
      ) {
        // A task that ended hands the model a notice, so the runtime starts
        // a turn for it unless the turn running now takes it in.
        if (state.backgroundTasks.delete(message.taskId) && state.heldTurn !== undefined) {
          state.heldTurn.idle = false;
        }
        settleHeldTurn(state);
      }
      // The boundary's event is out now; a status that already said the
      // compaction succeeded was only waiting for it.
      if (
        message.kind === "compaction" &&
        pendingCompaction !== undefined &&
        state.compaction === pendingCompaction &&
        pendingCompaction.succeeded &&
        pendingCompaction.boundary !== undefined
      ) {
        settleCompaction(state);
      }
    };
    const collectorFinished = (state: SessionState, exit: Exit.Exit<void, ProviderFailure>) => {
      if (state.terminal || state.releasing || state.released) return;
      options.runtimeRegistry.clearObservedState(options.instanceId);
      if (state.context === undefined) {
        const failed = failure("unavailable", "Claude session did not initialize.");
        state.initialized.reject(failed);
        terminal(state, { kind: "failed", failure: failed });
        return;
      }
      if (Exit.isFailure(exit)) {
        // A failure the port's sanitizer wrote already names the cause in safe
        // words and is forwarded; a raw payload that arrived on the stream is
        // still reduced to this sentence, which is the leak guard the tests pin.
        terminal(state, {
          kind: "failed",
          failure: Option.getOrElse(
            Option.filter(Cause.failureOption(exit.cause), isSanitizedFailure),
            () => failure("provider-failed", "Claude message stream failed."),
          ),
        });
      } else if (state.pendingTurns > 0) {
        terminal(state, {
          kind: "interrupted",
          message: "Claude runtime exited unexpectedly.",
        });
      } else {
        terminal(state, {
          kind: "waiting",
          message: "Claude runtime exited; resume must be verified.",
        });
      }
    };

    const startCollector = (state: SessionState) => {
      state.collector = Effect.runFork(
        Stream.runForEach(state.query.messages, (message) =>
          Effect.sync(() => handleMessage(state, message)),
        ).pipe(
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => collectorFinished(state, exit))),
          Effect.asVoid,
        ),
      );
    };

    const open = async (
      input: {
        readonly sessionId: ProviderSessionId;
        readonly modelId: ProviderModelId;
        readonly executionPolicy: ProviderExecutionPolicy;
        readonly fullAccessSandbox?: boolean;
        readonly autoApprove?: boolean;
        readonly modelOptionValues?: ProviderModelOptionValues;
        readonly singleUse?: boolean;
        readonly nativeArtifacts?: boolean;
        readonly nativeSetup?: ProviderNativeSetup;
        readonly compactionPoint?: ProviderCompactionPoint;
      },
      signal: AbortSignal,
      resumeSessionId?: string,
    ): Promise<SessionState> => {
      // An account nobody has checked yet (a fresh start, or a runtime exit that
      // cleared the reading) shows "Not checked". The turn runs that check
      // itself instead of failing on the missing reading.
      const observed =
        options.runtimeRegistry.observedState(options.instanceId) ??
        (await runSetupEffect(
          Effect.scoped(
            makeProbe(
              options,
              environmentFactory,
              factories.clock,
            )({ instanceId: options.instanceId }),
          ),
          signal,
        ));
      if (observed.readiness === "unauthenticated") {
        throw failure(
          "unauthenticated",
          "Claude is not signed in. Open Settings, then Providers, sign in to this account and try again.",
        );
      }
      if (observed.readiness !== "ready") {
        throw failure(
          "unavailable",
          "Octant could not check this Claude account. Open Settings, then Providers, check the account and try again.",
        );
      }
      const selectedModel = observed.models.find((model) => model.id === input.modelId);
      if (selectedModel?.source !== "discovered" || selectedModel.verification !== "verified") {
        throw failure(
          "unsupported",
          "This Claude account does not offer the selected model. Pick another model and try again.",
        );
      }
      const effort = selectedEffort(selectedModel, input.modelOptionValues);
      if (sessions.has(input.sessionId)) {
        throw failure("protocol", "Claude session is already active.");
      }

      let apiKey: string | undefined;
      let scope: Scope.CloseableScope | undefined;
      let state: SessionState | undefined;
      try {
        if (options.authentication === "api-key") {
          if (!(await runSetupEffect(brokerHas(options), signal))) {
            throw failure("unauthenticated", "Claude API-key credential is missing.");
          }
          apiKey = await runSetupEffect(brokerResolve(options), signal);
        }
        if (
          options.configDirectory !== undefined &&
          CONFINED_CLAUDE_EXECUTION_POLICIES.has(input.executionPolicy) &&
          claudeAccountDirectoryBroadensPlan(
            projectRoot,
            options.configDirectory,
            options.isProjectConfinedPath,
          )
        ) {
          throw failure(
            "invalid-configuration",
            "Claude Plan confinement cannot use an account directory that overlaps the checkout.",
          );
        }
        scope = await runSetupEffect(Scope.make(), signal);
        const initialized = deferred<string>();
        // Startup no longer waits on this: the runtime initializes with the
        // first turn, and a rejected initialization fails that turn instead.
        void initialized.promise.catch(() => undefined);
        const terminalResult = deferred<void>();
        const environment = await runSetupEffect(
          environmentFactory(options.authentication, {
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(options.configDirectory === undefined
              ? {}
              : { configDirectory: options.configDirectory }),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
          signal,
        );
        const ownClaudeAccountPaths = claudeOwnAccountPaths(environment.environment);
        const sandboxedFullAccess =
          input.executionPolicy === "full-access" && input.fullAccessSandbox === true;
        const networkPolicy = sandboxedFullAccess ? "auto-accept-edits" : input.executionPolicy;
        // Claude's own process: its inference and in-process web fetch. It
        // runs at Auto under the same reviewer as its command sandbox.
        const ownNetwork = await runSetupEffect(
          acquireProviderRuntimeNetwork(options.runtimeNetwork, {
            runtime: "claude",
            root: projectRoot,
            executionPolicy: networkPolicy,
            environment: environment.environment,
            autoReview: input.autoApprove === true,
            // Only Plan runs the process in Octant's own capsule; outside it
            // the process reads the proxy variables on the host's loopback.
            ...(CONFINED_CLAUDE_EXECUTION_POLICIES.has(input.executionPolicy)
              ? {}
              : { listener: "loopback" as const }),
            sessionId: String(input.sessionId),
            ...(workThreadId === undefined ? {} : { threadId: workThreadId }),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
          signal,
        );
        const servers = await runSetupEffect(
          acquireProviderServerAccess(options.serverAccess, {
            root: projectRoot,
            executionPolicy: input.executionPolicy,
          }).pipe(Effect.provideService(Scope.Scope, scope)),
          signal,
        );
        const runtimeVersion = await runSetupEffect(
          options.process.probeVersion(options.binaryPath),
          signal,
        );
        if (options.authentication === "subscription") {
          // A confined launch reads its sign-in from inside the sandbox, so the
          // check runs there too. An unconfined check said "signed in" while
          // the confined runtime could not reach the Keychain, and the turn
          // then failed after it had started.
          const confined = CONFINED_CLAUDE_EXECUTION_POLICIES.has(input.executionPolicy);
          const status = await runSetupEffect(
            options.process.probeSubscription(
              options.binaryPath,
              environment.environment,
              confined
                ? {
                    projectRoot,
                    executionPolicy: input.executionPolicy,
                    ...(ownNetwork === undefined ? {} : { network: ownNetwork }),
                  }
                : undefined,
            ),
            signal,
          );
          if (status === "unauthenticated") {
            throw failure(
              "unauthenticated",
              confined
                ? "Claude could not read this account's sign-in inside the Plan sandbox. Sign in with the account's command in Settings › Providers, then try again."
                : "Claude authentication is required.",
            );
          }
        }
        // The person's own Claude setup, as the host resolved it for this
        // session; absent on every session before the person turned it on.
        const nativeSetup = input.nativeSetup;
        const policyExecutionOptions = claudeExecutionOptions(
          input.executionPolicy,
          input.autoApprove,
          mode,
        );
        const baseExecutionOptions: ClaudeExecutionOptions = {
          ...policyExecutionOptions,
          tools: [...policyExecutionOptions.tools, ...claudeNativeTools(nativeSetup)],
        };
        // Read at each launch: one launch per turn means the next turn after
        // the person turns the setting or the thread's choice off launches
        // with every guard again.
        const offersArtifacts = claudeOffersArtifacts({
          authentication: options.authentication,
          artifactDelivery: options.artifactDelivery?.() === true,
          threadChoseArtifacts: input.nativeArtifacts === true,
          hostTrafficDisabled: disablesNonessentialTraffic(environment.environment),
          mode,
          executionPolicy: input.executionPolicy,
        });
        const executionOptions: ClaudeExecutionOptions = offersArtifacts
          ? {
              ...baseExecutionOptions,
              tools: [...baseExecutionOptions.tools, CLAUDE_ARTIFACT_TOOL],
            }
          : baseExecutionOptions;
        // Outside Plan the session holds Claude Code's whole built-in set
        // less what Octant withholds, so the gate below sees every tool.
        const withheldTools = executionOptions.fullToolSet
          ? claudeWithheldTools(nativeSetup, offersArtifacts)
          : undefined;
        // The switch is read again at every call: a session opened while it
        // was on keeps the tool in its list after the person turns it off.
        const artifactCallRefusal = (toolInput: Readonly<Record<string, unknown>>) =>
          claudeArtifactCallRefusal({
            stillOn: options.artifactDelivery?.() === true,
            input: toolInput,
            projectRoot,
            isProjectConfinedPath: options.isProjectConfinedPath,
          });
        const sandboxNetwork = claudeRunsSandbox(input.executionPolicy, sandboxedFullAccess)
          ? await runSetupEffect(
              acquireProviderRuntimeNetwork(options.runtimeNetwork, {
                runtime: "claude-sandbox",
                root: projectRoot,
                executionPolicy: networkPolicy,
                autoReview: input.autoApprove === true,
                sessionId: String(input.sessionId),
                ...(workThreadId === undefined ? {} : { threadId: workThreadId }),
                // The sandbox points its commands at a bare port on the
                // host's loopback and sends no proxy credentials.
                authentication: "none",
                listener: "loopback",
              }).pipe(Effect.provideService(Scope.Scope, scope)),
              signal,
            )
          : undefined;
        if (sandboxNetwork !== undefined && sandboxNetwork.endpoint.kind !== "loopback") {
          throw failure("incompatible", "Claude's sandbox needs its egress proxy on loopback.");
        }
        const sandbox = claudeSandboxSettings(
          input.executionPolicy,
          projectRoot,
          extraFolders,
          sandboxNetwork?.endpoint.kind === "loopback" ? sandboxNetwork.endpoint.port : undefined,
          sandboxedFullAccess,
        );
        let callbackState: SessionState | undefined;
        const insideFolder = (root: string, candidate: string): boolean => {
          try {
            return candidate === root || options.isProjectConfinedPath(root, candidate) === true;
          } catch {
            return false;
          }
        };
        // The Project's folders, and each worktree outside them the session
        // was let into.
        const sessionHolds = (state: SessionState, candidate: string): boolean =>
          insideFolder(projectRoot, candidate) ||
          [...state.worktrees].some((worktree) => insideFolder(worktree, candidate));
        // A switch into a worktree outside the Project's folders, once
        // allowed, adds that worktree to what the session holds.
        const holdWorktree = (
          state: SessionState,
          toolName: string,
          toolInput: Readonly<Record<string, unknown>>,
          workingDirectory: string,
        ) => {
          if (toolName !== CLAUDE_ENTER_WORKTREE_TOOL) return;
          const target = claudeWorktreeTarget(toolInput, workingDirectory);
          if (target !== undefined && !sessionHolds(state, target)) state.worktrees.add(target);
        };
        const canUseTool: ClaudeOpenQueryInput["canUseTool"] = async (request) => {
          const activeState = callbackState;
          const deny = (message: string) =>
            denyClaudeToolRequest(activeState, request.toolUseId, message);
          if (
            activeState === undefined ||
            activeState.terminal ||
            activeState.context?.terminal === true ||
            activeState.releasing ||
            activeState.released
          ) {
            return deny("Claude tool request did not pass the Octant authority gate.");
          }
          if (!admitToolUse(activeState, request.toolUseId)) {
            return deny("Claude tool authority state was exhausted.");
          }
          expireClaudePreToolGrants(activeState, factories.authorityNow());
          const digest = claudeAuthorityInputDigest(request.input);
          const grant = activeState?.preToolRequests.get(request.toolUseId);
          if (
            digest === undefined ||
            grant?.toolName !== request.toolName ||
            grant.inputDigest !== digest ||
            activeState.settledToolUseIds.has(request.toolUseId)
          ) {
            return deny("Claude tool request did not pass the Octant authority gate.");
          }
          activeState.preToolRequests.delete(request.toolUseId);
          if (request.toolName === CLAUDE_ARTIFACT_TOOL) {
            const refusal = artifactCallRefusal(request.input);
            if (refusal !== undefined) return deny(refusal);
          }
          if (
            (input.executionPolicy === "full-access" && request.toolName !== "AskUserQuestion") ||
            // Auto-accept edits covers exactly the file writes the gate above
            // already proved to be inside the Project. Shell, network, and
            // every other tool still ask.
            (input.executionPolicy === "auto-accept-edits" &&
              CLAUDE_EDIT_TOOLS.has(request.toolName)) ||
            CLAUDE_READ_TOOLS.has(request.toolName) ||
            CLAUDE_SESSION_TOOLS.has(request.toolName) ||
            isPlanShellCommand(input.executionPolicy, request.toolName, executionOptions.tools)
          ) {
            holdWorktree(activeState, request.toolName, request.input, grant.workingDirectory);
            activeState.settledToolUseIds.add(request.toolUseId);
            return { behavior: "allow" };
          }
          if (request.toolName === "AskUserQuestion" && activeState.pendingQuestions.size > 0) {
            terminal(activeState, {
              kind: "failed",
              failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
            });
            return deny("Claude user question state was exhausted.");
          }
          if (request.toolName === "AskUserQuestion" && Object.hasOwn(request.input, "answers")) {
            return deny("Claude user question input was invalid.");
          }
          const providerPrompts =
            request.toolName === "AskUserQuestion"
              ? validatedClaudeQuestionPrompts(request.input)
              : undefined;
          if (request.toolName === "AskUserQuestion" && providerPrompts === undefined) {
            return deny("Claude user question input was invalid.");
          }
          const reusableApprovalKey = approvalReuseKey(request.toolName, digest);
          if (
            request.toolName !== "AskUserQuestion" &&
            activeState.approvalReuse.has(reusableApprovalKey)
          ) {
            holdWorktree(activeState, request.toolName, request.input, grant.workingDirectory);
            activeState.settledToolUseIds.add(request.toolUseId);
            return { behavior: "allow" };
          }
          if (
            request.toolName !== "AskUserQuestion" &&
            activeState.pendingApprovals.size >= MAX_PENDING_APPROVALS
          ) {
            terminal(activeState, {
              kind: "failed",
              failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
            });
            return deny("Claude tool authority state was exhausted.");
          }
          const mapped = mapClaudeToolRequest(activeState.context!, request);
          if (mapped.kind === "question") {
            if (providerPrompts === undefined) {
              return deny("Claude user question input was invalid.");
            }
            const pending: ClaudePendingQuestionState = {
              ...mapped.request,
              answer: deferred<Record<string, string> | undefined>(),
              events: mapped.request.events.map((event) =>
                event.kind === "user-input-request" && mapped.request.events.length > 1
                  ? { ...event, requestId: randomUUID() }
                  : event,
              ),
              received: new Map(),
              providerPrompts,
            };
            activeState.pendingQuestions.set(pending.requestId, pending);
            for (const event of pending.events) publish(event);
            activeState.outputAccepted = true;
            const answers = await waitForClaudeAuthorityValue({
              promise: pending.answer.promise,
              signal: request.signal,
              cancelledValue: undefined,
              cancel: () => {
                if (activeState.pendingQuestions.get(pending.requestId) === pending) {
                  activeState.pendingQuestions.delete(pending.requestId);
                }
                activeState.settledToolUseIds.add(pending.providerToolUseId);
              },
            });
            if (answers === undefined) {
              return { behavior: "deny", message: "Claude user question was cancelled." };
            }
            return {
              behavior: "allow",
              updatedInput: { ...request.input, answers },
            };
          }
          if (mapped.kind !== "approval") {
            for (const [requestId, pending] of activeState.pendingApprovals) {
              if (pending.providerToolUseId !== request.toolUseId) continue;
              activeState.pendingApprovals.delete(requestId);
              activeState.settledToolUseIds.add(pending.providerToolUseId);
              pending.decision.resolve({
                behavior: "deny",
                message: "Claude approval correlation changed.",
              });
            }
            return deny("Claude tool request was denied by Octant.");
          }
          const reuseKey = approvalReuseKey(mapped.request.toolName, mapped.request.inputDigest);
          if (activeState.pendingApprovals.has(mapped.request.requestId)) {
            const existing = activeState.pendingApprovals.get(mapped.request.requestId)!;
            activeState.pendingApprovals.delete(mapped.request.requestId);
            existing.decision.resolve({
              behavior: "deny",
              message: "Claude approval correlation was duplicated.",
            });
            return deny("Claude approval request was duplicated.");
          }
          const pending: ClaudePendingApprovalState = {
            ...mapped.request,
            decision: deferred<ClaudeToolDecision>(),
            reuseKey,
            call: providerApprovalCall({
              tool: mapped.request.toolName,
              arguments: request.input,
              workingDirectory: grant.workingDirectory,
              ownerShell: sandbox !== undefined && input.executionPolicy !== "plan",
            }),
          };
          activeState.pendingApprovals.set(pending.requestId, pending);
          publish(pending.event);
          activeState.outputAccepted = true;
          const decision = await waitForClaudeAuthorityValue({
            promise: pending.decision.promise,
            signal: request.signal,
            cancelledValue: {
              behavior: "deny",
              message: "Claude tool request was cancelled.",
            },
            cancel: () => {
              if (activeState.pendingApprovals.get(pending.requestId) === pending) {
                activeState.pendingApprovals.delete(pending.requestId);
              }
              activeState.settledToolUseIds.add(pending.providerToolUseId);
            },
          });
          // The snapshot is read the moment the person approves, just before
          // the runtime reads the same file to publish it, so the thread
          // shows what they approved sending. The answer can come long after
          // the gate read the setting and the path, so both are read again
          // first: a setting turned off, or a folder swapped for a link out of
          // the Project, while the person decided refuses the publish.
          if (
            decision.behavior === "allow" &&
            request.toolName === CLAUDE_ARTIFACT_TOOL &&
            typeof request.input.file_path === "string"
          ) {
            const refusal = artifactCallRefusal(request.input);
            if (refusal !== undefined) return { behavior: "deny", message: refusal };
            const snapshot = await readClaudePublishedSnapshot(request.input.file_path);
            if (snapshot !== undefined) {
              activeState.publishedSnapshots.set(request.toolUseId, snapshot);
            }
          }
          if (decision.behavior === "allow") {
            holdWorktree(activeState, request.toolName, request.input, grant.workingDirectory);
          }
          return decision;
        };
        const preToolUse: ClaudeOpenQueryInput["preToolUse"] = async (request) => {
          const activeState = callbackState;
          const deny = (message: string) =>
            denyClaudeToolRequest(activeState, request.toolUseId, message);
          if (
            activeState === undefined ||
            activeState.terminal ||
            activeState.context?.terminal === true ||
            activeState.releasing ||
            activeState.released ||
            request.sessionId !== activeState.claudeSessionId ||
            // The session's working directory: the Project root, or a
            // worktree Claude moved it into that the session holds.
            (request.projectRoot !== projectRoot && !sessionHolds(activeState, request.projectRoot))
          ) {
            return deny("Claude tool request is outside the Project.");
          }
          if (!admitToolUse(activeState, request.toolUseId)) {
            return deny("Claude tool authority state was exhausted.");
          }
          expireClaudePreToolGrants(activeState, factories.authorityNow());
          if (
            !claudeOffersTool(
              {
                tools: executionOptions.tools,
                ...(withheldTools === undefined ? {} : { withheldTools }),
                ...(nativeSetup === undefined ? {} : { nativeSetup }),
              },
              request.toolName,
            ) ||
            activeState.settledToolUseIds.has(request.toolUseId)
          ) {
            return deny("Claude tool request is outside the Project.");
          }
          const requestInput =
            typeof request.input === "object" &&
            request.input !== null &&
            !Array.isArray(request.input)
              ? (request.input as Readonly<Record<string, unknown>>)
              : undefined;
          if (requestInput === undefined) {
            return deny("Claude tool request has invalid input.");
          }
          // The plan already reached the thread as the reply's text from the
          // call's transcript block. Granting the call would let Claude Code
          // leave plan mode for one that edits, so it is always refused.
          if (request.toolName === CLAUDE_PLAN_EXIT_TOOL) {
            return deny(CLAUDE_PLAN_CAPTURED_MESSAGE);
          }
          // Checked here, before any posture: Full access answers "allow" in
          // this hook and Claude Code then never calls `canUseTool`.
          if (request.toolName === CLAUDE_ARTIFACT_TOOL) {
            const refusal = artifactCallRefusal(requestInput);
            if (refusal !== undefined) return deny(refusal);
          }
          if (request.toolName === "AskUserQuestion" && Object.hasOwn(requestInput, "answers")) {
            return deny("Claude user question input was invalid.");
          }
          if (
            request.toolName === "AskUserQuestion" &&
            validatedClaudeQuestionPrompts(requestInput) === undefined
          ) {
            return deny("Claude user question input was invalid.");
          }
          const digest = claudeAuthorityInputDigest(requestInput);
          if (digest === undefined) {
            return deny("Claude tool request has invalid input.");
          }
          // The secret guard answers before every posture below Full access,
          // and says which rule refused and which channel to use. The
          // runtime's own account state is its own to read.
          const secretRefusal = claudeSecretGuardApplies(input.executionPolicy)
            ? claudeFileToolSecretRefusal(
                request.toolName,
                requestInput,
                ownClaudeAccountPaths,
                request.projectRoot,
                claudeSearchesRunUnguarded(input.executionPolicy),
              )
            : undefined;
          if (secretRefusal !== undefined) return deny(secretRefusal);
          // Full access with its sandbox keeps the Project's folders, where
          // the sandbox holds every command, so a worktree outside them is
          // refused there rather than held.
          if (sandboxedFullAccess && request.toolName === CLAUDE_ENTER_WORKTREE_TOOL) {
            const target = claudeWorktreeTarget(requestInput, request.projectRoot);
            if (target === undefined || !sessionHolds(activeState, target)) {
              return deny("Claude tool request is outside the Project.");
            }
          }
          // Claude Code takes a hook "allow" as the final word and runs the
          // tool without calling `canUseTool`. Observed 2026-09-06: an
          // approval-gated thread answered "allow" here for a Project-confined
          // Edit, the file changed 1.2 s later, and no approval was ever
          // raised. So the hook may only allow what `canUseTool` would let
          // through unasked; every call that needs an approval or a question
          // is answered "ask", which routes it to `canUseTool` with the grant
          // recorded here. An allowed call holds no grant: nothing will come
          // to consume it, and sixteen unconsumed grants used to end the turn.
          const settledUnasked = (): ClaudePreToolDecision => {
            holdWorktree(activeState, request.toolName, requestInput, request.projectRoot);
            activeState.settledToolUseIds.add(request.toolUseId);
            return { behavior: "allow" };
          };
          const askThroughGrant = (): ClaudePreToolDecision => {
            if (
              !activeState.preToolRequests.has(request.toolUseId) &&
              activeState.preToolRequests.size >= MAX_PRE_TOOL_GRANTS
            ) {
              terminal(activeState, {
                kind: "failed",
                failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
              });
              return deny("Claude tool authority state was exhausted.");
            }
            activeState.preToolRequests.set(request.toolUseId, {
              workingDirectory: request.projectRoot,
              toolName: request.toolName,
              inputDigest: digest,
              expiresAt: factories.authorityNow() + PRE_TOOL_GRANT_TTL_MS,
            });
            return { behavior: "ask" };
          };
          // A publish asks under every posture below Full access, which asks
          // nobody; the path checks above still refuse a file outside the Project.
          const decide = (): ClaudePreToolDecision =>
            (input.executionPolicy === "full-access" && request.toolName !== "AskUserQuestion") ||
            (input.executionPolicy === "auto-accept-edits" &&
              CLAUDE_EDIT_TOOLS.has(request.toolName)) ||
            (request.toolName !== "AskUserQuestion" && CLAUDE_READ_TOOLS.has(request.toolName)) ||
            CLAUDE_SESSION_TOOLS.has(request.toolName) ||
            isPlanShellCommand(input.executionPolicy, request.toolName, executionOptions.tools)
              ? settledUnasked()
              : askThroughGrant();
          // The person's own Claude tools name no file to confine: a subagent
          // start and a skill read act inside the session, and a web read or
          // an MCP server call asks below Full access.
          const nativeAnswer = claudeNativeToolAnswer(request.toolName, nativeSetup);
          if (nativeAnswer !== undefined) {
            return nativeAnswer === "unasked" || input.executionPolicy === "full-access"
              ? settledUnasked()
              : askThroughGrant();
          }
          if (input.executionPolicy === "full-access") {
            // Nothing asks here, so nothing reads the snapshot at approval:
            // the host keeps what was sent from this hook instead.
            if (
              request.toolName === CLAUDE_ARTIFACT_TOOL &&
              typeof requestInput.file_path === "string"
            ) {
              const snapshot = await readClaudePublishedSnapshot(requestInput.file_path);
              if (snapshot !== undefined) {
                activeState.publishedSnapshots.set(request.toolUseId, snapshot);
              }
            }
            if (!sandboxedFullAccess) return decide();
          }
          // A shell call carries no cwd of its own: Claude Code runs it in the
          // session's working directory, which is the Project root, and the
          // sandbox confines it there. Requiring a cwd field denied every
          // shell call before it could be asked about (observed 2026-09-06:
          // "git status" refused four times, then the turn failed).
          const candidate = claudeConfinedTarget(
            request.toolName,
            requestInput,
            projectRoot,
            request.projectRoot,
          );
          if (typeof candidate !== "string") {
            return deny("Claude tool request has no authoritative confined path.");
          }
          // A confined subscription launch may read the login keychain file so
          // the runtime can sign in. That grant is not the model's: a Project
          // that contains the folder (a home directory opened as a Project)
          // would otherwise let a file tool name it.
          if (
            CLAUDE_READ_TOOLS.has(request.toolName) &&
            claudeToolPathIsInKeychainFolder(candidate)
          ) {
            return deny("Claude tool request is outside the Project.");
          }
          if (!sessionHolds(activeState, candidate)) {
            return deny("Claude tool request is outside the Project.");
          }
          return decide();
        };
        const artifactEnvironment = offersArtifacts
          ? claudeArtifactLaunchEnvironment(environment.environment)
          : environment.environment;
        // Read at each launch, like the artifact switch: the next turn after
        // the person turns the account's memory off launches guarded again.
        const keepsOwnMemory = providerOwnMemoryLaunches({
          accountAllows: options.ownMemory?.() === true,
          mode,
          executionPolicy: input.executionPolicy,
        });
        // The runtime initializes with the first turn, so a new session's id
        // is assigned here and the initialized message is later held to it.
        const assignedSessionId = resumeSessionId === undefined ? randomUUID() : undefined;
        // The task tools keep their list outside the session's transcript, so
        // a resumed session's panel starts from the list Claude stored.
        const taskList = new ClaudeTaskList();
        const storedTaskList = await readClaudeStoredTaskList(
          claudeConfigurationDirectory(environment.environment),
          resumeSessionId ?? assignedSessionId ?? "",
        );
        throwIfSetupCancelled(signal);
        if (storedTaskList.status === "read") {
          taskList.seed(storedTaskList.tasks);
        } else {
          console.warn(
            `[provider] Claude's stored task list was refused: ${storedTaskList.reason}`,
          );
        }
        const query = await runSetupEffect(
          options.sdk
            .openQuery({
              binaryPath: options.binaryPath,
              projectRoot,
              ...(extraFolders.length === 0 ? {} : { additionalDirectories: extraFolders }),
              authEnvironment: withServerAccess(
                claudeNativeLaunchEnvironment(
                  keepsOwnMemory
                    ? claudeOwnMemoryLaunchEnvironment(artifactEnvironment)
                    : artifactEnvironment,
                  nativeSetup,
                ),
                servers,
              ),
              ...(ownNetwork === undefined ? {} : { network: ownNetwork }),
              ...(keepsOwnMemory ? { ownMemory: true as const } : {}),
              model: input.modelId,
              ...(effort === undefined ? {} : { effort }),
              executionPolicy: input.executionPolicy,
              ...(sandboxedFullAccess ? { fullAccessSandbox: true } : {}),
              ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }),
              ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
              ...(assignedSessionId === undefined ? {} : { sessionId: assignedSessionId }),
              // Nothing resumes a single-use session, so the runtime's own
              // transcript of it would only be a copy of the request left in
              // the account's configuration directory.
              ...(input.singleUse === true ? { persistSession: false as const } : {}),
              tools: executionOptions.tools,
              ...(withheldTools === undefined ? {} : { withheldTools }),
              ...(nativeSetup === undefined ? {} : { nativeSetup }),
              ...claudeAutoCompactWindow(input.compactionPoint),
              ...(sandbox === undefined ? {} : { sandbox }),
              canUseTool,
              preToolUse,
            })
            .pipe(
              Effect.timeoutFail({
                duration: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
                onTimeout: () => failure("unavailable", "Claude session startup timed out."),
              }),
              Effect.provideService(Scope.Scope, scope),
            ),
          signal,
        );
        apiKey = undefined;
        throwIfSetupCancelled(signal);
        const account = query.initialization.account;
        if (
          account.ready !== true ||
          (account.apiProvider !== undefined && account.apiProvider !== "firstParty")
        ) {
          throw failure("protocol", "Claude initialized an unsupported account routing policy.");
        }
        state = {
          sessionId: input.sessionId,
          projectRoot,
          modelId: input.modelId,
          executionPolicy: input.executionPolicy,
          authentication: options.authentication,
          ...(resumeSessionId === undefined ? {} : { expectedClaudeSessionId: resumeSessionId }),
          expectedRuntimeVersion: runtimeVersion,
          correlationId: factories.makeCorrelation() as CorrelationId,
          scope,
          query,
          initialized,
          terminalResult,
          pendingApprovals: new Map(),
          pendingAppTools: new Map(),
          pendingQuestions: new Map(),
          preToolRequests: new Map(),
          approvalReuse: new Set(),
          publishedSnapshots: new Map(),
          worktrees: new Set(),
          observedToolUseIds: new Set(),
          settledToolUseIds: new Set(),
          taskList,
          outputAccepted: false,
          pendingTurns: 0,
          promptHookRuns: claudePromptHookRuns(nativeSetup, runtimeVersion),
          hookDeliveries: [],
          appToolsEnabled: false,
          terminal: false,
          active: true,
          releasing: false,
          released: false,
          backgroundTasks: new Set(),
          startedBackgroundWork: false,
          reportsSessionState: false,
        };
        callbackState = state;
        sessions.set(input.sessionId, state);
        options.runtimeRegistry.setActiveSessionCount(
          options.instanceId,
          options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
        );
        startCollector(state);
        const claudeSessionId = await runSetupEffect(
          query.sessionId.pipe(
            Effect.timeoutFail({
              duration: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
              onTimeout: () => failure("unavailable", "Claude session startup timed out."),
            }),
          ),
          signal,
        );
        throwIfSetupCancelled(signal);
        state.claudeSessionId ??= claudeSessionId;
        if (state.terminal && !state.outputAccepted) {
          throw failure("protocol", "Claude session failed during startup.");
        }
        // A single-use session is never resumed, and its random session id is
        // named by no thread's journal, so a recorded identity (with the
        // thread's scratch folder in it) would outlive every purge.
        if (input.singleUse === true) return state;
        const identity = {
          providerInstanceId: options.instanceId,
          octantSessionId: input.sessionId,
          sdkSessionId: claudeSessionId,
          projectRoot,
          modelId: input.modelId,
          authentication: options.authentication,
        } satisfies ClaudeResumeIdentity;
        await awaitSetupPromise(options.resumeIdentityPort.put(identity, signal), signal);
        throwIfSetupCancelled(signal);
        return state;
      } catch (error) {
        apiKey = undefined;
        if (state !== undefined) {
          sessions.delete(input.sessionId);
          await release(state);
        } else if (scope !== undefined) {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
        throw error;
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closing = true;
        const setups = [...inFlightSetups];
        for (const setup of setups) setup.controller.abort();
        await Promise.all(setups.map(({ done }) => done));
        await Promise.all([...sessions.values()].map(release));
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(events));
      }),
    );

    return {
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        withSessionReservation(input.sessionId, (signal) => open(input, signal)).pipe(
          Effect.map((state) =>
            input.singleUse === true
              ? { sessionId: state.sessionId }
              : {
                  sessionId: state.sessionId,
                  resumeCursor: {
                    driverKind: "claude" as const,
                    value: state.claudeSessionId!,
                    binding: providerResumeBinding({
                      instanceId: options.instanceId,
                      sessionId: state.sessionId,
                      projectRoot,
                      mode,
                      modelId: input.modelId,
                    }),
                  },
                },
          ),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== "claude") {
          return Effect.fail(
            failure("stale-resume", "Provider resume cursor does not belong to Claude."),
          );
        }
        // The recorded identity names the instance, session, folder, and
        // sign-in but not the mode; the cursor's binding does, so a Work
        // session is never reopened under Code's posture or the other way.
        // The SDK resumes onto another model, so the model is not checked.
        if (
          resumeBindingRefuses(input.resumeCursor, {
            instanceId: options.instanceId,
            sessionId: input.sessionId,
            projectRoot,
            mode,
          })
        ) {
          return Effect.fail(
            failure("stale-resume", "The saved Claude session belongs to another task or Project."),
          );
        }
        return withSessionReservation(input.sessionId, async (signal) => {
          let identity: ClaudeResumeIdentity | undefined;
          try {
            identity = await awaitSetupPromise(
              options.resumeIdentityPort.lookup(
                {
                  providerInstanceId: options.instanceId,
                  sdkSessionId: input.resumeCursor.value,
                },
                signal,
              ),
              signal,
            );
          } catch {
            if (signal.aborted) throw connectionClosingFailure();
            throw failure(
              "stale-resume",
              "Claude session identity is unavailable for exact resume.",
            );
          }
          if (
            identity === undefined ||
            identity.providerInstanceId !== options.instanceId ||
            identity.octantSessionId !== input.sessionId ||
            identity.sdkSessionId !== input.resumeCursor.value ||
            identity.projectRoot !== projectRoot ||
            identity.authentication !== options.authentication
          ) {
            throw failure(
              "stale-resume",
              "Claude session identity is unavailable for exact resume.",
            );
          }

          let metadata;
          try {
            metadata = await runSetupEffect(
              options.sdk.findSession({
                sessionId: input.resumeCursor.value,
                projectRoot,
                ...(options.configDirectory === undefined
                  ? {}
                  : { configDirectory: options.configDirectory }),
              }),
              signal,
            );
          } catch {
            if (signal.aborted) throw connectionClosingFailure();
            throw failure("stale-resume", "Claude session history is unavailable for resume.");
          }
          if (
            metadata === undefined ||
            metadata.sessionId !== input.resumeCursor.value ||
            metadata.projectRoot !== projectRoot
          ) {
            try {
              await awaitSetupPromise(
                options.resumeIdentityPort.remove(
                  {
                    providerInstanceId: options.instanceId,
                    sdkSessionId: input.resumeCursor.value,
                  },
                  signal,
                ),
                signal,
              );
            } catch {
              if (signal.aborted) throw connectionClosingFailure();
              // Missing history remains the authoritative resume failure.
            }
            throw failure("stale-resume", "Claude session history is unavailable for resume.");
          }
          return open(
            {
              sessionId: input.sessionId,
              // The SDK resumes a session under whichever model it is given,
              // and opening re-records the identity with that model, so a
              // thread switched to another model carries its conversation on.
              modelId: input.modelId ?? identity.modelId,
              executionPolicy: input.executionPolicy,
              ...(input.fullAccessSandbox === undefined
                ? {}
                : { fullAccessSandbox: input.fullAccessSandbox }),
              ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }),
              ...(input.modelOptionValues === undefined
                ? {}
                : { modelOptionValues: input.modelOptionValues }),
              ...(input.nativeArtifacts === true ? { nativeArtifacts: true } : {}),
              ...(input.nativeSetup === undefined ? {} : { nativeSetup: input.nativeSetup }),
              ...(input.compactionPoint === undefined
                ? {}
                : { compactionPoint: input.compactionPoint }),
            },
            signal,
            input.resumeCursor.value,
          );
        }).pipe(
          Effect.map((state) => ({
            sessionId: state.sessionId,
            resumeCursor: input.resumeCursor,
          })),
        );
      },
      send: (input) => {
        const state = sessions.get(input.sessionId);
        if (state === undefined || state.terminal || state.released) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        // The runtime answers `/compact` with a result of its own, which a
        // turn sent meanwhile would take as its reply.
        if (state.compaction !== undefined) {
          return Effect.fail(failure("unavailable", "Claude is compacting this session."));
        }
        const observed = options.runtimeRegistry.observedState(options.instanceId);
        const model = observed?.models.find((candidate) => candidate.id === state.modelId);
        const rejected = validateChatTurnInput(
          input,
          observed?.capabilities ?? unavailableCapabilities,
          model,
        );
        if (rejected !== undefined) return Effect.fail(rejected);
        // The runtime may still start turns of its own inside the held one.
        if (state.heldTurn !== undefined) {
          return Effect.fail(
            failure("unavailable", "Claude is still finishing background work from the last turn."),
          );
        }
        if ((input.tools.length > 0 || state.appToolsEnabled) && state.pendingTurns > 0) {
          return Effect.fail(
            failure("unavailable", "The previous tool-enabled turn is still active."),
          );
        }
        const message = claudeTurnMessage(
          input,
          state.expectedRuntimeVersion,
          state.promptHookRuns,
        );
        const delivery = { viaHook: message.context !== undefined, delivered: false };
        return Effect.sync(() => {
          if (state.context?.terminal === true && state.pendingTurns === 0) {
            state.context = makeEventContext(state, state.claudeSessionId!, state.context.sequence);
          }
          if (state.pendingTurns === 0) {
            state.terminalResult = deferred<void>();
            state.outputAccepted = false;
          }
          state.appToolsEnabled = input.tools.length > 0;
          state.pendingTurns += 1;
          state.hookDeliveries.push(delivery);
        }).pipe(
          Effect.zipRight(
            state.query.send({
              ...message,
              ...(delivery.viaHook
                ? {
                    onContextDelivered: () => {
                      delivery.delivered = true;
                    },
                  }
                : {}),
              ...(input.tools.length === 0
                ? {}
                : {
                    appManagedTools: input.tools,
                    onAppToolCall: async (
                      name: string,
                      inputJson: string,
                      signal: AbortSignal,
                      toolUseId?: string,
                    ): Promise<ManagedToolAnswer> => {
                      const denied = { resultJson: '{"error":"tool-unavailable"}', isError: true };
                      if (
                        signal.aborted ||
                        state.terminal ||
                        state.releasing ||
                        state.released ||
                        state.context === undefined ||
                        state.context.terminal ||
                        !input.tools.some((tool) => tool.name === name) ||
                        inputJson.length > 262_144 ||
                        state.pendingAppTools.size >= MAX_PENDING_APPROVALS
                      )
                        return denied;
                      // Asked under the step id of the row the tool use
                      // opened, so the call's record opens from that row.
                      const requestId =
                        (toolUseId === undefined
                          ? undefined
                          : claudeToolUseStepId(
                              state.context,
                              toolUseId,
                              `mcp__octant__${name}`,
                            )) ?? factories.makeRequestId();
                      if (state.pendingAppTools.has(requestId)) return denied;
                      const pending = deferred<ManagedToolAnswer>();
                      state.pendingAppTools.set(requestId, { answer: pending, signal });
                      publish({
                        kind: "tool-request",
                        requestId,
                        toolName: name,
                        inputJson,
                        instanceId: options.instanceId,
                        sessionId: state.sessionId,
                        correlationId: state.correlationId,
                        sequence: state.context.sequence++,
                        occurredAt: factories.clock() as UtcTimestamp,
                      });
                      return waitForClaudeAuthorityValue({
                        promise: pending.promise,
                        signal,
                        cancelledValue: {
                          resultJson: '{"error":"tool-interrupted"}',
                          isError: true,
                        },
                        cancel: () => {
                          state.pendingAppTools.delete(requestId);
                        },
                      });
                    },
                  }),
            }),
          ),
          Effect.tap(() => Effect.sync(() => (state.outputAccepted = true))),
          Effect.catchAll((providerFailure) => {
            if (state.outputAccepted) {
              terminal(state, {
                kind: "failed",
                failure: failure("provider-failed", "Claude input failed after work was accepted."),
              });
            } else {
              state.pendingTurns = Math.max(0, state.pendingTurns - 1);
              const index = state.hookDeliveries.indexOf(delivery);
              if (index !== -1) state.hookDeliveries.splice(index, 1);
            }
            return Effect.fail(sanitizeFailure(providerFailure));
          }),
        );
      },
      compact: ({ sessionId }) => {
        const state = sessions.get(sessionId);
        if (state === undefined || state.terminal || state.released) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        if (state.pendingTurns > 0 || state.compaction !== undefined) {
          return Effect.succeed<ProviderSessionCompaction>({
            kind: "refused",
            reason: "turn-running",
          });
        }
        if (!state.query.initialization.compactAnnounced) {
          return Effect.succeed<ProviderSessionCompaction>({
            kind: "refused",
            reason: "runtime-version-unsupported",
          });
        }
        return Effect.async<ProviderSessionCompaction>((resume) => {
          const pending: ClaudePendingCompaction = {
            succeeded: false,
            settle: (outcome) => resume(Effect.succeed(outcome)),
          };
          state.compaction = pending;
          // A finished turn closed its event context; the compaction's own
          // events are numbered on from it, as the next turn's would be.
          if (state.context?.terminal === true && state.claudeSessionId !== undefined) {
            state.context = makeEventContext(state, state.claudeSessionId, state.context.sequence);
          } else if (state.context !== undefined) {
            state.context.compactionRequested = true;
          }
          Effect.runFork(
            state.query.requestCompaction().pipe(
              // The command never reached the runtime's input, so nothing ran.
              Effect.catchAll(() =>
                Effect.sync(() => {
                  if (state.compaction !== pending) return;
                  state.compaction = undefined;
                  pending.settle({
                    kind: "failed",
                    message: "Claude did not accept the compaction request.",
                    sessionMayHaveChanged: false,
                  });
                }),
              ),
            ),
          );
          return Effect.sync(() => {
            if (state.compaction === pending) state.compaction = undefined;
          });
        });
      },
      interrupt: (sessionId) => {
        const state = sessions.get(sessionId);
        if (state === undefined || state.terminal || state.released || state.pendingTurns === 0) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        // An idle runtime has no turn to abort. Stopping the held turn ends
        // the session, and with it every background task it still runs.
        if (state.heldTurn !== undefined && !state.heldTurn.runtimeTurnOpen) {
          return Effect.tryPromise({
            try: async () => {
              terminal(state, {
                kind: "interrupted",
                message: "Claude's background work was stopped.",
              });
              await release(state);
            },
            catch: () => failure("interrupted", "Claude interruption cleanup did not complete."),
          });
        }
        return state.query.interrupt().pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () =>
                promiseWithTimeout(
                  state.terminalResult.promise,
                  options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS,
                  failure("interrupted", "Claude interruption did not return a terminal outcome."),
                ),
              catch: () => failure("interrupted", "Claude interruption did not complete."),
            }),
          ),
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => release(state),
              catch: () => failure("interrupted", "Claude interruption cleanup did not complete."),
            }),
          ),
          Effect.catchAll((providerFailure) => {
            terminal(state, {
              kind: "interrupted",
              message: "Claude execution was interrupted.",
            });
            return Effect.fail(sanitizeFailure(providerFailure, "interrupted"));
          }),
        );
      },
      forceStop: (sessionId) => {
        const state = sessions.get(sessionId);
        if (state === undefined || state.terminal || state.released) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        // The kill comes first: the graceful release that follows waits on the
        // very runtime that stopped answering.
        return state.query.forceKill().pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              terminal(state, {
                kind: "interrupted",
                message: "Claude execution was stopped by force.",
              }),
            ),
          ),
          Effect.mapError((providerFailure) => sanitizeFailure(providerFailure, "interrupted")),
        );
      },
      stop: (sessionId) =>
        Effect.promise(async () => {
          const state = sessions.get(sessionId);
          if (state === undefined) return;
          sessions.delete(sessionId);
          if (!state.terminal) {
            state.terminal = true;
            if (state.context !== undefined) state.context.terminal = true;
            state.terminalResult.resolve(undefined);
          }
          await release(state);
        }),
      approvalCall: ({ sessionId, requestId }) =>
        sessions.get(sessionId)?.pendingApprovals.get(requestId)?.call,
      answerApproval: (answer) =>
        Effect.suspend(() => {
          const state = sessions.get(answer.sessionId);
          const pending = state?.pendingApprovals.get(answer.requestId);
          if (
            state === undefined ||
            state.terminal ||
            state.releasing ||
            state.released ||
            pending === undefined
          ) {
            return Effect.fail(failure("protocol", "Claude approval request is not active."));
          }
          return Effect.sync(() => {
            state.pendingApprovals.delete(answer.requestId);
            state.settledToolUseIds.add(pending.providerToolUseId);
            if (answer.approved) {
              let persistence: PermissionPersistence = "project-default";
              try {
                persistence = options.permissionPersistence?.() ?? "current-session";
              } catch {
                // An unreadable setting cannot broaden a one-shot answer into reuse.
              }
              // A publish is never reused: the same input republishes the
              // file as it is now, which the person has not seen.
              if (
                answer.scope !== "once" &&
                persistence === "current-session" &&
                pending.toolName !== CLAUDE_ARTIFACT_TOOL
              ) {
                state.approvalReuse.add(pending.reuseKey);
              }
              pending.decision.resolve({ behavior: "allow" });
            } else {
              pending.decision.resolve({
                behavior: "deny",
                message: "Claude tool request was denied by the user.",
              });
            }
          });
        }),
      answerUserInput: (answer) =>
        Effect.suspend(() => {
          const state = sessions.get(answer.sessionId);
          const pending = [...(state?.pendingQuestions.values() ?? [])].find((candidate) =>
            candidate.events.some(
              (event) =>
                event.kind === "user-input-request" && event.requestId === answer.requestId,
            ),
          );
          const index =
            pending?.events.findIndex(
              (event) =>
                event.kind === "user-input-request" && event.requestId === answer.requestId,
            ) ?? -1;
          if (
            state === undefined ||
            state.terminal ||
            state.releasing ||
            state.released ||
            pending === undefined ||
            index < 0 ||
            pending.received.has(index)
          ) {
            return Effect.fail(failure("protocol", "Claude user question is not active."));
          }
          if (answer.answer.length > USER_ANSWER_MAX_CHARACTERS * 2) {
            return Effect.fail(failure("invalid-configuration", "Claude user answer is invalid."));
          }
          const normalizedAnswer = answer.answer.trim();
          if (
            normalizedAnswer.length === 0 ||
            exceedsCodePointLimit(normalizedAnswer, USER_ANSWER_MAX_CHARACTERS)
          ) {
            return Effect.fail(failure("invalid-configuration", "Claude user answer is invalid."));
          }
          return Effect.sync(() => {
            pending.received.set(index, normalizedAnswer);
            if (pending.received.size < pending.events.length) return;
            state.pendingQuestions.delete(pending.requestId);
            state.settledToolUseIds.add(pending.providerToolUseId);
            const answers = Object.fromEntries(
              pending.providerPrompts.map((prompt, position) => [
                prompt,
                pending.received.get(position) ?? "",
              ]),
            );
            pending.answer.resolve(answers);
          });
        }),
      toolRequestSignal: (input) =>
        sessions.get(input.sessionId)?.pendingAppTools.get(input.requestId)?.signal ??
        AbortSignal.abort(),
      answerTool: (input) =>
        Effect.suspend(() => {
          const state = sessions.get(input.sessionId);
          const pending = state?.pendingAppTools.get(input.requestId);
          if (
            state === undefined ||
            pending === undefined ||
            state.terminal ||
            state.releasing ||
            state.released
          ) {
            return Effect.fail(failure("protocol", "App tool answer is no longer active."));
          }
          state.pendingAppTools.delete(input.requestId);
          pending.answer.resolve({
            resultJson: input.resultJson,
            isError: input.isError,
            ...(input.images === undefined ? {} : { images: input.images }),
          });
          return Effect.void;
        }),
    };
  });
}

function promiseWithTimeout<A>(
  promise: Promise<A>,
  milliseconds: number,
  timeoutFailure: ProviderFailure,
): Promise<A> {
  return new Promise<A>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(timeoutFailure), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    );
  });
}

/** Puts each approved publish's snapshot beside the page its result names. */
function withPublishedSnapshots(
  state: SessionState,
  message: ClaudeDecodedMessage,
): ClaudeDecodedMessage {
  if (message.kind !== "tool-results" || state.publishedSnapshots.size === 0) return message;
  return {
    ...message,
    results: message.results.map((result) => {
      const snapshot = state.publishedSnapshots.get(result.toolUseId);
      if (snapshot === undefined) return result;
      state.publishedSnapshots.delete(result.toolUseId);
      return result.publishedPage === undefined
        ? result
        : { ...result, publishedPage: { ...result.publishedPage, snapshot } };
    }),
  };
}

/**
 * Claude Code compacts once a session holds its auto-compact window less a
 * fixed 33,000-token reserve, the window being the smaller of the model's and
 * the `autoCompactWindow` setting, which it clamps to 100,000 to 1,000,000
 * (the 2.1.287 runtime that the agent SDK 0.3.211 bundles; measured live on
 * 2026-11-08: a 1,000,000 window reports its threshold at 967,000). So the
 * person's point is the setting at point plus the reserve, passed as a flag
 * setting on this query alone, never written to their settings files. A point
 * at or past the runtime's own, or below what the clamp allows, leaves the
 * runtime its own point.
 */
export function claudeAutoCompactWindow(point: ProviderCompactionPoint | undefined): {
  readonly autoCompactWindow?: number;
} {
  if (point === undefined) return {};
  const window = point.tokens + CLAUDE_AUTO_COMPACT_RESERVE_TOKENS;
  if (window >= point.contextWindow || window < 100_000 || window > 1_000_000) return {};
  return { autoCompactWindow: window };
}

const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
