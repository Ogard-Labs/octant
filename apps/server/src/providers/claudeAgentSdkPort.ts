import {
  listSessions as listClaudeSessions,
  query as queryClaude,
  type Options as ClaudeSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { Effect, Stream, type Scope } from "effect";

import {
  decodeAccount,
  decodeInitialization,
  decodeInterruptReceipt,
  decodeMessage,
  decodeModels,
  decodeSessions,
  failure,
  permissionMode,
  protocol,
  sanitizeFailure,
} from "./claudeAgentSdkDecoder";
import { BoundedAsyncInput, makeClaudeCloseCoordinator } from "./claudeAgentSdkLifecycle";
import type { ClaudeProcessPort } from "./claudeProcess";

export type ClaudePermissionMode = "default" | "bypassPermissions" | "plan";

export type ClaudeToolDecision =
  | { readonly behavior: "allow"; readonly updatedInput?: Readonly<Record<string, unknown>> }
  | { readonly behavior: "deny"; readonly message: string; readonly interrupt?: boolean };

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
    readonly allowRead: readonly [string];
    readonly allowWrite: readonly [string];
  };
}

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export function isClaudeEffortLevel(value: string): value is ClaudeEffortLevel {
  return (CLAUDE_EFFORT_LEVELS as ReadonlyArray<string>).includes(value);
}

export interface ClaudeOpenQueryInput {
  readonly binaryPath: string;
  readonly projectRoot: string;
  readonly authEnvironment: Readonly<Record<string, string | undefined>>;
  readonly model: string;
  /** Agent SDK `effort` for the session; absent means the SDK default. */
  readonly effort?: ClaudeEffortLevel;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly resumeSessionId?: string;
  readonly tools: readonly string[];
  readonly sandbox?: ClaudeSandboxSettings;
  readonly canUseTool: (request: ClaudeToolRequest) => Promise<ClaudeToolDecision>;
  readonly preToolUse: (request: ClaudePreToolRequest) => Promise<ClaudeToolDecision>;
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
      readonly model: string;
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
      readonly permissionDenials: readonly {
        readonly toolName: string;
        readonly toolUseId: string;
      }[];
    }
  | {
      readonly kind: "tool-progress";
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
    }
  | { readonly kind: "ignored" };

export interface ClaudeUserMessage {
  readonly text: string;
}

export interface ClaudeQueryPort {
  readonly initialization: ClaudeInitialization;
  readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>;
  readonly send: (message: ClaudeUserMessage) => Effect.Effect<void, ProviderFailure>;
  readonly interrupt: () => Effect.Effect<void, ProviderFailure>;
  readonly setPermissionMode: (mode: ClaudePermissionMode) => Effect.Effect<void, ProviderFailure>;
  readonly supportedModels: () => Effect.Effect<readonly ClaudeModelInfo[], ProviderFailure>;
  readonly accountInfo: () => Effect.Effect<ClaudeAccountState, ProviderFailure>;
  readonly close: () => Effect.Effect<void>;
}

export interface ClaudeAgentSdkPort {
  readonly openQuery: (
    input: ClaudeOpenQueryInput,
  ) => Effect.Effect<ClaudeQueryPort, ProviderFailure, Scope.Scope>;
  readonly findSession: (input: {
    readonly sessionId: string;
    readonly projectRoot: string;
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
    readonly permissionDecision: "allow" | "deny";
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

interface ClaudeAgentSdkInvocationOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly model: string;
  readonly effort?: ClaudeEffortLevel;
  readonly pathToClaudeCodeExecutable: string;
  readonly resume?: string;
  readonly permissionMode: ClaudePermissionMode;
  readonly allowDangerouslySkipPermissions?: true;
  readonly settingSources: readonly [];
  readonly skills: readonly [];
  readonly mcpServers: Readonly<Record<string, never>>;
  readonly strictMcpConfig: true;
  readonly additionalDirectories: readonly [];
  readonly tools: readonly string[];
  readonly agents: Readonly<Record<string, never>>;
  readonly plugins: readonly [];
  readonly includePartialMessages: true;
  readonly sandbox?: ClaudeSandboxSettings;
  readonly spawnClaudeCodeProcess: ClaudeProcessPort["spawn"];
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
  readonly interrupt: () => Promise<unknown>;
  readonly setPermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
  readonly initializationResult: () => Promise<unknown>;
  readonly supportedModels: () => Promise<unknown>;
  readonly accountInfo: () => Promise<unknown>;
  readonly close: () => void;
}

export interface ClaudeAgentSdkBridge {
  readonly query: (input: ClaudeAgentSdkQueryInvocation) => ClaudeAgentSdkQueryLike;
  readonly listSessions: (options: { readonly dir: string }) => Promise<unknown>;
}

export interface ClaudeAgentSdkPortOptions {
  readonly spawnClaudeCodeProcess: ClaudeProcessPort["spawn"];
  readonly sdk?: ClaudeAgentSdkBridge;
  readonly inputCapacity?: number;
}

const DEFAULT_INPUT_CAPACITY = 1;
const SANDBOX_KEYS = [
  "allowUnsandboxedCommands",
  "autoAllowBashIfSandboxed",
  "enabled",
  "failIfUnavailable",
  "filesystem",
] as const;
const SANDBOX_FILESYSTEM_KEYS = ["allowRead", "allowWrite", "denyRead"] as const;

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
    if (!hasExactKeys(input.sandbox, SANDBOX_KEYS)) return false;
    if (
      input.sandbox.enabled !== true ||
      input.sandbox.failIfUnavailable !== true ||
      input.sandbox.autoAllowBashIfSandboxed !== false ||
      input.sandbox.allowUnsandboxedCommands !== false ||
      !hasExactKeys(input.sandbox.filesystem, SANDBOX_FILESYSTEM_KEYS)
    ) {
      return false;
    }
    return (
      isExactPathTuple(input.sandbox.filesystem.denyRead, "/") &&
      isExactPathTuple(input.sandbox.filesystem.allowRead, input.projectRoot) &&
      isExactPathTuple(input.sandbox.filesystem.allowWrite, input.projectRoot)
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
      const { sandbox, ...baseOptions } = invocation.options;
      const options: ClaudeSdkOptions = {
        ...baseOptions,
        settingSources: [...invocation.options.settingSources],
        skills: [...invocation.options.skills],
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
      const expectedMode = permissionMode(input.executionPolicy);
      const acquire = Effect.tryPromise({
        try: async () => {
          const prompt = new BoundedAsyncInput<ClaudeAgentSdkInputMessage>(inputCapacity);
          const issuedMessageIds = new Set<string>();
          let query: ClaudeAgentSdkQueryLike | undefined;
          let initializedSessionId: string | undefined;
          const closeCoordinator = makeClaudeCloseCoordinator(
            () => prompt.close(),
            () => query?.close(),
          );
          try {
            const canUseTool: ClaudeAgentSdkInvocationOptions["canUseTool"] = async (
              toolName,
              toolInput,
              callback,
            ) => {
              if (initializedSessionId === undefined) {
                return { behavior: "deny", message: "Claude session is not initialized." };
              }
              if (callback.agentID !== undefined) {
                return { behavior: "deny", message: "Claude subagent tool use is unavailable." };
              }
              if (requestsUnavailableBackgroundTool(toolName, toolInput)) {
                return {
                  behavior: "deny",
                  message: "Claude background tool use is unavailable.",
                };
              }
              if (!input.tools.includes(toolName)) {
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
                if (hookInput.agent_id !== undefined || hookInput.agent_type !== undefined) {
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
                if (!input.tools.includes(hookInput.tool_name)) {
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
                      : decision.updatedInput === undefined
                        ? {}
                        : { updatedInput: { ...decision.updatedInput } }),
                  },
                };
              };
            const invocationOptions: ClaudeAgentSdkInvocationOptions = {
              cwd: input.projectRoot,
              env: { ...input.authEnvironment },
              model: input.model,
              ...(input.effort === undefined ? {} : { effort: input.effort }),
              pathToClaudeCodeExecutable: input.binaryPath,
              ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
              permissionMode: expectedMode,
              ...(input.executionPolicy === "full-access"
                ? { allowDangerouslySkipPermissions: true }
                : {}),
              settingSources: [],
              skills: [],
              mcpServers: {},
              strictMcpConfig: true,
              additionalDirectories: [],
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
                    },
                  }),
              spawnClaudeCodeProcess: options.spawnClaudeCodeProcess,
              canUseTool,
              hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
            };
            query = sdk.query({ prompt, options: invocationOptions });
            const initialization = decodeInitialization(await query.initializationResult());
            const iterator = query[Symbol.asyncIterator]();
            const first = await iterator.next();
            if (first.done) throw protocol("Claude did not initialize its runtime stream.");
            const initialized = decodeMessage(first.value, input, { kind: "initializing" });
            if (initialized.kind !== "initialized") {
              throw protocol("Claude returned an unsupported runtime message.");
            }
            initializedSessionId = initialized.sessionId;
            const hasInterruptReceipt = initialized.capabilities.includes("interrupt_receipt_v1");
            const remaining: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => iterator };
            const remainingMessages = Stream.fromAsyncIterable(remaining, () =>
              failure("provider-failed", "Claude message stream failed."),
            ).pipe(
              Stream.mapEffect((message) =>
                Effect.try({
                  try: () =>
                    decodeMessage(message, input, {
                      kind: "active",
                      sessionId: initializedSessionId!,
                    }),
                  catch: (error) => sanitizeFailure(error, "message decoding"),
                }),
              ),
            );
            const decodedMessages = Stream.concat(Stream.succeed(initialized), remainingMessages);
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
              messages,
              send: ({ text }) =>
                request(() => {
                  const messageId = crypto.randomUUID();
                  issuedMessageIds.add(messageId);
                  return prompt.offer({
                    type: "user",
                    message: { role: "user", content: text },
                    parent_tool_use_id: null,
                    origin: { kind: "human" },
                    uuid: messageId,
                    session_id: initializedSessionId!,
                  });
                }, "input delivery"),
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
              close: () => Effect.promise(closeCoordinator.closeWithRetry),
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
    findSession: ({ sessionId, projectRoot }) =>
      Effect.tryPromise({
        try: async () => {
          const sessions = decodeSessions(
            await sdk.listSessions({ dir: projectRoot }),
            projectRoot,
          );
          return sessions.find((session) => session.sessionId === sessionId);
        },
        catch: (error) => sanitizeFailure(error, "session lookup"),
      }),
  };
}
