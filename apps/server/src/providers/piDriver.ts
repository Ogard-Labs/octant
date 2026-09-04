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
} from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  rejectUnsupportedChatTurn,
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import type { PiProcessPort, PiRpcConnection, PiSessionMode } from "./piProcess";
import { PiRpcFailure, type PiRpcEvent, type PiRpcResponse } from "./piRpcClient";
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
  readonly tools: Map<string, { terminal: boolean }>;
  correlationId: CorrelationId;
  sequence: number;
  promptActive: boolean;
  terminal: boolean;
  closed: boolean;
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

function client(connection: PiRpcConnection): PiClientPort {
  return connection.rpc;
}

export function makePiDriver(options: PiDriverOptions): ProviderDriver {
  const clientFactory = options.clientFactory ?? client;
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? (() => crypto.randomUUID());
  const makeRequestId = options.requestId ?? (() => crypto.randomUUID());
  const resumeIdentities = new Map<string, ResumeIdentity>();

  return {
    kind: "pi",
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      return Effect.gen(function* () {
        const sourceSessionId = `probe-${crypto.randomUUID()}`;
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        const connection = yield* options.process.start({
          binaryPath: options.binaryPath,
          root: options.piHome,
          piHome: options.piHome,
          sessionDirectory: join(options.piHome, "sessions"),
          sessionId: sourceSessionId,
          mode: "chat",
          executionPolicy: "approval-gated",
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
        const models = normalizeModels(modelResponse);
        const observedAt = clock();
        const result = decodeProviderProbeResult({
          instanceId,
          readiness: models.length === 0 ? "degraded" : "ready",
          processState: "stopped",
          detectedVersion: connection.version,
          models,
          capabilities,
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
  },
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();

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

    const closeState = async (state: SessionState) => {
      if (state.closed) return;
      state.closed = true;
      state.removeEvent();
      for (const approval of state.approvals.values()) {
        await state.client.respondToUi(approval.uiId, { confirmed: false }).catch(() => undefined);
      }
      state.approvals.clear();
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
        state.tools.set(toolCallId, { terminal: false });
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
          toolName === undefined
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
    }) =>
      request(async () => {
        const selection = modelSelection(input.modelId);
        if (selection === undefined)
          throw failure("invalid-configuration", "Pi model ID must include provider/model.");
        const scope = await Effect.runPromise(Scope.make());
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        try {
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
                onProcessStarted: async (process) => {
                  receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
                  return receipt;
                },
              })
              .pipe(Effect.provideService(Scope.Scope, scope)),
          );
          if (receipt === undefined) {
            await options.runtimeRegistry.trackProcess(options.instanceId, processConnection);
          }
          const rpc = factories.clientFactory(processConnection);
          await rpc.request("set_model", selection);
          const stateResponse = await rpc.request("get_state");
          const sourceSessionId = bounded(record(stateResponse.data)?.sessionId, 256);
          if (sourceSessionId === undefined)
            throw new PiRpcFailure("protocol", "Pi session identity missing.");
          const previous = sessions.get(input.sessionId);
          if (previous !== undefined) await closeState(previous);
          let state!: SessionState;
          const removeEvent = rpc.onEvent((event) => handleEvent(state, event));
          state = {
            sessionId: input.sessionId,
            executionPolicy: input.executionPolicy,
            modelId: input.modelId,
            scope,
            client: rpc,
            removeEvent,
            approvals: new Map(),
            tools: new Map(),
            correlationId: factories.makeCorrelation() as CorrelationId,
            sequence: 1,
            promptActive: false,
            terminal: false,
            closed: false,
          };
          sessions.set(input.sessionId, state);
          resumeIdentities.set(input.sessionId, {
            root: projectRoot,
            mode,
            modelId: input.modelId,
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
          await Effect.runPromise(Scope.close(scope, Exit.void));
          throw error;
        }
      });

    return {
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      start: (input) =>
        createState(input).pipe(
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
        }).pipe(
          Effect.map(() => ({ sessionId: input.sessionId, resumeCursor: input.resumeCursor })),
          Effect.mapError(() => failure("stale-resume", "Pi session could not be resumed.")),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) =>
            rejectUnsupportedChatTurn(input, capabilities).pipe(
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
      answerTool: () => unsupportedAnswerTool(capabilities.appManagedTools),
    };
  });
}
