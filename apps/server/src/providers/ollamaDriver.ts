import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderFailure,
  decodeProviderProbeResult,
  type OllamaHistorySnapshot,
  type OllamaProviderConfiguration,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  renderProviderTurnPrompt,
  unsupportedAnswerTool,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Effect, PubSub, Stream } from "effect";
import {
  makeOllamaEndpoint,
  probeOllama,
  sendOllamaChat,
  type OllamaFetch,
  type OllamaHistoryMessage,
  type OllamaHttpLimits,
  type OllamaTurnEvent,
} from "./ollamaEndpoint";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { MemoryOllamaHistoryStore, type OllamaHistoryStore } from "./ollamaHistoryStore";

export interface OllamaDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly configuration: OllamaProviderConfiguration;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly fetch?: OllamaFetch;
  readonly limits?: Partial<OllamaHttpLimits>;
  readonly historyStore?: OllamaHistoryStore;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly root: string;
  readonly mode: "chat" | "work" | "code";
  readonly history: OllamaHistoryMessage[];
  correlationId: CorrelationId;
  sequence: number;
  abortController: AbortController | undefined;
  inFlight: Promise<void> | undefined;
  terminal: boolean;
  active: boolean;
}

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function sanitizeFailure(error: unknown): ProviderFailure {
  try {
    return decodeProviderFailure(error);
  } catch {
    return failure("provider-failed", "The Ollama request failed.");
  }
}

export function makeOllamaDriver(options: OllamaDriverOptions): ProviderDriver {
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? randomUUID;
  const endpoint = makeOllamaEndpoint({
    baseUrl: options.configuration.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const historyStore = options.historyStore ?? new MemoryOllamaHistoryStore();

  return {
    kind: "ollama",
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          const observed = await probeOllama(endpoint);
          const observedAt = clock() as UtcTimestamp;
          const result = decodeProviderProbeResult({
            instanceId,
            readiness: observed.readiness,
            processState: "stopped",
            detectedVersion: observed.version,
            models: observed.models,
            capabilities: observed.capabilities,
            ...(observed.models.length === 0
              ? { message: "Ollama is reachable but has no installed models." }
              : {}),
            lastSuccessfulProbeAt: observedAt,
            observedAt,
          });
          options.runtimeRegistry.setObservedState(result);
          return result;
        },
        catch: sanitizeFailure,
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
          failure("invalid-configuration", "Ollama requires an explicit product mode."),
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
      return makeConnection(
        options,
        endpoint,
        projectRoot,
        mode,
        historyStore,
        clock,
        makeCorrelation,
      );
    },
  };
}

function makeConnection(
  options: OllamaDriverOptions,
  endpoint: ReturnType<typeof makeOllamaEndpoint>,
  root: string,
  mode: "chat" | "work" | "code",
  historyStore: OllamaHistoryStore,
  clock: () => string,
  makeCorrelation: () => string,
): Effect.Effect<ProviderConnection, never, import("effect").Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();

    const emit = (state: SessionState, value: RuntimeEventWithoutEnvelope) => {
      const event = {
        ...value,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence: state.sequence++,
        correlationId: state.correlationId,
        occurredAt: clock() as UtcTimestamp,
      } as ProviderRuntimeEvent;
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

    const release = (state: SessionState) => {
      state.abortController = undefined;
      state.inFlight = undefined;
      state.history.length = 0;
      deactivate(state);
      if (sessions.get(state.sessionId) === state) sessions.delete(state.sessionId);
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const state of sessions.values()) state.abortController?.abort();
        await Promise.allSettled(
          [...sessions.values()].flatMap((state) =>
            state.inFlight === undefined ? [] : [state.inFlight],
          ),
        );
        for (const state of sessions.values()) release(state);
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(events));
      }),
    );

    const stateFor = (sessionId: ProviderSessionId): SessionState => {
      const state = sessions.get(sessionId);
      if (state === undefined || !state.active) {
        throw failure("protocol", "Ollama session is not active.");
      }
      return state;
    };

    const createState = (
      sessionId: ProviderSessionId,
      modelId: ProviderModelId,
      history: readonly OllamaHistoryMessage[],
    ) => {
      if (sessions.has(sessionId)) throw failure("protocol", "Ollama session is already active.");
      const state: SessionState = {
        sessionId,
        modelId,
        root,
        mode,
        history: history.map((message) => ({ ...message })),
        correlationId: makeCorrelation() as CorrelationId,
        sequence: 1,
        abortController: undefined,
        inFlight: undefined,
        terminal: false,
        active: true,
      };
      sessions.set(sessionId, state);
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
      );
      return state;
    };

    const snapshot = (
      sessionId: ProviderSessionId,
      modelId: ProviderModelId,
      history: readonly OllamaHistoryMessage[],
    ): OllamaHistorySnapshot => ({
      instanceId: options.instanceId,
      sessionId,
      root,
      mode,
      modelId,
      history: history.map((message) => ({ ...message })),
    });

    const mapTurnEvent = (state: SessionState, event: OllamaTurnEvent) => {
      if (
        event.kind === "text-delta" ||
        event.kind === "reasoning-delta" ||
        event.kind === "usage"
      ) {
        emit(state, event);
        return;
      }
      emit(state, { kind: "tool-start", toolCallId: event.toolCallId, toolName: event.toolName });
      emit(state, {
        kind: "tool-failure",
        toolCallId: event.toolCallId,
        message: "Ollama requested a tool, but native tool execution is unavailable.",
      });
    };

    const finishFailure = (state: SessionState, providerFailure: ProviderFailure) => {
      if (state.terminal) return;
      state.terminal = true;
      if (providerFailure.category === "interrupted") {
        emit(state, { kind: "interrupted", message: "The Ollama turn was interrupted." });
      } else emit(state, { kind: "failed", failure: providerFailure });
    };

    const recordTurnCapabilities = (result: Awaited<ReturnType<typeof sendOllamaChat>>) => {
      const observed = options.runtimeRegistry.observedState(options.instanceId);
      if (observed === undefined) return;
      options.runtimeRegistry.setObservedState(
        decodeProviderProbeResult({
          ...observed,
          capabilities: {
            ...observed.capabilities,
            streaming: "supported",
            usage: result.usage === undefined ? "unsupported" : "supported",
            reasoning: result.reasoning.length > 0 ? "supported" : observed.capabilities.reasoning,
            toolActivity:
              result.toolRequests.length > 0 ? "supported" : observed.capabilities.toolActivity,
          },
          observedAt: clock() as UtcTimestamp,
        }),
      );
    };

    return {
      events: Stream.fromPubSub(events),
      start: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (sessions.has(input.sessionId)) {
              throw failure("protocol", "Ollama session is already active.");
            }
            if ((await historyStore.load(input.sessionId)) !== undefined) {
              throw failure(
                "protocol",
                "Ollama session history already exists; resume it explicitly.",
              );
            }
            await historyStore.save(snapshot(input.sessionId, input.modelId, []));
            createState(input.sessionId, input.modelId, []);
            return {
              sessionId: input.sessionId,
              resumeCursor: { driverKind: "ollama" as const, value: input.sessionId },
            };
          },
          catch: sanitizeFailure,
        }),
      resume: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (
              input.resumeCursor.driverKind !== "ollama" ||
              input.resumeCursor.value !== input.sessionId
            ) {
              throw failure("stale-resume", "Ollama resume identity is incompatible.");
            }
            const restored = await historyStore.load(input.sessionId);
            if (
              restored === undefined ||
              restored.instanceId !== options.instanceId ||
              restored.sessionId !== input.sessionId ||
              restored.root !== root ||
              restored.mode !== mode
            ) {
              throw failure("stale-resume", "Ollama resume identity does not match this Project.");
            }
            createState(input.sessionId, restored.modelId, restored.history);
            return { sessionId: input.sessionId, resumeCursor: input.resumeCursor };
          },
          catch: (error) => {
            const decoded = sanitizeFailure(error);
            return decoded.category === "stale-resume"
              ? decoded
              : failure("stale-resume", "Ollama history could not be resumed.");
          },
        }),
      send: (input) =>
        Effect.try({
          try: () => {
            const state = stateFor(input.sessionId);
            if (state.terminal) throw failure("protocol", "Ollama session is terminal.");
            if (state.inFlight !== undefined)
              throw failure("protocol", "Ollama already has an active turn.");
            const observed = options.runtimeRegistry.observedState(options.instanceId);
            const model = observed?.models.find((candidate) => candidate.id === state.modelId);
            const chatCapabilities = observed?.capabilities ?? {
              nativeAttachments: "unsupported",
              appManagedTools: "unsupported",
            };
            const rejected = validateChatTurnInput(input, chatCapabilities, model);
            if (rejected !== undefined) throw rejected;
            const controller = new AbortController();
            const priorHistory = state.history.map((message) => ({ ...message }));
            const prompt = renderProviderTurnPrompt(input);
            state.abortController = controller;
            state.correlationId = makeCorrelation() as CorrelationId;
            const turn = sendOllamaChat(endpoint, {
              modelId: state.modelId,
              history: priorHistory,
              prompt,
              attachments: input.attachments.map((attachment) => ({
                mediaType: attachment.mediaType,
                bytes: attachment.bytes,
              })),
              signal: controller.signal,
              onEvent: (event) => mapTurnEvent(state, event),
            })
              .then(async (result) => {
                if (state.terminal) return;
                if (result.doneReason === "length") {
                  return finishFailure(
                    state,
                    failure("provider-failed", "Ollama returned an incomplete response."),
                  );
                }
                recordTurnCapabilities(result);
                if (result.toolRequests.length > 0) {
                  return finishFailure(
                    state,
                    failure(
                      "provider-failed",
                      "Ollama requested a tool, but Octant tool execution is unavailable.",
                    ),
                  );
                }
                if (result.text.length === 0) {
                  return finishFailure(
                    state,
                    failure("provider-failed", "Ollama completed without assistant text."),
                  );
                }
                const nextHistory = [
                  ...priorHistory,
                  { role: "user" as const, text: prompt },
                  { role: "assistant" as const, text: result.text },
                ].slice(-endpoint.limits.maximumHistoryMessages);
                await historyStore.save(snapshot(state.sessionId, state.modelId, nextHistory));
                state.history.splice(0, state.history.length, ...nextHistory);
                state.terminal = true;
                emit(state, {
                  kind: "completed",
                  resumeCursor: { driverKind: "ollama", value: state.sessionId },
                });
              })
              .catch((error) => finishFailure(state, sanitizeFailure(error)))
              .finally(() => {
                state.inFlight = undefined;
                state.abortController = undefined;
              });
            state.inFlight = turn;
          },
          catch: sanitizeFailure,
        }),
      interrupt: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = stateFor(sessionId);
            if (state.inFlight === undefined || state.abortController === undefined) {
              throw failure("protocol", "Ollama session has no active turn.");
            }
            state.abortController.abort();
            await state.inFlight;
            release(state);
          },
          catch: sanitizeFailure,
        }),
      stop: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const state = sessions.get(sessionId);
            if (state === undefined) return;
            state.abortController?.abort();
            if (state.inFlight !== undefined) await state.inFlight;
            release(state);
          },
          catch: sanitizeFailure,
        }),
      answerApproval: () =>
        Effect.fail(failure("unsupported", "Ollama does not provide native approval requests.")),
      answerUserInput: () =>
        Effect.fail(failure("unsupported", "Ollama does not provide native user questions.")),
      answerTool: () =>
        unsupportedAnswerTool(
          options.runtimeRegistry.observedState(options.instanceId)?.capabilities.appManagedTools ??
            "unsupported",
        ),
    };
  });
}
