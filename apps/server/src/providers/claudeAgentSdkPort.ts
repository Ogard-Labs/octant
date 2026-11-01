import {
  listSessions as listClaudeSessions,
  query as queryClaude,
  type Options as ClaudeSdkOptions,
  type McpSdkServerConfigWithInstance,
  type McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderContextBreakdown,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderNativeSetup,
  ProviderToolDefinition,
  ThreadPublishedSnapshot,
} from "@octant/contracts";
import { withClaudeAccountDirectory } from "./claudeAccountDirectory";
import { createManagedMcpTools, type ManagedToolAnswer } from "./managedMcpTools";
import { Effect, Stream, type Scope } from "effect";

import {
  claudeOffersTool,
  decodeAccount,
  decodeAutoCompactThreshold,
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
 */
export type ClaudePreToolDecision = ClaudeToolDecision | { readonly behavior: "ask" };

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
  readonly allowUnsandboxedCommands: false;
  readonly filesystem: {
    readonly denyRead: readonly ["/"];
    /** The Project root, then its extra folders. */
    readonly allowRead: readonly [string, ...string[]];
    readonly allowWrite: readonly [string, ...string[]];
  };
  /**
   * The sandbox's commands reach the network only through this loopback
   * port: Octant's egress proxy for the session. The Agent SDK's
   * `sandbox.network.httpProxyPort` points the sandbox at an outside proxy
   * instead of its own, so the proxy decides every host.
   */
  readonly network?: { readonly httpProxyPort: number };
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
   * What this session loads of the person's own Claude setup, already held to
   * what the driver supports for the session's mode and posture. Absent opens
   * the query with no setting sources, skills, agents, plugins, or MCP
   * servers but Octant's own.
   */
  readonly nativeSetup?: ProviderNativeSetup;
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
   * Where the runtime compacts the session by itself, in tokens, when it said
   * compaction is on. Absent when it said nothing usable.
   */
  readonly autoCompactThreshold?: number;
}

export interface ClaudeSessionMetadata {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly lastModified: number;
  readonly createdAt?: number;
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
      readonly kind: "tool-results";
      readonly sessionId: string;
      readonly results: readonly {
        readonly toolUseId: string;
        readonly isError: boolean;
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
      readonly status?: string;
      readonly description?: string;
      readonly summary?: string;
      readonly usage?: ClaudeTaskUsage;
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

export interface ClaudeUserMessage {
  readonly text: string;
  readonly appManagedTools?: ReadonlyArray<ProviderToolDefinition>;
  readonly onAppToolCall?: (
    name: string,
    inputJson: string,
    signal: AbortSignal,
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
}

export interface ClaudeAgentSdkInputMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly origin: { readonly kind: "human" };
  readonly uuid: `${string}-${string}-${string}-${string}-${string}`;
  readonly session_id: string;
}

interface ClaudeAgentSdkHookInput {
  readonly hook_event_name?: unknown;
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

interface ClaudeAgentSdkHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

/** The settings files a query reads: the account's home, the Project's, and the Project's local file. */
export type ClaudeSettingSource = "user" | "project" | "local";

/** Flag-level settings, which outrank every settings file the query reads. */
export interface ClaudeFlagSettings {
  readonly availableModels?: readonly string[];
  readonly disableAllHooks?: true;
  readonly autoMemoryEnabled?: false;
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
 * The account's home settings are where its skills, plugins, and hooks live
 * (`user`), so turning on skills or hooks reads that file; when hooks are off
 * (Chat and Plan) a flag setting keeps every hook from running, and it
 * outranks the file. Project settings and `.mcp.json` come only with the
 * Project's own code: Claude Code reads a Project's skills only with the
 * `project` source, which also loads that Project's hooks, so Project skills
 * load in a trusted Project and not otherwise. The runtime has no switch that
 * starts the account's MCP servers without also reading a Project's
 * `.mcp.json` (`strictMcpConfig` governs both), so MCP servers start only
 * with the Project's code. Claude's own memory stays off by flag as well as
 * by its environment switch.
 */
export function claudeNativeQueryOptions(
  setup: ProviderNativeSetup | undefined,
): ClaudeNativeQueryOptions {
  if (setup === undefined) {
    return { settingSources: [], skills: [], strictMcpConfig: true, settings: {} };
  }
  const readsHome = setup.skills || setup.hooks || setup.projectCode;
  const settingSources: ClaudeSettingSource[] = [];
  if (readsHome) settingSources.push("user");
  if (setup.projectCode) settingSources.push("project", "local");
  return {
    settingSources,
    skills: setup.skills ? "all" : [],
    strictMcpConfig: !setup.projectCode,
    settings: {
      ...(readsHome && !setup.hooks ? { disableAllHooks: true as const } : {}),
      ...(readsHome ? { autoMemoryEnabled: false as const } : {}),
    },
  };
}

interface ClaudeAgentSdkInvocationOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly model: string;
  readonly effort?: ClaudeEffortLevel;
  readonly pathToClaudeCodeExecutable: string;
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
  readonly tools: readonly string[];
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
}

export interface ClaudeAgentSdkPortOptions {
  readonly spawnClaudeCodeProcess: ClaudeProcessPort["spawn"];
  readonly sdk?: ClaudeAgentSdkBridge;
  readonly inputCapacity?: number;
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

function compactionPoint(autoCompactThreshold: number | undefined) {
  return autoCompactThreshold === undefined ? {} : { autoCompactThreshold };
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

/** Where the runtime compacts the session, or nothing when it did not say. */
async function askAutoCompactThreshold(
  query: ClaudeAgentSdkQueryLike,
): Promise<number | undefined> {
  return decodeAutoCompactThreshold(await askContextUsage(query, CONTEXT_USAGE_TIMEOUT_MS));
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
/** The only network setting Octant sends: the session's egress proxy port. */
const SANDBOX_NETWORK_KEYS = ["httpProxyPort"] as const;

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

function hasValidSandbox(input: ClaudeOpenQueryInput): boolean {
  try {
    if (
      input.executionPolicy !== "approval-gated" &&
      input.executionPolicy !== "auto-accept-edits"
    ) {
      return input.sandbox === undefined;
    }
    const sandbox = input.sandbox;
    if (sandbox === undefined) return false;
    const { network, ...rest } = sandbox;
    if (!hasExactKeys(rest, SANDBOX_KEYS)) return false;
    // A network setting is only ever the proxy port: anything that would let
    // the sandbox pick its own domains, sockets, or bindings is refused.
    if (
      network !== undefined &&
      (!hasExactKeys(network, SANDBOX_NETWORK_KEYS) ||
        !Number.isInteger(network.httpProxyPort) ||
        network.httpProxyPort < 1 ||
        network.httpProxyPort > 65_535)
    ) {
      return false;
    }
    if (
      sandbox.enabled !== true ||
      sandbox.failIfUnavailable !== true ||
      sandbox.autoAllowBashIfSandboxed !== false ||
      sandbox.allowUnsandboxedCommands !== false ||
      !hasExactKeys(sandbox.filesystem, SANDBOX_FILESYSTEM_KEYS)
    ) {
      return false;
    }
    return (
      isExactPathTuple(sandbox.filesystem.denyRead, "/") &&
      isExactPathTuple(sandbox.filesystem.allowRead, input.projectRoot) &&
      isExactPathTuple(sandbox.filesystem.allowWrite, input.projectRoot)
    );
  } catch {
    return false;
  }
}

function requestsUnavailableBackgroundTool(toolName: unknown, input: unknown): boolean {
  if (
    toolName !== "Bash" ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !Object.hasOwn(input, "run_in_background")
  ) {
    return false;
  }
  return (input as Readonly<Record<string, unknown>>).run_in_background !== false;
}

function liveBridge(): ClaudeAgentSdkBridge {
  return {
    query: (invocation) => {
      const { sandbox, settings, ...baseOptions } = invocation.options;
      const options: ClaudeSdkOptions = {
        ...baseOptions,
        ...(settings === undefined
          ? {}
          : {
              settings: {
                ...(settings.availableModels === undefined
                  ? {}
                  : { availableModels: [...settings.availableModels] }),
                ...(settings.disableAllHooks === undefined ? {} : { disableAllHooks: true }),
                ...(settings.autoMemoryEnabled === undefined ? {} : { autoMemoryEnabled: false }),
              },
            }),
        settingSources: [...invocation.options.settingSources],
        skills: invocation.options.skills === "all" ? "all" : [],
        mcpServers: { ...invocation.options.mcpServers },
        additionalDirectories: [...invocation.options.additionalDirectories],
        tools: [...invocation.options.tools],
        agents: { ...invocation.options.agents },
        plugins: [...invocation.options.plugins],
        ...(sandbox === undefined
          ? {}
          : {
              sandbox: {
                ...sandbox,
                filesystem: {
                  denyRead: [...sandbox.filesystem.denyRead],
                  allowRead: [...sandbox.filesystem.allowRead],
                  allowWrite: [...sandbox.filesystem.allowWrite],
                },
                ...(sandbox.network === undefined
                  ? {}
                  : { network: { httpProxyPort: sandbox.network.httpProxyPort } }),
              },
            }),
        hooks: {
          PreToolUse: [{ hooks: [...invocation.options.hooks.PreToolUse[0].hooks] }],
        },
      };
      return queryClaude({
        prompt: invocation.prompt,
        options,
      });
    },
    listSessions: (options) => listClaudeSessions(options),
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

export function makeClaudeAgentSdkPort(options: ClaudeAgentSdkPortOptions): ClaudeAgentSdkPort {
  const sdk = options.sdk ?? liveBridge();
  const inputCapacity = options.inputCapacity ?? DEFAULT_INPUT_CAPACITY;

  return {
    openQuery: (input) => {
      if (!Number.isInteger(inputCapacity) || inputCapacity < 1) {
        return Effect.fail(
          failure("invalid-configuration", "Claude input capacity must be a positive integer."),
        );
      }
      if (!hasValidSandbox(input)) {
        return Effect.fail(
          failure("invalid-configuration", "Claude sandbox configuration is invalid."),
        );
      }
      const expectedMode = permissionMode(input.executionPolicy, input.autoApprove);
      const acquire = Effect.tryPromise({
        try: async () => {
          const prompt = new BoundedAsyncInput<ClaudeAgentSdkInputMessage>(inputCapacity);
          const issuedMessageIds = new Set<string>();
          let query: ClaudeAgentSdkQueryLike | undefined;
          let initializedSessionId: string | undefined;
          let costBaseline: number | undefined;
          let costSnapshotUnavailable = false;
          let pendingCostInputs = 0;
          let managedServer:
            | import("@modelcontextprotocol/sdk/server/mcp.js").McpServer
            | undefined;
          let managedToolNames: ReadonlyArray<string> = [];
          const isManagedTool = (name: string) => managedToolNames.includes(name);
          const decodingInput = (): ClaudeOpenQueryInput => ({
            ...input,
            tools: [...input.tools, ...managedToolNames],
            managedToolServer: managedToolNames.length > 0,
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
              if (requestsUnavailableBackgroundTool(toolName, toolInput)) {
                return {
                  behavior: "deny",
                  message: "Claude background tool use is unavailable.",
                };
              }
              // This only authorizes forwarding to the app. The in-process
              // handler still waits for the server's tool policy and answer.
              if (isManagedTool(toolName)) return { behavior: "allow", updatedInput: toolInput };
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
                if (requestsUnavailableBackgroundTool(hookInput.tool_name, hookInput.tool_input)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "Claude background tool use is unavailable.",
                    },
                  };
                }
                if (
                  hookInput.hook_event_name !== "PreToolUse" ||
                  typeof hookInput.session_id !== "string" ||
                  typeof hookInput.cwd !== "string" ||
                  typeof hookInput.tool_name !== "string" ||
                  typeof hookInput.tool_use_id !== "string" ||
                  hookInput.cwd !== input.projectRoot ||
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
            const native = claudeNativeQueryOptions(input.nativeSetup);
            const flagSettings: ClaudeFlagSettings = {
              ...native.settings,
              // Claude Code upgrades Haiku to Sonnet in Plan unless Sonnet is
              // excluded. Keep the explicit selection local to this query.
              ...(input.executionPolicy === "plan" &&
              (input.model === "haiku" || input.model.startsWith("claude-haiku-"))
                ? { availableModels: [input.model] }
                : {}),
            };
            const invocationOptions: ClaudeAgentSdkInvocationOptions = {
              cwd: input.projectRoot,
              env: {
                ...input.authEnvironment,
                MCP_TOOL_TIMEOUT: "660000",
                // Claude Code 2.1.211 replaces its `TodoWrite` checklist with
                // `TaskCreate`/`TaskUpdate` unless this is off (observed
                // 2026-10-20 in the init tool list). The checklist keeps
                // `TodoWrite`, which restates the whole list in every call,
                // so the task panel never has to piece it together.
                CLAUDE_CODE_ENABLE_TASKS: "false",
              },
              model: input.model,
              ...(Object.keys(flagSettings).length === 0 ? {} : { settings: flagSettings }),
              ...(input.effort === undefined ? {} : { effort: input.effort }),
              pathToClaudeCodeExecutable: input.binaryPath,
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
              tools: [...input.tools],
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
                        : { network: { httpProxyPort: input.sandbox.network.httpProxyPort } }),
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
              hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
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
            // Status notes and rate-limit frames the runtime sends before it
            // initializes (a resumed `/compact` does) are held and delivered
            // right after the initialized message, so a consumer still sees
            // the session initialize first and the notes in their own order.
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
                costBaseline = undefined;
                pendingCostInputs = Math.max(0, pendingCostInputs - 1);
                const total = message.totalCostUsd;
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
              send: ({ text, appManagedTools = [], onAppToolCall }) =>
                request(async () => {
                  if (appManagedTools.length > 0 || managedServer !== undefined) {
                    if (
                      query?.setMcpServers === undefined ||
                      (appManagedTools.length > 0 && onAppToolCall === undefined)
                    ) {
                      throw protocol("App tool transport is unavailable.");
                    }
                    const prepared =
                      appManagedTools.length === 0 || onAppToolCall === undefined
                        ? undefined
                        : createManagedMcpTools(appManagedTools, onAppToolCall);
                    if (prepared?.kind === "invalid")
                      throw protocol("App tool catalogue is invalid.");
                    const next = prepared?.server;
                    const previous = managedServer;
                    const previousNames = managedToolNames;
                    managedToolNames = appManagedTools.map((tool) => `mcp__octant__${tool.name}`);
                    try {
                      const result = await query.setMcpServers(
                        next === undefined
                          ? {}
                          : {
                              octant: { type: "sdk", name: "octant", instance: next },
                            },
                      );
                      if (Object.keys(result.errors).length > 0)
                        throw protocol("App tool transport could not connect.");
                      managedServer = next;
                      await previous?.close();
                    } catch (error) {
                      managedToolNames = previousNames;
                      await next?.close();
                      throw error;
                    }
                  }
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
                  return prompt.offer({
                    type: "user",
                    message: { role: "user", content: text },
                    parent_tool_use_id: null,
                    origin: { kind: "human" },
                    uuid: messageId,
                    session_id: initializedSessionId ?? announcedSessionId ?? "",
                  });
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
                Effect.sync(() => {
                  spawned?.kill("SIGKILL");
                }),
              interrupt: () =>
                request(async () => {
                  for (const message of prompt.clear()) issuedMessageIds.delete(message.uuid);
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
  };
}
