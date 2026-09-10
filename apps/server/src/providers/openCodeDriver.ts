import { OpenCodeMessageParts } from "./openCodeMessageParts";
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
  type ProviderToolDefinition,
  type ProviderTurnInput,
  type UtcTimestamp,
  decodeProviderFailure,
  decodeProviderProbeResult,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  renderProviderTurnPrompt,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Event, PermissionRuleset, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { Cause, Effect, Exit, Option, PubSub, Scope, Stream } from "effect";
import { mapOpenCodeEvent } from "./openCodeEventMapper";
import type { ManagedToolAnswer, ManagedToolCallContext } from "./managedMcpTools";
import {
  createOpenCodeManagedToolsBridge,
  type OpenCodeManagedToolsBridge,
} from "./openCodeManagedTools";
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
    readonly permission: PermissionRuleset;
  }) => Promise<void>;
  readonly addMcpServer: (input: { readonly name: string; readonly url: string }) => Promise<void>;
  readonly disconnectMcpServer: (name: string) => Promise<void>;
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
  readonly messageParts: OpenCodeMessageParts;
  modelId: string;
  sourceId: string | undefined;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvals: Set<string>;
  readonly questions: Set<string>;
  readonly toolNames: Set<string>;
  readonly pendingToolAnswers: Map<string, PendingToolAnswer>;
  managedTools: ManagedToolsLease | undefined;
}

interface PendingToolAnswer {
  readonly controller: AbortController;
  readonly resolve: (answer: ManagedToolAnswer) => void;
}

interface ManagedToolsLease {
  readonly bridge: OpenCodeManagedToolsBridge;
  readonly serverName: string;
  readonly catalogKey: string;
  /** The bridge survives a same-process resume; route calls to the live session. */
  readonly owner: { state: SessionState };
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
  harnessAutoReview: "unsupported",
  ...unsupportedChatCapabilities,
  appManagedTools: "unsupported",
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
  isolatedConfiguration: boolean,
): ProviderCapabilities {
  return {
    ...capabilities,
    nativeAttachments: models.some((model) =>
      model.inputModalities.some((modality) => modality !== "text"),
    )
      ? "supported"
      : "unsupported",
    appManagedTools: isolatedConfiguration ? "supported" : "unsupported",
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

const BETA_API_TIMEOUT_MS = 5_000;
const BETA_INCOMPATIBILITY_MESSAGE =
  "OpenCode 2 preview is discovery-only: its API cannot carry Octant's session permission rules yet.";
const MCP_PROBE_TIMEOUT_MS = 5_000;

function betaRequestOptions() {
  return { throwOnError: true as const, signal: AbortSignal.timeout(BETA_API_TIMEOUT_MS) };
}

function awaitOpenCodeMcpAttestation(bridge: OpenCodeManagedToolsBridge): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), MCP_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    void bridge.attested.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(false);
      },
    );
  });
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
  const beta = server.runtime === "beta";
  const client = createOpencodeClient({
    baseUrl: server.url.toString(),
    directory: projectRoot,
    headers: { authorization: server.authorization },
  });
  return {
    health: async () =>
      beta
        ? {
            ...resultData(await client.v2.health.get(betaRequestOptions())),
            version: server.version ?? "unknown",
          }
        : resultData(await client.global.health({ throwOnError: true })),
    providers: async () => {
      if (beta) throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      return resultData(await client.provider.list({}, { throwOnError: true }));
    },
    subscribe: async (signal) =>
      beta
        ? (() => {
            throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
          })()
        : (await client.event.subscribe({}, { throwOnError: true, signal })).stream,
    createSession: async ({ permission }) =>
      beta
        ? (() => {
            throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
          })()
        : resultData(await client.session.create({ permission }, { throwOnError: true })),
    getSession: async (sessionId) =>
      beta
        ? (() => {
            throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
          })()
        : resultData(await client.session.get({ sessionID: sessionId }, { throwOnError: true })),
    prompt: async ({ sessionId, providerId, modelId, prompt, attachments = [], permission }) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
      await client.session.update(
        { sessionID: sessionId, permission },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      );
      await client.session.promptAsync(
        {
          sessionID: sessionId,
          model: { providerID: providerId, modelID: modelId },
          parts: openCodePromptParts(prompt, attachments),
        },
        { throwOnError: true },
      );
    },
    addMcpServer: async ({ name, url }) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
      await client.mcp.add(
        {
          directory: projectRoot,
          name,
          config: { type: "remote", url, enabled: true, oauth: false },
        },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      );
    },
    disconnectMcpServer: async (name) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
      await client.mcp.disconnect(
        { name, directory: projectRoot },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      );
    },
    abort: async (sessionId) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
      await client.session.abort(
        { sessionID: sessionId },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      );
    },
    replyPermission: async (requestId, reply) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
      await client.permission.reply({ requestID: requestId, reply }, { throwOnError: true });
    },
    replyQuestion: async (requestId, answer) => {
      if (beta) {
        throw fail("incompatible", BETA_INCOMPATIBILITY_MESSAGE);
      }
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
  const resumeToolCatalogs = new Map<string, ReadonlyArray<ProviderToolDefinition>>();
  return {
    kind: "opencode",
    probe: ({ instanceId }) =>
      instanceId !== options.instanceId
        ? Effect.fail(fail("invalid-configuration", "Provider instance does not match driver."))
        : Effect.gen(function* () {
            const projectRoot = resolve(process.cwd());
            // Probe the app-owned transport with an empty, private catalogue.
            // This is a non-generating declaration check: it does not send a
            // model prompt and its bridge is closed before the probe scope
            // returns. Linux intentionally skips it because bwrap cannot
            // express the exact loopback-only rule required by the bridge.
            const bridge =
              process.platform === "darwin"
                ? yield* Effect.acquireRelease(
                    Effect.tryPromise({
                      try: () =>
                        createOpenCodeManagedToolsBridge([], async () => ({
                          resultJson: '{"error":"probe-only"}',
                          isError: true,
                        })),
                      catch: () => fail("unavailable", "OpenCode MCP probe bridge is unavailable."),
                    }),
                    (ownedBridge) => Effect.promise(() => ownedBridge.close()),
                  )
                : undefined;
            const runtime = yield* acquireRuntime(
              options,
              projectRoot,
              bridge === undefined ? [] : [bridge.port],
            );
            const client = clientFactory(runtime, projectRoot);
            const health = yield* request(client.health);
            const providers = yield* request(client.providers);
            const mcpAccepted =
              bridge === undefined
                ? false
                : yield* Effect.tryPromise({
                    try: async () => {
                      const name = `octant-probe-${crypto.randomUUID().replaceAll("-", "")}`;
                      try {
                        await client.addMcpServer({ name, url: bridge.url });
                        const attested = await awaitOpenCodeMcpAttestation(bridge);
                        await client.disconnectMcpServer(name);
                        return attested;
                      } catch {
                        return false;
                      }
                    },
                    catch: () => false,
                  }).pipe(Effect.orDie);
            const normalized = normalizeOpenCodeProbe(
              instanceId,
              health,
              providers,
              clock(),
              runtime.isolatedConfiguration === true && mcpAccepted,
            );
            if (
              process.platform === "linux" &&
              normalized.models.length > 0 &&
              normalized.capabilities.appManagedTools === "unsupported"
            ) {
              return {
                ...normalized,
                message:
                  "OpenCode app-managed tools require macOS loopback confinement on this host.",
              };
            }
            return normalized;
          }),
    acquire: ({ instanceId, projectRoot, mode }) =>
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
            return yield* makeConnection(
              options,
              clientFactory,
              projectRoot,
              mode ?? "code",
              clock,
              makeCorrelation,
              resumeToolCatalogs,
            );
          }),
  };
}

function acquireRuntime(
  options: OpenCodeDriverOptions,
  projectRoot: string,
  loopbackPorts: ReadonlyArray<number> = [],
) {
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
              mode: "chat",
              executionPolicy: "plan",
              ...(loopbackPorts.length === 0 ? {} : { loopbackPorts }),
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
  clientFactory: NonNullable<OpenCodeDriverOptions["clientFactory"]>,
  projectRoot: string,
  mode: "chat" | "work" | "code",
  clock: () => string,
  makeCorrelation: () => string,
  resumeToolCatalogs: Map<string, ReadonlyArray<ProviderToolDefinition>>,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessionsBySource = new Map<string, SessionState>();
    const sourceBySession = new Map<ProviderSessionId, string>();
    const pendingBySource = new Map<string, Event[]>();
    const subscriptionAbort = new AbortController();
    let subscriptionReady: Promise<void> | undefined;
    let streamFailure: ProviderFailure | undefined;
    let sessionSetupInFlight = false;
    let closing = false;
    let client: OpenCodeClientPort | undefined;
    let runtimeScope: Scope.CloseableScope | undefined;
    let processMonitor: { readonly exited: Promise<void>; readonly cancel: () => void } | undefined;
    let runtimePolicy: ProviderExecutionPolicy | undefined;
    let runtimeIsolated = false;
    let runtimeLoopbackPorts: ReadonlyArray<number> = [];

    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(events, event));
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
    const managedToolReleases = new Map<SessionState, Promise<void>>();
    const releaseManagedTools = async (state: SessionState): Promise<void> => {
      const inFlight = managedToolReleases.get(state);
      if (inFlight !== undefined) return inFlight;
      const lease = state.managedTools;
      if (lease === undefined) return;
      state.managedTools = undefined;
      const release = (async () => {
        await lease.bridge.close();
        await client?.disconnectMcpServer(lease.serverName).catch(() => undefined);
      })();
      managedToolReleases.set(state, release);
      try {
        await release;
      } finally {
        if (managedToolReleases.get(state) === release) managedToolReleases.delete(state);
      }
    };
    const cancelPendingTools = (state: SessionState): void => {
      for (const pending of state.pendingToolAnswers.values()) {
        pending.controller.abort();
        pending.resolve({ resultJson: '{"error":"tool-interrupted"}', isError: true });
      }
      state.pendingToolAnswers.clear();
    };
    const retireState = (state: SessionState): void => {
      state.terminal = true;
      cancelPendingTools(state);
      state.approvals.clear();
      state.questions.clear();
      deactivate(state);
      void releaseManagedTools(state).catch(() => undefined);
    };
    const emitInterrupted = (state: SessionState, message: string) => {
      if (state.terminal) return;
      retireState(state);
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
    const samePorts = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
      left.length === right.length && left.every((port, index) => port === right[index]);
    const closeRuntime = async (): Promise<void> => {
      processMonitor?.cancel();
      if (runtimeScope !== undefined) {
        await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
      }
      runtimeScope = undefined;
      processMonitor = undefined;
      client = undefined;
      runtimePolicy = undefined;
      runtimeIsolated = false;
      runtimeLoopbackPorts = [];
      subscriptionReady = undefined;
    };
    const ensureRuntime = (
      executionPolicy: ProviderExecutionPolicy,
      loopbackPorts: ReadonlyArray<number>,
    ): Effect.Effect<OpenCodeClientPort, ProviderFailure> =>
      Effect.tryPromise({
        try: async () => {
          if (client !== undefined && runtimePolicy !== undefined) {
            if (runtimePolicy !== executionPolicy) {
              throw fail(
                "unauthorized",
                "OpenCode process authority cannot be widened on an active connection.",
              );
            }
            if (!samePorts(runtimeLoopbackPorts, loopbackPorts)) {
              throw fail(
                "unauthorized",
                "OpenCode process tool bridges cannot change on an active connection.",
              );
            }
            return client;
          }
          const scope = await Effect.runPromise(Scope.make());
          try {
            const startedExit = await Effect.runPromiseExit(
              options.process
                .start({
                  binaryPath: options.binaryPath,
                  cwd: projectRoot,
                  mode,
                  executionPolicy,
                  ...(loopbackPorts.length === 0 ? {} : { loopbackPorts }),
                  onProcessStarted: (process) =>
                    options.runtimeRegistry.trackProcess(options.instanceId, process),
                })
                .pipe(Effect.provideService(Scope.Scope, scope)),
            );
            if (Exit.isFailure(startedExit)) {
              throw Option.getOrElse(Cause.failureOption(startedExit.cause), () =>
                fail("provider-failed", "OpenCode process failed without a typed failure."),
              );
            }
            const started = startedExit.value;
            const monitor = monitorProcessExit(started.pid);
            const nextClient = clientFactory(started, projectRoot);
            runtimeScope = scope;
            processMonitor = monitor;
            runtimePolicy = executionPolicy;
            runtimeIsolated = started.isolatedConfiguration === true;
            runtimeLoopbackPorts = loopbackPorts;
            client = nextClient;
            void monitor.exited.then(() => {
              if (closing) return;
              streamFailure = fail("provider-failed", "Provider runtime exited unexpectedly.");
              subscriptionAbort.abort();
              for (const state of sessionsBySource.values()) {
                emitInterrupted(state, "Provider runtime exited unexpectedly.");
              }
            });
            return nextClient;
          } catch (error) {
            await Effect.runPromise(Scope.close(scope, Exit.void));
            throw error;
          }
        },
        catch: (error) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "category" in error &&
            "message" in error
          ) {
            try {
              return decodeProviderFailure(error);
            } catch {
              return fail("protocol", "OpenCode returned an invalid process failure.");
            }
          }
          return providerFailure(error);
        },
      });
    const removeInvalidation = options.runtimeRegistry.onRuntimeInvalidated(
      options.instanceId,
      () => {
        for (const state of sessionsBySource.values()) {
          emitInterrupted(state, "Provider runtime exited unexpectedly.");
        }
      },
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closing = true;
        for (const state of sessionsBySource.values()) {
          retireState(state);
        }
        subscriptionAbort.abort();
        for (const state of sessionsBySource.values()) {
          await releaseManagedTools(state);
        }
        await closeRuntime();
        removeInvalidation();
        await Effect.runPromise(PubSub.shutdown(events));
      }),
    );

    const failStream = () => {
      if (subscriptionAbort.signal.aborted || streamFailure !== undefined) return;
      streamFailure = fail("protocol", "Provider event stream ended unexpectedly.");
      for (const state of sessionsBySource.values()) {
        if (state.terminal) continue;
        retireState(state);
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

    const ensureSubscription = (runtimeClient: OpenCodeClientPort) =>
      request(async () => {
        if (streamFailure !== undefined) throw streamFailure;
        if (subscriptionReady === undefined) {
          subscriptionReady = runtimeClient.subscribe(subscriptionAbort.signal).then((events) => {
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
                    mapAndOffer(state, event, options.instanceId, clock, offer, retireState);
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
      return source === undefined || state === undefined || state.sessionId !== sessionId
        ? Effect.fail(fail("protocol", "Provider session is not active."))
        : Effect.succeed([source, state]);
    };
    const usableStateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<[string, SessionState], ProviderFailure> =>
      streamFailure === undefined ? stateFor(sessionId) : Effect.fail(streamFailure);

    const requestManagedTool = async (
      state: SessionState,
      name: string,
      inputJson: string,
      signal: AbortSignal,
      context?: ManagedToolCallContext,
    ): Promise<{ readonly resultJson: string; readonly isError: boolean }> => {
      if (
        !state.toolNames.has(name) ||
        state.terminal ||
        state.sourceId === undefined ||
        (context?.metadata.sessionID !== undefined && context.metadata.sessionID !== state.sourceId)
      ) {
        return { resultJson: '{"error":"tool-unavailable"}', isError: true };
      }
      if (signal.aborted) return { resultJson: '{"error":"tool-interrupted"}', isError: true };
      const requestId = `opencode-tool-${crypto.randomUUID()}`;
      return new Promise((resolve) => {
        const controller = new AbortController();
        const finish = (answer: ManagedToolAnswer) => {
          signal.removeEventListener("abort", cancel);
          resolve({
            resultJson: answer.resultJson,
            isError: answer.isError,
            ...(answer.images === undefined ? {} : { images: answer.images }),
          });
        };
        const cancel = () => {
          if (!state.pendingToolAnswers.delete(requestId)) return;
          controller.abort();
          finish({ resultJson: '{"error":"tool-interrupted"}', isError: true });
        };
        state.pendingToolAnswers.set(requestId, { controller, resolve: finish });
        signal.addEventListener("abort", cancel, { once: true });
        offer({
          kind: "tool-request",
          instanceId: options.instanceId,
          sessionId: state.sessionId,
          sequence: state.nextSequence++,
          correlationId: state.correlationId,
          occurredAt: clock() as UtcTimestamp,
          requestId,
          toolName: name,
          inputJson,
        });
      });
    };

    const prepareManagedTools = (
      state: SessionState,
      definitions: ReadonlyArray<ProviderToolDefinition>,
    ) =>
      definitions.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: async () => {
              const catalogNames = definitions.map((definition) =>
                definition.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
              );
              if (new Set(catalogNames).size !== definitions.length) {
                throw fail(
                  "invalid-configuration",
                  "App tool names collide in the provider catalogue.",
                );
              }
              const catalogKey = JSON.stringify(definitions);
              if (
                state.managedTools !== undefined &&
                state.managedTools.catalogKey !== catalogKey
              ) {
                throw fail(
                  "invalid-configuration",
                  "OpenCode cannot change app-managed tools while its session is active.",
                );
              }
              if (state.managedTools === undefined) {
                const serverName = `octant-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
                const owner = { state };
                const bridge = await createOpenCodeManagedToolsBridge(
                  definitions,
                  (name, inputJson, signal, context) =>
                    requestManagedTool(owner.state, name, inputJson, signal, context),
                );
                state.managedTools = { bridge, serverName, catalogKey, owner };
                state.toolNames.clear();
                for (const definition of definitions) state.toolNames.add(definition.name);
              }
            },
            catch: (error) =>
              error && typeof error === "object" && "category" in error
                ? (error as ProviderFailure)
                : fail("unsupported", "OpenCode could not register app-managed tools."),
          });

    const discardUnregisteredState = (
      state: SessionState,
      providerSessionId: string,
      failure: ProviderFailure,
    ): Effect.Effect<never, ProviderFailure> =>
      request(() => client?.abort(providerSessionId) ?? Promise.resolve()).pipe(
        Effect.ignore,
        Effect.tap(() =>
          Effect.promise(async () => {
            retireState(state);
            await releaseManagedTools(state);
          }),
        ),
        Effect.zipRight(Effect.fail(failure)),
      );

    return {
      toolRequestSignal: ({ sessionId, requestId }) => {
        const source = sourceBySession.get(sessionId);
        const state = source === undefined ? undefined : sessionsBySource.get(source);
        return state?.pendingToolAnswers.get(requestId)?.controller.signal ?? AbortSignal.abort();
      },
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        Effect.suspend(() => {
          if (sourceBySession.has(input.sessionId)) {
            return Effect.fail(fail("protocol", "Provider session is already active."));
          }
          if (
            sessionSetupInFlight ||
            [...sessionsBySource.values()].some((state) => !state.terminal)
          ) {
            return Effect.fail(fail("protocol", "A provider session is already active."));
          }
          sessionSetupInFlight = true;
          const state = newSessionState(
            input.sessionId,
            input.modelId,
            input.executionPolicy,
            makeCorrelation,
            input.tools ?? [],
          );
          return prepareManagedTools(state, input.tools ?? []).pipe(
            Effect.flatMap(() =>
              ensureRuntime(
                input.executionPolicy,
                state.managedTools === undefined ? [] : [state.managedTools.bridge.port],
              ),
            ),
            Effect.flatMap((runtimeClient) => {
              if (state.managedTools !== undefined && !runtimeIsolated) {
                return Effect.promise(() => releaseManagedTools(state)).pipe(
                  Effect.zipRight(
                    Effect.fail(
                      fail(
                        "unsupported",
                        "OpenCode app tools require a confined provider process.",
                      ),
                    ),
                  ),
                );
              }
              const attachManagedTools =
                state.managedTools === undefined
                  ? Promise.resolve()
                  : runtimeClient.addMcpServer({
                      name: state.managedTools.serverName,
                      url: state.managedTools.bridge.url,
                    });
              return request(() => attachManagedTools).pipe(
                Effect.zipRight(ensureSubscription(runtimeClient)),
                Effect.zipRight(
                  request(() =>
                    runtimeClient.createSession({
                      permission: permissionRules(
                        input.executionPolicy,
                        state.managedTools?.serverName,
                      ),
                    }),
                  ),
                ),
                Effect.tapError(() => Effect.promise(() => releaseManagedTools(state))),
                Effect.map((session) => ({ session, state })),
              );
            }),
            Effect.flatMap(({ session, state }) => {
              if (!isAbsolute(session.directory) || resolve(session.directory) !== projectRoot) {
                return discardUnregisteredState(
                  state,
                  session.id,
                  fail("unauthorized", "Provider session belongs to a different Project root."),
                );
              }
              if (streamFailure !== undefined) {
                return discardUnregisteredState(state, session.id, streamFailure);
              }
              state.sourceId = session.id;
              sessionsBySource.set(session.id, state);
              sourceBySession.set(input.sessionId, session.id);
              resumeToolCatalogs.set(session.id, input.tools ?? []);
              activate(state);
              for (const event of pendingBySource.get(session.id) ?? []) {
                mapAndOffer(state, event, options.instanceId, clock, offer, retireState);
              }
              pendingBySource.delete(session.id);
              return Effect.succeed({
                sessionId: input.sessionId,
                resumeCursor: { driverKind: "opencode" as const, value: session.id },
              });
            }),
            Effect.ensuring(
              Effect.sync(() => {
                sessionSetupInFlight = false;
              }),
            ),
          );
        }),
      resume: (input) =>
        input.resumeCursor.driverKind !== "opencode"
          ? Effect.fail(fail("stale-resume", "Provider resume cursor does not belong to OpenCode."))
          : Effect.suspend(() => {
              if (
                sessionSetupInFlight ||
                [...sessionsBySource.values()].some(
                  (state) => !state.terminal && state.sessionId !== input.sessionId,
                )
              ) {
                return Effect.fail(fail("protocol", "A provider session is already active."));
              }
              sessionSetupInFlight = true;
              const tools = resumeToolCatalogs.get(input.resumeCursor.value) ?? [];
              const priorSource = sourceBySession.get(input.sessionId);
              const priorState =
                priorSource === undefined ? undefined : sessionsBySource.get(priorSource);
              const inheritedTools = priorState?.managedTools;
              if (priorState !== undefined && inheritedTools !== undefined) {
                priorState.managedTools = undefined;
              }
              const state = newSessionState(
                input.sessionId,
                "unknown/unknown",
                input.executionPolicy,
                makeCorrelation,
                tools,
              );
              if (inheritedTools !== undefined) {
                inheritedTools.owner.state = state;
                state.managedTools = inheritedTools;
              }
              return Effect.promise(async () => {
                if (priorState !== undefined) {
                  retireState(priorState);
                  await releaseManagedTools(priorState);
                }
              }).pipe(
                Effect.zipRight(prepareManagedTools(state, tools)),
                Effect.flatMap(() =>
                  ensureRuntime(
                    input.executionPolicy,
                    state.managedTools === undefined ? [] : [state.managedTools.bridge.port],
                  ),
                ),
                Effect.flatMap((runtimeClient) => {
                  const attachManagedTools =
                    state.managedTools === undefined || inheritedTools !== undefined
                      ? Promise.resolve()
                      : runtimeClient.addMcpServer({
                          name: state.managedTools.serverName,
                          url: state.managedTools.bridge.url,
                        });
                  return request(() => attachManagedTools).pipe(
                    Effect.zipRight(ensureSubscription(runtimeClient)),
                    Effect.zipRight(
                      request(() => runtimeClient.getSession(input.resumeCursor.value)).pipe(
                        Effect.mapError(() =>
                          fail("stale-resume", "Provider resume session is no longer available."),
                        ),
                      ),
                    ),
                    Effect.map((session) => ({ runtimeClient, session })),
                  );
                }),
                Effect.flatMap(({ session }) => {
                  if (
                    !isAbsolute(session.directory) ||
                    resolve(session.directory) !== projectRoot
                  ) {
                    return Effect.fail(
                      fail("stale-resume", "Provider session belongs to a different Project root."),
                    );
                  }
                  const resumedModel =
                    session.model === undefined
                      ? "unknown/unknown"
                      : `${session.model.providerID}/${session.model.id}`;
                  state.modelId = resumedModel;
                  state.sourceId = session.id;
                  sessionsBySource.set(session.id, state);
                  sourceBySession.set(input.sessionId, session.id);
                  activate(state);
                  for (const event of pendingBySource.get(session.id) ?? []) {
                    mapAndOffer(state, event, options.instanceId, clock, offer, retireState);
                  }
                  pendingBySource.delete(session.id);
                  return Effect.succeed({
                    sessionId: input.sessionId,
                    resumeCursor: input.resumeCursor,
                  });
                }),
                Effect.ensuring(
                  Effect.sync(() => {
                    sessionSetupInFlight = false;
                  }),
                ),
              );
            }),
      send: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([source]) => {
            const state = sessionsBySource.get(source)!;
            if (state.terminal) {
              return Effect.fail(fail("protocol", "Provider session is already terminal."));
            }
            const observed = options.runtimeRegistry.observedState(options.instanceId);
            const model = observed?.models.find((candidate) => candidate.id === state.modelId);
            const runtimeClient = client;
            if (runtimeClient === undefined) {
              return Effect.fail(fail("protocol", "OpenCode provider process is not active."));
            }
            if (input.tools.length > 0 && state.managedTools === undefined) {
              return Effect.fail(
                fail(
                  "unsupported",
                  "OpenCode app-managed tools must be registered when the session starts.",
                ),
              );
            }
            const rejected = validateChatTurnInput(
              input,
              {
                ...(observed?.capabilities ?? capabilities),
                appManagedTools: runtimeIsolated ? "supported" : "unsupported",
              },
              model,
            );
            if (rejected !== undefined) return Effect.fail(rejected);
            return Effect.try({
              try: () => splitModelId(state.modelId),
              catch: providerFailure,
            }).pipe(
              Effect.flatMap((modelSelection) =>
                prepareManagedTools(state, input.tools).pipe(
                  Effect.flatMap(() =>
                    Effect.gen(function* () {
                      const managedTools = state.managedTools;
                      return yield* request(() =>
                        runtimeClient.prompt({
                          sessionId: source,
                          providerId: modelSelection.providerId,
                          modelId: modelSelection.modelId,
                          prompt: renderProviderTurnPrompt(input),
                          attachments: input.attachments,
                          permission: permissionRules(
                            state.executionPolicy,
                            managedTools?.serverName,
                          ),
                        }),
                      );
                    }),
                  ),
                ),
              ),
            );
          }),
        ),
      interrupt: (sessionId) =>
        usableStateFor(sessionId).pipe(
          Effect.flatMap(([source, state]) => {
            const activeClient = client;
            return Effect.sync(() => cancelPendingTools(state)).pipe(
              Effect.zipRight(
                activeClient === undefined
                  ? Effect.fail(fail("protocol", "OpenCode provider process is not active."))
                  : request(() => activeClient.abort(source)),
              ),
            );
          }),
        ),
      stop: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap(([source, state]) => {
            const activeClient = client;
            return Effect.sync(() => retireState(state)).pipe(
              Effect.zipRight(
                activeClient === undefined
                  ? Effect.void
                  : request(() => activeClient.abort(source)),
              ),
              Effect.ensuring(Effect.promise(() => releaseManagedTools(state))),
            );
          }),
        ),
      answerApproval: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([, state]) => {
            const activeClient = client;
            if (activeClient === undefined) {
              return Effect.fail(fail("protocol", "OpenCode provider process is not active."));
            }
            return state.terminal
              ? Effect.fail(fail("protocol", "Provider session is already terminal."))
              : state.executionPolicy === "plan"
                ? Effect.fail(fail("unauthorized", "Plan mode cannot approve provider actions."))
                : !state.approvals.has(input.requestId)
                  ? Effect.fail(fail("protocol", "Provider approval request is not pending."))
                  : request(() =>
                      activeClient.replyPermission(
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
                    );
          }),
        ),
      answerUserInput: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([, state]) => {
            const activeClient = client;
            if (activeClient === undefined) {
              return Effect.fail(fail("protocol", "OpenCode provider process is not active."));
            }
            return state.terminal
              ? Effect.fail(fail("protocol", "Provider session is already terminal."))
              : !state.questions.has(input.requestId)
                ? Effect.fail(fail("protocol", "Provider question request is not pending."))
                : request(() => activeClient.replyQuestion(input.requestId, input.answer)).pipe(
                    Effect.tap(() => Effect.sync(() => state.questions.delete(input.requestId))),
                  );
          }),
        ),
      answerTool: (input) =>
        usableStateFor(input.sessionId).pipe(
          Effect.flatMap(([, state]) => {
            if (state.terminal) {
              return Effect.fail(fail("protocol", "Provider session is already terminal."));
            }
            const resolve = state.pendingToolAnswers.get(input.requestId);
            if (resolve === undefined) {
              return Effect.fail(fail("protocol", "Provider tool request is not pending."));
            }
            state.pendingToolAnswers.delete(input.requestId);
            resolve.resolve({
              resultJson: input.resultJson,
              isError: input.isError,
              ...(input.images === undefined ? {} : { images: input.images }),
            });
            return Effect.void;
          }),
        ),
    };
  });
}

function newSessionState(
  sessionId: ProviderSessionId,
  modelId: string,
  executionPolicy: ProviderExecutionPolicy,
  makeCorrelation: () => string,
  tools: ReadonlyArray<ProviderToolDefinition>,
): SessionState {
  return {
    sessionId,
    correlationId: makeCorrelation() as CorrelationId,
    nextSequence: 1,
    terminal: false,
    active: false,
    taskIds: new Map(),
    messageParts: new OpenCodeMessageParts(),
    modelId,
    sourceId: undefined,
    executionPolicy,
    approvals: new Set(),
    questions: new Set(),
    toolNames: new Set(tools.map((tool) => tool.name)),
    pendingToolAnswers: new Map(),
    managedTools: undefined,
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
  retire: (state: SessionState) => void,
): void {
  if (state.terminal) return;
  const mapped = mapOpenCodeEvent(
    {
      instanceId,
      sessionId: state.sessionId,
      sequenceStart: state.nextSequence,
      messageParts: state.messageParts,
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
      retire(state);
    }
    state.nextSequence = normalized.sequence + 1;
    offer(normalized);
  }
}

function permissionRules(
  policy: ProviderExecutionPolicy,
  managedToolServerName?: string,
): PermissionRuleset {
  let rules: PermissionRuleset;
  if (policy === "full-access") {
    rules = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  } else if (policy === "auto-accept-edits") {
    // Edits inside the bound directory proceed; everything else still asks,
    // and reach outside the directory stays denied outright.
    rules = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  } else if (policy === "approval-gated") {
    rules = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  } else {
    rules = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "todowrite", pattern: "*", action: "deny" },
    ];
  }
  rules.push(
    { permission: "*_*", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "*", action: "deny" },
  );
  if (managedToolServerName === undefined) return rules;
  // OpenCode prefixes MCP tools as `<server>_<tool>`. Deny every other
  // namespaced tool in this session; only this session's bridge is allowed.
  return [...rules, { permission: `${managedToolServerName}_*`, pattern: "*", action: "allow" }];
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
  isolatedConfiguration = false,
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
        // Variants are reported by OpenCode but not selectable through it here:
        // this driver creates a session and prompts with provider and model ids
        // only, never `modelOptionValues`. A declared option would save the
        // user's choice and drop it on the next turn, so nothing is declared
        // until the value reaches the prompt.
        options: [],
      })),
    );
  return decodeProviderProbeResult({
    instanceId,
    readiness: models.length > 0 ? "ready" : "unauthenticated",
    processState: "running",
    detectedVersion: health.version,
    models,
    capabilities: openCodeChatCapabilities(models, isolatedConfiguration),
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
  if (typeof properties.sessionID === "string" && properties.sessionID.length > 0)
    return properties.sessionID;
  // Earlier runtimes put the session identity inside the message or part.
  const nested =
    event.type === "message.part.updated"
      ? event.properties.part?.sessionID
      : event.type === "message.updated"
        ? event.properties.info?.sessionID
        : undefined;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

export function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}
