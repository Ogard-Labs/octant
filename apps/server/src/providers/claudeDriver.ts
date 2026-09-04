import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  decodeProviderFailure,
  decodeProviderProbeResult,
  type ClaudeAuthentication,
  type CorrelationId,
  type PermissionPersistence,
  type ProviderCapabilities,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModel,
  type ProviderModelId,
  type ProviderModelOptionValues,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type UtcTimestamp,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import {
  renderProviderTurnPrompt,
  unsupportedAnswerTool,
  unsupportedChatCapabilities,
  validateChatTurnInput,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Fiber, Option, PubSub, Scope, Stream } from "effect";

import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { claudeAuthorityInputDigest, waitForClaudeAuthorityValue } from "./claudeAuthority";
import {
  isClaudeEffortLevel,
  type ClaudeAgentSdkPort,
  type ClaudeDecodedMessage,
  type ClaudeEffortLevel,
  type ClaudeModelInfo,
  type ClaudeOpenQueryInput,
  type ClaudePermissionMode,
  type ClaudeQueryPort,
  type ClaudeSandboxSettings,
  type ClaudeToolDecision,
} from "./claudeAgentSdkPort";
import {
  mapClaudeMessage,
  mapClaudeToolRequest,
  type ClaudeEventContext,
  type ClaudePendingApproval,
  type ClaudePendingQuestion,
} from "./claudeEventMapper";
import {
  makeClaudeEnvironmentScope,
  type ClaudeEnvironmentScope,
  type ClaudeEnvironmentScopeOptions,
} from "./claudeEnvironment";
import type { ClaudeProcessPort } from "./claudeProcess";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const CLAUDE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "AskUserQuestion"];
const CLAUDE_PLAN_TOOLS = ["Read", "Glob", "Grep"] as const;
const CLAUDE_READ_TOOLS = new Set<string>(CLAUDE_PLAN_TOOLS);
const CLAUDE_INCOMPATIBLE_FALLBACK = "Claude runtime policy is incompatible with Octant.";
const CLAUDE_INCOMPATIBLE_REASONS = new Set([
  "Claude probe did not initialize its runtime.",
  "Claude initialization version did not match the configured binary.",
  "Claude initialized an unsupported account routing policy.",
  "Claude returned no usable models.",
  "Claude initialized an unexpected runtime surface.",
  "Claude did not initialize its runtime stream.",
  "Claude returned an unsupported runtime message.",
  "Claude returned an invalid SDK response.",
]);
/** The tools that write files inside the Project, and nothing else. */
const CLAUDE_EDIT_TOOLS = new Set<string>(["Edit", "Write"]);
const PROBE_MODEL = "sonnet";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const MAX_PENDING_APPROVALS = 4;
const MAX_PRE_TOOL_GRANTS = 16;
const MAX_TOOL_USES_PER_SESSION = 256;
const MAX_TOOL_USES_PER_TURN = 64;
const PRE_TOOL_GRANT_TTL_MS = 30_000;
const USER_ANSWER_MAX_CHARACTERS = 4_096;
const USER_QUESTION_MAX_CHARACTERS = 1_024;

export interface ClaudeExecutionOptions {
  readonly permissionMode: ClaudePermissionMode;
  readonly allowDangerouslySkipPermissions: boolean;
  readonly tools: readonly string[];
}

export function claudeExecutionOptions(policy: ProviderExecutionPolicy): ClaudeExecutionOptions {
  switch (policy) {
    case "full-access":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: [...CLAUDE_TOOLS],
      };
    case "auto-accept-edits":
    case "approval-gated":
      // Both postures run Claude in its ordinary permission mode: Octant's own
      // gate decides every call, so auto-accepting edits stays a decision the
      // host records rather than one the provider makes for it.
      return {
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
        tools: [...CLAUDE_TOOLS],
      };
    case "plan":
      return {
        permissionMode: "plan",
        allowDangerouslySkipPermissions: false,
        tools: [...CLAUDE_PLAN_TOOLS],
      };
  }
}

function claudeSandboxSettings(
  policy: ProviderExecutionPolicy,
  projectRoot: string,
): ClaudeSandboxSettings | undefined {
  if (policy !== "approval-gated" && policy !== "auto-accept-edits") return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ["/"],
      allowRead: [projectRoot],
      allowWrite: [projectRoot],
    },
  };
}

const availableCapabilities: ProviderCapabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
};

const unavailableCapabilities: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "unavailable",
  interruption: "unavailable",
  approvals: "unavailable",
  userQuestions: "unavailable",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unavailable",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unsupported",
  ...unsupportedChatCapabilities,
};

type ClaudeEnvironmentFactory = (
  authentication: ClaudeAuthentication,
  options?: ClaudeEnvironmentScopeOptions,
) => Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope>;

export interface ClaudeDriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly authentication: ClaudeAuthentication;
  readonly process: ClaudeProcessPort;
  readonly sdk: ClaudeAgentSdkPort;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly resumeIdentityPort: ClaudeResumeIdentityPort;
  readonly permissionPersistence?: () => PermissionPersistence;
  readonly makeEnvironmentScope?: ClaudeEnvironmentFactory;
  readonly isProjectConfinedPath: (projectRoot: string, absolutePath: string) => boolean;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
  readonly taskId?: () => string;
  readonly toolCallId?: () => string;
  readonly startupTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
}

export interface ClaudeResumeIdentity {
  readonly providerInstanceId: ProviderInstanceId;
  readonly octantSessionId: ProviderSessionId;
  readonly sdkSessionId: string;
  readonly projectRoot: string;
  readonly modelId: ProviderModelId;
  readonly authentication: ClaudeAuthentication;
}

export interface ClaudeResumeIdentityPort {
  /** Implementations must observe abort before mutation and must not complete a mutation afterward. */
  readonly lookup: (
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ) => Promise<ClaudeResumeIdentity | undefined>;
  readonly put: (identity: ClaudeResumeIdentity, signal: AbortSignal) => Promise<void>;
  readonly remove: (
    input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly sdkSessionId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
}

interface DeferredValue<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
}

interface InFlightSetup {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface ClaudePreToolGrant {
  readonly toolName: string;
  readonly inputDigest: string;
  readonly expiresAt: number;
}

interface ClaudePendingApprovalState extends ClaudePendingApproval {
  readonly decision: DeferredValue<ClaudeToolDecision>;
  readonly reuseKey: string;
}

interface ClaudePendingQuestionState extends ClaudePendingQuestion {
  readonly answer: DeferredValue<string | undefined>;
  readonly providerPrompt: string;
}

interface SessionState {
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly modelId: ProviderModelId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly authentication: ClaudeAuthentication;
  readonly expectedClaudeSessionId?: string;
  readonly expectedRuntimeVersion: string;
  readonly correlationId: CorrelationId;
  readonly scope: Scope.CloseableScope;
  readonly query: ClaudeQueryPort;
  readonly initialized: DeferredValue<string>;
  terminalResult: DeferredValue<void>;
  readonly pendingApprovals: Map<string, ClaudePendingApprovalState>;
  readonly pendingQuestions: Map<string, ClaudePendingQuestionState>;
  readonly preToolRequests: Map<string, ClaudePreToolGrant>;
  readonly approvalReuse: Set<string>;
  readonly observedToolUseIds: Set<string>;
  readonly settledToolUseIds: Set<string>;
  readonly turnToolUseIds: Set<string>;
  claudeSessionId?: string;
  context?: ClaudeEventContext;
  collector?: Fiber.RuntimeFiber<void, never>;
  outputAccepted: boolean;
  pendingTurns: number;
  terminal: boolean;
  active: boolean;
  releasing: boolean;
  released: boolean;
  releasePromise?: Promise<void>;
}

interface ConnectionFactories {
  readonly clock: () => string;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
  readonly makeTaskId: () => string;
  readonly makeToolCallId: () => string;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function connectionClosingFailure(): ProviderFailure {
  return failure("unavailable", "Claude connection is closing.");
}

function throwIfSetupCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw connectionClosingFailure();
}

function awaitSetupPromise<A>(promise: PromiseLike<A>, signal: AbortSignal): Promise<A> {
  throwIfSetupCancelled(signal);
  return new Promise<A>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => rejectPromise(connectionClosingFailure()));
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(promise).then(
      (value) =>
        finish(() => {
          if (signal.aborted) rejectPromise(connectionClosingFailure());
          else resolvePromise(value);
        }),
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

async function runSetupEffect<A>(
  effect: Effect.Effect<A, ProviderFailure>,
  signal: AbortSignal,
): Promise<A> {
  throwIfSetupCancelled(signal);
  const fiber = Effect.runFork(effect);
  const interrupt = () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (Exit.isSuccess(exit)) {
      throwIfSetupCancelled(signal);
      return exit.value;
    }
    if (signal.aborted) throw connectionClosingFailure();
    throw (
      Option.getOrUndefined(Cause.failureOption(exit.cause)) ??
      failure("provider-failed", "Claude request failed.")
    );
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}

function sanitizeFailure(
  error: unknown,
  fallbackCategory: ProviderFailure["category"] = "provider-failed",
  fallbackMessage = "Claude request failed.",
): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return failure(fallbackCategory, fallbackMessage);
  }
}

function deferred<A>(): DeferredValue<A> {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function approvalReuseKey(toolName: string, digest: string): string {
  return `${toolName}:${digest}`;
}

function denyClaudeToolRequest(
  state: SessionState | undefined,
  toolUseId: string,
  message: string,
): ClaudeToolDecision {
  if (state !== undefined) {
    state.preToolRequests.delete(toolUseId);
    if (state.observedToolUseIds.has(toolUseId)) state.settledToolUseIds.add(toolUseId);
  }
  return { behavior: "deny", message };
}

function expireClaudePreToolGrants(state: SessionState, now: number): void {
  for (const [toolUseId, grant] of state.preToolRequests) {
    if (grant.expiresAt > now) continue;
    state.preToolRequests.delete(toolUseId);
    state.settledToolUseIds.add(toolUseId);
  }
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function validatedClaudeQuestionPrompt(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const question = questions[0];
  if (typeof question !== "object" || question === null || Array.isArray(question)) {
    return undefined;
  }
  const prompt = (question as Readonly<Record<string, unknown>>).question;
  if (
    typeof prompt !== "string" ||
    exceedsCodePointLimit(prompt, USER_QUESTION_MAX_CHARACTERS) ||
    prompt.trim().length === 0
  ) {
    return undefined;
  }
  return prompt;
}

function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "completed" ||
    event.kind === "failed" ||
    event.kind === "interrupted" ||
    event.kind === "waiting"
  );
}

/**
 * The runtime names a model by its family alias ("Sonnet", "Opus", "Default
 * (recommended)") and keeps the versioned name for the first clause of the
 * description ("Sonnet 5 · Efficient for routine tasks"; Claude Code 2.1.234).
 * A picker that says only "Sonnet" hides which generation a thread runs on,
 * so the versioned clause is the display name when it extends the alias, and
 * the default entry says what it resolves to.
 */
function versionedClaudeModelName(displayName: string, description: string): string {
  const versioned = description.split("·")[0]?.trim() ?? "";
  if (versioned.length === 0) return displayName;
  if (versioned.toLowerCase().startsWith(displayName.toLowerCase())) return versioned;
  if (displayName.toLowerCase().startsWith("default")) return `Default (${versioned})`;
  return displayName;
}

function modelFromClaude(source: ClaudeModelInfo): ProviderModel | undefined {
  const id = source.id.trim();
  const displayName = versionedClaudeModelName(source.displayName.trim(), source.description);
  if (id.length === 0 || displayName.length === 0) return undefined;
  const effort = source.supportsEffort
    ? [...new Set(source.supportedEffortLevels.map((value) => value.trim()))].filter(Boolean)
    : [];
  return {
    id: id as ProviderModelId,
    displayName,
    source: "discovered",
    verification: "verified",
    reasoning: source.supportsEffort ? "supported" : "unavailable",
    // Every model Claude Code offers takes images. Reporting text only made
    // the composer refuse a pasted screenshot on Sonnet with "does not
    // support images", which was Octant's claim, not the model's.
    inputModalities: ["text", "image"],
    options:
      effort.length === 0
        ? []
        : [
            {
              id: "effort",
              displayName: "Effort",
              kind: "selection",
              values: effort as [string, ...string[]],
            },
          ],
  };
}

/**
 * The `effort` value to hand the Agent SDK: only a level the verified model
 * observation declared for this model. Anything else (unknown option ids, a
 * level this model does not support) is dropped so the SDK default applies.
 */
function selectedEffort(
  model: ProviderModel,
  values: ProviderModelOptionValues | undefined,
): ClaudeEffortLevel | undefined {
  const requested = values?.["effort"];
  if (requested === undefined || !isClaudeEffortLevel(requested)) return undefined;
  const option = model.options.find((candidate) => candidate.id === "effort");
  return option?.kind === "selection" && option.values.includes(requested) ? requested : undefined;
}

function claudeIncompatibleMessage(message: string): string {
  return CLAUDE_INCOMPATIBLE_REASONS.has(message) ? message : CLAUDE_INCOMPATIBLE_FALLBACK;
}

function observation(
  options: ClaudeDriverOptions,
  input: {
    readonly readiness: "ready" | "unauthenticated" | "incompatible" | "unavailable";
    readonly version: string;
    readonly models?: readonly ProviderModel[];
    readonly credentialStatus?: "stored" | "missing" | "unavailable";
    readonly message?: string;
  },
  clock: () => string,
) {
  const observedAt = clock() as UtcTimestamp;
  const result = decodeProviderProbeResult({
    instanceId: options.instanceId,
    readiness: input.readiness,
    processState: "stopped",
    detectedVersion: input.version,
    ...(input.credentialStatus === undefined ? {} : { credentialStatus: input.credentialStatus }),
    models: input.models ?? [],
    capabilities: input.readiness === "ready" ? availableCapabilities : unavailableCapabilities,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.readiness === "ready" ? { lastSuccessfulProbeAt: observedAt } : {}),
    observedAt,
  });
  options.runtimeRegistry.setObservedState(result);
  return result;
}

function brokerHas(options: ClaudeDriverOptions): Effect.Effect<boolean, ProviderFailure> {
  if (options.credentialResolver === undefined) {
    return Effect.fail(failure("provider-failed", "Claude credential broker is unavailable."));
  }
  return Effect.tryPromise({
    try: () => options.credentialResolver!.has(options.instanceId),
    catch: () => failure("provider-failed", "Claude credential broker is unavailable."),
  });
}

function brokerResolve(options: ClaudeDriverOptions): Effect.Effect<string, ProviderFailure> {
  if (options.credentialResolver === undefined) {
    return Effect.fail(failure("provider-failed", "Claude credential broker is unavailable."));
  }
  return Effect.tryPromise({
    try: async () => {
      const value = await options.credentialResolver!.resolve(options.instanceId);
      if (value.trim().length === 0) {
        throw failure("unauthenticated", "Claude API-key credential is missing.");
      }
      return value;
    },
    catch: (error) => {
      const sanitized = sanitizeFailure(error);
      return sanitized.category === "unauthenticated"
        ? sanitized
        : failure("provider-failed", "Claude credential broker is unavailable.");
    },
  });
}

function probeSdk(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  environmentOptions: ClaudeEnvironmentScopeOptions,
): Effect.Effect<readonly ProviderModel[], ProviderFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const environment = yield* environmentFactory(options.authentication, environmentOptions);
    const query = yield* options.sdk.openQuery({
      binaryPath: options.binaryPath,
      projectRoot: resolve(process.cwd()),
      authEnvironment: environment.environment,
      model: PROBE_MODEL,
      executionPolicy: "plan",
      tools: CLAUDE_PLAN_TOOLS,
      canUseTool: async () => ({ behavior: "deny", message: "Probe cannot use tools." }),
      preToolUse: async () => ({ behavior: "deny", message: "Probe cannot use tools." }),
    });
    // The runtime initializes only once a user message arrives, so the probe
    // reads the catalogue and account through the SDK's control requests
    // and never consumes the message stream.
    const account = yield* query.accountInfo();
    if (!account.ready) {
      return yield* Effect.fail(failure("unauthenticated", "Claude authentication is required."));
    }
    if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
      return yield* Effect.fail(
        failure("protocol", "Claude initialized an unsupported account routing policy."),
      );
    }
    const models = (yield* query.supportedModels()).flatMap((model) => {
      const normalized = modelFromClaude(model);
      return normalized === undefined ? [] : [normalized];
    });
    if (models.length === 0) {
      return yield* Effect.fail(failure("protocol", "Claude returned no usable models."));
    }
    return models;
  });
}

function makeProbe(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  clock: () => string,
) {
  return ({ instanceId }: { readonly instanceId: ProviderInstanceId }) => {
    if (instanceId !== options.instanceId) {
      return Effect.fail(
        failure("invalid-configuration", "Provider instance does not match driver."),
      );
    }
    return Effect.gen(function* () {
      const version = yield* options.process.probeVersion(options.binaryPath);
      let apiKey: string | undefined;
      if (options.authentication === "subscription") {
        const environment = yield* environmentFactory("subscription");
        const status = yield* options.process.probeSubscription(
          options.binaryPath,
          environment.environment,
        );
        if (status === "unauthenticated") {
          return observation(
            options,
            {
              readiness: "unauthenticated",
              version,
              message: "Authenticate Claude with the official Claude Code application.",
            },
            clock,
          );
        }
      } else {
        const presence = yield* Effect.either(brokerHas(options));
        if (presence._tag === "Left") {
          return observation(
            options,
            {
              readiness: "unavailable",
              version,
              credentialStatus: "unavailable",
              message: "Claude credential broker is unavailable. Restart Octant and try again.",
            },
            clock,
          );
        }
        if (!presence.right) {
          return observation(
            options,
            {
              readiness: "unauthenticated",
              version,
              credentialStatus: "missing",
              message: "Store an Anthropic API key for this Claude provider.",
            },
            clock,
          );
        }
        const resolved = yield* Effect.either(brokerResolve(options));
        if (resolved._tag === "Left") {
          return observation(
            options,
            resolved.left.category === "unauthenticated"
              ? {
                  readiness: "unauthenticated",
                  version,
                  credentialStatus: "missing",
                  message: "Store an Anthropic API key for this Claude provider.",
                }
              : {
                  readiness: "unavailable",
                  version,
                  credentialStatus: "unavailable",
                  message: "Claude credential broker is unavailable. Restart Octant and try again.",
                },
            clock,
          );
        }
        apiKey = resolved.right;
      }
      const sdkResult = yield* probeSdk(
        options,
        environmentFactory,
        apiKey === undefined ? {} : { apiKey },
      ).pipe(
        Effect.map((models) => ({ kind: "ready" as const, models })),
        Effect.catchAll((providerFailure) =>
          providerFailure.category === "protocol" || providerFailure.category === "unsupported"
            ? Effect.succeed({
                kind: "incompatible" as const,
                message: claudeIncompatibleMessage(providerFailure.message),
              })
            : Effect.fail(providerFailure),
        ),
        Effect.ensuring(Effect.sync(() => (apiKey = undefined))),
      );
      if (sdkResult.kind === "incompatible") {
        return observation(
          options,
          {
            readiness: "incompatible",
            version,
            ...(options.authentication === "api-key"
              ? { credentialStatus: "stored" as const }
              : {}),
            message: sdkResult.message,
          },
          clock,
        );
      }
      return observation(
        options,
        {
          readiness: "ready",
          version,
          models: sdkResult.models,
          ...(options.authentication === "api-key" ? { credentialStatus: "stored" as const } : {}),
        },
        clock,
      );
    });
  };
}

export function makeClaudeDriver(options: ClaudeDriverOptions): ProviderDriver {
  const environmentFactory = options.makeEnvironmentScope ?? makeClaudeEnvironmentScope;
  const factories: ConnectionFactories = {
    clock: options.clock ?? (() => new Date().toISOString()),
    makeCorrelation: options.correlationId ?? randomUUID,
    makeRequestId: options.requestId ?? randomUUID,
    makeTaskId: options.taskId ?? randomUUID,
    makeToolCallId: options.toolCallId ?? randomUUID,
  };
  return {
    kind: "claude",
    probe: makeProbe(options, environmentFactory, factories.clock),
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
      return makeConnection(options, environmentFactory, projectRoot, factories);
    },
  };
}

function makeConnection(
  options: ClaudeDriverOptions,
  environmentFactory: ClaudeEnvironmentFactory,
  projectRoot: string,
  factories: ConnectionFactories,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const reservedSessionIds = new Set<ProviderSessionId>();
    const inFlightSetups = new Set<InFlightSetup>();
    let closing = false;

    const withSessionReservation = <A>(
      sessionId: ProviderSessionId,
      operation: (signal: AbortSignal) => Promise<A>,
    ): Effect.Effect<A, ProviderFailure> =>
      Effect.tryPromise({
        try: async (effectSignal) => {
          if (closing) throw connectionClosingFailure();
          if (sessions.has(sessionId) || reservedSessionIds.has(sessionId)) {
            throw failure("protocol", "Claude session is already active.");
          }
          reservedSessionIds.add(sessionId);
          const controller = new AbortController();
          const completed = deferred<void>();
          const setup: InFlightSetup = {
            controller,
            done: completed.promise,
          };
          const cancelForCaller = () => controller.abort();
          effectSignal.addEventListener("abort", cancelForCaller, { once: true });
          inFlightSetups.add(setup);
          try {
            return await operation(controller.signal);
          } finally {
            effectSignal.removeEventListener("abort", cancelForCaller);
            reservedSessionIds.delete(sessionId);
            inFlightSetups.delete(setup);
            completed.resolve(undefined);
          }
        },
        catch: (error) => sanitizeFailure(error),
      });

    const publish = (event: ProviderRuntimeEvent) => {
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
    const clearAuthorityState = (state: SessionState) => {
      const denial = {
        behavior: "deny",
        message: "Claude tool request is no longer active.",
      } as const;
      for (const pending of state.pendingApprovals.values()) {
        state.settledToolUseIds.add(pending.providerToolUseId);
        pending.decision.resolve(denial);
      }
      for (const pending of state.pendingQuestions.values()) {
        state.settledToolUseIds.add(pending.providerToolUseId);
        pending.answer.resolve(undefined);
      }
      for (const toolUseId of state.preToolRequests.keys()) {
        state.settledToolUseIds.add(toolUseId);
      }
      state.pendingApprovals.clear();
      state.pendingQuestions.clear();
      state.preToolRequests.clear();
      state.approvalReuse.clear();
    };
    const release = async (state: SessionState): Promise<void> => {
      if (state.releasePromise !== undefined) {
        await state.releasePromise;
        return;
      }
      if (state.released) return;
      state.releasePromise ??= (async () => {
        state.releasing = true;
        clearAuthorityState(state);
        let releaseFailure: unknown;
        try {
          await Effect.runPromise(Scope.close(state.scope, Exit.void));
        } catch (error) {
          releaseFailure = error;
        }
        try {
          if (state.collector !== undefined) {
            await Effect.runPromise(Fiber.interrupt(state.collector));
          }
        } catch (error) {
          releaseFailure ??= error;
        } finally {
          state.released = true;
          state.releasing = false;
          deactivate(state);
          if (state.terminal && sessions.get(state.sessionId) === state) {
            sessions.delete(state.sessionId);
          }
        }
        if (releaseFailure !== undefined) throw releaseFailure;
      })();
      await state.releasePromise;
    };
    const scheduleRelease = (state: SessionState) => {
      queueMicrotask(() => {
        void release(state).catch(() => undefined);
      });
    };
    const terminal = (
      state: SessionState,
      value:
        | {
            readonly kind: "completed";
            readonly resumeCursor?: { readonly driverKind: "claude"; readonly value: string };
          }
        | { readonly kind: "failed"; readonly failure: ProviderFailure }
        | { readonly kind: "interrupted"; readonly message: string }
        | { readonly kind: "waiting"; readonly message: string },
    ) => {
      if (state.terminal) return;
      state.terminal = true;
      if (state.context !== undefined) state.context.terminal = true;
      const sequence = state.context?.sequence ?? 1;
      if (state.context !== undefined) state.context.sequence += 1;
      publish({
        ...value,
        instanceId: options.instanceId,
        sessionId: state.sessionId,
        sequence,
        correlationId: state.correlationId,
        occurredAt: factories.clock() as UtcTimestamp,
      } as ProviderRuntimeEvent);
      clearAuthorityState(state);
      state.terminalResult.resolve(undefined);
      deactivate(state);
      scheduleRelease(state);
    };
    const makeEventContext = (
      state: SessionState,
      claudeSessionId: string,
      sequence: number,
    ): ClaudeEventContext => ({
      instanceId: options.instanceId,
      sessionId: state.sessionId,
      correlationId: state.correlationId,
      occurredAt: factories.clock() as UtcTimestamp,
      projectRoot: state.projectRoot,
      isProjectConfinedPath: (absolutePath) => {
        try {
          return options.isProjectConfinedPath(state.projectRoot, absolutePath) === true;
        } catch {
          return false;
        }
      },
      claudeSessionId,
      sequence,
      terminal: false,
      requestIds: new Map(),
      taskIds: new Map(),
      toolStates: new Map(),
      makeRequestId: factories.makeRequestId,
      makeTaskId: factories.makeTaskId,
      makeToolCallId: factories.makeToolCallId,
    });
    const admitToolUse = (state: SessionState, toolUseId: string): boolean => {
      if (state.observedToolUseIds.has(toolUseId)) return true;
      if (
        state.observedToolUseIds.size >= MAX_TOOL_USES_PER_SESSION ||
        state.turnToolUseIds.size >= MAX_TOOL_USES_PER_TURN
      ) {
        terminal(state, {
          kind: "failed",
          failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
        });
        return false;
      }
      state.observedToolUseIds.add(toolUseId);
      state.turnToolUseIds.add(toolUseId);
      return true;
    };
    const closeAfterPublishedTerminal = (state: SessionState) => {
      if (state.terminal) return;
      state.terminal = true;
      clearAuthorityState(state);
      state.terminalResult.resolve(undefined);
      deactivate(state);
      scheduleRelease(state);
    };
    const handleMessage = (state: SessionState, message: ClaudeDecodedMessage) => {
      if (state.terminal) return;
      if (state.context === undefined) {
        if (
          message.kind !== "initialized" ||
          message.projectRoot !== state.projectRoot ||
          message.requestedModel !== state.modelId ||
          message.runtimeVersion !== state.expectedRuntimeVersion ||
          (state.expectedClaudeSessionId !== undefined &&
            message.sessionId !== state.expectedClaudeSessionId) ||
          (state.claudeSessionId !== undefined && message.sessionId !== state.claudeSessionId)
        ) {
          const failed = failure("protocol", "Claude initialization did not match the session.");
          state.initialized.reject(failed);
          terminal(state, { kind: "failed", failure: failed });
          return;
        }
        state.claudeSessionId = message.sessionId;
        state.context = makeEventContext(state, message.sessionId, 1);
        state.initialized.resolve(message.sessionId);
        return;
      }
      if (message.kind === "result" && state.pendingTurns === 0) {
        closeAfterPublishedTerminal(state);
        return;
      }
      for (const mapped of mapClaudeMessage(state.context, message)) {
        if (mapped.kind === "ignored") continue;
        if (mapped.kind === "failure") {
          terminal(state, { kind: "failed", failure: mapped.failure });
          return;
        }
        if (mapped.kind === "approval" || mapped.kind === "question") {
          terminal(state, {
            kind: "failed",
            failure: failure("protocol", "Claude input callback bypassed its authority gate."),
          });
          return;
        }
        publish(mapped.event);
        if (isTerminalEvent(mapped.event)) {
          state.terminalResult.resolve(undefined);
          clearAuthorityState(state);
          state.pendingTurns = Math.max(0, state.pendingTurns - 1);
          if (mapped.event.kind === "completed") {
            if (state.pendingTurns > 0) {
              state.context = makeEventContext(
                state,
                state.claudeSessionId!,
                state.context.sequence,
              );
              state.terminalResult = deferred<void>();
            } else {
              state.outputAccepted = false;
            }
            return;
          }
          state.terminal = true;
          deactivate(state);
          scheduleRelease(state);
          return;
        }
        state.outputAccepted = true;
      }
    };
    const collectorFinished = (state: SessionState, exit: Exit.Exit<void, ProviderFailure>) => {
      if (state.terminal || state.releasing || state.released) return;
      options.runtimeRegistry.clearObservedState(options.instanceId);
      if (state.context === undefined) {
        const failed = failure("unavailable", "Claude session did not initialize.");
        state.initialized.reject(failed);
        terminal(state, { kind: "failed", failure: failed });
        return;
      }
      if (Exit.isFailure(exit)) {
        terminal(state, {
          kind: "failed",
          failure: failure("provider-failed", "Claude message stream failed."),
        });
      } else if (state.pendingTurns > 0) {
        terminal(state, {
          kind: "interrupted",
          message: "Claude runtime exited unexpectedly.",
        });
      } else {
        terminal(state, {
          kind: "waiting",
          message: "Claude runtime exited; resume must be verified.",
        });
      }
    };

    const startCollector = (state: SessionState) => {
      state.collector = Effect.runFork(
        Stream.runForEach(state.query.messages, (message) =>
          Effect.sync(() => handleMessage(state, message)),
        ).pipe(
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => collectorFinished(state, exit))),
          Effect.asVoid,
        ),
      );
    };

    const open = async (
      input: {
        readonly sessionId: ProviderSessionId;
        readonly modelId: ProviderModelId;
        readonly executionPolicy: ProviderExecutionPolicy;
        readonly modelOptionValues?: ProviderModelOptionValues;
      },
      signal: AbortSignal,
      resumeSessionId?: string,
    ): Promise<SessionState> => {
      const observed = options.runtimeRegistry.observedState(options.instanceId);
      const selectedModel = observed?.models.find((model) => model.id === input.modelId);
      if (
        observed?.readiness !== "ready" ||
        selectedModel?.source !== "discovered" ||
        selectedModel.verification !== "verified"
      ) {
        throw failure(
          "unsupported",
          "Claude model is not available in the verified provider observation.",
        );
      }
      const effort = selectedEffort(selectedModel, input.modelOptionValues);
      if (sessions.has(input.sessionId)) {
        throw failure("protocol", "Claude session is already active.");
      }

      let apiKey: string | undefined;
      let scope: Scope.CloseableScope | undefined;
      let state: SessionState | undefined;
      try {
        if (options.authentication === "api-key") {
          if (!(await runSetupEffect(brokerHas(options), signal))) {
            throw failure("unauthenticated", "Claude API-key credential is missing.");
          }
          apiKey = await runSetupEffect(brokerResolve(options), signal);
        }
        scope = await runSetupEffect(Scope.make(), signal);
        const initialized = deferred<string>();
        // Startup no longer waits on this: the runtime initializes with the
        // first turn, and a rejected initialization fails that turn instead.
        void initialized.promise.catch(() => undefined);
        const terminalResult = deferred<void>();
        const environment = await runSetupEffect(
          environmentFactory(options.authentication, apiKey === undefined ? {} : { apiKey }).pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
          signal,
        );
        const runtimeVersion = await runSetupEffect(
          options.process.probeVersion(options.binaryPath),
          signal,
        );
        if (options.authentication === "subscription") {
          const status = await runSetupEffect(
            options.process.probeSubscription(options.binaryPath, environment.environment),
            signal,
          );
          if (status === "unauthenticated") {
            throw failure("unauthenticated", "Claude authentication is required.");
          }
        }
        const executionOptions = claudeExecutionOptions(input.executionPolicy);
        const sandbox = claudeSandboxSettings(input.executionPolicy, projectRoot);
        let callbackState: SessionState | undefined;
        const canUseTool: ClaudeOpenQueryInput["canUseTool"] = async (request) => {
          const activeState = callbackState;
          const deny = (message: string) =>
            denyClaudeToolRequest(activeState, request.toolUseId, message);
          if (
            activeState === undefined ||
            activeState.terminal ||
            activeState.context?.terminal === true ||
            activeState.releasing ||
            activeState.released
          ) {
            return deny("Claude tool request did not pass the Octant authority gate.");
          }
          if (!admitToolUse(activeState, request.toolUseId)) {
            return deny("Claude tool authority state was exhausted.");
          }
          expireClaudePreToolGrants(activeState, Date.now());
          const digest = claudeAuthorityInputDigest(request.input);
          const grant = activeState?.preToolRequests.get(request.toolUseId);
          if (
            digest === undefined ||
            grant?.toolName !== request.toolName ||
            grant.inputDigest !== digest ||
            activeState.settledToolUseIds.has(request.toolUseId)
          ) {
            return deny("Claude tool request did not pass the Octant authority gate.");
          }
          activeState.preToolRequests.delete(request.toolUseId);
          if (
            (input.executionPolicy === "full-access" && request.toolName !== "AskUserQuestion") ||
            // Auto-accept edits covers exactly the file writes the gate above
            // already proved to be inside the Project. Shell, network, and
            // every other tool still ask.
            (input.executionPolicy === "auto-accept-edits" &&
              CLAUDE_EDIT_TOOLS.has(request.toolName)) ||
            CLAUDE_READ_TOOLS.has(request.toolName)
          ) {
            activeState.settledToolUseIds.add(request.toolUseId);
            return { behavior: "allow" };
          }
          if (request.toolName === "AskUserQuestion" && activeState.pendingQuestions.size > 0) {
            terminal(activeState, {
              kind: "failed",
              failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
            });
            return deny("Claude user question state was exhausted.");
          }
          if (request.toolName === "AskUserQuestion" && Object.hasOwn(request.input, "answers")) {
            return deny("Claude user question input was invalid.");
          }
          const providerPrompt =
            request.toolName === "AskUserQuestion"
              ? validatedClaudeQuestionPrompt(request.input)
              : undefined;
          if (request.toolName === "AskUserQuestion" && providerPrompt === undefined) {
            return deny("Claude user question input was invalid.");
          }
          const reusableApprovalKey = approvalReuseKey(request.toolName, digest);
          if (
            request.toolName !== "AskUserQuestion" &&
            activeState.approvalReuse.has(reusableApprovalKey)
          ) {
            activeState.settledToolUseIds.add(request.toolUseId);
            return { behavior: "allow" };
          }
          if (
            request.toolName !== "AskUserQuestion" &&
            activeState.pendingApprovals.size >= MAX_PENDING_APPROVALS
          ) {
            terminal(activeState, {
              kind: "failed",
              failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
            });
            return deny("Claude tool authority state was exhausted.");
          }
          const mapped = mapClaudeToolRequest(activeState.context!, request);
          if (mapped.kind === "question") {
            if (providerPrompt === undefined) {
              return deny("Claude user question input was invalid.");
            }
            const pending: ClaudePendingQuestionState = {
              ...mapped.request,
              answer: deferred<string | undefined>(),
              providerPrompt,
            };
            activeState.pendingQuestions.set(pending.requestId, pending);
            publish(pending.event);
            activeState.outputAccepted = true;
            const answer = await waitForClaudeAuthorityValue({
              promise: pending.answer.promise,
              signal: request.signal,
              cancelledValue: undefined,
              cancel: () => {
                if (activeState.pendingQuestions.get(pending.requestId) === pending) {
                  activeState.pendingQuestions.delete(pending.requestId);
                }
                activeState.settledToolUseIds.add(pending.providerToolUseId);
              },
            });
            if (answer === undefined) {
              return { behavior: "deny", message: "Claude user question was cancelled." };
            }
            return {
              behavior: "allow",
              updatedInput: { ...request.input, answers: { [pending.providerPrompt]: answer } },
            };
          }
          if (mapped.kind !== "approval") {
            for (const [requestId, pending] of activeState.pendingApprovals) {
              if (pending.providerToolUseId !== request.toolUseId) continue;
              activeState.pendingApprovals.delete(requestId);
              activeState.settledToolUseIds.add(pending.providerToolUseId);
              pending.decision.resolve({
                behavior: "deny",
                message: "Claude approval correlation changed.",
              });
            }
            return deny("Claude tool request was denied by Octant.");
          }
          const reuseKey = approvalReuseKey(mapped.request.toolName, mapped.request.inputDigest);
          if (activeState.pendingApprovals.has(mapped.request.requestId)) {
            const existing = activeState.pendingApprovals.get(mapped.request.requestId)!;
            activeState.pendingApprovals.delete(mapped.request.requestId);
            existing.decision.resolve({
              behavior: "deny",
              message: "Claude approval correlation was duplicated.",
            });
            return deny("Claude approval request was duplicated.");
          }
          const pending: ClaudePendingApprovalState = {
            ...mapped.request,
            decision: deferred<ClaudeToolDecision>(),
            reuseKey,
          };
          activeState.pendingApprovals.set(pending.requestId, pending);
          publish(pending.event);
          activeState.outputAccepted = true;
          return waitForClaudeAuthorityValue({
            promise: pending.decision.promise,
            signal: request.signal,
            cancelledValue: {
              behavior: "deny",
              message: "Claude tool request was cancelled.",
            },
            cancel: () => {
              if (activeState.pendingApprovals.get(pending.requestId) === pending) {
                activeState.pendingApprovals.delete(pending.requestId);
              }
              activeState.settledToolUseIds.add(pending.providerToolUseId);
            },
          });
        };
        const preToolUse: ClaudeOpenQueryInput["preToolUse"] = async (request) => {
          const activeState = callbackState;
          const deny = (message: string) =>
            denyClaudeToolRequest(activeState, request.toolUseId, message);
          if (
            activeState === undefined ||
            activeState.terminal ||
            activeState.context?.terminal === true ||
            activeState.releasing ||
            activeState.released ||
            request.sessionId !== activeState.claudeSessionId ||
            request.projectRoot !== projectRoot
          ) {
            return deny("Claude tool request is outside the Project.");
          }
          if (!admitToolUse(activeState, request.toolUseId)) {
            return deny("Claude tool authority state was exhausted.");
          }
          expireClaudePreToolGrants(activeState, Date.now());
          if (
            !executionOptions.tools.includes(request.toolName) ||
            activeState.settledToolUseIds.has(request.toolUseId)
          ) {
            return deny("Claude tool request is outside the Project.");
          }
          const requestInput =
            typeof request.input === "object" &&
            request.input !== null &&
            !Array.isArray(request.input)
              ? (request.input as Readonly<Record<string, unknown>>)
              : undefined;
          if (requestInput === undefined) {
            return deny("Claude tool request has invalid input.");
          }
          if (request.toolName === "AskUserQuestion" && Object.hasOwn(requestInput, "answers")) {
            return deny("Claude user question input was invalid.");
          }
          if (
            request.toolName === "AskUserQuestion" &&
            validatedClaudeQuestionPrompt(requestInput) === undefined
          ) {
            return deny("Claude user question input was invalid.");
          }
          const digest = claudeAuthorityInputDigest(requestInput);
          if (digest === undefined) {
            return deny("Claude tool request has invalid input.");
          }
          const grant = (): ClaudeToolDecision => {
            if (
              !activeState.preToolRequests.has(request.toolUseId) &&
              activeState.preToolRequests.size >= MAX_PRE_TOOL_GRANTS
            ) {
              terminal(activeState, {
                kind: "failed",
                failure: failure("protocol", "Claude exceeded its bounded tool authority state."),
              });
              return deny("Claude tool authority state was exhausted.");
            }
            activeState.preToolRequests.set(request.toolUseId, {
              toolName: request.toolName,
              inputDigest: digest,
              expiresAt: Date.now() + PRE_TOOL_GRANT_TTL_MS,
            });
            return { behavior: "allow" };
          };
          if (input.executionPolicy === "full-access") {
            return grant();
          }
          const candidate =
            request.toolName === "AskUserQuestion"
              ? projectRoot
              : request.toolName === "Bash"
                ? requestInput?.cwd
                : request.toolName === "Glob" || request.toolName === "Grep"
                  ? (requestInput?.path ?? projectRoot)
                  : requestInput?.file_path;
          if (typeof candidate !== "string") {
            return deny("Claude tool request has no authoritative confined path.");
          }
          let confined = false;
          try {
            confined =
              candidate === projectRoot ||
              options.isProjectConfinedPath(projectRoot, candidate) === true;
          } catch {
            confined = false;
          }
          if (!confined) {
            return deny("Claude tool request is outside the Project.");
          }
          return grant();
        };
        // The runtime initializes with the first turn, so a new session's id
        // is assigned here and the initialized message is later held to it.
        const assignedSessionId = resumeSessionId === undefined ? randomUUID() : undefined;
        const query = await runSetupEffect(
          options.sdk
            .openQuery({
              binaryPath: options.binaryPath,
              projectRoot,
              authEnvironment: environment.environment,
              model: input.modelId,
              ...(effort === undefined ? {} : { effort }),
              executionPolicy: input.executionPolicy,
              ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
              ...(assignedSessionId === undefined ? {} : { sessionId: assignedSessionId }),
              tools: executionOptions.tools,
              ...(sandbox === undefined ? {} : { sandbox }),
              canUseTool,
              preToolUse,
            })
            .pipe(
              Effect.timeoutFail({
                duration: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
                onTimeout: () => failure("unavailable", "Claude session startup timed out."),
              }),
              Effect.provideService(Scope.Scope, scope),
            ),
          signal,
        );
        apiKey = undefined;
        throwIfSetupCancelled(signal);
        const account = query.initialization.account;
        if (
          account.ready !== true ||
          (account.apiProvider !== undefined && account.apiProvider !== "firstParty")
        ) {
          throw failure("protocol", "Claude initialized an unsupported account routing policy.");
        }
        state = {
          sessionId: input.sessionId,
          projectRoot,
          modelId: input.modelId,
          executionPolicy: input.executionPolicy,
          authentication: options.authentication,
          ...(resumeSessionId === undefined ? {} : { expectedClaudeSessionId: resumeSessionId }),
          expectedRuntimeVersion: runtimeVersion,
          correlationId: factories.makeCorrelation() as CorrelationId,
          scope,
          query,
          initialized,
          terminalResult,
          pendingApprovals: new Map(),
          pendingQuestions: new Map(),
          preToolRequests: new Map(),
          approvalReuse: new Set(),
          observedToolUseIds: new Set(),
          settledToolUseIds: new Set(),
          turnToolUseIds: new Set(),
          outputAccepted: false,
          pendingTurns: 0,
          terminal: false,
          active: true,
          releasing: false,
          released: false,
        };
        callbackState = state;
        sessions.set(input.sessionId, state);
        options.runtimeRegistry.setActiveSessionCount(
          options.instanceId,
          options.runtimeRegistry.activeSessionCount(options.instanceId) + 1,
        );
        startCollector(state);
        const claudeSessionId = await runSetupEffect(
          query.sessionId.pipe(
            Effect.timeoutFail({
              duration: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
              onTimeout: () => failure("unavailable", "Claude session startup timed out."),
            }),
          ),
          signal,
        );
        throwIfSetupCancelled(signal);
        state.claudeSessionId ??= claudeSessionId;
        if (state.terminal && !state.outputAccepted) {
          throw failure("protocol", "Claude session failed during startup.");
        }
        const identity = {
          providerInstanceId: options.instanceId,
          octantSessionId: input.sessionId,
          sdkSessionId: claudeSessionId,
          projectRoot,
          modelId: input.modelId,
          authentication: options.authentication,
        } satisfies ClaudeResumeIdentity;
        await awaitSetupPromise(options.resumeIdentityPort.put(identity, signal), signal);
        throwIfSetupCancelled(signal);
        return state;
      } catch (error) {
        apiKey = undefined;
        if (state !== undefined) {
          sessions.delete(input.sessionId);
          await release(state);
        } else if (scope !== undefined) {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
        throw error;
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closing = true;
        const setups = [...inFlightSetups];
        for (const setup of setups) setup.controller.abort();
        await Promise.all(setups.map(({ done }) => done));
        await Promise.all([...sessions.values()].map(release));
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(events));
      }),
    );

    return {
      subscribe: Stream.fromPubSub(events, { scoped: true }),
      start: (input) =>
        withSessionReservation(input.sessionId, (signal) => open(input, signal)).pipe(
          Effect.map((state) => ({
            sessionId: state.sessionId,
            resumeCursor: {
              driverKind: "claude" as const,
              value: state.claudeSessionId!,
            },
          })),
        ),
      resume: (input) => {
        if (input.resumeCursor.driverKind !== "claude") {
          return Effect.fail(
            failure("stale-resume", "Provider resume cursor does not belong to Claude."),
          );
        }
        return withSessionReservation(input.sessionId, async (signal) => {
          let identity: ClaudeResumeIdentity | undefined;
          try {
            identity = await awaitSetupPromise(
              options.resumeIdentityPort.lookup(
                {
                  providerInstanceId: options.instanceId,
                  sdkSessionId: input.resumeCursor.value,
                },
                signal,
              ),
              signal,
            );
          } catch {
            if (signal.aborted) throw connectionClosingFailure();
            throw failure(
              "stale-resume",
              "Claude session identity is unavailable for exact resume.",
            );
          }
          if (
            identity === undefined ||
            identity.providerInstanceId !== options.instanceId ||
            identity.octantSessionId !== input.sessionId ||
            identity.sdkSessionId !== input.resumeCursor.value ||
            identity.projectRoot !== projectRoot ||
            identity.authentication !== options.authentication
          ) {
            throw failure(
              "stale-resume",
              "Claude session identity is unavailable for exact resume.",
            );
          }

          let metadata;
          try {
            metadata = await runSetupEffect(
              options.sdk.findSession({
                sessionId: input.resumeCursor.value,
                projectRoot,
              }),
              signal,
            );
          } catch {
            if (signal.aborted) throw connectionClosingFailure();
            throw failure("stale-resume", "Claude session history is unavailable for resume.");
          }
          if (
            metadata === undefined ||
            metadata.sessionId !== input.resumeCursor.value ||
            metadata.projectRoot !== projectRoot
          ) {
            try {
              await awaitSetupPromise(
                options.resumeIdentityPort.remove(
                  {
                    providerInstanceId: options.instanceId,
                    sdkSessionId: input.resumeCursor.value,
                  },
                  signal,
                ),
                signal,
              );
            } catch {
              if (signal.aborted) throw connectionClosingFailure();
              // Missing history remains the authoritative resume failure.
            }
            throw failure("stale-resume", "Claude session history is unavailable for resume.");
          }
          return open(
            {
              sessionId: input.sessionId,
              modelId: identity.modelId,
              executionPolicy: input.executionPolicy,
              ...(input.modelOptionValues === undefined
                ? {}
                : { modelOptionValues: input.modelOptionValues }),
            },
            signal,
            input.resumeCursor.value,
          );
        }).pipe(
          Effect.map((state) => ({
            sessionId: state.sessionId,
            resumeCursor: input.resumeCursor,
          })),
        );
      },
      send: (input) => {
        const state = sessions.get(input.sessionId);
        if (state === undefined || state.terminal || state.released) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        const observed = options.runtimeRegistry.observedState(options.instanceId);
        const model = observed?.models.find((candidate) => candidate.id === state.modelId);
        const rejected = validateChatTurnInput(
          input,
          observed?.capabilities ?? unavailableCapabilities,
          model,
        );
        if (rejected !== undefined) return Effect.fail(rejected);
        return Effect.sync(() => {
          if (state.context?.terminal === true && state.pendingTurns === 0) {
            state.context = makeEventContext(state, state.claudeSessionId!, state.context.sequence);
          }
          if (state.pendingTurns === 0) {
            state.terminalResult = deferred<void>();
            state.outputAccepted = false;
            state.turnToolUseIds.clear();
          }
          state.pendingTurns += 1;
        }).pipe(
          Effect.zipRight(state.query.send({ text: renderProviderTurnPrompt(input) })),
          Effect.tap(() => Effect.sync(() => (state.outputAccepted = true))),
          Effect.catchAll((providerFailure) => {
            if (state.outputAccepted) {
              terminal(state, {
                kind: "failed",
                failure: failure("provider-failed", "Claude input failed after work was accepted."),
              });
            } else {
              state.pendingTurns = Math.max(0, state.pendingTurns - 1);
            }
            return Effect.fail(sanitizeFailure(providerFailure));
          }),
        );
      },
      interrupt: (sessionId) => {
        const state = sessions.get(sessionId);
        if (state === undefined || state.terminal || state.released || state.pendingTurns === 0) {
          return Effect.fail(failure("protocol", "Claude session is not active."));
        }
        return state.query.interrupt().pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () =>
                promiseWithTimeout(
                  state.terminalResult.promise,
                  options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS,
                  failure("interrupted", "Claude interruption did not return a terminal outcome."),
                ),
              catch: () => failure("interrupted", "Claude interruption did not complete."),
            }),
          ),
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => release(state),
              catch: () => failure("interrupted", "Claude interruption cleanup did not complete."),
            }),
          ),
          Effect.catchAll((providerFailure) => {
            terminal(state, {
              kind: "interrupted",
              message: "Claude execution was interrupted.",
            });
            return Effect.fail(sanitizeFailure(providerFailure, "interrupted"));
          }),
        );
      },
      stop: (sessionId) =>
        Effect.promise(async () => {
          const state = sessions.get(sessionId);
          if (state === undefined) return;
          sessions.delete(sessionId);
          if (!state.terminal) {
            state.terminal = true;
            if (state.context !== undefined) state.context.terminal = true;
            state.terminalResult.resolve(undefined);
          }
          await release(state);
        }),
      answerApproval: (answer) =>
        Effect.suspend(() => {
          const state = sessions.get(answer.sessionId);
          const pending = state?.pendingApprovals.get(answer.requestId);
          if (
            state === undefined ||
            state.terminal ||
            state.releasing ||
            state.released ||
            pending === undefined
          ) {
            return Effect.fail(failure("protocol", "Claude approval request is not active."));
          }
          return Effect.sync(() => {
            state.pendingApprovals.delete(answer.requestId);
            state.settledToolUseIds.add(pending.providerToolUseId);
            if (answer.approved) {
              let persistence: PermissionPersistence = "project-default";
              try {
                persistence = options.permissionPersistence?.() ?? "current-session";
              } catch {
                // An unreadable setting cannot broaden a one-shot answer into reuse.
              }
              if (persistence === "current-session") {
                state.approvalReuse.add(pending.reuseKey);
              }
              pending.decision.resolve({ behavior: "allow" });
            } else {
              pending.decision.resolve({
                behavior: "deny",
                message: "Claude tool request was denied by the user.",
              });
            }
          });
        }),
      answerUserInput: (answer) =>
        Effect.suspend(() => {
          const state = sessions.get(answer.sessionId);
          const pending = state?.pendingQuestions.get(answer.requestId);
          if (
            state === undefined ||
            state.terminal ||
            state.releasing ||
            state.released ||
            pending === undefined
          ) {
            return Effect.fail(failure("protocol", "Claude user question is not active."));
          }
          if (answer.answer.length > USER_ANSWER_MAX_CHARACTERS * 2) {
            return Effect.fail(failure("invalid-configuration", "Claude user answer is invalid."));
          }
          const normalizedAnswer = answer.answer.trim();
          if (
            normalizedAnswer.length === 0 ||
            exceedsCodePointLimit(normalizedAnswer, USER_ANSWER_MAX_CHARACTERS)
          ) {
            return Effect.fail(failure("invalid-configuration", "Claude user answer is invalid."));
          }
          return Effect.sync(() => {
            state.pendingQuestions.delete(answer.requestId);
            state.settledToolUseIds.add(pending.providerToolUseId);
            pending.answer.resolve(normalizedAnswer);
          });
        }),
      answerTool: () => unsupportedAnswerTool(availableCapabilities.appManagedTools),
    };
  });
}

function promiseWithTimeout<A>(
  promise: Promise<A>,
  milliseconds: number,
  timeoutFailure: ProviderFailure,
): Promise<A> {
  return new Promise<A>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(timeoutFailure), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    );
  });
}
