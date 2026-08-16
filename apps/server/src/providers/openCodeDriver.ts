import { isAbsolute, resolve } from "node:path";
import {
  type CorrelationId,
  type PermissionPersistence,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderCapabilities,
  type ProviderInstanceId,
  type ProviderInputModality,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderTurnInput,
  type UtcTimestamp,
  decodeProviderFailure,
  decodeProviderProbeResult,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  renderProviderTurnPrompt,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Event, PermissionRuleset, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { Cause, Effect, Exit, Option, Queue, Scope, Stream } from "effect";
import { mapOpenCodeEvent } from "./openCodeEventMapper";
import type { OpenCodeProcessPort, OpenCodeServerConnection } from "./openCodeProcess";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface OpenCodeClientPort {
  readonly health: () => Promise<{ readonly healthy: true; readonly version: string }>;
  readonly providers: () => Promise<{
    readonly all: ReadonlyArray<Provider>;
    readonly connected: ReadonlyArray<string>;
  }>;
  readonly subscribe: (signal: AbortSignal) => Promise<AsyncIterable<Event>>;
  readonly createSession: (input: { readonly permission: PermissionRuleset }) => Promise<Session>;
  readonly getSession: (sessionId: string) => Promise<Session>;
  readonly prompt: (input: {
    readonly sessionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly prompt: string;
    readonly attachments?: ProviderTurnInput["attachments"];
  }) => Promise<void>;
  readonly abort: (sessionId: string) => Promise<void>;
  readonly replyPermission: (
    requestId: string,
    reply: "once" | "always" | "reject",
  ) => Promise<void>;
  readonly replyQuestion: (requestId: string, answer: string) => Promise<void>;
}

export interface OpenCodeDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly process: OpenCodeProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly clientFactory?: (
    server: OpenCodeServerConnection,
    projectRoot: string,
  ) => OpenCodeClientPort;
  readonly permissionPersistence?: () => PermissionPersistence;
  readonly idleLeaseMs?: number;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly correlationId: CorrelationId;
  nextSequence: number;
  terminal: boolean;
  active: boolean;
  readonly taskIds: Map<string, string>;
  readonly modelId: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvals: Set<string>;
  readonly questions: Set<string>;
}

const capabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "unsupported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
} as const;

function openCodeInputModalities(model: Provider["models"][string]): ProviderInputModality[] {
  const input = model.capabilities.input;
  const modalities: ProviderInputModality[] = [];
  if (input.text) modalities.push("text");
  if (input.image) modalities.push("image");
  if (input.audio) modalities.push("audio");
  if (input.pdf) modalities.push("document");
  return modalities.length > 0 ? modalities : ["text"];
}

function openCodeChatCapabilities(
  models: ReadonlyArray<{ readonly inputModalities: readonly ProviderInputModality[] }>,
): ProviderCapabilities {
  return {
    ...capabilities,
    nativeAttachments: models.some((model) =>
      model.inputModalities.some((modality) => modality !== "text"),
    )
      ? "supported"
      : "unsupported",
  };
}

function fail(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function request<A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({ try: operation, catch: providerFailure });
}

function resultData<A>(result: { readonly data: A | undefined }): A {
  if (result.data === undefined) throw new Error("OpenCode returned no response data.");
  return result.data;
}

export function openCodePromptParts(prompt: string, attachments: ProviderTurnInput["attachments"]) {
  const parts: Array<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "file";
        readonly mime: string;
        readonly filename: string;
        readonly url: string;
      }
  > = [{ type: "text", text: prompt }];
  for (const attachment of attachments) {
    const base64 = Buffer.from(attachment.bytes).toString("base64");
    parts.push({
      type: "file",
      mime: attachment.mediaType,
      filename: attachment.displayName,
      url: `data:${attachment.mediaType};base64,${base64}`,
    });
  }
  return parts;
}

export function makeOfficialOpenCodeClient(
  server: OpenCodeServerConnection,
  projectRoot: string,
): OpenCodeClientPort {
  const client = createOpencodeClient({
    baseUrl: server.url.toString(),
    directory: projectRoot,
    headers: { authorization: server.authorization },
  });
  return {
    health: async () => resultData(await client.global.health({ throwOnError: true })),
    providers: async () => resultData(await client.provider.list({}, { throwOnError: true })),
    subscribe: async (signal) =>
      (await client.event.subscribe({}, { throwOnError: true, signal })).stream,
    createSession: async ({ permission }) =>
      resultData(await client.session.create({ permission }, { throwOnError: true })),
    getSession: async (sessionId) =>
      resultData(await client.session.get({ sessionID: sessionId }, { throwOnError: true })),
    prompt: async ({ sessionId, providerId, modelId, prompt, attachments = [] }) => {
      await client.session.promptAsync(
        {
          sessionID: sessionId,
          model: { providerID: providerId, modelID: modelId },
          parts: openCodePromptParts(prompt, attachments),
        },
        { throwOnError: true },
      );
    },
    abort: async (sessionId) => {
      await client.session.abort({ sessionID: sessionId }, { throwOnError: true });
    },
    replyPermission: async (requestId, reply) => {
      await client.permission.reply({ requestID: requestId, reply }, { throwOnError: true });
    },
    replyQuestion: async (requestId, answer) => {
      await client.question.reply(
        { requestID: requestId, answers: [[answer]] },
        { throwOnError: true },
      );
    },
  };
}

export function makeOpenCodeDriver(options: OpenCodeDriverOptions): ProviderDriver {
  const clientFactory = options.clientFactory ?? makeOfficialOpenCodeClient;
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeCorrelation = options.correlationId ?? (() => crypto.randomUUID());
  return {
    kind: "opencode",
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(fail("invalid-configuration", "Provider instance does not match driver."))
        : Effect.gen(function* () {
            const projectRoot = resolve(process.cwd());
            const runtime = yield* acquireRuntime(options, projectRoot);
            const client = clientFactory(runtime, projectRoot);
            const health = yield* request(client.health);
            const providers = yield* request(client.providers);
            return normalizeOpenCodeProbe(instanceId, health, providers, clock());
          }),
    acquire: ({ instanceId, projectRoot }) =>
      instanceId !== options.instanceId
        ? Effect.fail(fail("invalid-configuration", "Provider instance does not match driver."))
        : Effect.gen(function* () {
            if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) {
              return yield* Effect.fail(
                fail(
                  "invalid-configuration",
                  "Provider Project root must be an absolute normalized path.",
                ),
              );
            }
            const runtime = yield* acquireRuntime(options, projectRoot);
            return yield* makeConnection(
              options,
              clientFactory(runtime, projectRoot),
              projectRoot,
              clock,
              makeCorrelation,
            );
          }),
  };
}

function acquireRuntime(options: OpenCodeDriverOptions, projectRoot: string) {
  return options.runtimeRegistry.acquireRuntime(options.instanceId, {
    idleMs: options.idleLeaseMs ?? 30_000,
    start: async () => {
      const scope = await Effect.runPromise(Scope.make());
      let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
      try {
        const serverExit = await Effect.runPromiseExit(
          options.process
            .start({
              binaryPath: options.binaryPath,
              cwd: projectRoot,
              onProcessStarted: async (process) => {
                receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
                return receipt;
              },
            })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        if (Exit.isFailure(serverExit)) {
          const typedFailure = Option.getOrUndefined(Cause.failureOption(serverExit.cause));
          throw (
            typedFailure ??
            fail("provider-failed", "OpenCode process failed without a typed provider failure.")
          );
        }
        const server = serverExit.value;
        const monitor = monitorProcessExit(server.pid);
        return {
          value: server,
          pid: server.pid,
          ...(receipt === undefined ? {} : { receipt }),
          exited: monitor.exited,
          close: async () => {
            monitor.cancel();
            await Effect.runPromise(Scope.close(scope, Exit.void));
          },
        };
      } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      }
    },
  });
}

function monitorProcessExit(pid: number): {
  readonly exited: Promise<void>;
  readonly cancel: () => void;
} {
  let cancel = () => undefined;
  const exited = new Promise<void>((resolveExit) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
        resolveExit();
      }
    }, 250);
    timer.unref();
    cancel = () => {
      clearInterval(timer);
      resolveExit();
    };
  });
  return { exited, cancel };
}

function makeConnection(
  options: OpenCodeDriverOptions,
  client: OpenCodeClientPort,
  projectRoot: string,
  clock: () => string,
  makeCorrelation: () => string,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessionsBySource = new Map<string, SessionState>();
    const sourceBySession = new Map<ProviderSessionId, string>();
    const pendingBySource = new Map<string, Event[]>();
    const subscriptionAbort = new AbortController();
    let subscriptionReady: Promise<void> | undefined;
    let streamFailure: ProviderFailure | undefined;

    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(Queue.offer(queue, event));
    };
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
    const emitInterrupted = (state: SessionState, message: string) => {
      if (state.terminal) return;
      state.terminal = true;
      deactivate(state);
      offer({
        kind: "interrupted",
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence: state.nextSequence++,
        correlationId: state.correlationId,
        occurredAt: clock() as UtcTimestamp,
        message,
      });
    };
    const removeInvalidation = options.runtimeRegistry.onRuntimeInvalidated(
      options.instanceId,
      () => {
        for (const state of sessionsBySource.values()) {
          emitInterrupted(state, "Provider runtime exited unexpectedly.");
        }
      },
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        removeInvalidation();
        for (const state of sessionsBySource.values()) deactivate(state);
        subscriptionAbort.abort();
        Effect.runFork(Queue.shutdown(queue));
      }),
    );

    const failStream = () => {
      if (subscriptionAbort.signal.aborted || streamFailure !== undefined) return;
      streamFailure = fail("protocol", "Provider event stream ended unexpectedly.");
      for (const state of sessionsBySource.values()) {
        if (state.terminal) continue;
        state.terminal = true;
        deactivate(state);
        offer({
          kind: "failed",
          instanceId: options.instanceId,
          sessionId: state.sessionId,
          sequence: state.nextSequence++,
          correlationId: state.correlationId,
          occurredAt: clock() as UtcTimestamp,
          failure: streamFailure,
        });
      }
    };

    const ensureSubscription = () =>
      request(async () => {
        if (subscriptionReady === undefined) {
          subscriptionReady = client.subscribe(subscriptionAbort.signal).then((events) => {
            void (async () => {
              try {
                for await (const event of events) {
                  const sourceId = sourceSessionId(event);
                  if (sourceId === undefined) continue;
                  const state = sessionsBySource.get(sourceId);
                  if (state === undefined) {
                    const pending = pendingBySource.get(sourceId) ?? [];
                    if (
                      pending.length < 64 &&
                      (pendingBySource.has(sourceId) || pendingBySource.size < 64)
                    ) {
                      pending.push(event);
                      pendingBySource.set(sourceId, pending);
                    }
                  } else {
                    mapAndOffer(state, event, options.instanceId, clock, offer, deactivate);
                  }
                }
              } finally {
                failStream();
              }
            })().catch(() => undefined);
          });
        }
        await subscriptionReady;
      });

    const stateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<[string, SessionState], ProviderFailure> => {
      const source = sourceBySession.get(sessionId);
      const state = source === undefined ? undefined : sessionsBySource.get(source);
      return source === undefined || state === undefined
        ? Effect.fail(fail("protocol", "Provider session is not active."))
        : Effect.succeed([source, state]);
    };
    const usableStateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<[string, SessionState], ProviderFailure> =>
      streamFailure === undefined ? stateFor(sessionId) : Effect.fail(streamFailure);

    return {
      events: Stream.fromQueue(queue).pipe(Stream.takeUntil(isTerminalEvent)),
      start: (input) =>
        ensureSubscription().pipe(
          Effect.flatMap(() =>
            streamFailure === undefined
              ? request(() =>
                  client.createSession({ permission: permissionRules(input.executionPolicy) }),
                )
              : Effect.fail(streamFailure),
          ),
          Effect.flatMap((session) => {
            if (streamFailure !== undefined) {
              return request(() => client.abort(session.id)).pipe(
                Effect.ignore,
                Effect.zipRight(Effect.fail(streamFailure)),
              );
            }
            const state = newSessionState(
              input.sessionId,
              input.modelId,
              input.executionPolicy,
              makeCorrelation,
            );
            sessionsBySource.set(session.id, state);
            sourceBySession.set(input.sessionId, session.id);
            activate(state);
            for (const event of pendingBySource.get(session.id) ?? []) {
              mapAndOffer(state, event, options.instanceId, clock, offer, deactivate);
            }
            pendingBySource.delete(session.id);
            return Effect.succeed({
              sessionId: input.sessionId,
              resumeCursor: { driverKind: "opencode" as const, value: session.id },
            });
          }),
        ),
      resume: (input) =>
        input.resumeCursor.driverKind !== "opencode"
          ? Effect.fail(fail("stale-resume", "Provider resume cursor does not belong to OpenCode."))
          : ensureSubscription().pipe(
              Effect.flatMap(() =>
                request(() => client.getSession(input.resumeCursor.value)).pipe(
                  Effect.mapError(() =>
                    fail("stale-resume", "Provider resume session is no longer available."),
                  ),
                ),
              ),
              Effect.flatMap((session) =>
                !isAbsolute(session.directory) || resolve(session.directory) !== projectRoot
                  ? Effect.fail(
                      fail("stale-resume", "Provider session belongs to a different Project root."),
                    )
                  : Effect.succeed(session),
              ),
              Effect.flatMap((session) => {
                if (streamFailure !== undefined) return Effect.fail(streamFailure);
                const resumedModel =
                  session.model === undefined
                    ? "unknown/unknown"
                    : `${session.model.providerID}/${session.model.id}`;
                const priorSource = sourceBySession.get(input.sessionId);
                const priorState =
                  priorSource === undefined ? undefined : sessionsBySource.get(priorSource);
                if (priorState !== undefined) {
                  priorState.terminal = true;
                  deactivate(priorState);
                }
                const state = newSessionState(
                  input.sessionId,
                  resumedModel,
                  input.executionPolicy,
                  makeCorrelation,
                );
                sessionsBySource.set(session.id, state);
                sourceBySession.set(input.sessionId, session.id);
                activate(state);
                for (const event of pendingBySource.get(session.id) ?? []) {
                  mapAndOffer(state, event, options.instanceId, clock, offer, deactivate);
                }
                pendingBySource.delete(session.id);
                return Effect.succeed({
                  sessionId: input.sessionId,
                  resumeCursor: input.resumeCursor,
                });
              }),
            ),
      send: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([source]) => {
            const state = sessionsBySource.get(source)!;
            const observed = options.runtimeRegistry.observedState(options.instanceId);
            const model = observed?.models.find((candidate) => candidate.id === state.modelId);
            const rejected = validateChatTurnInput(
              input,
              observed?.capabilities ?? capabilities,
              model,
            );
            if (rejected !== undefined) return Effect.fail(rejected);
            return Effect.try({
              try: () => splitModelId(state.modelId),
              catch: providerFailure,
            }).pipe(
              Effect.flatMap((modelSelection) =>
                request(() =>
                  client.prompt({
                    sessionId: source,
                    providerId: modelSelection.providerId,
                    modelId: modelSelection.modelId,
                    prompt: renderProviderTurnPrompt(input),
                    attachments: input.attachments,
                  }),
                ),
              ),
            );
          }),
        ),
      interrupt: (sessionId) =>
        usableStateFor(sessionId).pipe(
          Effect.flatMap(([source]) => request(() => client.abort(source))),
        ),
      stop: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap(([source, state]) =>
            request(() => client.abort(source)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  state.terminal = true;
                  deactivate(state);
                }),
              ),
            ),
          ),
        ),
      answerApproval: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([, state]) =>
            state.executionPolicy === "plan"
              ? Effect.fail(fail("unauthorized", "Plan mode cannot approve provider actions."))
              : !state.approvals.has(input.requestId)
                ? Effect.fail(fail("protocol", "Provider approval request is not pending."))
                : request(() =>
                    client.replyPermission(
                      input.requestId,
                      input.approved
                        ? (options.permissionPersistence?.() ?? "current-session") ===
                          "project-default"
                          ? "always"
                          : "once"
                        : "reject",
                    ),
                  ).pipe(
                    Effect.tap(() => Effect.sync(() => state.approvals.delete(input.requestId))),
                  ),
          ),
        ),
      answerUserInput: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([, state]) =>
            !state.questions.has(input.requestId)
              ? Effect.fail(fail("protocol", "Provider question request is not pending."))
              : request(() => client.replyQuestion(input.requestId, input.answer)).pipe(
                  Effect.tap(() => Effect.sync(() => state.questions.delete(input.requestId))),
                ),
          ),
        ),
      answerTool: () => unsupportedAnswerTool(capabilities.appManagedTools),
    };
  });
}

function newSessionState(
  sessionId: ProviderSessionId,
  modelId: string,
  executionPolicy: ProviderExecutionPolicy,
  makeCorrelation: () => string,
): SessionState {
  return {
    sessionId,
    correlationId: makeCorrelation() as CorrelationId,
    nextSequence: 1,
    terminal: false,
    active: false,
    taskIds: new Map(),
    modelId,
    executionPolicy,
    approvals: new Set(),
    questions: new Set(),
  };
}

function stableTaskIdentity(
  state: SessionState,
  event: ProviderRuntimeEvent,
  occurrence: number,
): ProviderRuntimeEvent {
  if (event.kind !== "task-progress") return event;
  const key = `${event.summary}\u0000${occurrence}`;
  let taskId = state.taskIds.get(key);
  if (taskId === undefined) {
    taskId = `task-${state.taskIds.size + 1}`;
    state.taskIds.set(key, taskId);
  }
  return { ...event, taskId };
}

function mapAndOffer(
  state: SessionState,
  event: Event,
  instanceId: ProviderInstanceId,
  clock: () => string,
  offer: (event: ProviderRuntimeEvent) => void,
  deactivate: (state: SessionState) => void,
): void {
  if (state.terminal) return;
  const mapped = mapOpenCodeEvent(
    {
      instanceId,
      sessionId: state.sessionId,
      sequenceStart: state.nextSequence,
      correlationId: state.correlationId,
      occurredAt: clock() as UtcTimestamp,
    },
    event,
  );
  const taskOccurrences = new Map<string, number>();
  for (const original of mapped) {
    const occurrence =
      original.kind === "task-progress" ? (taskOccurrences.get(original.summary) ?? 0) : 0;
    if (original.kind === "task-progress") {
      taskOccurrences.set(original.summary, occurrence + 1);
    }
    const normalized = stableTaskIdentity(state, original, occurrence);
    if (normalized.kind === "approval-request") state.approvals.add(normalized.requestId);
    if (normalized.kind === "user-input-request") state.questions.add(normalized.requestId);
    if (isTerminalEvent(normalized)) {
      state.terminal = true;
      deactivate(state);
    }
    state.nextSequence = normalized.sequence + 1;
    offer(normalized);
  }
}

function permissionRules(policy: ProviderExecutionPolicy): PermissionRuleset {
  if (policy === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  }
  if (policy === "auto-accept-edits") {
    // Edits inside the bound directory proceed; everything else still asks,
    // and reach outside the directory stays denied outright.
    return [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  }
  if (policy === "approval-gated") {
    return [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "todowrite", pattern: "*", action: "deny" },
  ];
}

function splitModelId(value: string): { providerId: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) {
    throw fail("invalid-configuration", "Provider model identity is invalid.");
  }
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function normalizeOpenCodeProbe(
  instanceId: ProviderInstanceId,
  health: { readonly version: string },
  providers: { readonly all: ReadonlyArray<Provider>; readonly connected: ReadonlyArray<string> },
  observedAt: string,
): ProviderProbeResult {
  const connected = new Set(providers.connected);
  const models = providers.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: `${provider.id}/${model.id}` as never,
        displayName: model.name,
        source: "discovered" as const,
        verification: "verified" as const,
        ...(model.limit.context > 0 ? { contextLimit: model.limit.context } : {}),
        reasoning: model.capabilities.reasoning ? ("supported" as const) : ("unsupported" as const),
        inputModalities: openCodeInputModalities(model),
        // OpenCode reports per-model input capabilities as booleans, so image
        // support and its absence are both observed facts.
        imageInput: model.capabilities.input.image
          ? ("supported" as const)
          : ("unsupported" as const),
        options:
          model.variants === undefined || Object.keys(model.variants).length === 0
            ? []
            : [
                {
                  id: "reasoning",
                  displayName: "Reasoning",
                  kind: "selection" as const,
                  values: Object.keys(model.variants) as [string, ...string[]],
                },
              ],
      })),
    );
  return decodeProviderProbeResult({
    instanceId,
    readiness: models.length > 0 ? "ready" : "unauthenticated",
    processState: "running",
    detectedVersion: health.version,
    models,
    capabilities: openCodeChatCapabilities(models),
    ...(models.length === 0 ? { message: "Authenticate OpenCode with a provider." } : {}),
    ...(models.length > 0 ? { lastSuccessfulProbeAt: observedAt as UtcTimestamp } : {}),
    observedAt: observedAt as UtcTimestamp,
  });
}

export function providerFailure(error: unknown): ProviderFailure {
  if (typeof error === "object" && error !== null && "category" in error && "message" in error) {
    try {
      return decodeProviderFailure(error);
    } catch {
      return fail("protocol", "OpenCode returned an invalid failure.");
    }
  }
  if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
    return fail("unauthenticated", "OpenCode provider authentication is required.");
  }
  return fail("provider-failed", "OpenCode request failed.");
}

export function sourceSessionId(event: Event): string | undefined {
  const properties = event.properties as { readonly sessionID?: unknown };
  return typeof properties.sessionID === "string" && properties.sessionID.length > 0
    ? properties.sessionID
    : undefined;
}

export function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}
