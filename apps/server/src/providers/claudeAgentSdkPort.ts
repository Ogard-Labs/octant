import {
  forkSession as forkClaudeSession,
  listSessions as listClaudeSessions,
  query as queryClaude,
  type Options as ClaudeSdkOptions,
  type McpSdkServerConfigWithInstance,
  type McpSetServersResult,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderContextBreakdown,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderNativeSetup,
  ProviderSlashCommand,
  ProviderToolDefinition,
  ThreadPublishedSnapshot,
} from "@octant/contracts";
import { withClaudeAccountDirectory } from "./claudeAccountDirectory";
import { createManagedMcpTools, type ManagedToolAnswer } from "./managedMcpTools";
import { Effect, Stream, type Scope } from "effect";
import { isAbsolute } from "node:path";

import {
  claudeOffersTool,
  decodeAccount,
  decodeAutoCompactThreshold,
  decodeContextUsageWindow,
  decodeContextBreakdown,
  decodeInitialization,
  type ClaudeDecodePhase,
  decodeInterruptReceipt,
  decodeMessage,
  decodeModels,
  decodeSessions,
  failure,
  permissionMode,
  protocol,
  object,
  runtimeErrorReason,
  sanitizeFailure,
} from "./claudeAgentSdkDecoder";
import { BoundedAsyncInput, makeClaudeCloseCoordinator } from "./claudeAgentSdkLifecycle";
import type { ClaudeProcessPort, SpawnClaudeCodeProcess } from "./claudeProcess";
import type { ClaudeTaskToolOutput } from "./claudeTaskList";
import type { ProviderRuntimeProxiedNetwork } from "../network/providerRuntimeNetwork";

export type ClaudePermissionMode = "default" | "bypassPermissions" | "plan" | "auto";

export type ClaudeToolDecision =
  | { readonly behavior: "allow"; readonly updatedInput?: Readonly<Record<string, unknown>> }
  | { readonly behavior: "deny"; readonly message: string; readonly interrupt?: boolean };

/**
 * What the PreToolUse hook may answer. Claude Code treats a hook "allow" as
 * final and runs the tool without consulting `canUseTool`, so the hook can
 * only say "allow" for a call Octant would let through unasked; "ask" hands
 * the call to `canUseTool`, where approvals and questions are raised.
 * "own-rules" answers nothing, so Claude Code's own permission rules (the
 * person's `permissions.allow`, `ask`, and `deny`) run first and only a call
 * they leave to ask reaches `canUseTool`: a forced "ask" skips the person's
 * allow rules in the bundled runtime.
 */
export type ClaudePreToolDecision =
  | ClaudeToolDecision
  | { readonly behavior: "ask" }
  | { readonly behavior: "own-rules" };

export interface ClaudeToolRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolUseId: string;
  readonly requestId?: string;
  readonly blockedPath?: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly signal: AbortSignal;
}

export interface ClaudePreToolRequest {
  readonly sessionId: string;
  /**
   * The session's working directory when the call was made: the Project
   * root, or any folder a `cd` moved the session into.
   */
  readonly projectRoot: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly toolUseId: string;
  readonly signal: AbortSignal;
}

export interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly autoAllowBashIfSandboxed: false;
  /**
   * True below Full access, so a `Bash` call may leave the sandbox with
   * `dangerouslyDisableSandbox` once the gate asked about it; false for a Full
   * access thread that kept its sandbox.
   */
  readonly allowUnsandboxedCommands: boolean;
  readonly filesystem: {
    readonly denyRead: readonly ["/"];
    /** The Project root, then its extra folders. */
    readonly allowRead: readonly [string, ...string[]];
    readonly allowWrite: readonly [string, ...string[]];
  };
  /**
   * With Network limits on, the sandbox's commands reach the network only
   * through this loopback port: Octant's egress proxy for the session. The
   * Agent SDK's `sandbox.network.httpProxyPort` points the sandbox at an
   * outside proxy instead of its own, so the proxy decides every host. With
   * them off, `allowedDomains: ["*"]` keeps Claude's own proxy from
   * restricting hosts or asking about each one: open network is the default.
   */
  readonly network?: ClaudeSandboxNetwork;
}

export type ClaudeSandboxNetwork =
  | { readonly httpProxyPort: number }
  | { readonly allowedDomains: readonly ["*"] };

/** The SDK's own copy of a sandbox network setting, so a caller's value is never shared. */
function sdkSandboxNetwork(
  network: ClaudeSandboxNetwork,
): { httpProxyPort: number } | { allowedDomains: string[] } {
  return "httpProxyPort" in network
    ? { httpProxyPort: network.httpProxyPort }
    : { allowedDomains: [...network.allowedDomains] };
}

/**
 * Claude Code's own system prompt, with Octant's additions only appended.
 * Every launch sends it: agent-sdk 0.3.211 reads a missing `systemPrompt` as
 * the custom prompt `""`, and the runtime then replaces its default prompt
 * (output styles, commit and pull-request guidance, environment details)
 * with that empty one, so Claude ran without its own prompt.
 */
export interface ClaudeSystemPrompt {
  readonly type: "preset";
  readonly preset: "claude_code";
  readonly append?: string;
}

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export function isClaudeEffortLevel(value: string): value is ClaudeEffortLevel {
  return (CLAUDE_EFFORT_LEVELS as ReadonlyArray<string>).includes(value);
}

export interface ClaudeOpenQueryInput {
  readonly binaryPath: string;
  readonly projectRoot: string;
  /** The Project's extra folders, granted what `projectRoot` is granted. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly authEnvironment: Readonly<Record<string, string | undefined>>;
  /**
   * The runtime's own network, where the host routes Claude's process
   * through its egress proxy: the launch's listener and proxy variables.
   */
  readonly network?: ProviderRuntimeProxiedNetwork;
  readonly model: string;
  /** Agent SDK `effort` for the session; absent means the SDK default. */
  readonly effort?: ClaudeEffortLevel;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean;
  /**
   * Whether the harness may answer approval prompts via its native `auto`
   * permission mode. The driver only sends `auto` when this is true and the
   * posture produces prompts; `canUseTool` and `PreToolUse` stay registered
   * regardless, so Octant's authority check runs if the SDK calls it.
   */
  readonly autoApprove?: boolean;
  readonly resumeSessionId?: string;
  /**
   * The id a new session is opened under. The runtime initializes lazily, so
   * the id is assigned up front and the initialized message must carry it;
   * ignored when `resumeSessionId` names an existing session.
   */
  readonly sessionId?: string;
  /**
   * `false` keeps the runtime from saving the session's transcript in its
   * configuration directory. Such a session cannot be resumed, so only a
   * session the host never resumes asks for it.
   */
  readonly persistSession?: false;
  readonly tools: readonly string[];
  /**
   * Present: the session holds Claude Code's whole built-in tool set except
   * these, and `tools` names the ones Octant's gate has its own rule for.
   * Absent: the session holds exactly `tools`.
   */
  readonly withheldTools?: readonly string[];
  /**
   * What this session loads of the person's own Claude setup, already held to
   * what the driver supports for the session's mode and posture. Absent opens
   * the query with no setting sources, skills, agents, plugins, or MCP
   * servers but Octant's own.
   */
  readonly nativeSetup?: ProviderNativeSetup;
  /**
   * Instruction files Octant read for this session because its setting
   * sources do not load them (`claudeSessionInstructions`), appended to
   * Claude Code's own system prompt and never in place of it.
   */
  readonly instructions?: string;
  /** The account keeps Claude's own memory for this launch (`providerOwnMemoryLaunches`). */
  readonly ownMemory?: true;
  /**
   * The thread's attachments folder: a Plan launch's confinement binds it
   * read-only, as the command sandbox reads it below Full access.
   */
  readonly attachmentsFolder?: string;
  /**
   * The account's own MCP servers this Plan session starts, the person's
   * marks (`planReadOnlyToolServers`); absent or empty starts none.
   */
  readonly planMcpServers?: ReadonlyArray<string>;
  /**
   * The auto-compact window for this query alone, from the person's
   * compaction point; absent leaves the runtime its own.
   */
  readonly autoCompactWindow?: number;
  /** Decoder attestation for the one in-process server owned by this adapter. */
  readonly managedToolServer?: boolean;
  readonly sandbox?: ClaudeSandboxSettings;
  readonly canUseTool: (request: ClaudeToolRequest) => Promise<ClaudeToolDecision>;
  readonly preToolUse: (request: ClaudePreToolRequest) => Promise<ClaudePreToolDecision>;
}

export interface ClaudeModelInfo {
  readonly id: string;
  readonly resolvedId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort: boolean;
  readonly supportedEffortLevels: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
}

export interface ClaudeAccountState {
  readonly ready: true;
  readonly apiProvider?:
    | "firstParty"
    | "bedrock"
    | "vertex"
    | "foundry"
    | "anthropicAws"
    | "mantle"
    | "gateway";
}

export interface ClaudeInitialization {
  readonly models: readonly ClaudeModelInfo[];
  readonly account: ClaudeAccountState;
  /**
   * The runtime announced its `compact` command, so `/compact` reaches the
   * runtime as a request rather than as text for the model.
   */
  readonly compactAnnounced: boolean;
  /**
   * The runtime's own slash commands and skills as it announced them, which
   * a composer lists as the provider's. Absent when it announced none.
   */
  readonly commands?: ReadonlyArray<ProviderSlashCommand>;
  /**
   * Where the runtime compacts the session by itself, in tokens, when it said
   * compaction is on. Absent when it said nothing usable.
   */
  readonly autoCompactThreshold?: number;
  /** The session's window in tokens, as the runtime reported it. */
  readonly contextWindow?: number;
}

export interface ClaudeSessionMetadata {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly lastModified: number;
  readonly createdAt?: number;
  /** The name the person gave the session, or else the runtime's summary of it. */
  readonly title?: string;
  readonly gitBranch?: string;
}

export type ClaudeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ClaudeJsonValue[]
  | { readonly [key: string]: ClaudeJsonValue };

export interface ClaudeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface ClaudeTaskUsage {
  readonly totalTokens: number;
  readonly toolUses: number;
  readonly durationMs: number;
}

/**
 * One agent a workflow started, as the runtime's `workflow_progress` reports
 * it (Claude Code 2.1.211): its place in the script, its label, and how far
 * it got. The agent's own messages stay inside the runtime; each tool call it
 * makes reaches Octant's gate on its own.
 */
export interface ClaudeWorkflowAgent {
  readonly index: number;
  readonly label: string;
  readonly state: "start" | "progress" | "done" | "error";
  readonly lastToolName?: string;
}

export type ClaudeResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export type ClaudeAssistantContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "redacted-reasoning" }
  | {
      readonly kind: "tool-use";
      readonly toolUseId: string;
      readonly toolName: string;
      /** A reported attempt at a file tool disabled in Plan; only an error result is valid. */
      readonly disabled?: true;
      readonly input: { readonly [key: string]: ClaudeJsonValue };
    };

export type ClaudeStreamEvent =
  | {
      readonly kind: "message-start";
      readonly messageId: string;
      readonly model: string;
      readonly usage: ClaudeUsage;
    }
  | {
      readonly kind: "message-delta";
      readonly stopReason: string | null;
      readonly usage: ClaudeUsage;
    }
  | { readonly kind: "message-stop" }
  /** The streaming API's keep-alive; it carries nothing and only shows the stream is alive. */
  | { readonly kind: "ping" }
  | {
      readonly kind: "content-start";
      readonly index: number;
      readonly content: ClaudeAssistantContent;
    }
  | { readonly kind: "text-delta"; readonly index: number; readonly text: string }
  | {
      readonly kind: "reasoning-delta";
      readonly index: number;
      readonly text: string;
      readonly estimatedTokens?: number;
    }
  | { readonly kind: "tool-input-delta"; readonly index: number }
  | { readonly kind: "reasoning-signature"; readonly index: number }
  | { readonly kind: "citation-delta"; readonly index: number }
  | { readonly kind: "compaction-delta"; readonly index: number }
  | { readonly kind: "content-stop"; readonly index: number };

export type ClaudeDecodedMessage =
  | {
      readonly kind: "initialized";
      readonly sessionId: string;
      readonly projectRoot: string;
      /** The model the runtime reports, which may be what an alias resolved to. */
      readonly model: string;
      /** The model id Octant asked for; the port already matched the two. */
      readonly requestedModel: string;
      readonly permissionMode: ClaudePermissionMode;
      readonly tools: readonly string[];
      readonly capabilities: readonly string[];
      readonly runtimeVersion: string;
    }
  | {
      readonly kind: "assistant";
      readonly sessionId: string;
      readonly messageId: string;
      /**
       * The SDK's id for this message in the session transcript, which
       * `forkSession` and `resumeSessionAt` cut at. Absent when not reported.
       */
      readonly uuid?: string;
      readonly error?: string;
      readonly content: readonly ClaudeAssistantContent[];
      readonly usage: ClaudeUsage;
    }
  | {
      readonly kind: "stream-event";
      readonly sessionId: string;
      readonly event: ClaudeStreamEvent;
    }
  | {
      /** The runtime's whole command list after a mid-session change. */
      readonly kind: "commands-changed";
      readonly sessionId: string;
      readonly commands: ReadonlyArray<ProviderSlashCommand>;
    }
  | {
      readonly kind: "tool-results";
      readonly sessionId: string;
      readonly results: readonly {
        readonly toolUseId: string;
        readonly isError: boolean;
        /**
         * The result's text as the model was handed it, cut to what one
         * tool-call content event carries. Only a thread's tool-call record
         * reads it.
         */
        readonly text?: string;
        readonly textTruncated?: true;
        /**
         * The claude.ai page the tool's structured result names, read only
         * from a message that settles one call. The mapper keeps it only for
         * an Artifact call.
         */
        readonly publishedPage?: {
          readonly url: string;
          readonly title?: string;
          /** Attached by the driver from the file the person approved publishing. */
          readonly snapshot?: ThreadPublishedSnapshot;
        };
        /**
         * A task tool's structured result, read only from a message that
         * settles one call. The mapper keeps it only for a task tool call.
         */
        readonly taskOutput?: ClaudeTaskToolOutput;
      }[];
    }
  | {
      readonly kind: "result";
      readonly sessionId: string;
      readonly outcome: "success" | "error";
      readonly subtype: ClaudeResultSubtype;
      readonly stopReason: string | null;
      readonly terminalReason?: string;
      readonly durationMs?: number;
      readonly usage: ClaudeUsage;
      /** Cumulative runtime session cost, including restored turns. */
      readonly totalCostUsd?: number;
      /** Increment measured from the pre-prompt session snapshot, when available. */
      readonly costUsd?: number;
      /**
       * What the runtime says fills the window as the turn ends, when it
       * answered. The stream attaches it; the decoder never reads it from the
       * result message itself.
       */
      readonly contextBreakdown?: ProviderContextBreakdown;
      readonly permissionDenials: readonly {
        readonly toolName: string;
        readonly toolUseId: string;
      }[];
    }
  | {
      readonly kind: "tool-progress";
      readonly parentToolUseId?: string;
      readonly sessionId: string;
      readonly toolUseId: string;
      readonly toolName: string;
      readonly elapsedSeconds: number;
      readonly taskId?: string;
    }
  | {
      readonly kind: "tool-summary";
      readonly sessionId: string;
      readonly summary: string;
      readonly toolUseIds: readonly string[];
    }
  | {
      readonly kind: "task";
      readonly sessionId: string;
      readonly subtype: "task_started" | "task_updated" | "task_progress" | "task_notification";
      readonly taskId: string;
      readonly toolUseId?: string;
      /**
       * Work the runtime runs in the background and wakes the model for when
       * it ends: a command or watch (`local_bash`), or a workflow
       * (`local_workflow`).
       */
      readonly background?: true;
      /**
       * A workflow's task: `task_started` names the workflow, and its
       * `task_progress` frames say where each agent it started stands.
       */
      readonly workflow?: {
        readonly name?: string;
        readonly agents?: readonly ClaudeWorkflowAgent[];
      };
      readonly status?: string;
      readonly description?: string;
      readonly summary?: string;
      readonly usage?: ClaudeTaskUsage;
    }
  | {
      /** Whether the runtime is running a turn, as it reports it. */
      readonly kind: "session-state";
      readonly sessionId: string;
      readonly state: "idle" | "running" | "requires_action";
    }
  | {
      readonly kind: "rate-limit";
      readonly sessionId: string;
      readonly status: "allowed" | "allowed_warning" | "rejected";
      readonly resetsAt?: number;
      readonly rateLimitType?: string;
      readonly utilization?: number;
      readonly overageStatus?: "allowed" | "allowed_warning" | "rejected";
      readonly overageResetsAt?: number;
      readonly overageDisabledReason?: string;
      readonly overageInUse?: boolean;
    }
  | {
      readonly kind: "authentication";
      readonly sessionId: string;
      readonly authenticating: boolean;
      readonly failed: boolean;
    }
  | {
      readonly kind: "status";
      readonly sessionId: string;
      readonly status: "compacting" | "requesting" | null;
      readonly permissionMode?: ClaudePermissionMode;
      /** How a compaction the runtime just ran ended, when this status reports one. */
      readonly compactResult?: "success" | "failed";
    }
  | {
      /** The runtime compacted the session's window. */
      readonly kind: "compaction";
      readonly sessionId: string;
      /** `manual` when `/compact` asked for it, `auto` when the runtime chose to. */
      readonly trigger: "manual" | "auto";
      /** What the window held before the cut, in tokens. */
      readonly preTokens: number;
      /** What the compacted window holds, in tokens, when the runtime said. */
      readonly postTokens?: number;
    }
  | {
      /** A reply from one of the runtime's own subagents, read only for the tools it calls. */
      readonly kind: "child-assistant";
      readonly sessionId: string;
      /** The parent's `Agent` call that started the subagent. */
      readonly parentToolUseId: string;
      readonly toolUses: readonly {
        readonly toolUseId: string;
        readonly toolName: string;
        readonly input: { readonly [key: string]: ClaudeJsonValue };
      }[];
    }
  | {
      /**
       * Claude's automatic-mode reviewer refused a call. The runtime reports
       * only these refusals (`permission_denied` with the `classifier`
       * reason); a call it approved runs with no notice.
       */
      readonly kind: "review-denied";
      readonly sessionId: string;
      readonly toolUseId: string;
      readonly toolName: string;
      readonly reason?: string;
    }
  | { readonly kind: "ignored" };

/** The image types Claude's Messages API takes as `image` content blocks. */
export const CLAUDE_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type ClaudeImageMediaType = (typeof CLAUDE_IMAGE_MEDIA_TYPES)[number];

/** One image the person attached, sent beside the message text as a base64 image block. */
export interface ClaudeImageInput {
  readonly mediaType: ClaudeImageMediaType;
  readonly data: string;
}

export interface ClaudeUserMessage {
  readonly text: string;
  /** Images the person attached, sent as image content blocks after the text. */
  readonly images?: ReadonlyArray<ClaudeImageInput>;
  /**
   * Octant's context for this message, handed to Claude Code by the
   * `UserPromptSubmit` hook so the message itself is only the person's text.
   * Claude Code records it beside the message, not in it, and keeps it in the
   * session's history across resume.
   */
  readonly context?: string;
  /**
   * Called once the prompt hook has handed `context` to Claude Code for this
   * message. A hook that never runs for it (a policy that turns hooks off, a
   * prompt Claude Code rewrote) never calls it, so the caller can tell that the
   * context did not arrive.
   */
  readonly onContextDelivered?: () => void;
  readonly appManagedTools?: ReadonlyArray<ProviderToolDefinition>;
  /**
   * `toolUseId` is the transcript's tool_use id when Claude Code names it, so
   * the call can be answered under the step its row already shows.
   */
  readonly onAppToolCall?: (
    name: string,
    inputJson: string,
    signal: AbortSignal,
    toolUseId?: string,
  ) => Promise<ManagedToolAnswer>;
}

export interface ClaudeQueryPort {
  readonly initialization: ClaudeInitialization;
  /**
   * The runtime's session id, available from the first message that names
   * one. Claude Code 2.1.258 only initializes once the first user message
   * arrives, so a caller that needs the id before sending waits here rather
   * than on the initialized message.
   */
  readonly sessionId: Effect.Effect<string, ProviderFailure>;
  readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>;
  readonly send: (message: ClaudeUserMessage) => Effect.Effect<void, ProviderFailure>;
  /**
   * Sends the runtime's own `/compact` command. It is a control input, not a
   * person's turn: it carries no tools and the runtime answers it with a
   * compaction boundary and a status, not a reply.
   */
  readonly requestCompaction: () => Effect.Effect<void, ProviderFailure>;
  readonly interrupt: () => Effect.Effect<void, ProviderFailure>;
  /**
   * Stops one task the runtime started, such as a subagent, by the runtime's
   * own task id, and leaves the turn that started it running. The runtime
   * reports the stop with a task notification; this only asks for it.
   * `unsupported` when the runtime offers no single-task stop.
   */
  readonly stopTask: (
    taskId: string,
  ) => Effect.Effect<"requested" | "unsupported", ProviderFailure>;
  /**
   * Kills this query's runtime process tree outright, without asking it to
   * stop first. Only this query's own process is signalled.
   */
  readonly forceKill: () => Effect.Effect<void, ProviderFailure>;
  readonly setPermissionMode: (mode: ClaudePermissionMode) => Effect.Effect<void, ProviderFailure>;
  readonly supportedModels: () => Effect.Effect<readonly ClaudeModelInfo[], ProviderFailure>;
  readonly accountInfo: () => Effect.Effect<ClaudeAccountState, ProviderFailure>;
  /**
   * Experimental process plan-usage answer. Missing or failing is undefined,
   * never a credential file read.
   */
  readonly readPlanUsage: () => Effect.Effect<unknown, ProviderFailure>;
  readonly close: () => Effect.Effect<void>;
}

export interface ClaudeAgentSdkPort {
  readonly openQuery: (
    input: ClaudeOpenQueryInput,
  ) => Effect.Effect<ClaudeQueryPort, ProviderFailure, Scope.Scope>;
  readonly findSession: (input: {
    readonly sessionId: string;
    readonly projectRoot: string;
    readonly configDirectory?: string;
  }) => Effect.Effect<ClaudeSessionMetadata | undefined, ProviderFailure>;
  /**
   * Copies a session of this Project into a new one ending at (and holding)
   * the message `upToMessageId`, with fresh message ids, and returns the new
   * session's id. The source is not changed. Absent on a port that cannot.
   */
  readonly forkSession?: (input: {
    readonly sessionId: string;
    readonly projectRoot: string;
    readonly upToMessageId: string;
    readonly configDirectory?: string;
  }) => Effect.Effect<string, ProviderFailure>;
  /**
   * The account's sessions whose own folder is `projectRoot`, as the runtime
   * lists them. A port without it offers no session to start a thread from.
   */
  readonly listSessions?: (input: {
    readonly projectRoot: string;
    readonly configDirectory?: string;
  }) => Effect.Effect<ReadonlyArray<ClaudeSessionMetadata>, ProviderFailure>;
}

// Mutable because the SDK's `SDKUserMessage` content is; the port builds a
// fresh one for each message and shares it with no caller.
type ClaudeAgentSdkInputContent =
  | string
  | Array<
      | { readonly type: "text"; readonly text: string }
      | {
          readonly type: "image";
          readonly source: {
            readonly type: "base64";
            readonly media_type: ClaudeImageMediaType;
            readonly data: string;
          };
        }
    >;

export interface ClaudeAgentSdkInputMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: ClaudeAgentSdkInputContent };
  readonly parent_tool_use_id: null;
  readonly origin: { readonly kind: "human" };
  readonly uuid: `${string}-${string}-${string}-${string}-${string}`;
  readonly session_id: string;
}

interface ClaudeAgentSdkHookInput {
  readonly hook_event_name?: unknown;
  readonly prompt?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_use_id?: unknown;
  readonly agent_id?: unknown;
  readonly agent_type?: unknown;
}

interface ClaudeAgentSdkHookOptions {
  readonly signal: AbortSignal;
}

/** A hook's answer; one with no `hookSpecificOutput` decides nothing. */
interface ClaudeAgentSdkHookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

/** Why a listed Octant tool the current turn does not offer is refused. */
const WITHDRAWN_TOOL_MESSAGE = "This Octant tool is not available in this turn.";
const WITHDRAWN_TOOL_ANSWER: ManagedToolAnswer = {
  resultJson: '{"error":"tool-unavailable"}',
  isError: true,
};

/**
 * The session's tool list after a turn offers `offered`: unchanged when it
 * already lists every offered tool as offered, otherwise the listed tools
 * followed by each new one, with a changed definition replacing the listed
 * one in place. A listed tool the turn does not offer is kept.
 */
function growToolListing(
  listed: ReadonlyArray<ProviderToolDefinition>,
  offered: ReadonlyArray<ProviderToolDefinition>,
):
  | { readonly kind: "unchanged" }
  | { readonly kind: "grown"; readonly tools: ReadonlyArray<ProviderToolDefinition> }
  | { readonly kind: "invalid" } {
  const names = new Set<string>();
  for (const tool of offered) {
    if (names.has(tool.name)) return { kind: "invalid" };
    names.add(tool.name);
  }
  const tools = [...listed];
  let grown = false;
  for (const tool of offered) {
    const index = tools.findIndex((candidate) => candidate.name === tool.name);
    if (index === -1) {
      tools.push(tool);
      grown = true;
    } else if (JSON.stringify(tools[index]) !== JSON.stringify(tool)) {
      tools[index] = tool;
      grown = true;
    }
  }
  return grown ? { kind: "grown", tools } : { kind: "unchanged" };
}

type ClaudeAgentSdkPromptHookOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "UserPromptSubmit";
        readonly additionalContext: string;
      };
    }
  | Record<string, never>;

/** The settings files a query reads: the account's home, the Project's, and the Project's local file. */
export type ClaudeSettingSource = "user" | "project" | "local";

/** Flag-level settings, which outrank every settings file the query reads. */
export interface ClaudeFlagSettings {
  readonly availableModels?: readonly string[];
  readonly disableAllHooks?: true;
  readonly autoMemoryEnabled?: false;
  readonly autoCompactWindow?: number;
  readonly allowedMcpServers?: ReadonlyArray<{ readonly serverName: string }>;
  readonly disableClaudeAiConnectors?: true;
}

export interface ClaudeNativeQueryOptions {
  readonly settingSources: ReadonlyArray<ClaudeSettingSource>;
  readonly skills: readonly [] | "all";
  readonly strictMcpConfig: boolean;
  readonly settings: ClaudeFlagSettings;
}

/**
 * How a query reads the person's own Claude setup. With none of it on, the
 * query reads no settings file, enables no skill, and starts no MCP server
 * but Octant's, which is how every session opened before this rule.
 *
 * The account's home settings are where its skills, plugins, hooks, and MCP
 * servers live (`user`), so turning on any of them reads that file. The
 * plugins the person installed and enabled there load with it: the SDK's
 * `plugins` option only adds session plugin folders, and Claude Code 2.1.211
 * loads every plugin its merged settings enable (read from the bundled
 * binary, 2026-11-14). When hooks are off (Chat and Plan) a flag setting keeps
 * every hook from running, a plugin's included, and it outranks the file.
 *
 * Project settings and `.mcp.json` come only with the Project's own code.
 * Claude Code reads a Project's `.mcp.json` only while the `project` setting
 * source is on, its home servers only while `user` is, and its per-folder
 * servers only while `local` is (2.1.211, read from the bundled binary,
 * 2026-11-14). So `strictMcpConfig: false` with only `user` starts the
 * account's own servers, its claude.ai connectors, and its plugins' servers,
 * while a Project's servers stay held until the Project is trusted. The
 * `enabledMcpjsonServers` settings would not hold them: a launch with no
 * terminal approves every pending Project server once the `project` source
 * is on. Claude's own memory stays off by flag as well as by its environment
 * switch, unless the account keeps its own memory.
 */
export function claudeNativeQueryOptions(
  setup: ProviderNativeSetup | undefined,
  ownMemory = false,
  planMcpServers: ReadonlyArray<string> = [],
): ClaudeNativeQueryOptions {
  if (setup === undefined) {
    return { settingSources: [], skills: [], strictMcpConfig: true, settings: {} };
  }
  // A Plan session whose person marked some of the account's servers
  // "Read-only — allowed in Plan" (`planReadOnlyToolServers`) reads them from
  // home settings like any other, and a flag allowlist starts those alone:
  // Claude Code applies `allowedMcpServers` to every scope and an empty list
  // to none, and the merged list keeps any narrower one the person set. Octant's
  // own server is named so the allowlist never drops it. The claude.ai
  // connectors are not the person's marked servers, so they stay off.
  const planServers = !setup.toolServers && !setup.projectCode ? planMcpServers : [];
  if (planServers.length > 0) {
    return {
      settingSources: ["user"],
      skills: setup.skills ? "all" : [],
      strictMcpConfig: false,
      settings: {
        allowedMcpServers: [...planServers, "octant"].map((serverName) => ({ serverName })),
        disableClaudeAiConnectors: true,
        ...(setup.hooks ? {} : { disableAllHooks: true as const }),
        ...(ownMemory ? {} : { autoMemoryEnabled: false as const }),
      },
    };
  }
  const readsHome = setup.skills || setup.hooks || setup.toolServers || setup.projectCode;
  const settingSources: ClaudeSettingSource[] = [];
  if (readsHome) settingSources.push("user");
  if (setup.projectCode) settingSources.push("project", "local");
  return {
    settingSources,
    skills: setup.skills ? "all" : [],
    strictMcpConfig: !(setup.toolServers || setup.projectCode),
    settings: {
      ...(readsHome && !setup.hooks ? { disableAllHooks: true as const } : {}),
      // Home settings could turn auto-memory on behind the account's switch,
      // so they are held to it; an account that keeps its own memory is not.
      ...(readsHome && !ownMemory ? { autoMemoryEnabled: false as const } : {}),
    },
  };
}

interface ClaudeAgentSdkInvocationOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly model: string;
  readonly effort?: ClaudeEffortLevel;
  readonly pathToClaudeCodeExecutable: string;
  readonly systemPrompt: ClaudeSystemPrompt;
  readonly resume?: string;
  readonly sessionId?: string;
  readonly persistSession?: false;
  readonly permissionMode: ClaudePermissionMode;
  readonly allowDangerouslySkipPermissions?: true;
  readonly settings?: ClaudeFlagSettings;
  readonly settingSources: ReadonlyArray<ClaudeSettingSource>;
  readonly skills: readonly [] | "all";
  readonly mcpServers: Readonly<Record<string, never>>;
  readonly strictMcpConfig: boolean;
  readonly additionalDirectories: readonly string[];
  readonly tools: readonly string[] | ClaudeToolPreset;
  readonly disallowedTools?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly agents: Readonly<Record<string, never>>;
  readonly plugins: readonly [];
  readonly includePartialMessages: true;
  readonly sandbox?: ClaudeSandboxSettings;
  readonly spawnClaudeCodeProcess: SpawnClaudeCodeProcess;
  readonly canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      readonly signal: AbortSignal;
      readonly blockedPath?: string;
      readonly title?: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly toolUseID: string;
      readonly requestId: string;
      readonly agentID?: unknown;
    },
  ) => Promise<ClaudeToolDecision>;
  readonly hooks: {
    readonly PreToolUse: readonly [
      {
        readonly hooks: readonly [
          (
            input: ClaudeAgentSdkHookInput,
            toolUseId: string | undefined,
            options: ClaudeAgentSdkHookOptions,
          ) => Promise<ClaudeAgentSdkHookOutput>,
        ];
      },
    ];
    readonly UserPromptSubmit: readonly [
      {
        readonly hooks: readonly [
          (
            input: ClaudeAgentSdkHookInput,
            toolUseId: string | undefined,
            options: ClaudeAgentSdkHookOptions,
          ) => Promise<ClaudeAgentSdkPromptHookOutput>,
        ];
      },
    ];
  };
}

export interface ClaudeAgentSdkQueryInvocation {
  readonly prompt: AsyncIterable<ClaudeAgentSdkInputMessage>;
  readonly options: ClaudeAgentSdkInvocationOptions;
}

export interface ClaudeAgentSdkQueryLike extends AsyncIterable<unknown> {
  readonly setMcpServers?: (
    servers: Record<string, McpSdkServerConfigWithInstance>,
  ) => Promise<McpSetServersResult>;
  readonly interrupt: () => Promise<unknown>;
  /** Older runtimes cannot stop one task without interrupting the turn. */
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly setPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
  readonly initializationResult: () => Promise<unknown>;
  /** The runtime's own account of its window; older runtimes do not answer. */
  readonly getContextUsage?: () => Promise<unknown>;
  readonly supportedModels: () => Promise<unknown>;
  readonly accountInfo: () => Promise<unknown>;
  /**
   * Experimental control request (`get_usage`). The name is the process's;
   * Octant uses it for plan windows and pre-prompt cost snapshots.
   */
  readonly usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
    readonly skipBehaviors?: boolean;
  }) => Promise<unknown>;
  readonly close: () => void;
}

export interface ClaudeAgentSdkBridge {
  readonly query: (input: ClaudeAgentSdkQueryInvocation) => ClaudeAgentSdkQueryLike;
  readonly listSessions: (options: {
    readonly dir: string;
    readonly includeWorktrees: false;
  }) => Promise<unknown>;
  /** The SDK's own session copy; absent on a bridge that cannot make one. */
  readonly forkSession?: (
    sessionId: string,
    options: { readonly dir: string; readonly upToMessageId: string },
  ) => Promise<unknown>;
}

export interface ClaudeAgentSdkPortOptions {
  readonly spawnClaudeCodeProcess: ClaudeProcessPort["spawn"];
  readonly sdk?: ClaudeAgentSdkBridge;
  readonly inputCapacity?: number;
  /** The host's platform; defaults to the running one. */
  readonly platform?: NodeJS.Platform;
}

const DEFAULT_INPUT_CAPACITY = 1;
/**
 * A resumed `/compact` sends a status or two and a rate-limit frame before
 * the runtime initializes; a runtime that sends more than this without ever
 * initializing is not holding a session open.
 */
const MAX_NOTES_BEFORE_INITIALIZATION = 64;
/** The answer is a local control request; one that takes longer is not coming. */
const CONTEXT_USAGE_TIMEOUT_MS = 3_000;
/**
 * A turn's result waits for this answer, so a runtime that is slow to give it
 * costs every turn this long. It is shorter than the session-open wait, and a
 * session stops asking after its first miss.
 */
const TURN_CONTEXT_USAGE_TIMEOUT_MS = 1_500;

function compactionPoint(usage: {
  readonly autoCompactThreshold: number | undefined;
  readonly contextWindow: number | undefined;
}) {
  return {
    ...(usage.autoCompactThreshold === undefined
      ? {}
      : { autoCompactThreshold: usage.autoCompactThreshold }),
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
  };
}

/**
 * Asks the runtime for its own account of its window. Whatever is read from it
 * is the runtime's figure or nothing: a runtime that does not answer, answers
 * late, or throws leaves the caller with no answer rather than a guessed one.
 */
async function askContextUsage(
  query: ClaudeAgentSdkQueryLike,
  timeoutMs: number,
): Promise<unknown> {
  if (query.getContextUsage === undefined) return undefined;
  let timer: number | undefined;
  try {
    return await Promise.race([
      query.getContextUsage(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Where the runtime compacts the session and its window, or nothing it did not say. */
async function askAutoCompactThreshold(query: ClaudeAgentSdkQueryLike): Promise<{
  readonly autoCompactThreshold: number | undefined;
  readonly contextWindow: number | undefined;
}> {
  const usage = await askContextUsage(query, CONTEXT_USAGE_TIMEOUT_MS);
  return {
    autoCompactThreshold: decodeAutoCompactThreshold(usage),
    contextWindow: decodeContextUsageWindow(usage),
  };
}

const PLAN_USAGE_TIMEOUT_MS = 5_000;

/**
 * Asks the Claude process for its own plan-usage windows. A runtime that
 * lacks the experimental method, answers late, or throws leaves no answer —
 * the caller falls back to the last session snapshot, never to credentials.
 */
async function askPlanUsage(query: ClaudeAgentSdkQueryLike): Promise<unknown> {
  if (query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === undefined) {
    return undefined;
  }
  let timer: number | undefined;
  try {
    // Call through the query. The process method uses its receiver for the
    // control request; extracting it makes `this` undefined and the catch
    // below would hide that as a missing answer.
    return await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, PLAN_USAGE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const SANDBOX_KEYS = [
  "allowUnsandboxedCommands",
  "autoAllowBashIfSandboxed",
  "enabled",
  "failIfUnavailable",
  "filesystem",
] as const;
const SANDBOX_FILESYSTEM_KEYS = ["allowRead", "allowWrite", "denyRead"] as const;
/** The only network settings Octant sends: the session's egress proxy port, or every host. */
const SANDBOX_NETWORK_KEYS = ["httpProxyPort"] as const;
const SANDBOX_OPEN_NETWORK_KEYS = ["allowedDomains"] as const;

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isExactPathTuple(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

/**
 * Whether Claude's sandbox lets a command out of it after the gate asks: only
 * at Guarded and Reviewed. Plan's read-only rule and a Full access thread
 * that kept its sandbox are held by the sandbox itself, not only the hook.
 */
export function claudeSandboxLetsCommandsOut(policy: ProviderExecutionPolicy): boolean {
  return policy === "approval-gated" || policy === "auto-accept-edits";
}

function isValidSandboxNetwork(network: unknown): boolean {
  if (hasExactKeys(network, SANDBOX_OPEN_NETWORK_KEYS)) {
    return isExactPathTuple(network.allowedDomains, "*");
  }
  return (
    hasExactKeys(network, SANDBOX_NETWORK_KEYS) &&
    typeof network.httpProxyPort === "number" &&
    Number.isInteger(network.httpProxyPort) &&
    network.httpProxyPort >= 1 &&
    network.httpProxyPort <= 65_535
  );
}

function hasValidSandbox(input: ClaudeOpenQueryInput, platform: NodeJS.Platform): boolean {
  // Claude Code has no command sandbox on Windows, so a launch there carries
  // none: one asking for it with `failIfUnavailable` would leave every
  // command unable to run. Its permission modes hold the turn instead.
  if (platform === "win32") return input.sandbox === undefined;
  try {
    if (
      input.executionPolicy !== "approval-gated" &&
      input.executionPolicy !== "auto-accept-edits" &&
      !(input.executionPolicy === "full-access" && input.fullAccessSandbox === true)
    ) {
      return input.sandbox === undefined;
    }
    const sandbox = input.sandbox;
    if (sandbox === undefined) return false;
    const { network, ...rest } = sandbox;
    if (!hasExactKeys(rest, SANDBOX_KEYS)) return false;
    // A network setting is only ever the proxy port or every host: anything
    // that would let the sandbox pick its own sockets or bindings is refused.
    if (network !== undefined && !isValidSandboxNetwork(network)) return false;
    if (
      sandbox.enabled !== true ||
      sandbox.failIfUnavailable !== true ||
      sandbox.autoAllowBashIfSandboxed !== false ||
      sandbox.allowUnsandboxedCommands !== claudeSandboxLetsCommandsOut(input.executionPolicy) ||
      !hasExactKeys(sandbox.filesystem, SANDBOX_FILESYSTEM_KEYS)
    ) {
      return false;
    }
    const roots = [input.projectRoot, ...(input.additionalDirectories ?? [])];
    const matchesRoots = (paths: ReadonlyArray<string>) =>
      paths.length === roots.length && paths.every((path, index) => path === roots[index]);
    return (
      isExactPathTuple(sandbox.filesystem.denyRead, "/") &&
      matchesRoots(sandbox.filesystem.allowRead) &&
      matchesRoots(sandbox.filesystem.allowWrite)
    );
  } catch {
    return false;
  }
}

/** Claude Code's whole built-in tool set, as the SDK names it. */
interface ClaudeToolPreset {
  readonly type: "preset";
  readonly preset: "claude_code";
}

/**
 * The tool options for a launch. With the full set the runtime gets its own
 * preset less the withheld tools. The SDK notes that a native build may drop
 * Grep and Glob from the preset in favour of searching through its shell
 * unless they are listed in `allowedTools`; they are listed so a search stays
 * a read the gate answers, not a command that asks. The `PreToolUse` hook
 * still answers every call to them first.
 */
function claudeToolSetOptions(
  input: Pick<ClaudeOpenQueryInput, "tools" | "withheldTools">,
): Pick<ClaudeAgentSdkInvocationOptions, "tools" | "disallowedTools" | "allowedTools"> {
  if (input.withheldTools === undefined) return { tools: [...input.tools] };
  return {
    tools: { type: "preset", preset: "claude_code" },
    disallowedTools: [...input.withheldTools],
    allowedTools: ["Grep", "Glob"],
  };
}

/**
 * Why a call asks for background work Octant cannot hold, or undefined. A
 * background command (`Bash` with `run_in_background`) and a command watch
 * (`Monitor`) run as background tasks the driver holds inside the turn that
 * started them (maintainer decision, 2026-11-14), so neither is refused in
 * general. Plan keeps the tool set and behaviour it had, so its read-only
 * commands still run in the foreground. A watch that lasts the whole session
 * would hold its turn open with nothing to end it but a stop, and a WebSocket
 * watch is opened by the runtime process itself, outside the command sandbox
 * and its network rules.
 */
function unavailableBackgroundWork(
  toolName: unknown,
  input: unknown,
  executionPolicy: ClaudeOpenQueryInput["executionPolicy"],
): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Readonly<Record<string, unknown>>;
  if (
    toolName === "Bash" &&
    executionPolicy === "plan" &&
    fields.run_in_background !== undefined &&
    fields.run_in_background !== false
  ) {
    return "Claude background commands are unavailable in Plan.";
  }
  // A remote workflow is sent to a cloud session that clones the Project
  // outside this host, its sandbox, and its gate.
  if (toolName === "Workflow") {
    return fields.remote !== undefined && fields.remote !== false
      ? "Claude's Workflow runs on this host; a remote run is unavailable."
      : undefined;
  }
  if (toolName !== "Monitor") return undefined;
  if (fields.ws !== undefined) return "Claude's Monitor may watch a command, not a WebSocket.";
  if (fields.persistent !== undefined && fields.persistent !== false) {
    return "Claude's Monitor may not keep a watch for the whole session.";
  }
  return undefined;
}

function liveBridge(): ClaudeAgentSdkBridge {
  return {
    query: (invocation) => {
      const { sandbox, settings, allowedTools, disallowedTools, ...baseOptions } =
        invocation.options;
      const options: ClaudeSdkOptions = {
        ...baseOptions,
        systemPrompt: { ...invocation.options.systemPrompt },
        ...(settings === undefined
          ? {}
          : {
              settings: {
                ...(settings.availableModels === undefined
                  ? {}
                  : { availableModels: [...settings.availableModels] }),
                ...(settings.disableAllHooks === undefined ? {} : { disableAllHooks: true }),
                ...(settings.autoMemoryEnabled === undefined ? {} : { autoMemoryEnabled: false }),
                ...(settings.autoCompactWindow === undefined
                  ? {}
                  : { autoCompactWindow: settings.autoCompactWindow }),
              },
            }),
        settingSources: [...invocation.options.settingSources],
        skills: invocation.options.skills === "all" ? "all" : [],
        mcpServers: { ...invocation.options.mcpServers },
        additionalDirectories: [...invocation.options.additionalDirectories],
        tools:
          "preset" in invocation.options.tools
            ? { type: "preset", preset: "claude_code" }
            : [...invocation.options.tools],
        ...(disallowedTools === undefined ? {} : { disallowedTools: [...disallowedTools] }),
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        agents: { ...invocation.options.agents },
        plugins: [...invocation.options.plugins],
        ...(sandbox === undefined
          ? {}
          : {
              sandbox: {
                enabled: sandbox.enabled,
                failIfUnavailable: sandbox.failIfUnavailable,
                autoAllowBashIfSandboxed: sandbox.autoAllowBashIfSandboxed,
                allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands,
                filesystem: {
                  denyRead: [...sandbox.filesystem.denyRead],
                  allowRead: [...sandbox.filesystem.allowRead],
                  allowWrite: [...sandbox.filesystem.allowWrite],
                },
                ...(sandbox.network === undefined
                  ? {}
                  : { network: sdkSandboxNetwork(sandbox.network) }),
              },
            }),
        hooks: {
          PreToolUse: [{ hooks: [...invocation.options.hooks.PreToolUse[0].hooks] }],
          UserPromptSubmit: [{ hooks: [...invocation.options.hooks.UserPromptSubmit[0].hooks] }],
        },
      };
      return queryClaude({
        prompt: invocation.prompt,
        options,
      });
    },
    listSessions: (options) => listClaudeSessions(options),
    forkSession: (sessionId, options) =>
      forkClaudeSession(sessionId, { dir: options.dir, upToMessageId: options.upToMessageId }),
  };
}

function rawSessionId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const sessionId = (message as Record<string, unknown>).session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function deferredPromise<A>(): {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * How long a forced kill waits for the runtime's own cleanup to confirm that
 * its whole process group is gone. The process port escalates and verifies
 * within a few seconds; past this the kill is reported as not confirmed.
 */
const FORCE_KILL_CONFIRMATION_MS = 10_000;

/**
 * Sends SIGKILL and resolves only once the runtime process reports how its
 * cleanup ended. A bare `kill` returns before anything has died, so treating
 * it as done reported every forced stop as successful, even one whose process
 * group survived; the architecture requires a kill failure to leave an explicit
 * recovery error instead. The process port emits `error` before `exit` when the
 * group outlives the kill.
 */
function killAndConfirmExit(
  runtime: SpawnedProcess | undefined,
): Promise<"exited" | "unconfirmed"> {
  // No runtime was ever launched for this query, so nothing is left running.
  if (runtime === undefined) return Promise.resolve("exited");
  if (runtime.exitCode !== null || (runtime.signalCode ?? null) !== null) {
    return Promise.resolve("exited");
  }
  return new Promise((resolve) => {
    let cleanupFailed = false;
    const onError = () => {
      cleanupFailed = true;
    };
    const finish = (outcome: "exited" | "unconfirmed") => {
      clearTimeout(timer);
      runtime.off("error", onError);
      runtime.off("exit", onExit);
      resolve(outcome);
    };
    const onExit = () => finish(cleanupFailed ? "unconfirmed" : "exited");
    const timer = setTimeout(() => finish("unconfirmed"), FORCE_KILL_CONFIRMATION_MS);
    runtime.on("error", onError);
    runtime.on("exit", onExit);
    runtime.kill("SIGKILL");
  });
}

export function makeClaudeAgentSdkPort(options: ClaudeAgentSdkPortOptions): ClaudeAgentSdkPort {
  const sdk = options.sdk ?? liveBridge();
  const copySession = sdk.forkSession;
  const inputCapacity = options.inputCapacity ?? DEFAULT_INPUT_CAPACITY;
  const platform = options.platform ?? process.platform;

  return {
    openQuery: (input) => {
      if (!Number.isInteger(inputCapacity) || inputCapacity < 1) {
        return Effect.fail(
          failure("invalid-configuration", "Claude input capacity must be a positive integer."),
        );
      }
      if (!hasValidSandbox(input, platform)) {
        return Effect.fail(
          failure("invalid-configuration", "Claude sandbox configuration is invalid."),
        );
      }
      const expectedMode = permissionMode(input.executionPolicy, input.autoApprove);
      const acquire = Effect.tryPromise({
        try: async () => {
          const prompt = new BoundedAsyncInput<ClaudeAgentSdkInputMessage>(inputCapacity);
          const issuedMessageIds = new Set<string>();
          // Several messages can wait in the input at once, and the hook names
          // a message only by its text, so every message sent waits here in
          // order, with or without context. Matching by text alone let a
          // context-free message take the context of a later one with the
          // same text, a turn early, leaving its own turn without any.
          const submissions: Array<
            Pick<ClaudeUserMessage, "text" | "context" | "onContextDelivered">
          > = [];
          let query: ClaudeAgentSdkQueryLike | undefined;
          let initializedSessionId: string | undefined;
          let costBaseline: number | undefined;
          let costSnapshotUnavailable = false;
          let pendingCostInputs = 0;
          let managedServer:
            | import("@modelcontextprotocol/sdk/server/mcp.js").McpServer
            | undefined;
          // The session's Octant tool list only grows. Claude Code keeps the
          // tools a server listed when it first connected: replacing the
          // server under the same name changed nothing the model saw (2.1.211
          // against a local stand-in endpoint), and any change to the list
          // re-bills the whole conversation's cached prefix. So a tool joins
          // the list the first time a turn offers it, stays listed after, and
          // is refused while the current turn does not offer it.
          let listedTools: ReadonlyArray<ProviderToolDefinition> = [];
          let offeredToolNames: ReadonlyArray<string> = [];
          let answerToolCall: ClaudeUserMessage["onAppToolCall"];
          const managedName = (name: string) => `mcp__octant__${name}`;
          const isManagedTool = (name: string) => offeredToolNames.includes(name);
          const isWithdrawnTool = (name: string) =>
            !isManagedTool(name) && listedTools.some((tool) => managedName(tool.name) === name);
          const decodingInput = (): ClaudeOpenQueryInput => ({
            ...input,
            tools: [...input.tools, ...listedTools.map((tool) => managedName(tool.name))],
            managedToolServer: listedTools.length > 0,
          });
          const closeCoordinator = makeClaudeCloseCoordinator(
            () => prompt.close(),
            () => {
              query?.close();
              void managedServer?.close().catch(() => undefined);
            },
          );
          const bindSpawn = options.spawnClaudeCodeProcess({
            projectRoot: input.projectRoot,
            ...(input.additionalDirectories === undefined
              ? {}
              : { extraFolders: input.additionalDirectories }),
            executionPolicy: input.executionPolicy,
            ...(input.attachmentsFolder === undefined
              ? {}
              : { readOnlyFolders: [input.attachmentsFolder] }),
            runsCommands: input.tools.includes("Bash"),
            ...(input.network === undefined ? {} : { network: input.network }),
          });
          // The runtime process this query's launch produced, kept so a stuck
          // turn can be killed without the graceful close that waits on it.
          let spawned: ReturnType<typeof bindSpawn> | undefined;
          try {
            const canUseTool: ClaudeAgentSdkInvocationOptions["canUseTool"] = async (
              toolName,
              toolInput,
              callback,
            ) => {
              if (initializedSessionId === undefined) {
                return { behavior: "deny", message: "Claude session is not initialized." };
              }
              // A subagent's call reaches the same gate as the parent's own, at the
              // parent's posture, once the person let Claude run its subagents.
              if (callback.agentID !== undefined && input.nativeSetup?.subagents !== true) {
                return { behavior: "deny", message: "Claude subagent tool use is unavailable." };
              }
              const backgroundRefusal = unavailableBackgroundWork(
                toolName,
                toolInput,
                input.executionPolicy,
              );
              if (backgroundRefusal !== undefined)
                return { behavior: "deny", message: backgroundRefusal };
              // This only authorizes forwarding to the app. The in-process
              // handler still waits for the server's tool policy and answer.
              if (isManagedTool(toolName)) return { behavior: "allow", updatedInput: toolInput };
              if (isWithdrawnTool(toolName)) {
                return { behavior: "deny", message: WITHDRAWN_TOOL_MESSAGE };
              }
              if (!claudeOffersTool(input, toolName)) {
                return {
                  behavior: "deny",
                  message: "Claude requested a tool outside the configured allowlist.",
                };
              }
              return input.canUseTool({
                toolName,
                input: toolInput,
                toolUseId: callback.toolUseID,
                requestId: callback.requestId,
                ...(callback.blockedPath === undefined
                  ? {}
                  : { blockedPath: callback.blockedPath }),
                ...(callback.title === undefined ? {} : { title: callback.title }),
                ...(callback.displayName === undefined
                  ? {}
                  : { displayName: callback.displayName }),
                ...(callback.description === undefined
                  ? {}
                  : { description: callback.description }),
                signal: callback.signal,
              });
            };
            const userPromptSubmit: ClaudeAgentSdkInvocationOptions["hooks"]["UserPromptSubmit"][0]["hooks"][0] =
              async (hookInput) => {
                // A subagent's prompt, or one Octant did not send, takes
                // nothing. Claude Code reads its input in order, so messages
                // queued ahead of the one named here will never reach the
                // hook and are dropped with it.
                if (hookInput.agent_id !== undefined || hookInput.agent_type !== undefined)
                  return {};
                const index = submissions.findIndex(
                  (submission) => submission.text === hookInput.prompt,
                );
                if (index === -1) return {};
                const [pending] = submissions.splice(0, index + 1).slice(-1);
                if (pending?.context === undefined) return {};
                pending.onContextDelivered?.();
                return {
                  hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    additionalContext: pending.context,
                  },
                };
              };
            const preToolUse: ClaudeAgentSdkInvocationOptions["hooks"]["PreToolUse"][0]["hooks"][0] =
              async (hookInput, toolUseId, callback) => {
                if (
                  input.nativeSetup?.subagents !== true &&
                  (hookInput.agent_id !== undefined || hookInput.agent_type !== undefined)
                ) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Claude subagent tool use is unavailable.",
                    },
                  };
                }
                const backgroundRefusal = unavailableBackgroundWork(
                  hookInput.tool_name,
                  hookInput.tool_input,
                  input.executionPolicy,
                );
                if (backgroundRefusal !== undefined) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: backgroundRefusal,
                    },
                  };
                }
                if (
                  hookInput.hook_event_name !== "PreToolUse" ||
                  typeof hookInput.session_id !== "string" ||
                  typeof hookInput.cwd !== "string" ||
                  typeof hookInput.tool_name !== "string" ||
                  typeof hookInput.tool_use_id !== "string" ||
                  // The session's working directory moves with a `cd`, so it is
                  // passed on as the call's folder and the driver judges it
                  // against the folders the session holds: after `cd apps/web`
                  // every later call used to be refused here.
                  !isAbsolute(hookInput.cwd) ||
                  hookInput.session_id !== initializedSessionId ||
                  toolUseId === undefined ||
                  toolUseId !== hookInput.tool_use_id
                ) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Claude pre-tool request was invalid.",
                    },
                  };
                }
                if (isManagedTool(hookInput.tool_name)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                    },
                  };
                }
                if (isWithdrawnTool(hookInput.tool_name)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: WITHDRAWN_TOOL_MESSAGE,
                    },
                  };
                }
                if (!claudeOffersTool(input, hookInput.tool_name)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason:
                        "Claude requested a tool outside the configured allowlist.",
                    },
                  };
                }
                const decision = await input.preToolUse({
                  sessionId: hookInput.session_id,
                  projectRoot: hookInput.cwd,
                  toolName: hookInput.tool_name,
                  input: hookInput.tool_input,
                  toolUseId,
                  signal: callback.signal,
                });
                if (decision.behavior === "own-rules") return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: decision.behavior,
                    ...(decision.behavior === "deny"
                      ? { permissionDecisionReason: decision.message }
                      : decision.behavior === "allow" && decision.updatedInput !== undefined
                        ? { updatedInput: { ...decision.updatedInput } }
                        : {}),
                  },
                };
              };
            const native = claudeNativeQueryOptions(
              input.nativeSetup,
              input.ownMemory === true,
              input.planMcpServers,
            );
            const flagSettings: ClaudeFlagSettings = {
              ...native.settings,
              // Claude Code upgrades Haiku to Sonnet in Plan unless Sonnet is
              // excluded. Keep the explicit selection local to this query.
              ...(input.executionPolicy === "plan" &&
              (input.model === "haiku" || input.model.startsWith("claude-haiku-"))
                ? { availableModels: [input.model] }
                : {}),
              ...(input.autoCompactWindow === undefined
                ? {}
                : { autoCompactWindow: input.autoCompactWindow }),
            };
            const invocationOptions: ClaudeAgentSdkInvocationOptions = {
              cwd: input.projectRoot,
              env: {
                ...input.authEnvironment,
                // The runtime says when it goes idle, so the driver can tell a
                // turn it starts by itself from a queued notice from the end
                // of the person's turn.
                CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
                MCP_TOOL_TIMEOUT: "660000",
                // `CLAUDE_CODE_ENABLE_TASKS` is left to Claude Code: its
                // default replaces the `TodoWrite` checklist with the task
                // tools, and Octant adds to a provider rather than taking its
                // features away (maintainer decision, 2026-11-14). The task
                // panel follows those tools from their results and rebuilds a
                // resumed session's list from the one Claude stored.
              },
              model: input.model,
              ...(Object.keys(flagSettings).length === 0 ? {} : { settings: flagSettings }),
              ...(input.effort === undefined ? {} : { effort: input.effort }),
              pathToClaudeCodeExecutable: input.binaryPath,
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                ...(input.instructions === undefined ? {} : { append: input.instructions }),
              },
              ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
              ...(input.resumeSessionId === undefined && input.sessionId !== undefined
                ? { sessionId: input.sessionId }
                : {}),
              ...(input.persistSession === false ? { persistSession: false as const } : {}),
              permissionMode: expectedMode,
              ...(input.executionPolicy === "full-access"
                ? { allowDangerouslySkipPermissions: true }
                : {}),
              settingSources: native.settingSources,
              skills: native.skills,
              mcpServers: {},
              strictMcpConfig: native.strictMcpConfig,
              // The Project's extra folders, which Claude Code then counts as
              // its workspace beside `cwd`; its sandbox lists them too.
              additionalDirectories: [...(input.additionalDirectories ?? [])],
              ...claudeToolSetOptions(input),
              agents: {},
              plugins: [],
              includePartialMessages: true,
              ...(input.sandbox === undefined
                ? {}
                : {
                    sandbox: {
                      ...input.sandbox,
                      filesystem: {
                        denyRead: [...input.sandbox.filesystem.denyRead] as ["/"],
                        allowRead: [...input.sandbox.filesystem.allowRead] as [string],
                        allowWrite: [...input.sandbox.filesystem.allowWrite] as [string],
                      },
                      ...(input.sandbox.network === undefined
                        ? {}
                        : { network: input.sandbox.network }),
                    },
                  }),
              // The SDK composes the launch and its `SpawnOptions` carry no
              // bound root or posture, so this query's own are bound to the
              // callback here.
              spawnClaudeCodeProcess: (spawnOptions) => {
                spawned = bindSpawn(spawnOptions);
                return spawned;
              },
              canUseTool,
              hooks: {
                PreToolUse: [{ hooks: [preToolUse] }],
                UserPromptSubmit: [{ hooks: [userPromptSubmit] }],
              },
            };
            query = sdk.query({ prompt, options: invocationOptions });
            const initialization = {
              ...decodeInitialization(await query.initializationResult()),
              ...compactionPoint(await askAutoCompactThreshold(query)),
            };
            // The runtime echoes the model an alias such as `sonnet` resolved
            // to, so the initialized message is checked against the resolved
            // id its own catalogue declares for the requested model.
            const acceptedModels = new Set(
              initialization.models.flatMap((model) =>
                model.id === input.model && model.resolvedId !== undefined
                  ? [model.resolvedId]
                  : [],
              ),
            );
            const iterator = query[Symbol.asyncIterator]();
            // The runtime initializes lazily: nothing but goal and compaction
            // notes arrives until the first user message. The initialized
            // message is therefore validated inside the stream, and the
            // session id is announced from the first message that names one.
            let phase: ClaudeDecodePhase = { kind: "initializing", acceptedModels };
            let hasInterruptReceipt = false;
            let announcedSessionId: string | undefined;
            const sessionAnnounced = deferredPromise<string>();
            void sessionAnnounced.promise.catch(() => undefined);
            const announce = (sessionId: string) => {
              if (announcedSessionId === undefined) {
                announcedSessionId = sessionId;
                sessionAnnounced.resolve(sessionId);
              }
            };
            // A resumed or assigned id is known before the runtime says
            // anything; the initialized message is later held to it.
            const expectedSessionId = input.resumeSessionId ?? input.sessionId;
            if (expectedSessionId !== undefined) announce(expectedSessionId);
            const streamEnded = (failed: ProviderFailure) => {
              sessionAnnounced.reject(failed);
            };
            // Status notes, rate-limit frames and session states the runtime
            // sends before it initializes (a resumed `/compact` does) are held
            // and delivered right after the initialized message, so a consumer
            // still sees the session initialize first and the notes in their
            // own order.
            const heldBeforeInitialization: ClaudeDecodedMessage[] = [];
            const decodeNext = (message: unknown): readonly ClaudeDecodedMessage[] => {
              if (phase.kind !== "initializing")
                return [decodeMessage(message, decodingInput(), phase)];
              const decoded = decodeMessage(message, decodingInput(), phase);
              if (decoded.kind === "initialized") {
                if (announcedSessionId !== undefined && announcedSessionId !== decoded.sessionId) {
                  throw protocol("Claude initialized an unexpected runtime surface.");
                }
                initializedSessionId = decoded.sessionId;
                hasInterruptReceipt = decoded.capabilities.includes("interrupt_receipt_v1");
                phase = { kind: "active", sessionId: decoded.sessionId };
                announce(decoded.sessionId);
                // Each held note already named the session announced here.
                return [decoded, ...heldBeforeInitialization.splice(0)];
              }
              const sessionId = rawSessionId(message);
              if (sessionId !== undefined) announce(sessionId);
              if (decoded.kind === "ignored") return [];
              // Only the latest state matters, so a run of them holds one.
              if (decoded.kind === "session-state") {
                const earlier = heldBeforeInitialization.findIndex(
                  (held) => held.kind === "session-state",
                );
                if (earlier !== -1) heldBeforeInitialization.splice(earlier, 1);
              }
              if (
                heldBeforeInitialization.length >= MAX_NOTES_BEFORE_INITIALIZATION ||
                (announcedSessionId !== undefined && decoded.sessionId !== announcedSessionId)
              ) {
                throw protocol("Claude returned an unsupported runtime message.");
              }
              heldBeforeInitialization.push(decoded);
              return [];
            };
            const remaining: AsyncIterable<unknown> = {
              [Symbol.asyncIterator]: () => ({
                next: async () => {
                  try {
                    const result = await iterator.next();
                    if (result.done) {
                      streamEnded(
                        failure("unavailable", "Claude did not initialize its runtime stream."),
                      );
                    }
                    return result;
                  } catch (error) {
                    // Only the classified reason reaches the log: the raw error
                    // can quote paths, prompt text, or tokens.
                    console.error("Claude message stream failed.", {
                      reason: runtimeErrorReason(error) ?? "unclassified",
                    });
                    streamEnded(sanitizeFailure(error, "message stream"));
                    throw error;
                  }
                },
              }),
            };
            const decodedMessages = Stream.fromAsyncIterable(remaining, (error) =>
              sanitizeFailure(error, "message stream"),
            ).pipe(
              Stream.mapEffect((message) =>
                Effect.try({
                  try: () => decodeNext(message),
                  catch: (error) => {
                    // The shape, never the content: enough to name which runtime
                    // message the decoder refused when a turn dies on it.
                    const shape = object(message);
                    console.error("Claude runtime message refused by the decoder.", {
                      type: shape?.type,
                      subtype: shape?.subtype,
                      keys: shape === undefined ? [] : Object.keys(shape).sort(),
                      parentToolUse:
                        shape?.parent_tool_use_id === null
                          ? "null"
                          : typeof shape?.parent_tool_use_id,
                      event: object(shape?.event)?.type,
                      delta: object(object(shape?.event)?.delta)?.type,
                      block: object(object(shape?.event)?.content_block)?.type,
                      blockKeys: Object.keys(
                        object(object(shape?.event)?.content_block) ?? {},
                      ).sort(),
                      callerKeys: Object.keys(
                        object(object(object(shape?.event)?.content_block)?.caller) ?? {},
                      ),
                      toolAllowed: input.tools.includes(
                        String(object(object(shape?.event)?.content_block)?.name),
                      ),
                      inputIsObject:
                        object(object(object(shape?.event)?.content_block)?.input) !== undefined,
                    });
                    const failed = sanitizeFailure(error, "message decoding");
                    streamEnded(failed);
                    return failed;
                  },
                }),
              ),
              Stream.flattenIterables,
              Stream.map((message) => {
                if (message.kind !== "result") return message;
                const baseline = costBaseline;
                pendingCostInputs = Math.max(0, pendingCostInputs - 1);
                const total = message.totalCostUsd;
                // A turn the runtime starts by itself after this result sends
                // no prompt to take a new baseline at, so this result's total
                // is its baseline; a prompt still reads a fresh one.
                costBaseline =
                  pendingCostInputs === 0 && total !== undefined && Number.isFinite(total)
                    ? total
                    : undefined;
                return baseline !== undefined && total !== undefined && total >= baseline
                  ? { ...message, costUsd: total - baseline }
                  : message;
              }),
              // The window's make-up is asked for where a turn settles. The
              // answer is the runtime's, so it rides on the result that carries
              // the turn's usage and nowhere else.
              Stream.mapEffect((message) =>
                message.kind === "result" && !contextUsageUnavailable
                  ? Effect.promise(async () => {
                      const answer = await askContextUsage(query!, TURN_CONTEXT_USAGE_TIMEOUT_MS);
                      if (answer === undefined) contextUsageUnavailable = true;
                      const contextBreakdown = decodeContextBreakdown(answer);
                      return contextBreakdown === undefined
                        ? message
                        : { ...message, contextBreakdown };
                    })
                  : Effect.succeed(message),
              ),
            );
            let contextUsageUnavailable = false;
            let messageStreamClaimed = false;
            const messages = Stream.unwrap(
              Effect.sync(() => {
                if (messageStreamClaimed) {
                  return Stream.fail(
                    failure("protocol", "Claude message stream already has a consumer."),
                  );
                }
                messageStreamClaimed = true;
                return decodedMessages;
              }),
            );
            const request = <A>(operation: () => Promise<A>, name: string) =>
              Effect.tryPromise({
                try: operation,
                catch: (error) => sanitizeFailure(error, name),
              });
            const port: ClaudeQueryPort = {
              initialization,
              sessionId: Effect.tryPromise({
                try: () => sessionAnnounced.promise,
                catch: (error) => sanitizeFailure(error, "session discovery"),
              }),
              messages,
              send: ({
                text,
                images = [],
                context,
                onContextDelivered,
                appManagedTools = [],
                onAppToolCall,
              }) =>
                request(async () => {
                  if (appManagedTools.length > 0) {
                    if (query?.setMcpServers === undefined || onAppToolCall === undefined) {
                      throw protocol("App tool transport is unavailable.");
                    }
                    const listing = growToolListing(listedTools, appManagedTools);
                    if (listing.kind === "invalid")
                      throw protocol("App tool catalogue is invalid.");
                    if (listing.kind === "grown") {
                      const prepared = createManagedMcpTools(
                        listing.tools,
                        (name, inputJson, signal, call) => {
                          const answer = answerToolCall;
                          // Claude Code 2.1 sends each call's tool_use id in
                          // this request metadata key.
                          const toolUseId = call?.metadata["claudecode/toolUseId"];
                          return offeredToolNames.includes(managedName(name)) &&
                            answer !== undefined
                            ? typeof toolUseId === "string"
                              ? answer(name, inputJson, signal, toolUseId)
                              : answer(name, inputJson, signal)
                            : Promise.resolve(WITHDRAWN_TOOL_ANSWER);
                        },
                      );
                      if (prepared.kind === "invalid")
                        throw protocol("App tool catalogue is invalid.");
                      const previous = managedServer;
                      try {
                        // Claude Code reloads a server's tools only when the
                        // server is removed and added again.
                        if (previous !== undefined) {
                          managedServer = undefined;
                          listedTools = [];
                          await query.setMcpServers({});
                          await previous.close();
                        }
                        const result = await query.setMcpServers({
                          octant: { type: "sdk", name: "octant", instance: prepared.server },
                        });
                        if (Object.keys(result.errors).length > 0)
                          throw protocol("App tool transport could not connect.");
                        managedServer = prepared.server;
                        listedTools = listing.tools;
                      } catch (error) {
                        await prepared.server.close();
                        throw error;
                      }
                    }
                  }
                  offeredToolNames = appManagedTools.map((tool) => managedName(tool.name));
                  answerToolCall = onAppToolCall;
                  // Read at each prompt, not from the last successful result:
                  // a resumed session also contains interrupted/failed usage.
                  // Overlapping inputs have no separable session-cost window.
                  const separateCostWindow = pendingCostInputs === 0;
                  pendingCostInputs += 1;
                  costBaseline = undefined;
                  const snapshot =
                    query === undefined || costSnapshotUnavailable
                      ? undefined
                      : await askPlanUsage(query);
                  if (snapshot === undefined) costSnapshotUnavailable = true;
                  const total = object(object(snapshot)?.session)?.total_cost_usd;
                  if (
                    separateCostWindow &&
                    pendingCostInputs === 1 &&
                    typeof total === "number" &&
                    Number.isFinite(total) &&
                    total >= 0
                  ) {
                    costBaseline = total;
                  }
                  const messageId = crypto.randomUUID();
                  issuedMessageIds.add(messageId);
                  const submission =
                    context === undefined
                      ? { text }
                      : {
                          text,
                          context,
                          ...(onContextDelivered === undefined ? {} : { onContextDelivered }),
                        };
                  submissions.push(submission);
                  try {
                    return await prompt.offer({
                      type: "user",
                      message: {
                        role: "user",
                        content:
                          images.length === 0
                            ? text
                            : [
                                { type: "text", text },
                                ...images.map((image) => ({
                                  type: "image" as const,
                                  source: {
                                    type: "base64" as const,
                                    media_type: image.mediaType,
                                    data: image.data,
                                  },
                                })),
                              ],
                      },
                      parent_tool_use_id: null,
                      origin: { kind: "human" },
                      uuid: messageId,
                      session_id: initializedSessionId ?? announcedSessionId ?? "",
                    });
                  } catch (error) {
                    // A message the input refused never reaches the hook.
                    const index = submissions.indexOf(submission);
                    if (index !== -1) submissions.splice(index, 1);
                    throw error;
                  }
                }, "input delivery"),
              requestCompaction: () =>
                request(async () => {
                  const messageId = crypto.randomUUID();
                  issuedMessageIds.add(messageId);
                  return prompt.offer({
                    type: "user",
                    message: { role: "user", content: "/compact" },
                    parent_tool_use_id: null,
                    origin: { kind: "human" },
                    uuid: messageId,
                    session_id: initializedSessionId ?? announcedSessionId ?? "",
                  });
                }, "compaction request"),
              forceKill: () =>
                Effect.flatMap(
                  Effect.promise(() => killAndConfirmExit(spawned)),
                  (outcome) =>
                    outcome === "exited"
                      ? Effect.void
                      : Effect.fail(
                          failure(
                            "unavailable",
                            "Claude's runtime did not confirm that it stopped after a forced kill.",
                          ),
                        ),
                ),
              interrupt: () =>
                request(async () => {
                  for (const message of prompt.clear()) issuedMessageIds.delete(message.uuid);
                  // An interrupted turn never counts as holding its context, so
                  // the next turn sends it again; a stale entry left here could
                  // attach to a later message with the same text.
                  // A message Claude Code read but had not started is named by
                  // the interrupt receipt, which closes the session below, so
                  // nothing left here is still owed context.
                  submissions.length = 0;
                  try {
                    const receipt = decodeInterruptReceipt(await query!.interrupt());
                    if (
                      !hasInterruptReceipt ||
                      receipt === undefined ||
                      receipt.some((messageId) => issuedMessageIds.has(messageId))
                    ) {
                      await closeCoordinator.closeOnce();
                    }
                  } catch (error) {
                    await closeCoordinator.closeOnce().catch(() => undefined);
                    throw error;
                  }
                }, "interruption"),
              stopTask: (taskId) =>
                request(async () => {
                  const stop = query?.stopTask;
                  if (stop === undefined) return "unsupported" as const;
                  await stop.call(query, taskId);
                  return "requested" as const;
                }, "task stop"),
              setPermissionMode: (mode) =>
                request(() => query!.setPermissionMode(mode), "permission update"),
              supportedModels: () =>
                request(
                  async () => decodeModels(await query!.supportedModels()),
                  "model discovery",
                ),
              accountInfo: () =>
                request(async () => decodeAccount(await query!.accountInfo()), "account discovery"),
              readPlanUsage: () =>
                request(async () => {
                  const sessionQuery = query;
                  return sessionQuery === undefined ? undefined : askPlanUsage(sessionQuery);
                }, "plan usage"),
              close: () =>
                Effect.promise(async () => {
                  streamEnded(failure("unavailable", "Claude connection is closing."));
                  await closeCoordinator.closeWithRetry();
                }),
            };
            return port;
          } catch (error) {
            await closeCoordinator.closeWithRetry();
            throw error;
          }
        },
        catch: (error) => sanitizeFailure(error, "initialization"),
      });
      return Effect.acquireRelease(acquire, (query, _exit) => query.close());
    },
    listSessions: ({ projectRoot, configDirectory }) =>
      Effect.tryPromise({
        try: async () =>
          decodeSessions(
            await withClaudeAccountDirectory(configDirectory, () =>
              sdk.listSessions({ dir: projectRoot, includeWorktrees: false }),
            ),
            projectRoot,
            { titles: true },
          ),
        catch: (error) => sanitizeFailure(error, "session lookup"),
      }),
    findSession: ({ sessionId, projectRoot, configDirectory }) =>
      Effect.tryPromise({
        try: async () => {
          // Only a session whose own root is this Project counts, so the
          // other worktrees are not listed. Listing them runs Git first, and
          // the account directory stays overlaid on process.env for that
          // long: measured about 90 ms with worktrees and 8 ms without.
          const sessions = decodeSessions(
            await withClaudeAccountDirectory(configDirectory, () =>
              sdk.listSessions({ dir: projectRoot, includeWorktrees: false }),
            ),
            projectRoot,
          );
          return sessions.find((session) => session.sessionId === sessionId);
        },
        catch: (error) => sanitizeFailure(error, "session lookup"),
      }),
    ...(copySession === undefined
      ? {}
      : {
          forkSession: ({ sessionId, projectRoot, upToMessageId, configDirectory }) =>
            Effect.tryPromise({
              try: async () => {
                const forked: unknown = await withClaudeAccountDirectory(configDirectory, () =>
                  copySession(sessionId, { dir: projectRoot, upToMessageId }),
                );
                const id =
                  typeof forked === "object" && forked !== null && "sessionId" in forked
                    ? forked.sessionId
                    : undefined;
                if (typeof id !== "string" || id.trim().length === 0 || id === sessionId)
                  throw new Error("Claude did not name the copied session.");
                return id;
              },
              catch: (error) => sanitizeFailure(error, "session copy"),
            }),
        }),
  };
}
