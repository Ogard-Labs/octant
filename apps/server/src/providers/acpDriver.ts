import { isAbsolute, resolve } from "node:path";
import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderAuthenticationAttempt,
  decodeProviderFailure,
  decodeProviderModelId,
  decodeProviderProbeResult,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  rejectUnsupportedChatTurn,
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import {
  mapAcpNotification,
  mapAcpPermissionRequest,
  type AcpEventContext,
  type AcpMappedPermission,
} from "./acpEventMapper";
import type { AcpConnection, AcpProcessPort, AcpSessionMode } from "./acpProcess";
import type { AcpProviderProfile } from "./acpProfiles";
import {
  AcpFailure,
  type AcpBrowserAuthenticationAttempt,
  type AcpConfigOptionsResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpServerNotification,
  type AcpServerRequest,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
} from "./acpProtocol";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { type ProviderRuntimeRegistry, trackProviderProcess } from "./providerRuntimeRegistry";

/** The subset of the ACP client the driver depends on (fakeable in tests). */
export interface AcpClientPort {
  readonly authenticate: () => Promise<void>;
  readonly startBrowserAuthentication: () => Promise<AcpBrowserAuthenticationAttempt>;
  readonly completeBrowserAuthentication: (attemptId: string) => Promise<void>;
  readonly newSession: (cwd: string) => Promise<AcpNewSessionResult>;
  readonly loadSession: (sessionId: string, cwd: string) => Promise<AcpNewSessionResult>;
  readonly resumeSession: (sessionId: string, cwd: string) => Promise<AcpNewSessionResult>;
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly prompt: (sessionId: string, prompt: string) => Promise<AcpPromptResult>;
  readonly setConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<AcpConfigOptionsResult>;
  readonly call: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
  readonly onNotification: (listener: (message: AcpServerNotification) => void) => () => void;
  readonly onRequest: (listener: (message: AcpServerRequest) => void) => () => void;
  readonly respondPermission: (id: string | number, optionId?: string) => Promise<void>;
  readonly notify: (
    method: "session/cancel",
    params: { readonly sessionId: string },
  ) => Promise<void>;
}

export interface AcpDriverOptions {
  readonly profile: AcpProviderProfile;
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly managedHome: string;
  readonly process: AcpProcessPort;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  /** Instance authentication mode for profiles with delegated browser sign-in. */
  readonly authentication?: "subscription" | "api-key";
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly clientFactory?: (connection: AcpConnection) => AcpClientPort;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
}

interface ResumeIdentity {
  readonly root: string;
  readonly mode: AcpSessionMode;
  readonly modelId: string;
}

interface PendingApproval {
  readonly kind: "approval";
  readonly providerRequestId: string | number;
  readonly allowOptionId: string;
  readonly rejectOptionId: string;
}

interface PendingQuestion {
  readonly kind: "question";
  readonly providerRequestId: string | number;
  readonly optionIds: ReadonlyMap<string, string>;
  readonly skipOptionId?: string;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly sourceSessionId: string;
  readonly modelId: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly scope: Scope.CloseableScope;
  readonly client: AcpClientPort;
  readonly context: AcpEventContext;
  readonly removeNotification: () => void;
  readonly removeRequest: () => void;
  readonly approvals: Map<string, PendingApproval>;
  readonly questions: Map<string, PendingQuestion>;
  promptActive: boolean;
  closed: boolean;
}

interface Factories {
  readonly clientFactory: (connection: AcpConnection) => AcpClientPort;
  readonly clock: () => string;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
}

function baseCapabilities(profile: AcpProviderProfile) {
  return {
    streaming: "supported",
    resume: "supported",
    interruption: "supported",
    approvals: "supported",
    userQuestions: profile.userQuestions,
    reasoning: "unavailable",
    usage: "unavailable",
    toolActivity: "supported",
    fileChanges: "unavailable",
    diffs: "unavailable",
    taskProgress: "supported",
    nativeChildAgents: "unavailable",
    ...unsupportedChatCapabilities,
  } as const;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function providerFailure(profile: AcpProviderProfile, error: unknown): ProviderFailure {
  const name = profile.displayName;
  try {
    return decodeProviderFailure(error);
  } catch {
    if (error instanceof AcpFailure) {
      if (error.message.toLowerCase().includes("authentication")) {
        return failure("unauthenticated", profile.unauthenticatedMessage);
      }
      if (error.kind === "protocol") return failure("protocol", `${name} ACP protocol failed.`);
      if (error.kind === "timeout") return failure("unavailable", `${name} ACP request timed out.`);
      if (error.kind === "closed") return failure("interrupted", `${name} ACP connection closed.`);
    }
    return failure("provider-failed", `${name} request failed.`);
  }
}

function normalizeModels(
  profile: AcpProviderProfile,
  options: ReadonlyArray<AcpSessionConfigOption>,
  models: AcpSessionModelState | undefined,
) {
  const model = options.find((option) => option.id === "model");
  // The config option and the session's model state are two ACP spellings of
  // the same list. Reading only the first reported an agent that speaks the
  // second as having nothing selectable, which left it unusable in every mode.
  const selectable =
    model !== undefined
      ? model.options.map((item) => ({ value: item.value, name: item.name }))
      : (models?.availableModels.map((item) => ({ value: item.modelId, name: item.name })) ?? []);
  if (selectable.length === 0) return [];
  const reasoning = options.find((option) => option.id === profile.reasoningOptionId);
  return selectable.map((item) => ({
    id: decodeProviderModelId(item.value),
    displayName: item.name,
    source: "discovered" as const,
    verification: "verified" as const,
    reasoning: reasoning === undefined ? ("unavailable" as const) : ("supported" as const),
    inputModalities: textOnlyInputModalities,
    // The agent reasons, and that capability is reported above. Choosing how
    // hard is a different claim: this driver starts sessions with `model` and
    // `mode` only and never sends `modelOptionValues` back, so declaring a
    // selectable option would put a control in the composer that saves the
    // user's choice and silently drops it on the next turn. Declaring nothing
    // is the honest report until the value reaches the session.
    options: [],
  }));
}

function normalizeProbe(
  profile: AcpProviderProfile,
  instanceId: ProviderInstanceId,
  version: string,
  initialized: AcpConnection["initialized"],
  options: ReadonlyArray<AcpSessionConfigOption>,
  sessionModels: AcpSessionModelState | undefined,
  observedAt: string,
  credentialStatus?: "stored",
): ProviderProbeResult {
  const reasoning = options.some((option) => option.id === profile.reasoningOptionId)
    ? ("supported" as const)
    : ("unavailable" as const);
  const resume =
    initialized.agentCapabilities.loadSession === true ||
    initialized.agentCapabilities.sessionCapabilities?.resume !== undefined
      ? ("supported" as const)
      : ("unsupported" as const);
  const models = normalizeModels(profile, options, sessionModels);
  return decodeProviderProbeResult({
    instanceId,
    readiness: models.length === 0 ? "degraded" : "ready",
    processState: "stopped",
    detectedVersion: version,
    ...(credentialStatus === undefined ? {} : { credentialStatus }),
    models,
    capabilities: { ...baseCapabilities(profile), resume, reasoning },
    ...(models.length === 0
      ? { message: `${profile.displayName} did not report a selectable model.` }
      : {}),
    lastSuccessfulProbeAt: observedAt,
    observedAt,
  });
}

function makeClient(connection: AcpConnection): AcpClientPort {
  return connection.acp;
}

function commandInventory(notification: AcpServerNotification): ReadonlyArray<string> | undefined {
  const update = notification.params.update;
  if (update.sessionUpdate !== "available_commands_update") return undefined;
  if (!Array.isArray(update.availableCommands)) return [];
  const names: string[] = [];
  for (const candidate of update.availableCommands) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("name" in candidate) ||
      typeof candidate.name !== "string"
    ) {
      return [];
    }
    names.push(candidate.name);
  }
  return names;
}

function isReviewedCommandInventory(
  reviewed: ReadonlyArray<string>,
  commands: ReadonlyArray<string>,
): boolean {
  const reviewedSet = new Set(reviewed);
  return (
    commands.length === reviewed.length &&
    new Set(commands).size === commands.length &&
    commands.every((command) => reviewedSet.has(command))
  );
}

function resolveApiKey(
  options: AcpDriverOptions,
): Effect.Effect<string | undefined, ProviderFailure> {
  const name = options.profile.displayName;
  if (options.profile.authentication.kind !== "delegated-browser") return Effect.succeed(undefined);
  if (options.authentication !== "api-key") return Effect.succeed(undefined);
  const resolver = options.credentialResolver;
  if (resolver === undefined) {
    return Effect.fail(failure("provider-failed", `${name} credential broker is unavailable.`));
  }
  return Effect.tryPromise({
    try: async () => {
      const present = await resolver.has(options.instanceId);
      if (!present) throw failure("unauthenticated", `${name} API-key credential is missing.`);
      const credential = await resolver.resolve(options.instanceId);
      if (credential.trim().length === 0) {
        throw failure("unauthenticated", `${name} API-key credential is missing.`);
      }
      return credential;
    },
    catch: (error) => {
      try {
        return decodeProviderFailure(error);
      } catch {
        return failure("provider-failed", `${name} credential broker is unavailable.`);
      }
    },
  });
}

export function makeAcpDriver(options: AcpDriverOptions): ProviderDriver {
  const { profile } = options;
  const name = profile.displayName;
  const factories: Factories = {
    clientFactory: options.clientFactory ?? makeClient,
    clock: options.clock ?? (() => new Date().toISOString()),
    makeCorrelation: options.correlationId ?? (() => crypto.randomUUID()),
    makeRequestId: options.requestId ?? (() => crypto.randomUUID()),
  };
  const resumeIdentities = new Map<string, ResumeIdentity>();
  const request = <A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> =>
    Effect.tryPromise({ try: operation, catch: (error) => providerFailure(profile, error) });

  /** A managed-home process used for probing and delegated authentication. */
  const managedHomeClient = Effect.gen(function* () {
    const apiKey = yield* resolveApiKey(options);
    let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
    const connection = yield* options.process.start({
      profile,
      binaryPath: options.binaryPath,
      root: options.managedHome,
      managedHome: options.managedHome,
      mode: "chat",
      executionPolicy: "approval-gated",
      ...(apiKey === undefined ? {} : { apiKey }),
      onProcessStarted: async (process) => {
        receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
        return receipt;
      },
    });
    if (receipt === undefined) {
      yield* trackProviderProcess(options.runtimeRegistry, options.instanceId, connection);
    }
    return { connection, client: factories.clientFactory(connection) };
  });

  const validateAuthenticationInput = (instanceId: ProviderInstanceId) => {
    if (instanceId !== options.instanceId) {
      return failure("invalid-configuration", "Provider instance does not match driver.");
    }
    if (options.authentication !== "subscription") {
      return failure(
        "unsupported",
        `Browser authentication is available only for ${name} subscription instances.`,
      );
    }
    return undefined;
  };

  const probeCommandInventory = (
    client: AcpClientPort,
    reviewed: ReadonlyArray<string>,
    root: string,
  ) =>
    Effect.gen(function* () {
      let observedCommands: ReadonlyArray<string> | undefined;
      let resolveCommands: ((commands: ReadonlyArray<string>) => void) | undefined;
      const removeNotification = client.onNotification((notification) => {
        const commands = commandInventory(notification);
        if (commands === undefined) return;
        observedCommands = commands;
        resolveCommands?.(commands);
      });
      let scratch: AcpNewSessionResult;
      let commands: ReadonlyArray<string>;
      try {
        scratch = yield* request(() => client.newSession(root));
        commands =
          observedCommands ??
          (yield* Effect.promise(
            () =>
              new Promise<ReadonlyArray<string>>((resolve) => {
                const timeout = setTimeout(() => resolve([]), 1_000);
                resolveCommands = (value) => {
                  clearTimeout(timeout);
                  resolve(value);
                };
              }),
          ));
      } finally {
        removeNotification();
      }
      if (!isReviewedCommandInventory(reviewed, commands)) {
        return yield* Effect.fail(
          failure("incompatible", `${name} advertised an unreviewed command inventory.`),
        );
      }
      return scratch;
    });

  return {
    kind: profile.kind,
    ...(profile.authentication.kind === "delegated-browser"
      ? {
          beginAuthentication: ({ instanceId }) => {
            const invalid = validateAuthenticationInput(instanceId);
            if (invalid !== undefined) return Effect.fail(invalid);
            return managedHomeClient.pipe(
              Effect.flatMap(({ client }) =>
                request(async () => {
                  const attempt = await client.startBrowserAuthentication();
                  let expiresAt: string;
                  try {
                    expiresAt = new Date(attempt.expiresAt).toISOString();
                  } catch {
                    throw new AcpFailure("protocol", `${name} returned an invalid auth expiry.`);
                  }
                  return decodeProviderAuthenticationAttempt({ ...attempt, expiresAt });
                }),
              ),
            );
          },
          completeAuthentication: ({ instanceId, attemptId }) => {
            const invalid = validateAuthenticationInput(instanceId);
            if (invalid !== undefined) return Effect.fail(invalid);
            return managedHomeClient.pipe(
              Effect.flatMap(({ client }) =>
                request(() => client.completeBrowserAuthentication(attemptId)),
              ),
            );
          },
        }
      : {}),
    probe: ({ instanceId }) => {
      if (instanceId !== options.instanceId) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      return Effect.gen(function* () {
        const { connection, client } = yield* managedHomeClient;
        if (profile.authenticateOnProbe) yield* request(() => client.authenticate());
        const scratch =
          profile.reviewedCommands === undefined
            ? yield* request(() => client.newSession(connection.root))
            : yield* probeCommandInventory(client, profile.reviewedCommands, connection.root);
        if (profile.closesSessions) yield* request(() => client.closeSession(scratch.sessionId));
        const observed = normalizeProbe(
          profile,
          instanceId,
          connection.version,
          connection.initialized,
          scratch.configOptions ?? [],
          scratch.models,
          factories.clock(),
          options.authentication === "api-key" ? "stored" : undefined,
        );
        options.runtimeRegistry.setObservedState(observed);
        return observed;
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
          failure("invalid-configuration", `${name} requires an explicit product mode.`),
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
      return makeConnection(options, projectRoot, mode, resumeIdentities, factories);
    },
  };
}

function makeConnection(
  options: AcpDriverOptions,
  projectRoot: string,
  mode: AcpSessionMode,
  resumeIdentities: Map<string, ResumeIdentity>,
  factories: Factories,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  const { profile } = options;
  const name = profile.displayName;
  const capabilities = baseCapabilities(profile);
  const request = <A>(operation: () => Promise<A>): Effect.Effect<A, ProviderFailure> =>
    Effect.tryPromise({ try: operation, catch: (error) => providerFailure(profile, error) });
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const runtimeRoot =
      mode === "chat" && profile.chatSessionRoot === "managed-home"
        ? options.managedHome
        : projectRoot;

    const closeState = async (state: SessionState) => {
      if (state.closed) return;
      state.closed = true;
      state.removeNotification();
      state.removeRequest();
      for (const pending of state.approvals.values()) {
        await state.client
          .respondPermission(pending.providerRequestId, pending.rejectOptionId)
          .catch(() => undefined);
      }
      for (const pending of state.questions.values()) {
        await state.client
          .respondPermission(pending.providerRequestId, pending.skipOptionId)
          .catch(() => undefined);
      }
      state.approvals.clear();
      state.questions.clear();
      if (profile.closesSessions) {
        await state.client.closeSession(state.sourceSessionId).catch(() => undefined);
      }
      await Effect.runPromise(Scope.close(state.scope, Exit.void));
      const count = options.runtimeRegistry.activeSessionCount(options.instanceId);
      options.runtimeRegistry.setActiveSessionCount(options.instanceId, Math.max(0, count - 1));
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.all([...sessions.values()].map(closeState));
        sessions.clear();
        await Effect.runPromise(Queue.shutdown(queue));
      }),
    );

    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(Queue.offer(queue, event));
    };

    const stateFor = (
      sessionId: ProviderSessionId,
    ): Effect.Effect<SessionState, ProviderFailure> => {
      const state = sessions.get(sessionId);
      return state === undefined || state.closed
        ? Effect.fail(failure("protocol", `${name} session is not active.`))
        : Effect.succeed(state);
    };

    const handleNotification = (state: SessionState, notification: AcpServerNotification) => {
      for (const mapped of mapAcpNotification(state.context, notification)) {
        if (mapped.kind === "event") offer(mapped.event);
        else if (mapped.kind === "protocol-failure") {
          state.context.terminal = true;
          offer(
            eventFor(state, factories.clock, {
              kind: "failed",
              failure: mapped.failure,
            }),
          );
        }
      }
    };

    const handleRequest = (state: SessionState, requestMessage: AcpServerRequest) => {
      const mapped = mapAcpPermissionRequest(state.context, requestMessage);
      if (mapped.kind === "protocol-failure") {
        state.context.terminal = true;
        offer(eventFor(state, factories.clock, { kind: "failed", failure: mapped.failure }));
        void state.client.respondPermission(requestMessage.id).catch(() => undefined);
        return;
      }
      if (state.executionPolicy === "plan" && mapped.kind === "approval") {
        void state.client
          .respondPermission(mapped.providerRequestId, mapped.rejectOptionId)
          .catch(() => undefined);
        return;
      }
      if (mapped.kind === "question" && profile.userQuestions === "unsupported") {
        void state.client
          .respondPermission(mapped.providerRequestId, mapped.skipOptionId)
          .catch(() => undefined);
        state.context.terminal = true;
        offer(
          eventFor(state, factories.clock, {
            kind: "failed",
            failure: failure(
              "unsupported",
              `${name} cannot request user input through its current ACP runtime.`,
            ),
          }),
        );
        return;
      }
      rememberPermission(state, mapped);
      offer(mapped.event);
      state.context.sequence += 1;
    };

    const register = async (
      input: {
        readonly sessionId: ProviderSessionId;
        readonly modelId: string;
        readonly executionPolicy: ProviderExecutionPolicy;
      },
      source: AcpNewSessionResult,
      scope: Scope.CloseableScope,
      client: AcpClientPort,
    ): Promise<SessionState> => {
      const previous = sessions.get(input.sessionId);
      if (previous !== undefined) await closeState(previous);
      const context: AcpEventContext = {
        instanceId: options.instanceId,
        sessionId: input.sessionId,
        correlationId: factories.makeCorrelation() as CorrelationId,
        occurredAt: factories.clock() as UtcTimestamp,
        sourceSessionId: source.sessionId,
        displayName: name,
        sequence: 1,
        terminal: false,
        tools: new Map(),
        requestIds: new Map(),
        makeRequestId: factories.makeRequestId,
      };
      let state!: SessionState;
      const removeNotification = client.onNotification((message) =>
        handleNotification(state, message),
      );
      const removeRequest = client.onRequest((message) => handleRequest(state, message));
      state = {
        sessionId: input.sessionId,
        sourceSessionId: source.sessionId,
        modelId: input.modelId,
        executionPolicy: input.executionPolicy,
        scope,
        client,
        context,
        removeNotification,
        removeRequest,
        approvals: new Map(),
        questions: new Map(),
        promptActive: false,
        closed: false,
      };
      sessions.set(input.sessionId, state);
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
      );
      resumeIdentities.set(source.sessionId, { root: projectRoot, mode, modelId: input.modelId });
      return state;
    };

    const startProcess = async (executionPolicy: ProviderExecutionPolicy) => {
      const scope = await Effect.runPromise(Scope.make());
      try {
        const apiKey = await Effect.runPromise(resolveApiKey(options));
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        const processConnection = await Effect.runPromise(
          options.process
            .start({
              profile,
              binaryPath: options.binaryPath,
              root: runtimeRoot,
              managedHome: options.managedHome,
              mode,
              executionPolicy,
              ...(apiKey === undefined ? {} : { apiKey }),
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
        return { scope, client: factories.clientFactory(processConnection) };
      } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      }
    };

    const createState = (input: {
      readonly sessionId: ProviderSessionId;
      readonly modelId: string;
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly sourceSessionId?: string;
    }) =>
      request(async () => {
        const { scope, client } = await startProcess(input.executionPolicy);
        try {
          const source =
            input.sourceSessionId === undefined
              ? await client.newSession(runtimeRoot)
              : profile.resumeMethod === "session/resume"
                ? await client.resumeSession(input.sourceSessionId, runtimeRoot)
                : await client.loadSession(input.sourceSessionId, runtimeRoot);
          // A profile that supplies its own request shape is describing an agent
          // whose reply the standard result schema does not fit, so that reply is
          // taken as-is. Everything else is standard ACP and stays validated: a
          // malformed success there would otherwise register a session whose
          // model and authority mode were never confirmed.
          const setModelCall = profile.setModelCall?.(source.sessionId, input.modelId);
          if (setModelCall === undefined) {
            await client.setConfigOption(source.sessionId, "model", input.modelId);
          } else {
            await client.call(setModelCall.method, setModelCall.params);
          }
          const modeValue = profile.sessionMode(mode, input.executionPolicy);
          const setModeCall = profile.setModeCall?.(source.sessionId, modeValue);
          if (setModeCall === undefined) {
            await client.setConfigOption(source.sessionId, "mode", modeValue);
          } else {
            await client.call(setModeCall.method, setModeCall.params);
          }
          return await register(input, source, scope, client);
        } catch (error) {
          await Effect.runPromise(Scope.close(scope, Exit.void));
          throw error;
        }
      });

    return {
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      start: (input) =>
        createState(input).pipe(
          Effect.map((state) => ({
            sessionId: input.sessionId,
            resumeCursor: { driverKind: profile.kind, value: state.sourceSessionId },
          })),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== profile.kind) {
          return Effect.fail(failure("stale-resume", `${name} resume identity is incompatible.`));
        }
        const identity = resumeIdentities.get(input.resumeCursor.value);
        if (identity === undefined || identity.root !== projectRoot || identity.mode !== mode) {
          return Effect.fail(
            failure("stale-resume", `${name} resume identity does not match this Project.`),
          );
        }
        return createState({
          sessionId: input.sessionId,
          modelId: identity.modelId,
          executionPolicy: input.executionPolicy,
          sourceSessionId: input.resumeCursor.value,
        }).pipe(
          Effect.map(() => ({ sessionId: input.sessionId, resumeCursor: input.resumeCursor })),
          Effect.mapError(() => failure("stale-resume", `${name} session could not be resumed.`)),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) =>
            rejectUnsupportedChatTurn(input, capabilities).pipe(
              Effect.flatMap(() => {
                const prompt = renderProviderTurnPrompt(input);
                if (profile.reviewedCommands !== undefined && prompt.trimStart().startsWith("/")) {
                  return Effect.fail(
                    failure(
                      "unauthorized",
                      `${name} slash commands are disabled. Rephrase the request without a leading slash.`,
                    ),
                  );
                }
                if (state.context.terminal) {
                  return Effect.fail(failure("protocol", `${name} session is already terminal.`));
                }
                if (state.promptActive) {
                  return Effect.fail(failure("protocol", `${name} already has an active turn.`));
                }
                state.promptActive = true;
                void state.client
                  .prompt(state.sourceSessionId, prompt)
                  .then((result) => {
                    state.promptActive = false;
                    if (state.closed || state.context.terminal) return;
                    state.context.terminal = true;
                    if (result.stopReason === "cancelled") {
                      offer(
                        eventFor(state, factories.clock, {
                          kind: "interrupted",
                          message: `${name} turn was interrupted.`,
                        }),
                      );
                    } else if (result.stopReason === "end_turn") {
                      offer(
                        eventFor(state, factories.clock, {
                          kind: "completed",
                          resumeCursor: { driverKind: profile.kind, value: state.sourceSessionId },
                        }),
                      );
                    } else {
                      offer(
                        eventFor(state, factories.clock, {
                          kind: "failed",
                          failure: failure("provider-failed", `${name} turn did not complete.`),
                        }),
                      );
                    }
                  })
                  .catch((error: unknown) => {
                    state.promptActive = false;
                    if (state.closed || state.context.terminal) return;
                    state.context.terminal = true;
                    offer(
                      eventFor(state, factories.clock, {
                        kind: "failed",
                        failure: providerFailure(profile, error),
                      }),
                    );
                  });
                return Effect.void;
              }),
            ),
          ),
        ),
      interrupt: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            request(() =>
              state.client.notify("session/cancel", { sessionId: state.sourceSessionId }),
            ),
          ),
        ),
      stop: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            Effect.promise(async () => {
              if (!state.context.terminal && state.promptActive) {
                await state.client
                  .notify("session/cancel", { sessionId: state.sourceSessionId })
                  .catch(() => undefined);
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
              return Effect.fail(failure("protocol", `${name} approval request is not pending.`));
            }
            state.approvals.delete(input.requestId);
            if (state.executionPolicy === "plan" && input.approved) {
              return request(() =>
                state.client.respondPermission(pending.providerRequestId, pending.rejectOptionId),
              ).pipe(
                Effect.zipRight(
                  Effect.fail(
                    failure("unauthorized", "Plan mode cannot approve provider actions."),
                  ),
                ),
              );
            }
            const selected = input.approved ? pending.allowOptionId : pending.rejectOptionId;
            return request(() =>
              state.client.respondPermission(pending.providerRequestId, selected),
            );
          }),
        ),
      answerUserInput: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            if (profile.userQuestions === "unsupported") {
              return Effect.fail(
                failure(
                  "unsupported",
                  `${name} cannot request user input through its current ACP runtime.`,
                ),
              );
            }
            const pending = state.questions.get(input.requestId);
            if (pending === undefined) {
              return Effect.fail(failure("protocol", `${name} question is not pending.`));
            }
            state.questions.delete(input.requestId);
            const optionId = pending.optionIds.get(input.answer) ?? pending.skipOptionId;
            return request(() =>
              state.client.respondPermission(pending.providerRequestId, optionId),
            );
          }),
        ),
      answerTool: () => unsupportedAnswerTool(capabilities.appManagedTools),
    };
  });
}

function rememberPermission(state: SessionState, mapped: AcpMappedPermission): void {
  if (mapped.kind === "approval") {
    state.approvals.set(mapped.requestId, {
      kind: "approval",
      providerRequestId: mapped.providerRequestId,
      allowOptionId: mapped.allowOptionId,
      rejectOptionId: mapped.rejectOptionId,
    });
  } else if (mapped.kind === "question") {
    state.questions.set(mapped.requestId, {
      kind: "question",
      providerRequestId: mapped.providerRequestId,
      optionIds: mapped.optionIds,
      ...(mapped.skipOptionId === undefined ? {} : { skipOptionId: mapped.skipOptionId }),
    });
  }
}

type RuntimeEventWithoutEnvelope = ProviderRuntimeEvent extends infer RuntimeEvent
  ? RuntimeEvent extends ProviderRuntimeEvent
    ? Omit<RuntimeEvent, "instanceId" | "sessionId" | "sequence" | "correlationId" | "occurredAt">
    : never
  : never;

function eventFor(
  state: SessionState,
  clock: () => string,
  value: RuntimeEventWithoutEnvelope,
): ProviderRuntimeEvent {
  const event = {
    ...value,
    instanceId: state.context.instanceId,
    sessionId: state.sessionId,
    sequence: state.context.sequence,
    correlationId: state.context.correlationId,
    occurredAt: clock() as UtcTimestamp,
  } as ProviderRuntimeEvent;
  state.context.sequence += 1;
  return event;
}
