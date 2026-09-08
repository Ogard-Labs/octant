import { isAbsolute, join, resolve } from "node:path";
import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderFailure,
  decodeProviderModelId,
  decodeProviderProbeResult,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  rejectUnsupportedChatTurn,
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import {
  piToolCatalogAttestation,
  type PiProcessPort,
  type PiRpcConnection,
  type PiSessionMode,
} from "./piProcess";
import { PiRpcFailure, type PiRpcEvent, type PiRpcResponse } from "./piRpcClient";
import {
  createPiManagedToolsBridge,
  type PiManagedToolCall,
  type PiManagedToolAnswer,
  type PiManagedToolsBridge,
} from "./piManagedTools";
import { type ProviderRuntimeRegistry, trackProviderProcess } from "./providerRuntimeRegistry";

export interface PiClientPort {
  readonly request: (
    type: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => Promise<PiRpcResponse>;
  readonly respondToUi: (
    id: string,
    response: {
      readonly confirmed?: boolean;
      readonly value?: string;
      readonly cancelled?: boolean;
    },
  ) => Promise<void>;
  readonly onEvent: (listener: (event: PiRpcEvent) => void) => () => void;
}

export interface PiDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly piHome: string;
  readonly process: PiProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly clientFactory?: (connection: PiRpcConnection) => PiClientPort;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
}

interface ResumeIdentity {
  readonly root: string;
  readonly mode: PiSessionMode;
  readonly modelId: string;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
}

interface PendingApproval {
  readonly uiId: string;
  readonly toolCallId: string;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly modelId: string;
  readonly scope: Scope.CloseableScope;
  readonly client: PiClientPort;
  readonly removeEvent: () => void;
  readonly approvals: Map<string, PendingApproval>;
  readonly tools: Map<string, { terminal: boolean; answered: boolean; name: string }>;
  readonly toolNames: ReadonlySet<string>;
  readonly pendingTools: Map<string, PendingPiTool>;
  readonly managedTools?: PiManagedToolsBridge;
  correlationId: CorrelationId;
  sequence: number;
  promptActive: boolean;
  terminal: boolean;
  closed: boolean;
}

interface PendingPiTool {
  readonly controller: AbortController;
  readonly resolve: (answer: PiManagedToolAnswer) => void;
}

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "unsupported",
  reasoning: "supported",
  usage: "unavailable",
  toolActivity: "supported",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
} as const;
const MAX_REMEMBERED_TOOL_CALLS = 256;

const PROBE_TOOL_BRIDGE = {
  url: "http://127.0.0.1:1/octant/probe",
  token: "octant-probe",
} as const;
const PI_APP_MANAGED_TOOLS_VERSION = "0.85.1";

function capabilitiesFor(appManagedTools: "supported" | "unsupported") {
  return { ...capabilities, appManagedTools } as const;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function providerFailure(error: unknown): ProviderFailure {
  if (error instanceof PiRpcFailure) {
    if (error.kind === "protocol") return failure("protocol", "Pi RPC protocol failed.");
    if (error.kind === "timeout") return failure("unavailable", "Pi RPC request timed out.");
    if (error.kind === "closed") return failure("interrupted", "Pi RPC connection closed.");
  }
  try {
    return decodeProviderFailure(error);
  } catch {
    // Provider boundaries expose only normalized failures.
  }
  return failure("provider-failed", "Pi request failed.");
}

function request<A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({ try: operation, catch: providerFailure });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function bounded(value: unknown, maximum = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, maximum).join("");
}

function normalizeModels(response: PiRpcResponse) {
  const data = record(response.data);
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.flatMap((candidate) => {
    const model = record(candidate);
    const provider = bounded(model?.provider, 128);
    const id = bounded(model?.id, 256);
    if (provider === undefined || id === undefined) return [];
    const context = model?.contextWindow;
    return [
      {
        id: decodeProviderModelId(`${provider}/${id}`),
        displayName: bounded(model?.name, 256) ?? id,
        source: "discovered" as const,
        verification: "verified" as const,
        ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0
          ? { contextLimit: context }
          : {}),
        reasoning: model?.reasoning === false ? ("unsupported" as const) : ("supported" as const),
        inputModalities: textOnlyInputModalities,
        options: [],
      },
    ];
  });
}

function modelSelection(modelId: string): { provider: string; modelId: string } | undefined {
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) return undefined;
  return { provider: modelId.slice(0, separator), modelId: modelId.slice(separator + 1) };
}

function hasToolAttestation(
  response: PiRpcResponse,
  tools: ReadonlyArray<ProviderToolDefinition>,
): boolean {
  const commands = record(response.data)?.commands;
  if (!Array.isArray(commands)) return false;
  const expected = `Octant managed tool catalog ${piToolCatalogAttestation(tools)}`;
  return commands.some((candidate) => {
    const command = record(candidate);
    return (
      command?.name === "octant-tool-attestation" &&
      command.source === "extension" &&
      command.description === expected
    );
  });
}

function client(connection: PiRpcConnection): PiClientPort {
  return connection.rpc;
}

export function makePiDriver(options: PiDriverOptions): ProviderDriver {
  const clientFactory = options.clientFactory ?? client;
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? (() => crypto.randomUUID());
  const makeRequestId = options.requestId ?? (() => crypto.randomUUID());
  const resumeIdentities = new Map<string, ResumeIdentity>();
  let appManagedToolsVerified = false;

  return {
    kind: "pi",
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      appManagedToolsVerified = false;
      return Effect.gen(function* () {
        const sourceSessionId = `probe-${crypto.randomUUID()}`;
        const probeTool = {
          name: "octant_probe_tool",
          description: "Octant provider capability probe.",
          inputSchema: { type: "object", properties: {} },
        } satisfies ProviderToolDefinition;
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        const connection = yield* options.process.start({
          binaryPath: options.binaryPath,
          root: options.piHome,
          piHome: options.piHome,
          sessionDirectory: join(options.piHome, "sessions"),
          sessionId: sourceSessionId,
          mode: "chat",
          executionPolicy: "approval-gated",
          tools: [probeTool],
          toolBridge: PROBE_TOOL_BRIDGE,
          onProcessStarted: async (process) => {
            receipt = await options.runtimeRegistry.trackProcess(instanceId, process);
            return receipt;
          },
        });
        if (receipt === undefined) {
          yield* trackProviderProcess(options.runtimeRegistry, instanceId, connection);
        }
        const rpc = clientFactory(connection);
        const modelResponse = yield* request(() => rpc.request("get_available_models"));
        yield* request(() => rpc.request("get_state"));
        const attestation = yield* request(() =>
          rpc.request("get_commands", { expected: "octant-tool-attestation" }),
        );
        appManagedToolsVerified =
          connection.version === PI_APP_MANAGED_TOOLS_VERSION &&
          hasToolAttestation(attestation, [probeTool]);
        const models = normalizeModels(modelResponse);
        const observedAt = clock();
        const result = decodeProviderProbeResult({
          instanceId,
          readiness: models.length === 0 ? "degraded" : "ready",
          processState: "stopped",
          detectedVersion: connection.version,
          models,
          capabilities: capabilitiesFor(appManagedToolsVerified ? "supported" : "unsupported"),
          ...(models.length === 0
            ? { message: "Pi did not report an authenticated selectable model." }
            : {}),
          lastSuccessfulProbeAt: observedAt,
          observedAt,
        });
        options.runtimeRegistry.setObservedState(result);
        return result;
      });
    },
    acquire: ({ instanceId, projectRoot, mode }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      if (mode === undefined) {
        return Effect.fail(
          failure("invalid-configuration", "Pi requires an explicit product mode."),
        );
      }
      if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Provider Project root must be an absolute normalized path.",
          ),
        );
      }
      return makeConnection(options, projectRoot, mode, resumeIdentities, {
        clientFactory,
        clock,
        makeCorrelation,
        makeRequestId,
        appManagedTools: {
          get: () => appManagedToolsVerified,
          set: (verified) => {
            appManagedToolsVerified = verified;
          },
        },
      });
    },
  };
}

function makeConnection(
  options: PiDriverOptions,
  projectRoot: string,
  mode: PiSessionMode,
  resumeIdentities: Map<string, ResumeIdentity>,
  factories: {
    readonly clientFactory: (connection: PiRpcConnection) => PiClientPort;
    readonly clock: () => string;
    readonly makeCorrelation: () => string;
    readonly makeRequestId: () => string;
    readonly appManagedTools: {
      readonly get: () => boolean;
      readonly set: (verified: boolean) => void;
    };
  },
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const rememberedToolCalls = new Map<ProviderSessionId, Map<string, string>>();

    const emit = (state: SessionState, value: RuntimeEventWithoutEnvelope) => {
      const event = {
        ...value,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence: state.sequence++,
        correlationId: state.correlationId,
        occurredAt: factories.clock() as UtcTimestamp,
      } as ProviderRuntimeEvent;
      Effect.runFork(Queue.offer(queue, event));
    };

    const cancelPendingTools = (state: SessionState): void => {
      for (const pending of state.pendingTools.values()) {
        pending.controller.abort();
        pending.resolve({
          resultJson: JSON.stringify({ error: "tool-interrupted" }),
          isError: true,
        });
      }
      state.pendingTools.clear();
    };

    const rememberToolCall = (
      sessionId: ProviderSessionId,
      toolCallId: string,
      toolName: string,
    ): void => {
      const calls = rememberedToolCalls.get(sessionId) ?? new Map<string, string>();
      if (!calls.has(toolCallId) && calls.size >= MAX_REMEMBERED_TOOL_CALLS) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
      calls.set(toolCallId, toolName);
      rememberedToolCalls.set(sessionId, calls);
    };

    const closeState = async (state: SessionState) => {
      if (state.closed) return;
      state.closed = true;
      state.removeEvent();
      for (const approval of state.approvals.values()) {
        await state.client.respondToUi(approval.uiId, { confirmed: false }).catch(() => undefined);
      }
      state.approvals.clear();
      cancelPendingTools(state);
      await state.managedTools?.close().catch(() => undefined);
      await Effect.runPromise(Scope.close(state.scope, Exit.void));
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) - 1),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.all([...sessions.values()].map(closeState));
        sessions.clear();
        await Effect.runPromise(Queue.shutdown(queue));
      }),
    );

    const stateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<SessionState, ProviderFailure> => {
      const state = sessions.get(sessionId);
      return state === undefined || state.closed
        ? Effect.fail(failure("protocol", "Pi session is not active."))
        : Effect.succeed(state);
    };

    const protocolFailure = (state: SessionState, message: string) => {
      if (state.terminal) return;
      state.terminal = true;
      emit(state, { kind: "failed", failure: failure("protocol", message) });
    };

    const requestManagedTool = async (
      state: SessionState,
      call: PiManagedToolCall,
    ): Promise<PiManagedToolAnswer> => {
      if (
        state.closed ||
        state.terminal ||
        !state.toolNames.has(call.name) ||
        state.tools.get(call.toolCallId)?.name !== call.name ||
        state.tools.get(call.toolCallId)?.answered !== false ||
        state.tools.get(call.toolCallId)?.terminal === true
      ) {
        return { resultJson: JSON.stringify({ error: "tool-unavailable" }), isError: true };
      }
      const tool = state.tools.get(call.toolCallId);
      if (tool === undefined) {
        return { resultJson: JSON.stringify({ error: "tool-unavailable" }), isError: true };
      }
      tool.answered = true;
      if (call.signal.aborted) {
        tool.terminal = true;
        return { resultJson: JSON.stringify({ error: "tool-interrupted" }), isError: true };
      }
      const requestId = factories.makeRequestId();
      if (state.pendingTools.has(requestId)) {
        protocolFailure(state, "Pi app-managed tool request identity was repeated.");
        return { resultJson: JSON.stringify({ error: "tool-unavailable" }), isError: true };
      }
      const controller = new AbortController();
      const answer = new Promise<PiManagedToolAnswer>((resolveAnswer) => {
        const finish = (value: PiManagedToolAnswer) => {
          state.pendingTools.delete(requestId);
          call.signal.removeEventListener("abort", cancel);
          resolveAnswer(value);
        };
        const cancel = () => {
          controller.abort();
          finish({ resultJson: JSON.stringify({ error: "tool-interrupted" }), isError: true });
        };
        state.pendingTools.set(requestId, { controller, resolve: finish });
        call.signal.addEventListener("abort", cancel, { once: true });
        if (call.signal.aborted) cancel();
      });
      emit(state, {
        kind: "tool-request",
        requestId,
        toolName: call.name,
        inputJson: call.inputJson,
      });
      return answer;
    };

    const handleEvent = (state: SessionState, event: PiRpcEvent) => {
      if (state.closed) return;
      if (state.terminal && event.type !== "extension_ui_request") return;
      if (event.type === "message_update") {
        const update = record(event.assistantMessageEvent);
        const delta = typeof update?.delta === "string" ? update.delta : undefined;
        if (delta === undefined || delta.length === 0) return;
        if (update?.type === "text_delta") emit(state, { kind: "text-delta", text: delta });
        else if (update?.type === "thinking_delta") {
          emit(state, { kind: "reasoning-delta", text: delta });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        const toolCallId = bounded(event.toolCallId, 256);
        const toolName = bounded(event.toolName, 256);
        if (toolCallId === undefined || toolName === undefined || state.tools.has(toolCallId)) {
          return protocolFailure(state, "Pi tool start was invalid.");
        }
        state.tools.set(toolCallId, { terminal: false, answered: false, name: toolName });
        rememberToolCall(state.sessionId, toolCallId, toolName);
        emit(state, { kind: "tool-start", toolCallId, toolName });
        return;
      }
      if (event.type === "tool_execution_update") {
        const toolCallId = bounded(event.toolCallId, 256);
        const tool = toolCallId === undefined ? undefined : state.tools.get(toolCallId);
        if (toolCallId === undefined || tool === undefined || tool.terminal) {
          return protocolFailure(state, "Pi tool progress was invalid.");
        }
        emit(state, { kind: "tool-progress", toolCallId, message: "Tool is running." });
        return;
      }
      if (event.type === "tool_execution_end") {
        const toolCallId = bounded(event.toolCallId, 256);
        const tool = toolCallId === undefined ? undefined : state.tools.get(toolCallId);
        if (toolCallId === undefined || tool === undefined || tool.terminal) {
          return protocolFailure(state, "Pi tool completion was invalid.");
        }
        tool.terminal = true;
        if (event.isError === true) {
          emit(state, { kind: "tool-failure", toolCallId, message: "Tool failed." });
        } else emit(state, { kind: "tool-success", toolCallId, summary: "Tool completed." });
        return;
      }
      if (event.type === "extension_ui_request") {
        const uiId = bounded(event.id, 256);
        const title = bounded(event.title, 1024);
        const match = title?.match(/^Octant approval:([^:]+):([^:]+)$/);
        if (
          event.method !== "confirm" ||
          uiId === undefined ||
          match === undefined ||
          match === null
        ) {
          return protocolFailure(state, "Pi approval request was invalid.");
        }
        const toolCallId = match[1];
        const toolName = match[2];
        const tool = toolCallId === undefined ? undefined : state.tools.get(toolCallId);
        if (
          toolCallId === undefined ||
          tool === undefined ||
          tool.terminal ||
          toolName === undefined ||
          tool.name !== toolName
        ) {
          void state.client.respondToUi(uiId, { confirmed: false });
          return protocolFailure(state, "Pi approval correlation was invalid.");
        }
        if (!decidesCodeEffectsByApproval(state.executionPolicy)) {
          void state.client.respondToUi(uiId, { confirmed: false });
          return;
        }
        const requestId = factories.makeRequestId();
        if (state.approvals.has(requestId)) {
          void state.client.respondToUi(uiId, { confirmed: false });
          return protocolFailure(state, "Pi approval identity was repeated.");
        }
        state.approvals.set(requestId, { uiId, toolCallId });
        emit(state, {
          kind: "approval-request",
          requestId,
          action: toolName,
          description: `Allow Pi ${toolName} for this session?`,
        });
        return;
      }
      if (event.type === "agent_settled") {
        if (!state.promptActive)
          return protocolFailure(state, "Pi settled without an active turn.");
        state.promptActive = false;
        state.terminal = true;
        emit(state, {
          kind: "completed",
          resumeCursor: { driverKind: "pi", value: state.sessionId },
        });
        return;
      }
      if (event.type === "message_update") return;
      if (event.type === "extension_error") {
        return protocolFailure(state, "Pi approval bridge failed.");
      }
    };

    const createState = (input: {
      readonly sessionId: ProviderSessionId;
      readonly modelId: string;
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly tools: ReadonlyArray<ProviderToolDefinition>;
    }) =>
      request(async () => {
        const selection = modelSelection(input.modelId);
        if (selection === undefined)
          throw failure("invalid-configuration", "Pi model ID must include provider/model.");
        // Plan mode refuses browser effects and keeps provider egress closed,
        // so do not register an app-tool bridge that could never reach the
        // host without widening the sandbox network policy.
        const tools = input.executionPolicy === "plan" ? [] : input.tools;
        const scope = await Effect.runPromise(Scope.make());
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        let managedTools: PiManagedToolsBridge | undefined;
        let currentState: SessionState | undefined;
        try {
          if (tools.length > 0) {
            managedTools = await createPiManagedToolsBridge(tools, (call) => {
              if (currentState === undefined) {
                return Promise.resolve({
                  resultJson: JSON.stringify({ error: "tool-unavailable" }),
                  isError: true,
                });
              }
              return requestManagedTool(currentState, call);
            });
          }
          const processConnection = await Effect.runPromise(
            options.process
              .start({
                binaryPath: options.binaryPath,
                root: mode === "chat" ? options.piHome : projectRoot,
                piHome: options.piHome,
                sessionDirectory: join(options.piHome, "sessions"),
                sessionId: input.sessionId,
                mode,
                executionPolicy: input.executionPolicy,
                ...(tools.length === 0 ? {} : { tools }),
                ...(managedTools === undefined ? {} : { toolBridge: managedTools.config }),
                onProcessStarted: async (process) => {
                  receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
                  return receipt;
                },
              })
              .pipe(Effect.provideService(Scope.Scope, scope)),
          );
          if (tools.length > 0 && processConnection.version !== PI_APP_MANAGED_TOOLS_VERSION) {
            throw failure(
              "unsupported",
              `Pi ${processConnection.version} is not verified for app-managed tools.`,
            );
          }
          if (receipt === undefined) {
            await options.runtimeRegistry.trackProcess(options.instanceId, processConnection);
          }
          const rpc = factories.clientFactory(processConnection);
          await rpc.request("set_model", selection);
          const stateResponse = await rpc.request("get_state");
          const sourceSessionId = bounded(record(stateResponse.data)?.sessionId, 256);
          if (sourceSessionId === undefined)
            throw new PiRpcFailure("protocol", "Pi session identity missing.");
          if (tools.length > 0) {
            const attestation = await rpc.request("get_commands", {
              expected: "octant-tool-attestation",
            });
            if (!hasToolAttestation(attestation, tools)) {
              throw failure(
                "unsupported",
                "Pi runtime did not attest the app-managed tool catalog.",
              );
            }
            factories.appManagedTools.set(true);
          }
          const previous = sessions.get(input.sessionId);
          if (previous !== undefined) await closeState(previous);
          let state!: SessionState;
          const removeEvent = rpc.onEvent((event) => handleEvent(state, event));
          const priorToolCalls = rememberedToolCalls.get(input.sessionId) ?? new Map();
          state = {
            sessionId: input.sessionId,
            executionPolicy: input.executionPolicy,
            modelId: input.modelId,
            scope,
            client: rpc,
            removeEvent,
            approvals: new Map(),
            tools: new Map(
              [...priorToolCalls].map(([toolCallId, name]) => [
                toolCallId,
                { terminal: true, answered: true, name },
              ]),
            ),
            toolNames: new Set(tools.map((tool) => tool.name)),
            pendingTools: new Map(),
            ...(managedTools === undefined ? {} : { managedTools }),
            correlationId: factories.makeCorrelation() as CorrelationId,
            sequence: 1,
            promptActive: false,
            terminal: false,
            closed: false,
          };
          currentState = state;
          sessions.set(input.sessionId, state);
          resumeIdentities.set(input.sessionId, {
            root: projectRoot,
            mode,
            modelId: input.modelId,
            tools,
          });
          options.runtimeRegistry.setActiveSessionCount(
            options.instanceId,
            options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
          );
          const handleExit = async () => {
            if (state.closed) return;
            if (!state.terminal) {
              state.terminal = true;
              emit(state, {
                kind: "failed",
                failure: failure("interrupted", "Pi process disconnected."),
              });
            }
            await closeState(state);
            sessions.delete(state.sessionId);
          };
          void processConnection.exited.then(handleExit, handleExit);
          return state;
        } catch (error) {
          await managedTools?.close().catch(() => undefined);
          await Effect.runPromise(Scope.close(scope, Exit.void));
          throw error;
        }
      });

    return {
      toolRequestSignal: ({ sessionId, requestId }) =>
        sessions.get(sessionId)?.pendingTools.get(requestId)?.controller.signal ??
        AbortSignal.abort(),
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      start: (input) =>
        createState({ ...input, tools: input.tools ?? [] }).pipe(
          Effect.map(() => ({
            sessionId: input.sessionId,
            resumeCursor: { driverKind: "pi" as const, value: input.sessionId },
          })),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== "pi") {
          return Effect.fail(failure("stale-resume", "Pi resume identity is incompatible."));
        }
        const identity = resumeIdentities.get(input.resumeCursor.value);
        if (
          identity === undefined ||
          identity.root !== projectRoot ||
          identity.mode !== mode ||
          input.resumeCursor.value !== input.sessionId
        ) {
          return Effect.fail(
            failure("stale-resume", "Pi resume identity does not match this Project."),
          );
        }
        return createState({
          sessionId: input.sessionId,
          modelId: identity.modelId,
          executionPolicy: input.executionPolicy,
          tools: identity.tools,
        }).pipe(
          Effect.map(() => ({ sessionId: input.sessionId, resumeCursor: input.resumeCursor })),
          Effect.mapError(() => failure("stale-resume", "Pi session could not be resumed.")),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) =>
            rejectUnsupportedChatTurn(
              input,
              capabilitiesFor(factories.appManagedTools.get() ? "supported" : "unsupported"),
            ).pipe(
              Effect.flatMap(() => {
                if (state.terminal)
                  return Effect.fail(failure("protocol", "Pi session is terminal."));
                if (state.promptActive)
                  return Effect.fail(failure("protocol", "Pi already has an active turn."));
                state.promptActive = true;
                state.correlationId = factories.makeCorrelation() as CorrelationId;
                return request(() =>
                  state.client.request("prompt", { message: renderProviderTurnPrompt(input) }),
                ).pipe(
                  Effect.asVoid,
                  Effect.tapError(() => Effect.sync(() => (state.promptActive = false))),
                );
              }),
            ),
          ),
        ),
      interrupt: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            request(() => state.client.request("abort")).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!state.terminal) {
                    state.promptActive = false;
                    state.terminal = true;
                    cancelPendingTools(state);
                    emit(state, { kind: "interrupted", message: "Pi turn was interrupted." });
                  }
                }),
              ),
              Effect.asVoid,
            ),
          ),
        ),
      stop: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            Effect.promise(async () => {
              if (state.promptActive && !state.terminal) {
                await state.client.request("abort").catch(() => undefined);
              }
              await closeState(state);
              sessions.delete(sessionId);
            }),
          ),
        ),
      answerApproval: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const pending = state.approvals.get(input.requestId);
            if (pending === undefined) {
              return Effect.fail(failure("protocol", "Pi approval request is not pending."));
            }
            state.approvals.delete(input.requestId);
            if (!decidesCodeEffectsByApproval(state.executionPolicy) && input.approved) {
              return request(() =>
                state.client.respondToUi(pending.uiId, { confirmed: false }),
              ).pipe(
                Effect.zipRight(
                  Effect.fail(failure("unauthorized", "This mode cannot approve Pi actions.")),
                ),
              );
            }
            return request(() =>
              state.client.respondToUi(pending.uiId, { confirmed: input.approved }),
            );
          }),
        ),
      answerUserInput: () =>
        Effect.fail(failure("unsupported", "Pi does not expose provider user questions.")),
      answerTool: (input: ProviderToolAnswer) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const pending = state.pendingTools.get(input.requestId);
            if (pending === undefined) {
              return Effect.fail(
                failure("protocol", "Pi app-managed tool request is not pending."),
              );
            }
            pending.resolve({ resultJson: input.resultJson, isError: input.isError });
            return Effect.void;
          }),
        ),
    };
  });
}
