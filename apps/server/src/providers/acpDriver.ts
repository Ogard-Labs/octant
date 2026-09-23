import { isAbsolute, resolve } from "node:path";
import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderAuthenticationAttempt,
  decodeProviderFailure,
  decodeProviderModelId,
  decodeProviderProbeResult,
  type ProviderExecutionPolicy,
  type ProviderCapabilitySupport,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelOptionValues,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  rejectUnsupportedChatTurn,
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Effect, Exit, PubSub, Scope, Stream } from "effect";
import {
  mapAcpNotification,
  mapAcpPermissionRequest,
  type AcpEventContext,
  type AcpMappedPermission,
} from "./acpEventMapper";
import type { AcpConnection, AcpProcessPort, AcpSessionMode } from "./acpProcess";
import type { AcpProviderProfile } from "./acpProfiles";
import { createAcpManagedToolsBridge, type AcpManagedToolsBridge } from "./acpManagedTools";
import {
  AcpFailure,
  type AcpBrowserAuthenticationAttempt,
  type AcpConfigOptionsResult,
  type AcpMcpHttpServer,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpServerNotification,
  type AcpServerRequest,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
} from "./acpProtocol";
import type { ManagedToolAnswer, ManagedToolCallContext } from "./managedMcpTools";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { type ProviderRuntimeRegistry, trackProviderProcess } from "./providerRuntimeRegistry";

/** The subset of the ACP client the driver depends on (fakeable in tests). */
export interface AcpClientPort {
  readonly authenticate: () => Promise<void>;
  readonly startBrowserAuthentication: () => Promise<AcpBrowserAuthenticationAttempt>;
  readonly completeBrowserAuthentication: (attemptId: string) => Promise<void>;
  readonly newSession: (
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ) => Promise<AcpNewSessionResult>;
  readonly loadSession: (
    sessionId: string,
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ) => Promise<AcpNewSessionResult>;
  readonly resumeSession: (
    sessionId: string,
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ) => Promise<AcpNewSessionResult>;
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
  readonly authentication?: "provider-owned" | "subscription" | "api-key";
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly clientFactory?: (connection: AcpConnection) => AcpClientPort;
  readonly managedToolsBridgeFactory?: typeof createAcpManagedToolsBridge;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
}

interface ResumeIdentity {
  readonly root: string;
  readonly mode: AcpSessionMode;
  readonly modelId: string;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
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

interface AcpRetainedRuntime {
  readonly source: AcpNewSessionResult;
  readonly scope: Scope.CloseableScope;
  readonly client: AcpClientPort;
  readonly managedTools: AcpManagedToolsLease | undefined;
  readonly appManagedTools: ProviderCapabilitySupport;
  readonly version: string;
  readonly compatibility: string;
  readonly history: AcpEventContext["tools"];
  readonly close: () => Promise<void>;
  readonly idle: () => void;
  readonly activate: () => void;
  readonly isClosed: () => boolean;
}

interface SessionState {
  readonly runtime: AcpRetainedRuntime;
  completed: boolean;
  readonly releaseOwnership: () => void;
  readonly releaseTaskOwnership: () => void;
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
  readonly toolNames: Set<string>;
  readonly pendingToolAnswers: Map<string, PendingToolAnswer>;
  readonly appManagedTools: ProviderCapabilitySupport;
  managedTools: AcpManagedToolsLease | undefined;
  promptActive: boolean;
  closed: boolean;
}

interface PendingToolAnswer {
  readonly controller: AbortController;
  readonly resolve: (answer: ManagedToolAnswer) => void;
}

interface AcpManagedToolsLease {
  readonly bridge: AcpManagedToolsBridge;
  readonly catalogKey: string;
}

interface Factories {
  readonly clientFactory: (connection: AcpConnection) => AcpClientPort;
  readonly clock: () => string;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
}

function baseCapabilities(
  profile: AcpProviderProfile,
  appManagedTools: ProviderCapabilitySupport = "unsupported",
) {
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
    harnessAutoReview: "unsupported",
    ...unsupportedChatCapabilities,
    appManagedTools,
  } as const;
}

function negotiatedAppManagedTools(
  initialized: AcpConnection["initialized"],
  profile: AcpProviderProfile,
  version: string,
): ProviderCapabilitySupport {
  // The managed bridge is a loopback HTTP endpoint. The current Linux
  // Bubblewrap launch has no narrow host-loopback rule; sharing its network
  // namespace would grant wider egress, so Linux stays fail-closed here.
  return process.platform === "darwin" &&
    (initialized.agentCapabilities.mcpCapabilities?.http === true ||
      (initialized.agentCapabilities.mcpCapabilities?.http === undefined &&
        profile.unadvertisedHttpMcpVersions?.includes(version) === true))
    ? "supported"
    : "unsupported";
}

function failure(
  category: ProviderFailure["category"],
  message: string,
  extras?: {
    readonly reason?: ProviderFailure["reason"];
    readonly diagnostic?: ProviderFailure["diagnostic"];
  },
): ProviderFailure {
  return {
    category,
    message,
    ...(extras?.reason === undefined ? {} : { reason: extras.reason }),
    ...(extras?.diagnostic === undefined ? {} : { diagnostic: extras.diagnostic }),
  };
}

function providerFailure(
  profile: AcpProviderProfile,
  error: unknown,
  processContext?: {
    readonly stage: "authentication" | "model-discovery";
    readonly detectedVersion: string;
  },
): ProviderFailure {
  const name = profile.displayName;
  try {
    return decodeProviderFailure(error);
  } catch {
    if (error instanceof AcpFailure) {
      if (error.message.toLowerCase().includes("authentication")) {
        return failure(
          "unauthenticated",
          profile.unauthenticatedMessage,
          processContext === undefined ? undefined : { reason: "authentication-required" },
        );
      }
      if (error.kind === "protocol") return failure("protocol", `${name} ACP protocol failed.`);
      if (error.kind === "timeout") return failure("unavailable", `${name} ACP request timed out.`);
      if (error.kind === "closed") return failure("interrupted", `${name} ACP connection closed.`);
      if (error.kind === "remote" && processContext !== undefined) {
        const context =
          error.remoteReason === "configuration"
            ? "Provider refused the ACP request because its configuration was invalid."
            : error.remoteReason === "workspace"
              ? "Provider refused the ACP request for the managed workspace."
              : error.remoteReason === "model"
                ? "Provider refused the ACP request because no usable model was available."
                : error.remoteReason === "network"
                  ? "Provider could not reach its remote service."
                  : "Provider refused the ACP request without a classified reason.";
        return {
          ...failure("provider-failed", `${name} request failed.`, {
            reason:
              error.remoteReason === "model"
                ? "no-usable-model"
                : error.remoteReason === "configuration"
                  ? "runtime-incompatible"
                  : undefined,
          }),
          diagnostic: {
            stage: processContext.stage,
            kind: "protocol-failed",
            detectedVersion: processContext.detectedVersion,
            stderrContext: context,
          },
        };
      }
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
  const reasoning = resolveReasoningOption(profile, options);
  const reasoningValues = (reasoning?.options ?? [])
    .map((choice) => choice.value.trim())
    .filter((value) => value.length > 0);
  const modelMeta = new Map(
    (models?.availableModels ?? [])
      .filter((item) => item._meta !== undefined)
      .map((item) => [item.modelId, item._meta] as const),
  );
  return selectable.map((item) => {
    // An agent may publish a model's levels in the model's own session
    // metadata rather than a session config option, one set per model. Grok
    // Build sends no config options at all, so reading only the option read
    // every one of its models as unable to reason.
    const declaredLevels =
      profile.sessionMetaReasoning?.levelsOf(modelMeta.get(item.value) ?? {}) ?? [];
    const levels = reasoningValues.length > 0 ? reasoningValues : declaredLevels;
    return {
      id: decodeProviderModelId(item.value),
      displayName: item.name,
      source: "discovered" as const,
      verification: "verified" as const,
      reasoning:
        reasoning !== undefined || declaredLevels.length > 0
          ? ("supported" as const)
          : ("unavailable" as const),
      inputModalities: textOnlyInputModalities,
      // The agent reasons, and that capability is reported above. A level is
      // declared only because the session applies it: the driver sets the
      // profile's reasoning option, or carries it in the session metadata, when
      // it starts or resumes a session, so the control the composer draws is
      // one the agent honours rather than a preference that is saved and
      // dropped.
      options:
        levels.length === 0
          ? []
          : [
              {
                id: reasoning?.id ?? profile.reasoningOptionId,
                displayName: reasoning?.name ?? "Reasoning",
                kind: "selection" as const,
                values: levels as [string, ...string[]],
              },
            ],
    };
  });
}

/**
 * Find the session config option that carries the agent's reasoning level.
 *
 * The profile names the id its agent is known to use, and the agent's own
 * `category` is the portable spelling of the same thing: the ACP spec's
 * `thought_level`, or plain `thinking` as some agents write it. Matching only
 * the profile's id read the installed Grok agent — which reports
 * `reasoning_effort` under `category: "thought_level"` — as an agent that
 * cannot reason at all, so the composer never offered a level.
 */
function resolveReasoningOption(
  profile: AcpProviderProfile,
  options: ReadonlyArray<AcpSessionConfigOption>,
): AcpSessionConfigOption | undefined {
  const byProfileId = options.find((option) => option.id === profile.reasoningOptionId);
  if (byProfileId !== undefined) return byProfileId;
  return options.find(
    (option) => option.category === "thought_level" || option.category === "thinking",
  );
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
  const models = normalizeModels(profile, options, sessionModels);
  const reasoning =
    resolveReasoningOption(profile, options) !== undefined ||
    models.some((model) => model.reasoning === "supported")
      ? ("supported" as const)
      : ("unavailable" as const);
  const resume =
    initialized.agentCapabilities.loadSession === true ||
    initialized.agentCapabilities.sessionCapabilities?.resume !== undefined
      ? ("supported" as const)
      : ("unsupported" as const);
  return decodeProviderProbeResult({
    instanceId,
    readiness: models.length === 0 ? "degraded" : "ready",
    processState: "stopped",
    detectedVersion: version,
    ...(credentialStatus === undefined ? {} : { credentialStatus }),
    models,
    capabilities: {
      ...baseCapabilities(profile, negotiatedAppManagedTools(initialized, profile, version)),
      resume,
      reasoning,
    },
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
  const request = <A>(
    operation: () => Promise<A>,
    processContext?: Parameters<typeof providerFailure>[2],
  ): Effect.Effect<A, ProviderFailure> =>
    Effect.tryPromise({
      try: operation,
      catch: (error) => providerFailure(profile, error, processContext),
    });

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
      purpose: "probe",
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
    detectedVersion: string,
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
        scratch = yield* request(() => client.newSession(root), {
          stage: "model-discovery",
          detectedVersion,
        });
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
          failure("incompatible", `${name} advertised an unreviewed command inventory.`, {
            reason: "runtime-incompatible",
          }),
        );
      }
      return scratch;
    });

  return {
    kind: profile.kind,
    conversationOwnership: "provider",
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
        if (profile.authenticateOnProbe) {
          yield* request(() => client.authenticate(), {
            stage: "authentication",
            detectedVersion: connection.version,
          });
        }
        const scratch =
          profile.reviewedCommands === undefined
            ? yield* request(() => client.newSession(connection.root), {
                stage: "model-discovery",
                detectedVersion: connection.version,
              })
            : yield* probeCommandInventory(
                client,
                profile.reviewedCommands,
                connection.root,
                connection.version,
              );
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
    const queue = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const pendingStarts = new Set<Promise<SessionState>>();
    let connectionClosing = false;
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
      cancelPendingTools(state);
      state.approvals.clear();
      state.questions.clear();
      state.toolNames.clear();
      state.managedTools = undefined;
      await state.runtime.close();
      state.releaseOwnership();
      const count = options.runtimeRegistry.activeSessionCount(options.instanceId);
      options.runtimeRegistry.setActiveSessionCount(options.instanceId, Math.max(0, count - 1));
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        connectionClosing = true;
        await Promise.allSettled(pendingStarts);
        await Promise.all([...sessions.values()].map(closeState));
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(queue));
      }),
    );

    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(queue, event));
    };

    const requestManagedTool = async (
      state: SessionState | undefined,
      name: string,
      inputJson: string,
      signal: AbortSignal,
      _context?: ManagedToolCallContext,
    ): Promise<ManagedToolAnswer> => {
      if (
        state === undefined ||
        !state.toolNames.has(name) ||
        state.closed ||
        !state.promptActive ||
        state.context.terminal ||
        signal.aborted
      ) {
        return {
          resultJson: signal.aborted
            ? '{"error":"tool-interrupted"}'
            : '{"error":"tool-unavailable"}',
          isError: true,
        };
      }
      const requestId = `acp-tool-${crypto.randomUUID()}`;
      return new Promise<ManagedToolAnswer>((resolve) => {
        const controller = new AbortController();
        const finish = (answer: ManagedToolAnswer) => {
          signal.removeEventListener("abort", cancel);
          resolve(answer);
        };
        const cancel = () => {
          if (!state.pendingToolAnswers.delete(requestId)) return;
          controller.abort();
          finish({ resultJson: '{"error":"tool-interrupted"}', isError: true });
        };
        state.pendingToolAnswers.set(requestId, { controller, resolve: finish });
        signal.addEventListener("abort", cancel, { once: true });
        offer(
          eventFor(state, factories.clock, {
            kind: "tool-request",
            requestId,
            toolName: name,
            inputJson,
          }),
        );
      });
    };

    function cancelPendingTools(state: SessionState): void {
      for (const [requestId, pending] of state.pendingToolAnswers) {
        state.pendingToolAnswers.delete(requestId);
        pending.controller.abort();
        pending.resolve({ resultJson: '{"error":"tool-interrupted"}', isError: true });
      }
    }

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
          state.completed = false;
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
        state.completed = false;
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
        readonly tools: ReadonlyArray<ProviderToolDefinition>;
      },
      source: AcpNewSessionResult,
      scope: Scope.CloseableScope,
      client: AcpClientPort,
      managedTools: AcpManagedToolsLease | undefined,
      appManagedTools: ProviderCapabilitySupport,
      releaseOwnership: () => void,
      releaseTaskOwnership: () => void,
      runtime: AcpRetainedRuntime,
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
        tools: new Map(runtime.history),
        requestIds: new Map(),
        makeRequestId: factories.makeRequestId,
      };
      let state!: SessionState;
      const removeNotification = client.onNotification((message) =>
        handleNotification(state, message),
      );
      const removeRequest = client.onRequest((message) => handleRequest(state, message));
      state = {
        runtime,
        completed: false,
        releaseOwnership,
        releaseTaskOwnership,
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
        toolNames: new Set(input.tools.map((tool) => tool.name)),
        pendingToolAnswers: new Map(),
        appManagedTools,
        managedTools,
        promptActive: false,
        closed: false,
      };
      managedTools?.bridge.bind((toolName, inputJson, signal, metadata) =>
        requestManagedTool(state, toolName, inputJson, signal, metadata),
      );
      sessions.set(input.sessionId, state);
      options.runtimeRegistry.setActiveSessionCount(
        options.instanceId,
        options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
      );
      resumeIdentities.set(source.sessionId, {
        root: projectRoot,
        mode,
        modelId: input.modelId,
        tools: input.tools,
      });
      return state;
    };

    const startProcess = async (
      executionPolicy: ProviderExecutionPolicy,
      loopbackPorts: ReadonlyArray<number> = [],
    ) => {
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
              ...(loopbackPorts.length === 0 ? {} : { loopbackPorts }),
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
        return {
          scope,
          client: factories.clientFactory(processConnection),
          connection: processConnection,
        };
      } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      }
    };

    const prepareManagedTools = async (
      definitions: ReadonlyArray<ProviderToolDefinition>,
      stateRef: { state?: SessionState },
    ): Promise<AcpManagedToolsLease | undefined> => {
      if (definitions.length === 0) return undefined;
      const catalogKey = JSON.stringify(definitions);
      const bridge = await (options.managedToolsBridgeFactory ?? createAcpManagedToolsBridge)(
        definitions,
        (toolName, inputJson, signal, context) =>
          requestManagedTool(stateRef.state, toolName, inputJson, signal, context),
      );
      return { bridge, catalogKey };
    };

    const createState = (input: {
      readonly sessionId: ProviderSessionId;
      readonly modelId: string;
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly modelOptionValues?: ProviderModelOptionValues;
      readonly sourceSessionId?: string;
      readonly tools: ReadonlyArray<ProviderToolDefinition>;
    }) =>
      request(() => {
        const pending = (async () => {
          if (connectionClosing) throw failure("interrupted", "ACP connection is closing.");
          const previous = sessions.get(input.sessionId);
          if (previous !== undefined && !previous.closed) {
            if (
              input.sourceSessionId === undefined ||
              (previous.promptActive && !previous.context.terminal)
            )
              throw failure("protocol", "ACP session already has an active owner.");
            await closeState(previous);
            sessions.delete(input.sessionId);
          }
          const ownership = options.runtimeRegistry.claimNativeSession(
            options.instanceId,
            JSON.stringify(["acp-task", input.sessionId]),
          );
          if (ownership.status === "refused") throw ownership.failure;
          let releaseNative: (() => void) | undefined;
          const releaseOwnership = () => {
            releaseNative?.();
            ownership.release();
          };
          const claimNative = (identity: string) => {
            const claim = options.runtimeRegistry.claimNativeSession(
              options.instanceId,
              JSON.stringify(["acp-native", profile.kind, identity]),
            );
            if (claim.status === "refused") throw claim.failure;
            releaseNative = claim.release;
          };
          let scope: Scope.CloseableScope | undefined;
          let managedTools: AcpManagedToolsLease | undefined;
          let registered: SessionState | undefined;
          let runtime: AcpRetainedRuntime | undefined;
          const compatibility = JSON.stringify([
            profile.kind,
            input.sessionId,
            options.binaryPath,
            options.managedHome,
            projectRoot,
            mode,
            input.modelId,
            input.modelOptionValues ?? {},
            input.executionPolicy,
            options.authentication,
            input.tools,
          ]);
          const nativeKey = (identity: string) =>
            JSON.stringify(["acp-native", profile.kind, identity]);
          let shutdownRequested = false;
          let finishStartup = () => {};
          const startup = new Promise<void>((resolve) => {
            finishStartup = resolve;
          });
          ownership.onShutdown(async () => {
            shutdownRequested = true;
            await startup;
            if (registered !== undefined) await closeState(registered);
          });
          try {
            if (input.sourceSessionId !== undefined) {
              runtime = (
                await options.runtimeRegistry.takeNativeSessionRuntime<AcpRetainedRuntime>(
                  options.instanceId,
                  nativeKey(input.sourceSessionId),
                  compatibility,
                )
              )?.value;
              if (runtime?.isClosed()) runtime = undefined;
              if (runtime !== undefined) {
                runtime.activate();
                if (connectionClosing || shutdownRequested)
                  throw failure("interrupted", "ACP connection is closing.");
                registered = await register(
                  input,
                  runtime.source,
                  runtime.scope,
                  runtime.client,
                  runtime.managedTools,
                  runtime.appManagedTools,
                  ownership.release,
                  ownership.release,
                  runtime,
                );
                return registered;
              }
              claimNative(input.sourceSessionId);
            }
            const refusal = profile.refuses?.(mode, input.executionPolicy);
            if (refusal !== undefined) throw failure("incompatible", refusal);
            if (input.tools.length > 0 && process.platform !== "darwin") {
              throw failure(
                "unsupported",
                "App-managed tools are unsupported by this ACP runtime on this platform.",
              );
            }
            const stateRef: { state?: SessionState } = {};
            managedTools = await prepareManagedTools(input.tools, stateRef);
            const started = await startProcess(
              input.executionPolicy,
              managedTools?.bridge.port === undefined ? [] : [managedTools.bridge.port],
            );
            scope = started.scope;
            const { client, connection } = started;
            const appManagedTools = negotiatedAppManagedTools(
              connection.initialized,
              profile,
              connection.version,
            );
            if (input.tools.length > 0 && appManagedTools !== "supported") {
              throw failure(
                appManagedTools,
                "App-managed tools are unsupported by this ACP runtime.",
              );
            }
            const mcpServers = managedTools === undefined ? [] : [managedTools.bridge.server];
            // A level the agent takes in the session metadata is applied with the
            // session that selects the model: the agent's own model call resets a
            // level it did not set, so applying the two separately would drop it.
            // Nothing else changes shape: a session whose thread carries no level
            // is opened exactly as the standard path opens it.
            const requestedLevel = input.modelOptionValues?.[profile.reasoningOptionId];
            const sessionMeta =
              requestedLevel === undefined || requestedLevel.trim().length === 0
                ? undefined
                : profile.sessionMetaReasoning?.meta({
                    modelId: input.modelId,
                    level: requestedLevel,
                  });
            const sourceSessionId = input.sourceSessionId;
            // Native resume keeps agent context without replaying its growing
            // transcript. Retain profile compatibility for older runtimes that
            // implement resume but do not advertise the optional capability.
            const resumeWithoutReplay =
              connection.initialized.agentCapabilities.sessionCapabilities?.resume !== undefined ||
              profile.resumeMethod === "session/resume";
            const source =
              sourceSessionId === undefined
                ? sessionMeta === undefined
                  ? mcpServers.length === 0
                    ? await client.newSession(runtimeRoot)
                    : await client.newSession(runtimeRoot, mcpServers)
                  : await client.newSession(runtimeRoot, mcpServers, sessionMeta)
                : resumeWithoutReplay
                  ? sessionMeta === undefined
                    ? mcpServers.length === 0
                      ? await client.resumeSession(sourceSessionId, runtimeRoot)
                      : await client.resumeSession(sourceSessionId, runtimeRoot, mcpServers)
                    : await client.resumeSession(
                        sourceSessionId,
                        runtimeRoot,
                        mcpServers,
                        sessionMeta,
                      )
                  : sessionMeta === undefined
                    ? mcpServers.length === 0
                      ? await client.loadSession(sourceSessionId, runtimeRoot)
                      : await client.loadSession(sourceSessionId, runtimeRoot, mcpServers)
                    : await client.loadSession(
                        sourceSessionId,
                        runtimeRoot,
                        mcpServers,
                        sessionMeta,
                      );
            if (sourceSessionId !== undefined && source.sessionId !== sourceSessionId)
              throw failure("stale-resume", "The provider returned a different native session.");
            if (sourceSessionId === undefined) claimNative(source.sessionId);
            if (managedTools !== undefined) await managedTools.bridge.attested;
            // A profile that supplies its own request shape is describing an agent
            // whose reply the standard result schema does not fit, so that reply is
            // taken as-is. Everything else is standard ACP and stays validated: a
            // malformed success there would otherwise register a session whose
            // model and authority mode were never confirmed.
            // The reply names the model the session opened with, which is the
            // same confirmation the standard selection would have acted on. A
            // session that already opened the requested model is left alone,
            // because switching it would reset the level it was opened with.
            const modelOpenedWithSession =
              sessionMeta !== undefined && source.models?.currentModelId === input.modelId;
            const setModelCall = profile.setModelCall?.(source.sessionId, input.modelId);
            // The agent's config options can change with the model selection, so
            // the reply to each standard call carries the current set; keep the
            // newest one rather than the session's original list.
            let configOptions = source.configOptions ?? [];
            if (!modelOpenedWithSession) {
              if (setModelCall === undefined) {
                const result = await client.setConfigOption(
                  source.sessionId,
                  "model",
                  input.modelId,
                );
                configOptions = result.configOptions;
              } else {
                await client.call(setModelCall.method, setModelCall.params);
              }
            }
            const modeValue = profile.sessionMode(mode, input.executionPolicy);
            const setModeCall = profile.setModeCall?.(source.sessionId, modeValue);
            if (setModeCall === undefined) {
              const result = await client.setConfigOption(source.sessionId, "mode", modeValue);
              configOptions = result.configOptions;
            } else {
              await client.call(setModeCall.method, setModeCall.params);
            }
            // ACP reports the agent's reasoning control as a session config
            // option, and a chat turn carries only the prompt, so the level the
            // user chose for this model is applied here. A value the agent does
            // not offer is left alone: the probe declares the option from the
            // agent's own choices, which is the same check from the other side.
            const reasoningOption = resolveReasoningOption(profile, configOptions);
            const requestedReasoning =
              reasoningOption === undefined
                ? undefined
                : input.modelOptionValues?.[reasoningOption.id];
            if (
              reasoningOption !== undefined &&
              requestedReasoning !== undefined &&
              requestedReasoning.trim().length > 0 &&
              reasoningOption.options.some((choice) => choice.value === requestedReasoning)
            ) {
              await client.setConfigOption(
                source.sessionId,
                reasoningOption.id,
                requestedReasoning,
              );
            }
            if (connectionClosing || shutdownRequested)
              throw failure("interrupted", "ACP connection is closing.");
            let closed = false;
            let closing: Promise<void> | undefined;
            let removeIdle = () => {};
            const runtimeScope = scope;
            const runtimeTools = managedTools;
            const close = (): Promise<void> => {
              if (closing !== undefined) return closing;
              closed = true;
              removeIdle();
              runtimeTools?.bridge.bind(undefined);
              closing = (async () => {
                await runtimeTools?.bridge.close();
                if (profile.closesSessions)
                  await client.closeSession(source.sessionId).catch(() => undefined);
                await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
                releaseNative?.();
              })();
              return closing;
            };
            runtime = {
              source,
              scope: runtimeScope,
              client,
              managedTools: runtimeTools,
              appManagedTools,
              version: connection.version,
              compatibility,
              history: new Map(),
              close,
              isClosed: () => closed,
              activate: () => {
                removeIdle();
                removeIdle = () => {};
              },
              idle: () => {
                runtimeTools?.bridge.bind(undefined);
                const refuse = () => {
                  void close().catch(() => undefined);
                };
                const removeNotification = client.onNotification(refuse);
                const removeRequest = client.onRequest(refuse);
                removeIdle = () => {
                  removeNotification();
                  removeRequest();
                };
              },
            };
            void connection.exited.then(
              () => close().catch(() => undefined),
              () => close().catch(() => undefined),
            );
            const state = await register(
              input,
              source,
              scope,
              client,
              managedTools,
              appManagedTools,
              releaseOwnership,
              ownership.release,
              runtime,
            );
            registered = state;
            stateRef.state = state;
            return state;
          } catch (error) {
            // The bridge is opened before session/new so the agent can connect to
            // it during setup. Close it if setup or model selection fails.
            if (runtime !== undefined) await runtime.close();
            await managedTools?.bridge.close().catch(() => undefined);
            if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
            releaseOwnership();
            throw error;
          } finally {
            finishStartup();
          }
        })();
        pendingStarts.add(pending);
        void pending.finally(() => pendingStarts.delete(pending)).catch(() => undefined);
        return pending;
      });

    return {
      toolRequestSignal: ({ sessionId, requestId }) =>
        sessions.get(sessionId)?.pendingToolAnswers.get(requestId)?.controller.signal ??
        AbortSignal.abort(),
      subscribe: Stream.fromPubSub(queue, { scoped: true }),
      start: (input) =>
        createState({ ...input, tools: input.tools ?? [] }).pipe(
          Effect.map((state) => ({
            sessionId: input.sessionId,
            resumeCursor: {
              driverKind: profile.kind,
              value: state.sourceSessionId,
              binding: {
                instanceId: options.instanceId,
                sessionId: state.sessionId,
                projectRoot,
                mode,
                modelId: input.modelId,
              },
            },
          })),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== profile.kind) {
          return Effect.fail(failure("stale-resume", `${name} resume identity is incompatible.`));
        }
        const binding = input.resumeCursor.binding;
        if (
          binding !== undefined &&
          (binding.instanceId !== options.instanceId ||
            binding.sessionId !== input.sessionId ||
            binding.projectRoot !== projectRoot ||
            binding.mode !== mode)
        ) {
          return Effect.fail(
            failure("stale-resume", "The saved session belongs to another task or Project."),
          );
        }
        const identity =
          binding === undefined
            ? resumeIdentities.get(input.resumeCursor.value)
            : {
                root: binding.projectRoot,
                mode: binding.mode,
                modelId: binding.modelId,
                tools: input.tools ?? resumeIdentities.get(input.resumeCursor.value)?.tools ?? [],
              };
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
          tools: input.tools ?? identity.tools,
          ...(input.modelOptionValues === undefined
            ? {}
            : { modelOptionValues: input.modelOptionValues }),
        }).pipe(
          Effect.map(() => ({ sessionId: input.sessionId, resumeCursor: input.resumeCursor })),
          // A refusal outlives resume: fx still cannot serve Chat or Plan on an
          // existing session, and reporting that as a stale cursor would hide
          // the reason and invite a pointless retry.
          Effect.mapError((error) =>
            error.category === "incompatible"
              ? error
              : failure("stale-resume", `${name} session could not be resumed.`),
          ),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) =>
            rejectUnsupportedChatTurn(input, {
              ...capabilities,
              appManagedTools: state.appManagedTools,
            }).pipe(
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
                const catalogKey = JSON.stringify(input.tools);
                if (
                  (state.managedTools === undefined) !== (input.tools.length === 0) ||
                  (state.managedTools !== undefined && state.managedTools.catalogKey !== catalogKey)
                ) {
                  return Effect.fail(
                    failure(
                      "invalid-configuration",
                      `${name} cannot change app-managed tools while its session is active.`,
                    ),
                  );
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
                      state.completed = true;
                      offer(
                        eventFor(state, factories.clock, {
                          kind: "completed",
                          resumeCursor: {
                            driverKind: profile.kind,
                            value: state.sourceSessionId,
                            binding: {
                              instanceId: options.instanceId,
                              sessionId: state.sessionId,
                              projectRoot,
                              mode,
                              modelId: decodeProviderModelId(state.modelId),
                            },
                          },
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
              if (
                state.completed &&
                profile.retainedSessionVersions?.includes(state.runtime.version) === true &&
                state.approvals.size === 0 &&
                state.questions.size === 0 &&
                state.pendingToolAnswers.size === 0 &&
                [...state.context.tools.values()].every((tool) => tool.terminal) &&
                !state.runtime.isClosed()
              ) {
                state.closed = true;
                state.removeNotification();
                state.removeRequest();
                state.runtime.history.clear();
                for (const [id, tool] of [...state.context.tools].slice(-256))
                  state.runtime.history.set(id, tool);
                state.runtime.idle();
                sessions.delete(sessionId);
                options.runtimeRegistry.setActiveSessionCount(
                  options.instanceId,
                  Math.max(0, options.runtimeRegistry.activeSessionCount(options.instanceId) - 1),
                );
                state.releaseTaskOwnership();
                await options.runtimeRegistry.retainNativeSessionRuntime(
                  options.instanceId,
                  JSON.stringify(["acp-native", profile.kind, state.sourceSessionId]),
                  {
                    value: state.runtime,
                    compatibility: state.runtime.compatibility,
                    close: state.runtime.close,
                  },
                );
              } else {
                await closeState(state);
                sessions.delete(sessionId);
              }
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
      answerTool: (input: ProviderToolAnswer) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            if (state.appManagedTools !== "supported") {
              return unsupportedAnswerTool(state.appManagedTools);
            }
            const pending = state.pendingToolAnswers.get(input.requestId);
            if (pending === undefined) {
              return Effect.fail(failure("protocol", `${name} tool request is not pending.`));
            }
            state.pendingToolAnswers.delete(input.requestId);
            pending.controller.abort();
            pending.resolve({
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
