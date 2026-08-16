import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  type CorrelationId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderCapabilities,
  type ProviderInstanceId,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderTurnInput,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  attachmentMediaTypeToModality,
  renderProviderTurnPrompt,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option, Queue, Scope, Stream } from "effect";
import {
  mapCodexMessage,
  type CodexEventContext,
  type CodexPendingApproval,
} from "./codexEventMapper";
import type { CodexAppServerConnection, CodexProcessPort } from "./codexProcess";
import {
  decodeAccountReadResult,
  decodeModelListResult,
  decodeThreadResumeResult,
  decodeThreadStartResult,
  decodeTurnInterruptResult,
  decodeTurnStartResult,
  type CodexAccountReadResult,
  type CodexModelListResult,
  type CodexRpcId,
  type CodexServerMessage,
  type CodexThreadResult,
  type CodexTurnResult,
} from "./codexProtocol";
import { CodexRpcClientFailure } from "./codexRpcClient";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface CodexThreadStartInput {
  readonly cwd: string;
  readonly model: string;
  readonly approvalPolicy: "never" | "on-request";
  readonly sandbox: "danger-full-access" | "workspace-write" | "read-only";
}

export interface CodexThreadResumeInput {
  readonly threadId: string;
}

export type CodexTurnInputItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly url: string };

export interface CodexTurnStartInput {
  readonly threadId: string;
  readonly input: readonly CodexTurnInputItem[];
}

export interface CodexApprovalResponse {
  readonly providerRequestId: CodexRpcId;
  readonly result: unknown;
}

export interface CodexClientPort {
  accountRead(): Promise<CodexAccountReadResult>;
  modelList(cursor?: string): Promise<CodexModelListResult>;
  threadStart(input: CodexThreadStartInput): Promise<CodexThreadResult>;
  threadResume(input: CodexThreadResumeInput): Promise<CodexThreadResult>;
  turnStart(input: CodexTurnStartInput): Promise<CodexTurnResult>;
  turnInterrupt(input: { readonly threadId: string; readonly turnId: string }): Promise<void>;
  respondApproval(input: CodexApprovalResponse): Promise<void>;
  subscribe(listener: (message: CodexServerMessage) => void): () => void;
}

export interface CodexDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly process: CodexProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly clientFactory?: (connection: CodexAppServerConnection) => CodexClientPort;
  readonly permissionPersistence?: () => PermissionPersistence;
  readonly idleLeaseMs?: number;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
  readonly taskId?: () => string;
  readonly toolCallId?: () => string;
  readonly jitter?: (baseDelayMs: number) => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly modelId: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly threadId: string;
  readonly correlationId: CorrelationId;
  activeTurnId?: string;
  outputAccepted: boolean;
  terminal: boolean;
  active: boolean;
  context?: CodexEventContext;
  readonly pendingApprovals: Map<string, CodexPendingApproval>;
}

const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "unsupported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
} as const;

function codexChatCapabilities(
  models: ReadonlyArray<{ readonly inputModalities: ReadonlyArray<"text" | "image"> }>,
): ProviderCapabilities {
  return {
    ...capabilities,
    nativeAttachments: models.some((model) => model.inputModalities.includes("image"))
      ? "supported"
      : "unsupported",
  };
}

function codexTurnInput(input: ProviderTurnInput): readonly CodexTurnInputItem[] {
  const items: CodexTurnInputItem[] = [{ type: "text", text: renderProviderTurnPrompt(input) }];
  for (const attachment of input.attachments) {
    const modality = attachmentMediaTypeToModality(attachment.mediaType);
    if (modality !== "image") continue;
    const base64 = Buffer.from(attachment.bytes).toString("base64");
    items.push({
      type: "image",
      url: `data:${attachment.mediaType};base64,${base64}`,
    });
  }
  return items;
}

const MAX_MODEL_PAGES = 10;
const SATURATION_DELAYS_MS = [50, 100, 200] as const;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function providerFailure(error: unknown): ProviderFailure {
  if (typeof error === "object" && error !== null && "category" in error && "message" in error) {
    try {
      return decodeProviderFailure(error);
    } catch {
      return failure("protocol", "Codex returned an invalid failure.");
    }
  }
  if (error instanceof CodexRpcClientFailure) {
    if (error.kind === "protocol") {
      return failure("protocol", "Codex returned an invalid protocol response.");
    }
    if (error.kind === "closed") {
      return failure("interrupted", "Codex runtime closed unexpectedly.");
    }
  }
  return failure("provider-failed", "Codex request failed.");
}

function request<A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({ try: operation, catch: providerFailure });
}

export function codexExecutionSettings(
  policy: ProviderExecutionPolicy,
): Pick<CodexThreadStartInput, "approvalPolicy" | "sandbox"> {
  if (policy === "full-access") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (policy === "approval-gated" || policy === "auto-accept-edits") {
    // Codex confines writes to the workspace either way; which of those writes
    // Octant asks about is decided by the driver's approval handler (auto-accept
    // edits answers project-confined file changes itself), not by this mapping.
    return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
  return { approvalPolicy: "never", sandbox: "read-only" };
}

export function makeCodexClient(connection: CodexAppServerConnection): CodexClientPort {
  const { rpc } = connection;
  return {
    accountRead: () =>
      rpc.request("account/read", { refreshToken: false }, decodeAccountReadResult),
    modelList: (cursor) =>
      rpc.request(
        "model/list",
        { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        decodeModelListResult,
      ),
    threadStart: (input) => rpc.request("thread/start", input, decodeThreadStartResult),
    threadResume: (input) => rpc.request("thread/resume", input, decodeThreadResumeResult),
    turnStart: (input) => rpc.request("turn/start", input, decodeTurnStartResult),
    turnInterrupt: async (input) => {
      await rpc.request("turn/interrupt", input, decodeTurnInterruptResult);
    },
    respondApproval: async ({ providerRequestId, result }) => {
      await rpc.respond(providerRequestId, result);
    },
    subscribe: (listener) => {
      const removeNotification = rpc.onNotification(listener);
      const removeRequest = rpc.onRequest(listener);
      return () => {
        removeNotification();
        removeRequest();
      };
    },
  };
}

export function makeCodexDriver(options: CodexDriverOptions): ProviderDriver {
  const clientFactory = options.clientFactory ?? makeCodexClient;
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? (() => crypto.randomUUID());
  const makeRequestId = options.requestId ?? (() => crypto.randomUUID());
  const makeTaskId = options.taskId ?? (() => crypto.randomUUID());
  const makeToolCallId = options.toolCallId ?? (() => crypto.randomUUID());

  return {
    kind: "codex",
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.gen(function* () {
            const runtime = yield* acquireRuntime(options, clientFactory);
            const accountResult = yield* request(runtime.client.accountRead);
            const models = yield* readModels(runtime.client);
            return normalizeProbe(instanceId, runtime.version, accountResult, models, clock());
          }),
    acquire: ({ instanceId, projectRoot }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
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
      return Effect.gen(function* () {
        const runtime = yield* acquireRuntime(options, clientFactory);
        return yield* makeConnection(options, runtime.client, projectRoot, {
          instanceId: options.instanceId,
          clock,
          makeCorrelation,
          makeRequestId,
          makeTaskId,
          makeToolCallId,
        });
      });
    },
  };
}

function acquireRuntime(
  options: CodexDriverOptions,
  clientFactory: (connection: CodexAppServerConnection) => CodexClientPort,
) {
  return options.runtimeRegistry.acquireRuntime(options.instanceId, {
    idleMs: options.idleLeaseMs ?? 30_000,
    start: async () => {
      const scope = await Effect.runPromise(Scope.make());
      let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
      try {
        const processExit = await Effect.runPromiseExit(
          options.process
            .start({
              binaryPath: options.binaryPath,
              onProcessStarted: async (process) => {
                receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
                return receipt;
              },
            })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        if (Exit.isFailure(processExit)) {
          const typed = Option.getOrUndefined(Cause.failureOption(processExit.cause));
          throw typed ?? failure("provider-failed", "Codex runtime failed to start.");
        }
        const connection = processExit.value;
        return {
          value: { client: clientFactory(connection), version: connection.version },
          pid: connection.pid,
          ...(receipt === undefined ? {} : { receipt }),
          exited: connection.exited,
          close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      }
    },
  });
}

function readModels(
  client: CodexClientPort,
): Effect.Effect<ReadonlyArray<CodexModelListResult["data"][number]>, ProviderFailure> {
  return Effect.tryPromise({
    try: async () => {
      const models: CodexModelListResult["data"][number][] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const result = await client.modelList(cursor);
        models.push(...result.data);
        if (result.nextCursor === null) return models;
        if (cursors.has(result.nextCursor)) {
          throw failure("protocol", "Codex model pagination repeated a cursor.");
        }
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw failure("protocol", "Codex model pagination exceeded the supported bound.");
    },
    catch: providerFailure,
  });
}

function normalizeProbe(
  instanceId: ProviderInstanceId,
  version: string,
  accountResult: CodexAccountReadResult,
  sourceModels: ReadonlyArray<CodexModelListResult["data"][number]>,
  observedAt: string,
): ProviderProbeResult {
  const models = sourceModels
    .filter((source) => !source.hidden && source.id.trim().length > 0)
    .map((source) => {
      const reasoning = source.supportedReasoningEfforts
        .map(({ reasoningEffort }) => reasoningEffort.trim())
        .filter((value) => value.length > 0);
      const tiers = source.serviceTiers
        .map(({ id }) => id.trim())
        .filter((value) => value.length > 0);
      return {
        id: source.id as never,
        displayName: source.displayName.trim() || source.id,
        source: "discovered" as const,
        verification: "verified" as const,
        reasoning: reasoning.length > 0 ? ("supported" as const) : ("unsupported" as const),
        inputModalities:
          source.inputModalities.length > 0 ? [...source.inputModalities] : (["text"] as const),
        // The CLI reports a modality list per model; an empty list is no
        // report, so the capability stays absent (unknown) rather than
        // pretending text-only was observed.
        ...(source.inputModalities.length > 0
          ? {
              imageInput: source.inputModalities.includes("image")
                ? ("supported" as const)
                : ("unsupported" as const),
            }
          : {}),
        options: [
          ...(reasoning.length > 0
            ? [
                {
                  id: "reasoning",
                  displayName: "Reasoning",
                  kind: "selection" as const,
                  values: reasoning as [string, ...string[]],
                },
              ]
            : []),
          ...(tiers.length > 0
            ? [
                {
                  id: "service-tier",
                  displayName: "Service tier",
                  kind: "selection" as const,
                  values: tiers as [string, ...string[]],
                },
              ]
            : []),
        ],
      };
    });
  const ready =
    models.length > 0 && (accountResult.account !== null || !accountResult.requiresOpenaiAuth);
  return decodeProviderProbeResult({
    instanceId,
    readiness: ready ? "ready" : "unauthenticated",
    processState: "running",
    detectedVersion: version,
    models,
    capabilities: codexChatCapabilities(models),
    ...(ready
      ? { lastSuccessfulProbeAt: observedAt as UtcTimestamp }
      : { message: "Authenticate Codex and make at least one usable model available." }),
    observedAt: observedAt as UtcTimestamp,
  });
}

interface ConnectionFactories {
  readonly instanceId: ProviderInstanceId;
  readonly clock: () => string;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
  readonly makeTaskId: () => string;
  readonly makeToolCallId: () => string;
}

function makeConnection(
  options: CodexDriverOptions,
  client: CodexClientPort,
  projectRoot: string,
  factories: ConnectionFactories,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const sessionsByThread = new Map<string, SessionState>();
    const pendingApprovalOwners = new Map<string, ProviderSessionId>();
    let unsubscribe: (() => void) | undefined;
    let pendingLifecycleRegistrations = 0;

    const offer = (event: ProviderRuntimeEvent) => Effect.runFork(Queue.offer(queue, event));
    const activate = (state: SessionState) => {
      if (state.active) return;
      state.active = true;
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
      );
    };
    const deactivate = (state: SessionState) => {
      if (!state.active) return;
      state.active = false;
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) - 1),
      );
    };
    const clearPendingApprovals = (state: SessionState) => {
      for (const requestId of state.pendingApprovals.keys()) {
        if (pendingApprovalOwners.get(requestId) === state.sessionId) {
          pendingApprovalOwners.delete(requestId);
        }
      }
      state.pendingApprovals.clear();
    };
    const unsubscribeWhenIdle = () => {
      if (
        pendingLifecycleRegistrations > 0 ||
        [...sessions.values()].some(({ active }) => active)
      ) {
        return;
      }
      unsubscribe?.();
      unsubscribe = undefined;
    };
    const terminalEvent = (
      state: SessionState,
      value:
        | { readonly kind: "interrupted"; readonly message: string }
        | { readonly kind: "waiting"; readonly message: string }
        | { readonly kind: "failed"; readonly failure: ProviderFailure },
    ) => {
      if (state.terminal) return;
      state.terminal = true;
      clearPendingApprovals(state);
      deactivate(state);
      const context = state.context ?? makeEventContext(state, factories);
      offer({
        ...value,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence: context.sequence++,
        correlationId: state.correlationId,
        occurredAt: factories.clock() as UtcTimestamp,
      } as ProviderRuntimeEvent);
      unsubscribeWhenIdle();
    };
    const handleMessage = (message: CodexServerMessage) => {
      const state = stateForMessage(message, sessionsByThread, sessions);
      if (state === undefined || state.terminal) return;
      if (
        message.kind === "notification" &&
        message.method === "turn/started" &&
        state.activeTurnId === undefined
      ) {
        state.activeTurnId = message.params.turn.id;
        state.outputAccepted = true;
        state.context = makeEventContext(state, factories);
      }
      if (state.context === undefined) return;
      const mapped = mapCodexMessage(state.context, message);
      for (const item of mapped) {
        if (item.kind === "ignored") continue;
        if (item.kind === "protocol-failure") {
          terminalEvent(state, { kind: "failed", failure: item.failure });
          return;
        }
        if (item.kind === "approval") {
          state.outputAccepted = true;
          if (state.executionPolicy === "full-access") {
            terminalEvent(state, {
              kind: "failed",
              failure: failure(
                "protocol",
                "Codex requested approval while Full access was active.",
              ),
            });
            return;
          }
          if (
            state.executionPolicy === "plan" ||
            !approvalRequestIsProjectConfined(item.approval, state.projectRoot)
          ) {
            Effect.runFork(
              request(() =>
                client.respondApproval({
                  providerRequestId: item.approval.providerRequestId,
                  result: declinedApprovalResult(item.approval),
                }),
              ).pipe(
                Effect.catchAll((providerFailure) =>
                  Effect.sync(() =>
                    terminalEvent(state, { kind: "failed", failure: providerFailure }),
                  ),
                ),
              ),
            );
            continue;
          }
          if (
            state.executionPolicy === "auto-accept-edits" &&
            item.approval.kind === "file-change"
          ) {
            // Auto-accept edits waives exactly the project-confined file writes
            // proven above; commands and permission grants still ask.
            Effect.runFork(
              request(() =>
                client.respondApproval({
                  providerRequestId: item.approval.providerRequestId,
                  result: { decision: "accept" },
                }),
              ).pipe(
                Effect.catchAll((providerFailure) =>
                  Effect.sync(() =>
                    terminalEvent(state, { kind: "failed", failure: providerFailure }),
                  ),
                ),
              ),
            );
            continue;
          }
          if (pendingApprovalOwners.has(item.approval.requestId)) {
            terminalEvent(state, {
              kind: "failed",
              failure: failure("protocol", "Codex approval correlation was not unique."),
            });
            return;
          }
          state.pendingApprovals.set(item.approval.requestId, item.approval);
          pendingApprovalOwners.set(item.approval.requestId, state.sessionId);
          offer(item.approval.event);
          continue;
        }
        if (!isTerminal(item.event)) state.outputAccepted = true;
        offer(item.event);
        if (isTerminal(item.event)) {
          state.terminal = true;
          clearPendingApprovals(state);
          deactivate(state);
          unsubscribeWhenIdle();
          return;
        }
      }
    };
    const ensureSubscribed = () => {
      unsubscribe ??= client.subscribe(handleMessage);
    };
    const withPendingLifecycle = <A, E, R>(
      operation: () => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        pendingLifecycleRegistrations += 1;
        let finished = false;
        const finish = Effect.sync(() => {
          if (finished) return;
          finished = true;
          if (pendingLifecycleRegistrations > 0) pendingLifecycleRegistrations -= 1;
        });
        return operation().pipe(
          Effect.ensuring(finish),
          Effect.onError(() => Effect.sync(unsubscribeWhenIdle)),
        );
      });
    const removeInvalidation = options.runtimeRegistry.onRuntimeInvalidated(
      options.instanceId,
      () => {
        for (const state of sessions.values()) {
          if (state.terminal) continue;
          terminalEvent(
            state,
            state.activeTurnId === undefined
              ? { kind: "waiting", message: "Provider runtime exited; resume must be verified." }
              : { kind: "interrupted", message: "Provider runtime exited unexpectedly." },
          );
        }
      },
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        removeInvalidation();
        unsubscribe?.();
        unsubscribe = undefined;
        for (const state of sessions.values()) deactivate(state);
        sessions.clear();
        sessionsByThread.clear();
        pendingApprovalOwners.clear();
        Effect.runFork(Queue.shutdown(queue));
      }),
    );

    const stateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<SessionState, ProviderFailure> => {
      const state = sessions.get(sessionId);
      return state === undefined
        ? Effect.fail(failure("protocol", "Codex session is not active."))
        : Effect.succeed(state);
    };
    const register = (
      input: {
        readonly sessionId: ProviderSessionId;
        readonly executionPolicy: ProviderExecutionPolicy;
      },
      thread: CodexThreadResult,
      modelId: string,
    ) => {
      const previous = sessions.get(input.sessionId);
      if (previous !== undefined) {
        previous.terminal = true;
        clearPendingApprovals(previous);
        deactivate(previous);
        sessionsByThread.delete(previous.threadId);
      }
      const state: SessionState = {
        sessionId: input.sessionId,
        projectRoot,
        modelId,
        executionPolicy: input.executionPolicy,
        threadId: thread.thread.id,
        correlationId: factories.makeCorrelation() as CorrelationId,
        outputAccepted: false,
        terminal: false,
        active: false,
        pendingApprovals: new Map(),
      };
      sessions.set(input.sessionId, state);
      sessionsByThread.set(state.threadId, state);
      activate(state);
      return state;
    };

    return {
      events: Stream.fromQueue(queue).pipe(Stream.takeUntil(isTerminal)),
      start: (input) =>
        withPendingLifecycle(() =>
          Effect.gen(function* () {
            ensureSubscribed();
            const settings = codexExecutionSettings(input.executionPolicy);
            const thread = yield* request(() =>
              client.threadStart({
                cwd: projectRoot,
                model: input.modelId,
                ...settings,
              }),
            );
            if (
              !isAbsolute(thread.cwd) ||
              resolve(thread.cwd) !== thread.cwd ||
              thread.cwd !== projectRoot
            ) {
              return yield* Effect.fail(
                failure("unauthorized", "Codex thread belongs to a different Project root."),
              );
            }
            register(input, thread, input.modelId);
            return {
              sessionId: input.sessionId,
              resumeCursor: { driverKind: "codex" as const, value: thread.thread.id },
            };
          }),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== "codex") {
          return Effect.fail(
            failure("stale-resume", "Provider resume cursor does not belong to Codex."),
          );
        }
        return withPendingLifecycle(() =>
          Effect.gen(function* () {
            ensureSubscribed();
            const thread = yield* request(() =>
              client.threadResume({
                threadId: input.resumeCursor.value,
              }),
            ).pipe(
              Effect.mapError(() =>
                failure("stale-resume", "Codex thread is no longer available for resume."),
              ),
            );
            if (!isAbsolute(thread.cwd) || resolve(thread.cwd) !== projectRoot) {
              return yield* Effect.fail(
                failure("unauthorized", "Codex thread belongs to a different Project root."),
              );
            }
            register(input, thread, thread.model);
            return { sessionId: input.sessionId, resumeCursor: input.resumeCursor };
          }),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const observed = options.runtimeRegistry.observedState(options.instanceId);
            const model = observed?.models.find((candidate) => candidate.id === state.modelId);
            const rejected = validateChatTurnInput(
              input,
              observed?.capabilities ?? capabilities,
              model,
            );
            if (rejected !== undefined) return Effect.fail(rejected);
            if (state.terminal) {
              return Effect.fail(failure("protocol", "Codex session is already terminal."));
            }
            ensureSubscribed();
            return Effect.tryPromise({
              try: async () => {
                let lastError: unknown;
                for (let attempt = 0; attempt <= SATURATION_DELAYS_MS.length; attempt += 1) {
                  try {
                    const turn = await client.turnStart({
                      threadId: state.threadId,
                      input: codexTurnInput(input),
                    });
                    if (state.activeTurnId !== undefined && state.activeTurnId !== turn.turn.id) {
                      throw failure(
                        "protocol",
                        "Codex turn response did not match streamed output.",
                      );
                    }
                    state.activeTurnId = turn.turn.id;
                    state.context ??= makeEventContext(state, factories);
                    return;
                  } catch (error) {
                    lastError = error;
                    const retryable =
                      error instanceof CodexRpcClientFailure &&
                      error.kind === "saturated" &&
                      !state.outputAccepted &&
                      attempt < SATURATION_DELAYS_MS.length;
                    if (!retryable) break;
                    const base = SATURATION_DELAYS_MS[attempt]!;
                    await (options.sleep ?? defaultSleep)(base + (options.jitter?.(base) ?? 0));
                  }
                }
                if (state.outputAccepted) {
                  terminalEvent(state, {
                    kind: "failed",
                    failure: failure("provider-failed", "Codex turn failed after output began."),
                  });
                }
                throw lastError;
              },
              catch: providerFailure,
            });
          }),
        ),
      interrupt: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            state.activeTurnId === undefined
              ? Effect.fail(failure("protocol", "Codex session has no active turn."))
              : request(() =>
                  client.turnInterrupt({ threadId: state.threadId, turnId: state.activeTurnId! }),
                ),
          ),
        ),
      stop: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.tap((state) =>
            Effect.sync(() => {
              state.terminal = true;
              clearPendingApprovals(state);
              deactivate(state);
              sessions.delete(sessionId);
              sessionsByThread.delete(state.threadId);
              unsubscribeWhenIdle();
            }),
          ),
          Effect.asVoid,
        ),
      answerApproval: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            if (state.executionPolicy === "plan") {
              return Effect.fail(
                failure("unauthorized", "Plan mode cannot approve provider actions."),
              );
            }
            if (state.executionPolicy === "full-access") {
              return Effect.fail(
                failure("protocol", "Full access cannot have a pending approval request."),
              );
            }
            if (state.terminal) {
              return Effect.fail(failure("protocol", "Codex session is already terminal."));
            }
            const pending = state.pendingApprovals.get(input.requestId);
            if (
              pending === undefined ||
              pendingApprovalOwners.get(input.requestId) !== input.sessionId ||
              pending.threadId !== state.threadId ||
              pending.turnId !== state.activeTurnId ||
              state.context?.requestIds.get(pending.providerRequestId) !== input.requestId
            ) {
              return Effect.fail(
                failure("protocol", "Codex approval request is not pending for this turn."),
              );
            }
            state.pendingApprovals.delete(input.requestId);
            pendingApprovalOwners.delete(input.requestId);
            return request(() =>
              client.respondApproval({
                providerRequestId: pending.providerRequestId,
                result: approvalResult(pending, input.approved, permissionPersistence(options)),
              }),
            ).pipe(
              Effect.catchAll((providerFailure) =>
                Effect.sync(() =>
                  terminalEvent(state, {
                    kind: "waiting",
                    message: "Codex approval response failed; resume must be verified.",
                  }),
                ).pipe(Effect.zipRight(Effect.fail(providerFailure))),
              ),
            );
          }),
        ),
      answerUserInput: () =>
        Effect.fail(failure("unsupported", "Codex stable user questions are unsupported.")),
      answerTool: () => unsupportedAnswerTool(capabilities.appManagedTools),
    };
  });
}

function permissionPersistence(options: CodexDriverOptions): PermissionPersistence {
  try {
    return options.permissionPersistence?.() ?? "current-session";
  } catch {
    return "project-default";
  }
}

function approvalResult(
  pending: CodexPendingApproval,
  approved: boolean,
  persistence: PermissionPersistence,
): unknown {
  if (!approved) return declinedApprovalResult(pending);
  if (pending.kind === "permissions") {
    return {
      permissions: {
        ...(pending.permissions.network === null ? {} : { network: pending.permissions.network }),
        ...(pending.permissions.fileSystem === null
          ? {}
          : { fileSystem: pending.permissions.fileSystem }),
      },
      scope: "turn",
    };
  }
  return {
    decision: persistence === "current-session" ? "acceptForSession" : "accept",
  };
}

function declinedApprovalResult(pending: CodexPendingApproval): unknown {
  return pending.kind === "permissions"
    ? { permissions: {}, scope: "turn" }
    : { decision: "decline" };
}

function approvalRequestIsProjectConfined(
  pending: CodexPendingApproval,
  projectRoot: string,
): boolean {
  if (pending.kind === "command") {
    return (
      typeof pending.requestedCwd === "string" &&
      pathIsProjectConfined(pending.requestedCwd, projectRoot, projectRoot)
    );
  }
  if (pending.kind === "file-change") {
    return (
      pending.grantRoot == null ||
      pathIsProjectConfined(pending.grantRoot, projectRoot, projectRoot)
    );
  }
  if (pending.requestedCwd !== projectRoot) return false;
  const fileSystem = pending.permissions.fileSystem;
  if (fileSystem === null) return true;
  const legacyPaths = [...(fileSystem.read ?? []), ...(fileSystem.write ?? [])];
  if (legacyPaths.some((path) => !pathIsProjectConfined(path, projectRoot, pending.requestedCwd))) {
    return false;
  }
  return (fileSystem.entries ?? []).every(({ path }) => {
    if (path.type === "path") {
      return pathIsProjectConfined(path.path, projectRoot, pending.requestedCwd);
    }
    if (path.type === "glob_pattern") return false;
    if (path.value.kind !== "project_roots") return false;
    return (
      path.value.subpath === null ||
      pathIsProjectConfined(path.value.subpath, projectRoot, projectRoot)
    );
  });
}

function pathIsProjectConfined(path: string, projectRoot: string, cwd: string): boolean {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const fromRoot = relative(projectRoot, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function stateForMessage(
  message: CodexServerMessage,
  sessionsByThread: ReadonlyMap<string, SessionState>,
  sessions: ReadonlyMap<ProviderSessionId, SessionState>,
): SessionState | undefined {
  if (message.kind === "notification" || message.kind === "request") {
    return sessionsByThread.get(message.params.threadId);
  }
  const active = [...sessions.values()].filter(
    (state) => !state.terminal && state.context !== undefined,
  );
  return active.length === 1 ? active[0] : undefined;
}

function makeEventContext(state: SessionState, factories: ConnectionFactories): CodexEventContext {
  return {
    instanceId: factories.instanceId,
    sessionId: state.sessionId,
    correlationId: state.correlationId,
    occurredAt: factories.clock() as UtcTimestamp,
    projectRoot: state.projectRoot,
    threadId: state.threadId,
    turnId: state.activeTurnId!,
    sequence: state.context?.sequence ?? 1,
    terminal: false,
    requestIds: new Map(),
    agentMessages: new Map(),
    taskIds: new Map(),
    toolStates: new Map(),
    makeRequestId: factories.makeRequestId,
    makeTaskId: factories.makeTaskId,
    makeToolCallId: factories.makeToolCallId,
  };
}

function isTerminal(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "completed" ||
    event.kind === "interrupted" ||
    event.kind === "failed" ||
    event.kind === "waiting"
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
