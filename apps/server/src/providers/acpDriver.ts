import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { compactAcpConversation } from "./acpCompaction";
import {
  readAcpSessionPages,
  makeAcpNativeSessions,
  acpReplayCollector,
  type AcpSessionHistoryReader,
  type AcpSessionLister,
} from "./acpNativeSessions";
import { appToolBridgeReachesLaunchOn } from "./appToolBridgeHost";
import { readAcpFileReview } from "./acpFileReview";
import { isAbsolute, resolve } from "node:path";
import { providerCommandOf } from "@octant/domain";
import { advertisedSlashCommands } from "./providerSlashCommands";
import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderAuthenticationAttempt,
  decodeProviderFailure,
  decodeProviderModelId,
  decodeProviderProbeResult,
  acpAgentProfile,
  isAcpAgentKind,
  personalSignInRefusals,
  type AcpAgentAuthentication,
  type AcpAgentGoogleCloud,
  type ProviderExecutionPolicy,
  type ProviderCapabilitySupport,
  type ProviderFailure,
  type ProviderInputModality,
  type ProviderInstanceId,
  type ProviderModelOptionValues,
  type ProviderNativeSetup,
  type ProviderCapabilities,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderSlashCommand,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
  type ProviderApprovalCall,
  type PermissionPersistence,
  type ProviderTurnInput,
} from "@octant/contracts";
import { attachedFileText } from "../attachments/attachedFiles";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderOwnChannels,
  ProviderSessionOwnership,
} from "@octant/provider-sdk/driver";
import { launchOwnChannels } from "./providerOwnChannels";
import {
  normalizeAcpElicitation,
  answerAcpElicitation,
  type AcpElicitation,
} from "./acpElicitation";
import { outputStopReason } from "./outputStopReason";
import {
  acpReportedUsageState,
  beginAcpReportedTurn,
  beginAcpUsageTurn,
  finishAcpReportedTurn,
  finishAcpUsageTurn,
  observeAcpUsage,
  observeAcpUsageUpdate,
  observedAcpUsageTurn,
  type AcpReportedUsageState,
  type AcpUsageState,
} from "./acpUsage";
import { ACP_CLIENT_TERMINAL_TOOL_NAMES, ACP_CLIENT_TOOL_NAMES } from "@octant/provider-sdk";
import {
  attachmentMediaTypeToModality,
  rejectUnsupportedChatTurn,
  renderProviderContextSections,
  renderProviderTurnPrompt,
  textOnlyInputModalities,
  unsupportedChatCapabilities,
} from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option, PubSub, Scope, Stream } from "effect";
import {
  mapAcpNotification,
  mapAcpPermissionRequest,
  acpReportOfHostTool,
  type AcpEventContext,
  type AcpMappedPermission,
} from "./acpEventMapper";
import type {
  AcpAgentConnection,
  AcpConnection,
  AcpProcessPort,
  AcpSessionMode,
} from "./acpProcess";
import {
  acpLoadsAllOwnSetup,
  acpReleaseClaim,
  acpSubagentsRun,
  type AcpProviderProfile,
} from "./acpProfiles";
import { createAcpManagedToolsBridge, type AcpManagedToolsBridge } from "./acpManagedTools";
import {
  AcpFailure,
  type AcpBrowserAuthenticationAttempt,
  type AcpConfigOptionsResult,
  type AcpMcpHttpServer,
  type AcpNewSessionResult,
  type AcpPromptAttachment,
  type AcpPromptResult,
  type AcpServerRequest,
  type AcpServerRequestMessage,
  type AcpServerNotification,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
} from "./acpProtocol";
import type { ManagedToolAnswer, ManagedToolCallContext } from "./managedMcpTools";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  type ProviderRuntimeRegistry,
  type ProviderDriverRuntimeRegistry,
  trackProviderProcess,
} from "./providerRuntimeRegistry";

/** The subset of the ACP client the driver depends on (fakeable in tests). */
export interface AcpClientPort {
  readonly authenticate: () => Promise<void>;
  readonly authenticateWith: (methodId: string) => Promise<Readonly<Record<string, unknown>>>;
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
  readonly prompt: (
    sessionId: string,
    prompt: string | ReadonlyArray<string>,
    attachments?: ReadonlyArray<AcpPromptAttachment>,
  ) => Promise<AcpPromptResult>;
  readonly setConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<AcpConfigOptionsResult>;
  readonly call: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
  readonly onNotification: (listener: (message: AcpServerNotification) => void) => () => void;
  readonly onRequest: (listener: (message: AcpServerRequestMessage) => void) => () => void;
  readonly respondPermission: (id: string | number, optionId?: string) => Promise<void>;
  readonly respond: (id: string | number, result: unknown) => Promise<void>;
  readonly reject: (id: string | number, code: number, message: string) => Promise<void>;
  readonly notify: (
    method: "session/cancel",
    params: { readonly sessionId: string },
  ) => Promise<void>;
}

export interface AcpDriverOptions {
  readonly sandboxPolicy?: SandboxPolicySelection;
  readonly profile: AcpProviderProfile;
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly managedHome: string;
  readonly process: AcpProcessPort;
  readonly runtimeRegistry: ProviderDriverRuntimeRegistry;
  /** The sign-in the instance is configured with. */
  readonly authentication?: AcpAgentAuthentication;
  /** The Google Cloud project an `agent-platform` instance signs in to. */
  readonly googleCloud?: AcpAgentGoogleCloud;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly clientFactory?: (connection: AcpAgentConnection) => AcpClientPort;
  readonly managedToolsBridgeFactory?: typeof createAcpManagedToolsBridge;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly requestId?: () => string;
  /** The person's setting for how long an approval holds. */
  readonly permissionPersistence?: () => PermissionPersistence;
  /** Which of the agent's own sessions Octant threads hold, for `importsSessions`. */
  readonly sessionOwnership?: ProviderSessionOwnership;
}

/**
 * The setting decides whether an approval may choose the agent's own
 * `allow_always`, so a driver built without it (as added agents once were)
 * fails closed to `project-default`, which keeps every answer to one call.
 */
function permissionPersistence(options: AcpDriverOptions): PermissionPersistence {
  try {
    return options.permissionPersistence?.() ?? "project-default";
  } catch {
    return "project-default";
  }
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
  readonly allowOptionId?: string;
  readonly allowAlwaysOptionId?: string;
  readonly rejectOptionId: string;
  /** The pending call, for an automatic reviewer; never published. */
  readonly call?: ProviderApprovalCall;
}

interface PendingQuestion {
  readonly kind: "question";
  readonly providerRequestId: string | number;
  readonly optionIds: ReadonlyMap<string, string>;
  readonly skipOptionId?: string;
}

interface AcpRetainedRuntime {
  /** A pinned profile's reviewed reading of its cumulative usage updates. */
  readonly usage?: AcpUsageState;
  /** Every other agent's usage, read by ACP's standard schema. */
  readonly reported?: AcpReportedUsageState;
  readonly source: AcpNewSessionResult;
  readonly scope: Scope.CloseableScope;
  readonly client: AcpClientPort;
  readonly managedTools: AcpManagedToolsLease | undefined;
  readonly appManagedTools: ProviderCapabilitySupport;
  /** The prompt blocks this process's `initialize` reply advertised beyond text. */
  readonly promptInputs: AcpPromptInputs;
  readonly version: string;
  readonly commands: Set<string>;
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
  /** The host answers every approval for one call, as for a helper run. */
  readonly answersOncePerCall: boolean;
  readonly scope: Scope.CloseableScope;
  readonly client: AcpClientPort;
  readonly context: AcpEventContext;
  readonly removeNotification: () => void;
  readonly removeRequest: () => void;
  readonly approvals: Map<string, PendingApproval>;
  readonly questions: Map<string, PendingQuestion>;
  readonly forms: Map<string, { readonly id: string | number; readonly form: AcpElicitation }>;
  readonly toolNames: Set<string>;
  readonly pendingToolAnswers: Map<string, PendingToolAnswer>;
  readonly appManagedTools: ProviderCapabilitySupport;
  managedTools: AcpManagedToolsLease | undefined;
  promptActive: boolean;
  /** The turn's prompts the agent has not answered: more than one once steered. */
  openPrompts: number;
  compacting: boolean;
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
  readonly clientFactory: (connection: AcpAgentConnection) => AcpClientPort;
  readonly clock: () => string;
  readonly makeCorrelation: () => string;
  readonly makeRequestId: () => string;
  /**
   * The commands the last readiness check listed, for a profile that runs
   * only listed commands, until a session lists its own.
   */
  readonly listedCommands: { names: ReadonlyArray<string> };
}

function hasVerifiedCompaction(profile: AcpProviderProfile): boolean {
  return profile.kind === "mistral-vibe" && profile.compactionVersions?.includes("3.0.3") === true;
}

/**
 * Capabilities of one release, the same at every level. A feature reviewed
 * on named releases is kept from the earliest of them on, unverified on a
 * release that is not one of them (`acpReleaseClaim`).
 */
function baseCapabilities(
  profile: AcpProviderProfile,
  appManagedTools: ProviderCapabilitySupport = "unsupported",
  version?: string,
) {
  const claims = (reviewed: ReadonlyArray<string> | undefined) =>
    acpReleaseClaim(reviewed, version) !== "absent";
  const compaction: ProviderCapabilitySupport = !hasVerifiedCompaction(profile)
    ? "unsupported"
    : claims(profile.compactionVersions)
      ? "supported"
      : "unavailable";
  return {
    streaming: "supported",
    resume: "supported",
    interruption: "supported",
    approvals: "supported",
    userQuestions:
      profile.kind !== "mistral-vibe" || profile.elicitationVersions === undefined
        ? profile.userQuestions
        : claims(profile.elicitationVersions)
          ? "supported"
          : "unavailable",
    reasoning: "unavailable",
    // A profile that pins its usage reading reports it only on those
    // releases; every other agent's usage is read by ACP's standard schema.
    usage:
      profile.usageVersions === undefined || claims(profile.usageVersions)
        ? "supported"
        : "unsupported",
    toolActivity: "supported",
    fileChanges: "unavailable",
    diffs: "unavailable",
    taskProgress: "supported",
    sessionCompaction: { chat: compaction, work: compaction, code: compaction },
    nativeChildAgents: "unavailable",
    // Only an agent whose own mode answers its prompts (Mistral Vibe's
    // auto-approve) can be Reviewed's reviewer.
    harnessAutoReview: profile.ownReviewer === true ? "supported" : "unsupported",
    ...unsupportedChatCapabilities,
    appManagedTools,
    acpClientCapabilities: "supported",
    nativeSetup: profile.nativeSetupSupport ?? NO_NATIVE_SETUP,
  } as const;
}

/**
 * What an approval says when the agent asks about a call Octant never saw.
 * The agent's own subagents run in Work and Code outside Plan wherever the
 * person's setup carries them (maintainer decision, 2026-11-14), and a
 * subagent's request names a call only the child saw, so it is shown plainly
 * with Allow and Deny under the thread's level instead of failing the turn. A
 * profile with its own sentence keeps it everywhere; elsewhere, and in Chat
 * and Plan, such a request still fails the turn.
 */
function unnamedPermission(
  profile: AcpProviderProfile,
  mode: AcpSessionMode,
  executionPolicy: ProviderExecutionPolicy,
  nativeSetup: ProviderNativeSetup | undefined,
): { readonly unnamedPermissionDescription?: string } {
  if (profile.unnamedPermissionDescription !== undefined) {
    return { unnamedPermissionDescription: profile.unnamedPermissionDescription };
  }
  if (!acpSubagentsRun(mode, executionPolicy, nativeSetup)) return {};
  return {
    unnamedPermissionDescription: `A ${profile.displayName} subagent asks to run a tool. ${profile.displayName} doesn't say which.`,
  };
}

/** Every ACP agent but a key provider loads none of its own setup. */
const NO_NATIVE_SETUP = {
  subagents: "unsupported",
  webTools: "unsupported",
  skills: "unsupported",
  toolServers: "unsupported",
  hooks: "unsupported",
  projectCode: "unsupported",
} as const satisfies NonNullable<ProviderCapabilities["nativeSetup"]>;

function negotiatedAppManagedTools(
  initialized: AcpConnection["initialized"],
  profile: AcpProviderProfile,
  version: string,
): ProviderCapabilitySupport {
  return appToolBridgeReachesLaunchOn(process.platform) &&
    (initialized.agentCapabilities.mcpCapabilities?.http === true ||
      (initialized.agentCapabilities.mcpCapabilities?.http === undefined &&
        acpReleaseClaim(profile.unadvertisedHttpMcpVersions, version) !== "absent"))
    ? "supported"
    : "unsupported";
}

function failure(
  category: ProviderFailure["category"],
  message: string,
  extras?: {
    readonly reason?: ProviderFailure["reason"];
    readonly diagnostic?: ProviderFailure["diagnostic"];
    readonly signInNotOffered?: ProviderFailure["signInNotOffered"];
  },
): ProviderFailure {
  return {
    category,
    message,
    ...(extras?.reason === undefined ? {} : { reason: extras.reason }),
    ...(extras?.diagnostic === undefined ? {} : { diagnostic: extras.diagnostic }),
    ...(extras?.signInNotOffered === true ? { signInNotOffered: true } : {}),
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
      if (/authenticat|api key/i.test(error.message)) {
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

interface AcpPromptInputs {
  /** `promptCapabilities.image`: the agent takes `image` blocks. */
  readonly image: boolean;
  /** `promptCapabilities.embeddedContext`: the agent takes embedded `resource` blocks. */
  readonly embeddedContext: boolean;
  /** `promptCapabilities.audio`: the agent takes `audio` blocks. */
  readonly audio: boolean;
}

/**
 * What the agent's own `initialize` reply says it takes beyond text. A file
 * reaches an ACP agent natively only as a block it advertised: an image as an
 * `image` block, any other file as an embedded `resource`; otherwise the agent
 * stays text only (maintainer decision, 2026-11-14) and a Work or Code turn
 * names the file by its path in the thread's attachments folder.
 */
function acceptedPromptInputs(initialized: AcpConnection["initialized"]): AcpPromptInputs {
  const prompt = initialized.agentCapabilities.promptCapabilities;
  return {
    image: prompt?.image === true,
    embeddedContext: prompt?.embeddedContext === true,
    audio: prompt?.audio === true,
  };
}

function promptInputModalities(inputs: AcpPromptInputs): readonly ProviderInputModality[] {
  if (!inputs.image && !inputs.embeddedContext && !inputs.audio) return textOnlyInputModalities;
  return [
    "text",
    ...(inputs.image ? (["image"] as const) : []),
    ...(inputs.audio ? (["audio"] as const) : []),
    ...(inputs.embeddedContext ? (["document"] as const) : []),
  ];
}

/**
 * One attached file as the prompt block the agent advertised for it, or
 * undefined when it advertised none that carries it. An embedded resource
 * names the attachment, not a path: the agent is handed the content itself.
 */
function acpPromptAttachment(
  attachment: ProviderTurnInput["attachments"][number],
  inputs: AcpPromptInputs,
): AcpPromptAttachment | undefined {
  const modality = attachmentMediaTypeToModality(attachment.mediaType);
  if (modality === "image") {
    return inputs.image
      ? {
          type: "image",
          mimeType: attachment.mediaType,
          data: Buffer.from(attachment.bytes).toString("base64"),
        }
      : undefined;
  }
  // Audio goes as the `audio` block an agent advertised for it, and otherwise
  // as an embedded file like any other.
  if (modality === "audio" && inputs.audio) {
    return {
      type: "audio",
      mimeType: attachment.mediaType,
      data: Buffer.from(attachment.bytes).toString("base64"),
    };
  }
  if (!inputs.embeddedContext) return undefined;
  const uri = `attachment:${encodeURIComponent(attachment.attachmentId)}/${encodeURIComponent(attachment.displayName)}`;
  // A PDF or office file goes as its bytes even when they decode as UTF-8:
  // its raw syntax is not its text, and the agent reads the format itself.
  const text =
    modality === "document" && !attachment.mediaType.startsWith("text/")
      ? undefined
      : attachedFileText(attachment.bytes);
  return {
    type: "resource",
    resource:
      text === undefined
        ? {
            uri,
            mimeType: attachment.mediaType,
            blob: Buffer.from(attachment.bytes).toString("base64"),
          }
        : { uri, mimeType: attachment.mediaType, text },
  };
}

function normalizeModels(
  profile: AcpProviderProfile,
  options: ReadonlyArray<AcpSessionConfigOption>,
  models: AcpSessionModelState | undefined,
  optionsByModel?: ReadonlyMap<string, ReadonlyArray<AcpSessionConfigOption>>,
  promptInputs: AcpPromptInputs = { image: false, embeddedContext: false, audio: false },
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

  const modelMeta = new Map(
    (models?.availableModels ?? [])
      .filter((item) => item._meta !== undefined)
      .map((item) => [item.modelId, item._meta] as const),
  );
  const eligible =
    optionsByModel === undefined
      ? selectable
      : selectable.filter((item) => optionsByModel.has(item.value));
  return eligible.map((item) => {
    const modelOptions = optionsByModel?.get(item.value) ?? options;
    const reasoning = resolveReasoningOption(profile, modelOptions);
    const reasoningValues = (reasoning?.options ?? [])
      .map((choice) => choice.value.trim())
      .filter((value) => value.length > 0);
    const configuration = profile.modelConfiguration?.(item);
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
      ...(configuration === undefined ? {} : { configuration }),
      source: "discovered" as const,
      verification: "verified" as const,
      reasoning:
        reasoning !== undefined || declaredLevels.length > 0
          ? ("supported" as const)
          : ("unavailable" as const),
      // ACP advertises prompt blocks for the agent, not per model, so every
      // model it lists carries what the agent said it accepts.
      inputModalities: promptInputModalities(promptInputs),
      // The agent reasons, and that capability is reported above. A level is
      // declared only because the session applies it: the driver sets the
      // profile's reasoning option, or carries it in the session metadata, when
      // it starts or resumes a session, so the control the composer draws is
      // one the agent honours rather than a preference that is saved and
      // dropped.
      options: [
        ...(levels.length === 0
          ? []
          : [
              {
                id: reasoning?.id ?? profile.reasoningOptionId,
                displayName: reasoning?.name ?? "Reasoning",
                kind: "selection" as const,
                values: levels as [string, ...string[]],
              },
            ]),
        ...modelOptions
          .filter(
            (option) =>
              option.category === "model_config" &&
              option.id !== "model" &&
              option.id !== "mode" &&
              option.id !== reasoning?.id,
          )
          .flatMap((option) => {
            const values = option.options.map((choice) => choice.value);
            return values.length === 0
              ? []
              : [
                  {
                    id: option.id,
                    displayName: option.name,
                    kind: "selection" as const,
                    values: values as [string, ...string[]],
                  },
                ];
          }),
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
  optionsByModel?: ReadonlyMap<string, ReadonlyArray<AcpSessionConfigOption>>,
): ProviderProbeResult {
  const promptInputs = acceptedPromptInputs(initialized);
  const models = normalizeModels(profile, options, sessionModels, optionsByModel, promptInputs);
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
  const appManagedTools = negotiatedAppManagedTools(initialized, profile, version);
  const capabilities = baseCapabilities(profile, appManagedTools, version);
  const unverified = unverifiedFeatures(profile, version, initialized, capabilities);
  return decodeProviderProbeResult({
    instanceId,
    readiness: models.length === 0 ? "degraded" : "ready",
    processState: "stopped",
    detectedVersion: version,
    ...(credentialStatus === undefined ? {} : { credentialStatus }),
    models,
    capabilities: {
      ...capabilities,
      nativeAttachments:
        promptInputs.image || promptInputs.embeddedContext || promptInputs.audio
          ? "supported"
          : "unsupported",
      resume,
      reasoning,
    },
    ...(models.length === 0
      ? { message: `${profile.displayName} did not report a selectable model.` }
      : unverified.length === 0
        ? {}
        : {
            message: `${profile.displayName} ${version} keeps ${unverified.join(", ")}, unverified: Octant reviewed them on another release.`,
          }),
    lastSuccessfulProbeAt: observedAt,
    observedAt,
  });
}

/**
 * The features this release keeps without being one they were reviewed on,
 * as the runtime card names them. A release keeps them at every level, so
 * the card is where a person learns they run unverified.
 */
function unverifiedFeatures(
  profile: AcpProviderProfile,
  version: string,
  initialized: AcpConnection["initialized"],
  capabilities: ReturnType<typeof baseCapabilities>,
): ReadonlyArray<string> {
  const unverified = (reviewed: ReadonlyArray<string> | undefined) =>
    acpReleaseClaim(reviewed, version) === "unverified";
  return [
    ...(capabilities.usage === "supported" && unverified(profile.usageVersions) ? ["usage"] : []),
    ...(capabilities.userQuestions === "supported" && unverified(profile.elicitationVersions)
      ? ["forms"]
      : []),
    ...(capabilities.appManagedTools === "supported" &&
    initialized.agentCapabilities.mcpCapabilities?.http !== true &&
    unverified(profile.unadvertisedHttpMcpVersions)
      ? ["Octant's tools"]
      : []),
    ...(capabilities.sessionCompaction.code === "supported" &&
    unverified(profile.compactionVersions)
      ? ["compaction"]
      : []),
    ...(hasVerifiedFileReview(profile) && unverified(profile.fileReviewVersions)
      ? ["file review"]
      : []),
    ...(profile.retainsSessions !== true && unverified(profile.retainedSessionVersions)
      ? ["its process open between turns"]
      : []),
  ];
}

function makeClient(connection: AcpAgentConnection): AcpClientPort {
  return connection.acp;
}

function commandInventory(notification: AcpServerNotification): ReadonlyArray<string> | undefined {
  const update = notification.params.update;
  if (update.sessionUpdate !== "available_commands_update") return undefined;
  if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 128) return [];
  const names: string[] = [];
  for (const candidate of update.availableCommands) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("name" in candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      candidate.name.length > 128
    ) {
      return [];
    }
    names.push(candidate.name);
  }
  return names;
}

/** The commands an `available_commands_update` lists, with what the menu shows for each. */
function advertisedCommandsOf(
  notification: AcpServerNotification,
): ReadonlyArray<ProviderSlashCommand> | undefined {
  const update = notification.params.update;
  if (update.sessionUpdate !== "available_commands_update") return undefined;
  return advertisedSlashCommands(update.availableCommands);
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

/** What Settings calls a posture, for a refusal that names it. */
function signInLabel(profile: AcpProviderProfile, posture: AcpAgentAuthentication): string {
  const descriptor = isAcpAgentKind(profile.kind) ? acpAgentProfile(profile.kind) : undefined;
  if (posture === "api-key") return descriptor?.apiKeyLabel ?? "API key";
  return descriptor?.postureLabels?.[posture] ?? posture;
}

/**
 * Chooses the sign-in Octant passed the agent, on a freshly initialized
 * process, before any session opens. The agent's own cached login could
 * otherwise win over the credential in its environment, and Octant decides
 * what a run may do by the sign-in it configured, so the method must be one
 * the agent listed and the agent must accept it.
 */
function selectSignIn(
  options: AcpDriverOptions,
  client: AcpClientPort,
  connection: AcpConnection,
): Effect.Effect<void, ProviderFailure> {
  const { profile, authentication } = options;
  const method = authentication === undefined ? undefined : profile.signInMethods?.[authentication];
  if (authentication === undefined || method === undefined) return Effect.void;
  const name = profile.displayName;
  const label = signInLabel(profile, authentication);
  if (connection.initialized.authMethods?.some((offered) => offered.id === method) !== true) {
    return Effect.fail(
      failure(
        "unauthenticated",
        `${name} did not offer ${label} sign-in. Update ${name}, or choose another sign-in in Settings.`,
        { reason: "authentication-required", signInNotOffered: true },
      ),
    );
  }
  return Effect.tryPromise({
    try: () => client.authenticateWith(method),
    catch: (error) =>
      error instanceof AcpFailure && error.kind === "remote"
        ? failure(
            "unauthenticated",
            `${name} refused its ${label} sign-in. Check it in Settings, then retry.`,
            { reason: "authentication-required" },
          )
        : providerFailure(profile, error, {
            stage: "authentication",
            detectedVersion: connection.version,
          }),
  }).pipe(Effect.asVoid);
}

function hasVerifiedFileReview(profile: AcpProviderProfile): boolean {
  return profile.kind === "mistral-vibe" && profile.fileReviewVersions?.includes("3.0.3") === true;
}

export function makeAcpDriver(options: AcpDriverOptions): ProviderDriver {
  const { profile } = options;
  const name = profile.displayName;
  const factories: Factories = {
    clientFactory: options.clientFactory ?? makeClient,
    clock: options.clock ?? (() => new Date().toISOString()),
    makeCorrelation: options.correlationId ?? (() => crypto.randomUUID()),
    makeRequestId: options.requestId ?? (() => crypto.randomUUID()),
    listedCommands: { names: [] },
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
      ...(options.googleCloud === undefined ? {} : { googleCloud: options.googleCloud }),
      onProcessStarted: async (process) => {
        receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
        return receipt;
      },
    });
    if (receipt === undefined) {
      yield* trackProviderProcess(options.runtimeRegistry, options.instanceId, connection);
    }
    const client = factories.clientFactory(connection);
    yield* selectSignIn(options, client, connection);
    return { connection, client };
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

  // An agent may list its commands just after it opens the session, so the
  // readiness check waits a moment for the list it runs commands from.
  const probeCommandListing = (client: AcpClientPort, root: string, detectedVersion: string) =>
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
      factories.listedCommands.names = [...new Set(commands)];
      return scratch;
    });

  // The agent's own sessions for a folder, read through a readiness-check
  // process: `session/list` reads the agent's own store, not the folder.
  const listAgentSessions: AcpSessionLister = (projectRoot) =>
    Effect.runPromise(
      Effect.scoped(
        managedHomeClient.pipe(
          Effect.flatMap(({ connection, client }) =>
            Effect.tryPromise({
              try: async () => {
                if (
                  connection.initialized.agentCapabilities.sessionCapabilities?.list === undefined
                )
                  return "unsupported" as const;
                const listed = await readAcpSessionPages((cursor) =>
                  client.call(
                    "session/list",
                    cursor === undefined ? { cwd: projectRoot } : { cwd: projectRoot, cursor },
                  ),
                );
                if (listed === undefined)
                  throw failure(
                    "protocol",
                    `${name} listed its sessions in a shape Octant cannot read.`,
                  );
                return listed;
              },
              catch: (error) => providerFailure(profile, error),
            }),
          ),
        ),
      ),
    );
  // A session's earlier conversation, read by loading it in a readiness-check
  // process of its own: `session/load` replays the history as session
  // updates before it answers (the ACP session setup reference), and the
  // process closes with the read, so nothing runs a turn in it.
  const readAgentSessionHistory: AcpSessionHistoryReader = (projectRoot, sessionId) =>
    Effect.runPromise(
      Effect.scoped(
        managedHomeClient.pipe(
          Effect.flatMap(({ connection, client }) =>
            Effect.tryPromise({
              try: async () => {
                if (connection.initialized.agentCapabilities.loadSession !== true)
                  return "unsupported" as const;
                const replay = acpReplayCollector();
                const stop = client.onNotification((notification) => {
                  if (notification.params.sessionId === sessionId)
                    replay.add(notification.params.update);
                });
                try {
                  await client.loadSession(sessionId, projectRoot);
                } finally {
                  stop();
                }
                return replay.collected();
              },
              catch: (error) => providerFailure(profile, error),
            }),
          ),
        ),
      ),
    );
  const sessionOwnership = options.sessionOwnership;

  return {
    kind: profile.kind,
    conversationOwnership: "provider",
    ...(profile.importsSessions === true && sessionOwnership !== undefined
      ? {
          nativeSessions: makeAcpNativeSessions({
            instanceId: options.instanceId,
            driverKind: profile.kind,
            displayName: name,
            heldSessions: () => sessionOwnership.held(profile.kind),
            listSessions: listAgentSessions,
            readHistory: readAgentSessionHistory,
          }),
        }
      : {}),
    ...(hasVerifiedFileReview(profile) ? { fileReviewReads: true as const } : {}),
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
                request(async () => {
                  await client.completeBrowserAuthentication(attemptId);
                  return "completed" as const;
                }),
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
        // The agent lists its commands after `session/new`; the probe's
        // client closes with its scope, and the listener with it.
        let advertised: ReadonlyArray<ProviderSlashCommand> = [];
        client.onNotification((notification) => {
          const commands = advertisedCommandsOf(notification);
          if (commands !== undefined) advertised = commands;
        });
        if (profile.authenticateOnProbe) {
          yield* request(() => client.authenticate(), {
            stage: "authentication",
            detectedVersion: connection.version,
          });
        }
        const scratch =
          profile.listedCommandsOnly !== true
            ? yield* request(() => client.newSession(connection.root), {
                stage: "model-discovery",
                detectedVersion: connection.version,
              })
            : yield* probeCommandListing(client, connection.root, connection.version);
        const optionsByModel = new Map<string, ReadonlyArray<AcpSessionConfigOption>>();
        if (profile.discoverModelOptions === true) {
          // Devin's first session reports only its default model's settings.
          // Selecting every advertised model in this disposable, non-generating
          // session reveals its actual effort and speed choices.
          for (const model of normalizeModels(
            profile,
            scratch.configOptions ?? [],
            scratch.models,
          )) {
            const result = yield* request(
              async () => {
                try {
                  return await client.setConfigOption(scratch.sessionId, "model", String(model.id));
                } catch (error) {
                  // An advertised model may be unavailable to this account. Only
                  // a classified model refusal is recoverable; connection and
                  // configuration failures must still fail the probe.
                  if (
                    error instanceof AcpFailure &&
                    error.kind === "remote" &&
                    error.remoteReason === "model"
                  )
                    return undefined;
                  throw error;
                }
              },
              { stage: "model-discovery", detectedVersion: connection.version },
            );
            if (result !== undefined) optionsByModel.set(String(model.id), result.configOptions);
          }
        }
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
          profile.discoverModelOptions === true ? optionsByModel : undefined,
        );
        const listed = advertised.length === 0 ? observed : { ...observed, commands: advertised };
        options.runtimeRegistry.setObservedState(listed);
        return listed;
      });
    },
    acquire: ({
      instanceId,
      projectRoot,
      mode,
      extraFolders = [],
      attachmentsFolder,
      sandboxPolicy,
      permissionPersistence: threadPersistence,
    }) => {
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
      // Chat has no folder, so it is granted no attachments folder either.
      const readOnlyFolders =
        attachmentsFolder === undefined || mode === "chat" ? [] : [attachmentsFolder];
      if (
        [projectRoot, ...extraFolders, ...readOnlyFolders].some(
          (root) => !isAbsolute(root) || resolve(root) !== root,
        )
      ) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Provider Project root must be an absolute normalized path.",
          ),
        );
      }
      return makeConnection(
        { ...options, ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }) },
        projectRoot,
        mode === "chat" ? [] : extraFolders,
        mode,
        resumeIdentities,
        factories,
        readOnlyFolders,
        threadPersistence === "project-default",
      );
    },
  };
}

function makeConnection(
  options: AcpDriverOptions,
  projectRoot: string,
  extraFolders: ReadonlyArray<string>,
  mode: AcpSessionMode,
  resumeIdentities: Map<string, ResumeIdentity>,
  factories: Factories,
  /** Folders the agent reads and never writes: the thread's attachments folder. */
  readOnlyFolders: ReadonlyArray<string> = [],
  /** The thread keeps no answer, so it never takes up a process that may hold one. */
  keepsNoAnswers = false,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  const { profile } = options;
  const name = profile.displayName;
  const capabilities = baseCapabilities(profile);
  const request = <A>(
    operation: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, ProviderFailure> =>
    Effect.tryPromise({ try: operation, catch: (error) => providerFailure(profile, error) });
  return Effect.gen(function* () {
    const queue = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ProviderSessionId, SessionState>();
    const pendingStarts = new Set<Promise<SessionState>>();
    const cancelPendingStarts = new Set<() => void>();
    let connectionClosing = false;
    const runtimeRoot =
      mode === "chat" && profile.chatSessionRoot === "managed-home"
        ? options.managedHome
        : projectRoot;

    const closeState = async (state: SessionState) => {
      if (state.closed) {
        // A timed-out stop may already be closing this private runtime. Join
        // its cleanup rather than leaving it detached from the owner scope.
        // A parked retained runtime remains open and is owned by the registry.
        if (state.runtime.isClosed()) await state.runtime.close();
        return;
      }
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
      await cancelForms(state);
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
        for (const cancel of cancelPendingStarts) cancel();
        await Promise.allSettled(pendingStarts);
        await Promise.all([...sessions.values()].map(closeState));
        sessions.clear();
        await Effect.runPromise(PubSub.shutdown(queue));
      }),
    );

    const offer = (event: ProviderRuntimeEvent) => {
      Effect.runFork(PubSub.publish(queue, event));
    };
    // A turn's consumer stops reading at its failure, and a failed turn's
    // reply (if one ever comes) arrives after that, so the usage a pinned
    // profile's snapshots showed so far is offered before the failure.
    const offerObservedUsage = (state: SessionState) => {
      if (state.runtime.usage === undefined) return;
      const usage = observedAcpUsageTurn(state.runtime.usage);
      if (usage !== undefined) offer(eventFor(state, factories.clock, usage));
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
      const reportedAs = acpReportOfHostTool(state.context, name);
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
            ...(reportedAs === undefined ? {} : { toolCallId: reportedAs }),
          }),
        );
      });
    };

    const partitionTools = (tools: ReadonlyArray<ProviderToolDefinition>) => {
      const nativeNames = new Set<string>(Object.values(ACP_CLIENT_TOOL_NAMES));
      const nativeClientTools = tools.filter((tool) => nativeNames.has(tool.name));
      const bridgeTools = tools.filter((tool) => !nativeNames.has(tool.name));
      return { nativeClientTools, bridgeTools };
    };

    const handleClientCapabilityRequest = async (
      state: SessionState,
      requestMessage: Exclude<
        AcpServerRequestMessage,
        AcpServerRequest | { readonly method: "elicitation/create" }
      >,
    ): Promise<void> => {
      if (requestMessage.params.sessionId !== state.sourceSessionId) {
        await state.client.reject(requestMessage.id, -32602, "Invalid params");
        return;
      }
      const toolName = ACP_CLIENT_TOOL_NAMES[requestMessage.capability];
      if (
        !state.toolNames.has(toolName) ||
        (requestMessage.capability.startsWith("terminal") &&
          !ACP_CLIENT_TERMINAL_TOOL_NAMES.every((name) => state.toolNames.has(name)))
      ) {
        await state.client.reject(requestMessage.id, -32601, "Method not found");
        return;
      }
      const input = Object.fromEntries(
        Object.entries(requestMessage.params).filter(
          ([key, value]) => key !== "sessionId" && key !== "_meta" && value !== null,
        ),
      );
      const answer = await requestManagedTool(
        state,
        toolName,
        JSON.stringify(input),
        new AbortController().signal,
      );
      if (answer.isError === true) {
        let message = "Client capability failed.";
        try {
          const result = JSON.parse(answer.resultJson);
          if (typeof result === "object" && result !== null) {
            // `message` carries the sentence a reader needs — the error slug
            // is for matching, so prefer the sentence when both are present.
            if ("message" in result && typeof result.message === "string") message = result.message;
            else if ("error" in result && typeof result.error === "string") message = result.error;
          }
        } catch {
          // Use the stable protocol error when an app-managed tool broke its contract.
        }
        await state.client.reject(requestMessage.id, -32000, message);
        return;
      }
      let result: unknown;
      try {
        result = JSON.parse(answer.resultJson);
      } catch {
        await state.client.reject(requestMessage.id, -32000, "Client capability failed.");
        return;
      }
      await state.client.respond(requestMessage.id, result);
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
      const commands = commandInventory(notification);
      if (notification.params.sessionId === state.sourceSessionId && commands !== undefined) {
        state.runtime.commands.clear();
        for (const command of commands) state.runtime.commands.add(command);
        options.runtimeRegistry.setObservedCommands(
          options.instanceId,
          advertisedCommandsOf(notification) ?? [],
        );
        return;
      }
      if (
        state.runtime.usage !== undefined &&
        notification.params.sessionId === state.sourceSessionId &&
        notification.params.update.sessionUpdate === "usage_update"
      ) {
        observeAcpUsage(state.runtime.usage, notification.params.update);
        return;
      }
      if (
        state.runtime.reported !== undefined &&
        notification.params.sessionId === state.sourceSessionId &&
        notification.params.update.sessionUpdate === "usage_update"
      ) {
        observeAcpUsageUpdate(state.runtime.reported, notification.params.update);
        return;
      }
      if (state.compacting) return;
      // The mapper drops an update that arrives after the turn ended, which is
      // right for the turn. A tool call among them means the agent is still
      // working for that finished turn, though, and a process kept warm in
      // that state would report the rest of the call into the next turn, where
      // the mapper starts a call it never saw. Such a process is closed at stop
      // instead of parked, as a parked one is on any update. An agent whose
      // trailing updates are known to be harmless keeps its process, as it
      // does while parked.
      const update = notification.params.update.sessionUpdate;
      if (
        state.context.terminal &&
        profile.toleratesStrayUpdates !== true &&
        notification.params.sessionId === state.sourceSessionId &&
        (update === "tool_call" || update === "tool_call_update")
      )
        state.completed = false;
      for (const mapped of mapAcpNotification(state.context, notification)) {
        if (mapped.kind === "event") offer(mapped.event);
        else if (mapped.kind === "protocol-failure") {
          state.completed = false;
          state.context.terminal = true;
          offerObservedUsage(state);
          offer(
            eventFor(state, factories.clock, {
              kind: "failed",
              failure: mapped.failure,
            }),
          );
        }
      }
    };

    const shellWithoutRequestRefusal = (
      mode: AcpSessionMode,
      policy: ProviderExecutionPolicy,
    ): string | undefined =>
      profile.shellWithoutRequest === true &&
      mode !== "chat" &&
      policy !== "plan" &&
      policy !== "full-access"
        ? `${name} runs shell commands without asking first, so they cannot be asked per command; use Full access to let it run them.`
        : undefined;

    const cancelForms = async (state: SessionState) => {
      const pending = [...state.forms.values()];
      state.forms.clear();
      await Promise.all(
        pending.map(({ id }) =>
          state.client.respond(id, { action: "cancel" }).catch(() => undefined),
        ),
      );
    };
    const handleRequest = (state: SessionState, requestMessage: AcpServerRequestMessage) => {
      if (state.compacting) {
        void state.client
          .reject(requestMessage.id, -32601, "Context compaction offers no client tools.")
          .catch(() => undefined);
        return;
      }
      if (requestMessage.method === "elicitation/create") {
        const enabled =
          profile.kind === "mistral-vibe" &&
          acpReleaseClaim(profile.elicitationVersions, state.runtime.version) !== "absent";
        const form = normalizeAcpElicitation(
          requestMessage.params.message,
          requestMessage.params.requestedSchema,
        );
        if (
          !enabled ||
          state.closed ||
          state.context.terminal ||
          !state.promptActive ||
          requestMessage.params.sessionId !== state.sourceSessionId ||
          form === undefined ||
          state.forms.size !== 0
        ) {
          for (const [key, pending] of state.forms) {
            if (pending.id === requestMessage.id) {
              state.forms.delete(key);
              state.context.terminal = true;
              offerObservedUsage(state);
              offer(
                eventFor(state, factories.clock, {
                  kind: "failed",
                  failure: failure(
                    "protocol",
                    "The provider repeated a pending questionnaire callback.",
                  ),
                }),
              );
            }
          }
          void state.client
            .reject(requestMessage.id, -32602, "Session form is unavailable or invalid")
            .catch(() => undefined);
          return;
        }
        const requestId = factories.makeRequestId();
        state.forms.set(requestId, { id: requestMessage.id, form });
        offer(
          eventFor(state, factories.clock, {
            kind: "user-input-request",
            requestId,
            prompt: form.prompt,
            options: [],
            questionnaire: form.questionnaire,
          }),
        );
        return;
      }
      if (requestMessage.method !== "session/request_permission") {
        void handleClientCapabilityRequest(state, requestMessage).catch(() => undefined);
        return;
      }
      const mapped = mapAcpPermissionRequest(state.context, requestMessage);
      if (mapped.kind === "protocol-failure") {
        state.completed = false;
        state.context.terminal = true;
        offerObservedUsage(state);
        offer(eventFor(state, factories.clock, { kind: "failed", failure: mapped.failure }));
        void state.client.respondPermission(requestMessage.id).catch(() => undefined);
        return;
      }
      // An unseen subagent's run is journaled before the approval it asks for.
      if (mapped.kind === "approval")
        for (const preceding of mapped.preceding ?? []) offer(preceding);
      // Plan is read-only, so nothing it asks for is anyone's to approve. Work
      // and Code share the shell at the thread's level, so an `execute`
      // request reaches the person in Work as it does in Code.
      if (mapped.kind === "approval" && state.executionPolicy === "plan") {
        void state.client
          .respondPermission(mapped.providerRequestId, mapped.rejectOptionId)
          .catch(() => undefined);
        return;
      }
      // Offered only allow-always, an approval needs an answer that holds for
      // the session, and a Strict helper run's answers hold for one call.
      // Asking the person would end in a refusal the run cannot get past, so
      // the request is denied on arrival and the reason shown on the call.
      if (
        mapped.kind === "approval" &&
        mapped.allowOptionId === undefined &&
        state.answersOncePerCall
      ) {
        void state.client
          .respondPermission(mapped.providerRequestId, mapped.rejectOptionId)
          .catch(() => undefined);
        if (mapped.event.kind === "approval-request" && mapped.event.toolCallId !== undefined)
          offer(
            eventFor(state, factories.clock, {
              kind: "tool-progress",
              toolCallId: mapped.event.toolCallId,
              message: `${name} only offers Always allow, which a helper run can't grant; denied.`,
            }),
          );
        return;
      }
      if (mapped.kind === "question" && profile.userQuestions === "unsupported") {
        void state.client
          .respondPermission(mapped.providerRequestId, mapped.skipOptionId)
          .catch(() => undefined);
        state.context.terminal = true;
        offerObservedUsage(state);
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
        readonly answersOncePerCall?: boolean;
        readonly tools: ReadonlyArray<ProviderToolDefinition>;
        readonly nativeSetup?: ProviderNativeSetup;
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
        ...(profile.childRunMetaKey === undefined
          ? {}
          : { childRunMetaKey: profile.childRunMetaKey }),
        ...unnamedPermission(profile, mode, input.executionPolicy, input.nativeSetup),
        ...(profile.unseenChildCalls === undefined
          ? {}
          : { unseenChildCalls: profile.unseenChildCalls }),
        ...(profile.toleratesStrayUpdates === true ? { toleratesStrayUpdates: true as const } : {}),
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
        answersOncePerCall: input.answersOncePerCall === true,
        scope,
        client,
        context,
        removeNotification,
        removeRequest,
        approvals: new Map(),
        questions: new Map(),
        forms: new Map(),
        toolNames: new Set(input.tools.map((tool) => tool.name)),
        pendingToolAnswers: new Map(),
        appManagedTools,
        managedTools,
        promptActive: false,
        openPrompts: 0,
        compacting: false,
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
      fullAccessSandbox: boolean,
      strict: boolean,
      ownChannels: ProviderOwnChannels | undefined,
      loopbackPorts: ReadonlyArray<number> = [],
      tools: ReadonlyArray<ProviderToolDefinition> = [],
      nativeSetup?: ProviderNativeSetup,
      signal?: AbortSignal,
    ): Promise<{
      readonly scope: Scope.CloseableScope;
      readonly client: AcpClientPort;
      readonly connection: AcpAgentConnection;
    }> => {
      const clientCapabilities = {
        readTextFile: tools.some((tool) => tool.name === ACP_CLIENT_TOOL_NAMES.readTextFile),
        writeTextFile:
          profile.withholdsClientWrites !== true &&
          tools.some((tool) => tool.name === ACP_CLIENT_TOOL_NAMES.writeTextFile),
        terminal: ACP_CLIENT_TERMINAL_TOOL_NAMES.every((name) =>
          tools.some((tool) => tool.name === name),
        ),
      };
      const scope = await Effect.runPromise(Scope.make());
      try {
        const runOptions = signal === undefined ? undefined : { signal };
        const apiKeyExit = await Effect.runPromiseExit(resolveApiKey(options), runOptions);
        if (Exit.isFailure(apiKeyExit)) {
          throw Option.getOrElse(Cause.failureOption(apiKeyExit.cause), () =>
            failure("provider-failed", `${name} credentials could not be resolved.`),
          );
        }
        const apiKey = apiKeyExit.value;
        let receipt: Awaited<ReturnType<ProviderRuntimeRegistry["trackProcess"]>> | undefined;
        const startedExit = await Effect.runPromiseExit(
          options.process
            .start({
              ...(options.sandboxPolicy === undefined
                ? {}
                : { sandboxPolicy: options.sandboxPolicy }),
              profile,
              binaryPath: options.binaryPath,
              root: runtimeRoot,
              ...(extraFolders.length === 0 ? {} : { extraFolders }),
              ...(readOnlyFolders.length === 0 ? {} : { readOnlyFolders }),
              managedHome: options.managedHome,
              mode,
              executionPolicy,
              ...(fullAccessSandbox ? { fullAccessSandbox: true } : {}),
              ...(strict ? {} : { strict: false }),
              ...(ownChannels === undefined ? {} : { ownChannels }),
              ...(apiKey === undefined ? {} : { apiKey }),
              ...(options.googleCloud === undefined ? {} : { googleCloud: options.googleCloud }),
              ...(loopbackPorts.length === 0 ? {} : { loopbackPorts }),
              ...(nativeSetup === undefined ? {} : { nativeSetup }),
              clientCapabilities,
              onProcessStarted: async (process) => {
                receipt = await options.runtimeRegistry.trackProcess(options.instanceId, process);
                return receipt;
              },
            })
            .pipe(Effect.provideService(Scope.Scope, scope)),
          runOptions,
        );
        if (Exit.isFailure(startedExit)) {
          throw Option.getOrElse(Cause.failureOption(startedExit.cause), () =>
            failure("provider-failed", `${name} process failed without a typed failure.`),
          );
        }
        const processConnection = startedExit.value;
        if (receipt === undefined) {
          await options.runtimeRegistry.trackProcess(options.instanceId, processConnection);
        }
        const client = factories.clientFactory(processConnection);
        const signedInExit = await Effect.runPromiseExit(
          selectSignIn(options, client, processConnection),
          runOptions,
        );
        if (Exit.isFailure(signedInExit)) {
          throw Option.getOrElse(Cause.failureOption(signedInExit.cause), () =>
            failure("provider-failed", `${name} sign-in failed without a typed failure.`),
          );
        }
        return { scope, client, connection: processConnection };
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
      readonly singleUse?: boolean;
      readonly answersOncePerCall?: boolean;
      readonly fullAccessSandbox?: boolean;
      readonly strict?: boolean;
      readonly ownChannels?: ProviderOwnChannels;
      readonly modelOptionValues?: ProviderModelOptionValues;
      readonly autoApprove?: boolean;
      readonly nativeSetup?: ProviderNativeSetup;
      readonly sourceSessionId?: string;
      readonly tools: ReadonlyArray<ProviderToolDefinition>;
      readonly current?: () => boolean;
    }) =>
      request((effectSignal) => {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        effectSignal.addEventListener("abort", cancel, { once: true });
        if (effectSignal.aborted) cancel();
        cancelPendingStarts.add(cancel);
        const signal = controller.signal;
        const assertCurrent = () => {
          if (signal.aborted || connectionClosing || input.current?.() === false)
            throw failure("interrupted", "ACP session startup was cancelled.");
        };
        const awaitStartup = async <A>(run: () => Promise<A>): Promise<A> => {
          assertCurrent();
          let onAbort: (() => void) | undefined;
          try {
            const result = await Promise.race([
              Promise.resolve().then(() => {
                assertCurrent();
                return run();
              }),
              new Promise<never>((_, reject) => {
                onAbort = () =>
                  reject(failure("interrupted", "ACP session startup was cancelled."));
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              }),
            ]);
            assertCurrent();
            return result;
          } finally {
            if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
          }
        };
        const pending = (async () => {
          assertCurrent();
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
          let removeUsage = () => {};
          let removeCommands = () => {};
          let runtime: AcpRetainedRuntime | undefined;
          const compatibility = JSON.stringify([
            options.sandboxPolicy ?? null,
            profile.kind,
            input.sessionId,
            options.binaryPath,
            options.managedHome,
            projectRoot,
            extraFolders,
            readOnlyFolders,
            mode,
            input.modelId,
            input.modelOptionValues ?? {},
            input.executionPolicy,
            // A process launched open never serves a sandboxed session, nor
            // the reverse: the wall is fixed when the process starts.
            input.executionPolicy === "full-access" && input.fullAccessSandbox === true,
            // The launch environment and channel guards are fixed when the
            // process starts, so a Strict process never serves a session that
            // is not, nor the reverse.
            input.strict !== false,
            // Its telemetry and self-update guards are fixed at start too.
            launchOwnChannels(input.strict !== false, input.ownChannels),
            // The agent's own reviewer is the session's mode and the person's
            // setup is its launch's guards and filesystem denies; a retained
            // process opened under either other value is never taken up.
            profile.ownReviewer === true && input.autoApprove === true,
            input.nativeSetup ?? null,
            options.authentication,
            input.tools,
            // An agent's process holds the `allow_always` it was sent, so the
            // next turn starts another once approvals hold for one call each.
            keepsNoAnswers,
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
              assertCurrent();
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
                assertCurrent();
                return registered;
              }
              claimNative(input.sourceSessionId);
            }
            const refusal = profile.refuses?.(mode, input.executionPolicy);
            if (refusal !== undefined) throw failure("incompatible", refusal);
            if (input.singleUse === true) {
              const backgroundRefusal = personalSignInRefusals({
                driverKind: profile.kind,
                configuration:
                  options.authentication === undefined
                    ? {}
                    : { authentication: options.authentication },
              })?.refusesBackgroundModelCalls;
              if (backgroundRefusal !== undefined) {
                throw failure("unauthorized", backgroundRefusal);
              }
            }
            const shellRefusal = shellWithoutRequestRefusal(mode, input.executionPolicy);
            if (shellRefusal !== undefined) throw failure("unsupported", shellRefusal);
            // A Project trusted for the agent, outside Plan, and any session
            // outside Strict that carries the person's setup load the files
            // the refusal is about, as the agent does on its own.
            const projectRefusal =
              runtimeRoot === projectRoot &&
              input.nativeSetup?.projectCode !== true &&
              !acpLoadsAllOwnSetup({ strict: input.strict, setup: input.nativeSetup })
                ? profile.refusesProject?.(projectRoot)
                : undefined;
            if (projectRefusal !== undefined) throw failure("incompatible", projectRefusal);
            const { bridgeTools } = partitionTools(input.tools);
            if (bridgeTools.length > 0 && !appToolBridgeReachesLaunchOn(process.platform)) {
              throw failure(
                "unsupported",
                "App-managed tools are unsupported by this ACP runtime on this platform.",
              );
            }
            const stateRef: { state?: SessionState } = {};
            managedTools = await prepareManagedTools(bridgeTools, stateRef);
            const started = await startProcess(
              input.executionPolicy,
              input.executionPolicy === "full-access" && input.fullAccessSandbox === true,
              input.strict !== false,
              input.ownChannels,
              managedTools?.bridge.port === undefined ? [] : [managedTools.bridge.port],
              input.tools,
              input.nativeSetup,
              signal,
            );
            scope = started.scope;
            assertCurrent();
            const { client, connection } = started;
            let commandSessionId: string | undefined;
            let startupCommands: ReadonlyArray<string> = [];
            let commandsMismatch = false;
            removeCommands = client.onNotification((notification) => {
              const commands = commandInventory(notification);
              if (commands === undefined) return;
              commandSessionId ??= notification.params.sessionId;
              if (commandSessionId !== notification.params.sessionId) commandsMismatch = true;
              startupCommands = commands;
              options.runtimeRegistry.setObservedCommands(
                options.instanceId,
                advertisedCommandsOf(notification) ?? [],
              );
            });
            const appManagedTools = negotiatedAppManagedTools(
              connection.initialized,
              profile,
              connection.version,
            );
            if (bridgeTools.length > 0 && appManagedTools !== "supported") {
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
            // new/load can send their baseline before replying. Listen before
            // opening the session, then keep only its exact native identity.
            const initialUsage: AcpUsageState | undefined =
              acpReleaseClaim(profile.usageVersions, connection.version) === "absent"
                ? undefined
                : {};
            // Every other agent's cumulative cost reported while loading or
            // resuming is the baseline its first turn grows from, so the state
            // exists before the session opens and is kept for the session.
            const reportedUsage: AcpReportedUsageState | undefined =
              profile.usageVersions === undefined
                ? acpReportedUsageState(sourceSessionId === undefined ? "new" : "existing")
                : undefined;
            let usageSessionId = sourceSessionId;
            let usageMismatch = false;
            if (initialUsage !== undefined || reportedUsage !== undefined) {
              removeUsage = client.onNotification((message) => {
                if (message.params.update.sessionUpdate !== "usage_update") return;
                usageSessionId ??= message.params.sessionId;
                if (usageSessionId !== message.params.sessionId) {
                  usageMismatch = true;
                  return;
                }
                if (initialUsage !== undefined)
                  observeAcpUsage(initialUsage, message.params.update);
                if (reportedUsage !== undefined)
                  observeAcpUsageUpdate(reportedUsage, message.params.update);
              });
            }
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
                    ? await awaitStartup(() => client.newSession(runtimeRoot))
                    : await awaitStartup(() => client.newSession(runtimeRoot, mcpServers))
                  : await awaitStartup(() =>
                      client.newSession(runtimeRoot, mcpServers, sessionMeta),
                    )
                : resumeWithoutReplay
                  ? sessionMeta === undefined
                    ? mcpServers.length === 0
                      ? await awaitStartup(() => client.resumeSession(sourceSessionId, runtimeRoot))
                      : await awaitStartup(() =>
                          client.resumeSession(sourceSessionId, runtimeRoot, mcpServers),
                        )
                    : await awaitStartup(() =>
                        client.resumeSession(sourceSessionId, runtimeRoot, mcpServers, sessionMeta),
                      )
                  : sessionMeta === undefined
                    ? mcpServers.length === 0
                      ? await awaitStartup(() => client.loadSession(sourceSessionId, runtimeRoot))
                      : await awaitStartup(() =>
                          client.loadSession(sourceSessionId, runtimeRoot, mcpServers),
                        )
                    : await awaitStartup(() =>
                        client.loadSession(sourceSessionId, runtimeRoot, mcpServers, sessionMeta),
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
            // An added agent follows the spelling its session reported: a
            // `model` config option, or else `models` (answered with
            // `session/set_model`); a session already on the model is left
            // alone. A reviewed profile pins its spelling.
            const followsSession = profile.modelSelection === "follow-session";
            const sessionHasModelOption = (source.configOptions ?? []).some(
              (option) => option.id === "model",
            );
            const modelOpenedWithSession =
              (sessionMeta !== undefined || followsSession) &&
              source.models?.currentModelId === input.modelId;
            const setModelCall =
              followsSession && !sessionHasModelOption && source.models !== undefined
                ? {
                    method: "session/set_model",
                    params: { sessionId: source.sessionId, modelId: input.modelId },
                  }
                : profile.setModelCall?.(source.sessionId, input.modelId);
            // The agent's config options can change with the model selection, so
            // the reply to each standard call carries the current set; keep the
            // newest one rather than the session's original list.
            let configOptions = source.configOptions ?? [];
            if (!modelOpenedWithSession) {
              if (setModelCall === undefined) {
                const result = await awaitStartup(() =>
                  client.setConfigOption(source.sessionId, "model", input.modelId),
                );
                configOptions = result.configOptions;
              } else {
                await awaitStartup(() => client.call(setModelCall.method, setModelCall.params));
              }
            }
            const modeValue = profile.sessionMode(
              mode,
              input.executionPolicy,
              profile.ownReviewer === true && input.autoApprove === true,
            );
            if (
              profile.acceptsUnknownModeIds === true &&
              !configOptions.some(
                (option) =>
                  option.id === "mode" &&
                  option.options.some((choice) => choice.value === modeValue),
              )
            )
              throw failure(
                "incompatible",
                `${name} does not offer the ${modeValue} mode this thread needs.`,
              );
            const setModeCall = profile.setModeCall?.(source.sessionId, modeValue);
            // A profile that selects no mode leaves the session in the mode it
            // opened with.
            if (profile.selectsNoMode !== true) {
              if (setModeCall === undefined) {
                const result = await awaitStartup(() =>
                  client.setConfigOption(source.sessionId, "mode", modeValue),
                );
                configOptions = result.configOptions;
              } else {
                await awaitStartup(() => client.call(setModeCall.method, setModeCall.params));
              }
            }
            // Turns carry only the prompt. Restore model settings against the
            // selected session's fresh choices before it can send; apply effort
            // first because dependent controls can change with it.
            const reasoningId = resolveReasoningOption(profile, configOptions)?.id;
            const requestedSettings = Object.entries(input.modelOptionValues ?? {}).sort(
              ([left], [right]) => Number(right === reasoningId) - Number(left === reasoningId),
            );
            for (const [id, value] of requestedSettings) {
              const reasoningOption = resolveReasoningOption(profile, configOptions);
              const option = configOptions.find(
                (candidate) =>
                  candidate.id === id &&
                  candidate.id !== "mode" &&
                  candidate.id !== "model" &&
                  (candidate.id === reasoningOption?.id || candidate.category === "model_config"),
              );
              if (
                option === undefined ||
                !option.options.some((choice) => choice.value === value)
              ) {
                if (profile.discoverModelOptions === true)
                  throw failure(
                    "invalid-configuration",
                    `${name} no longer offers the selected model setting.`,
                  );
                continue;
              }
              const result = await awaitStartup(() =>
                client.setConfigOption(source.sessionId, option.id, value),
              );
              configOptions = result.configOptions;
              if (
                profile.discoverModelOptions === true &&
                result.configOptions.find((candidate) => candidate.id === id)?.currentValue !==
                  value
              )
                throw failure(
                  "invalid-configuration",
                  `${name} did not apply the selected model setting.`,
                );
            }
            if (
              profile.discoverModelOptions === true &&
              requestedSettings.some(
                ([id, value]) =>
                  configOptions.find((option) => option.id === id)?.currentValue !== value,
              )
            )
              throw failure(
                "invalid-configuration",
                `${name} did not retain the selected model settings.`,
              );
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
                if (profile.closesSessions) {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await Promise.race([
                      client.closeSession(source.sessionId).catch(() => undefined),
                      new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 500);
                      }),
                    ]);
                  } finally {
                    if (timer !== undefined) clearTimeout(timer);
                  }
                }
                await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
                releaseNative?.();
              })();
              return closing;
            };
            runtime = {
              ...(initialUsage === undefined
                ? {}
                : {
                    usage: usageMismatch || usageSessionId !== source.sessionId ? {} : initialUsage,
                  }),
              ...(reportedUsage === undefined
                ? {}
                : {
                    reported:
                      usageMismatch || usageSessionId !== source.sessionId
                        ? acpReportedUsageState(sourceSessionId === undefined ? "new" : "existing")
                        : reportedUsage,
                  }),
              source,
              scope: runtimeScope,
              client,
              managedTools: runtimeTools,
              appManagedTools,
              promptInputs: acceptedPromptInputs(connection.initialized),
              version: connection.version,
              commands: new Set(
                !commandsMismatch && commandSessionId === source.sessionId ? startupCommands : [],
              ),
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
                // Google Antigravity sends a finished turn's usage and trailing
                // chunks after its prompt answered; closing on them threw away
                // the warm process it keeps open precisely to avoid a cold
                // launch. Its updates are dropped while parked; a request,
                // which needs an answer no turn is there to give, still closes.
                const removeNotification = client.onNotification((message) => {
                  if (profile.toleratesStrayUpdates === true && message.method === "session/update")
                    return;
                  refuse();
                });
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
            assertCurrent();
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
            removeUsage();
            removeCommands();
            finishStartup();
          }
        })();
        pendingStarts.add(pending);
        void pending
          .finally(() => {
            pendingStarts.delete(pending);
            cancelPendingStarts.delete(cancel);
            effectSignal.removeEventListener("abort", cancel);
          })
          .catch(() => undefined);
        return pending;
      });

    /**
     * Settles one prompt of a turn. A turn the agent steers holds more than
     * one open prompt (`steer` sends each note as another `session/prompt`);
     * an earlier prompt answering while a later one is open is part of the
     * same turn, whatever stop reason it gives (the agent may end it as
     * `cancelled` once the note takes over), so only the last prompt to
     * answer ends the turn and settles its usage. A prompt that fails ends
     * the turn at once, and the prompts still open answer into a turn that
     * is already over.
     */
    const settlePrompt = (
      state: SessionState,
      outcome:
        | { readonly status: "answered"; readonly result: AcpPromptResult }
        | { readonly status: "failed"; readonly error: unknown },
    ): void => {
      state.openPrompts = Math.max(0, state.openPrompts - 1);
      if (outcome.status === "answered" && state.openPrompts > 0) return;
      state.promptActive = state.openPrompts > 0;
      if (outcome.status === "answered") {
        const { result } = outcome;
        void cancelForms(state);
        if (result.stopReason === "cancelled") cancelPendingTools(state);
        // The reply settles the session's cumulative cost even
        // when the turn already failed, so the next turn is
        // charged only its own share.
        const reported =
          state.runtime.reported === undefined
            ? undefined
            : finishAcpReportedTurn(
                state.runtime.reported,
                result.usage,
                profile.turnUsageWithoutTotal,
              );
        if (state.closed || state.context.terminal) return;
        if (state.runtime.usage !== undefined) {
          const usage = finishAcpUsageTurn(state.runtime.usage, result.usage);
          if (usage !== undefined) offer(eventFor(state, factories.clock, usage));
        } else if (reported !== undefined) {
          offer(eventFor(state, factories.clock, reported));
        }
        state.context.terminal = true;
        if (result.stopReason === "cancelled") {
          offer(
            eventFor(state, factories.clock, {
              kind: "interrupted",
              message: `${name} turn was interrupted.`,
            }),
          );
        } else if (
          result.stopReason === "end_turn" ||
          outputStopReason(result.stopReason) !== undefined
        ) {
          const stop = outputStopReason(result.stopReason);
          state.completed = true;
          // A call the agent never finished (a subagent's read)
          // is done once its turn is.
          if (profile.toleratesStrayUpdates === true)
            for (const tool of state.context.tools.values()) {
              if (tool.terminal) continue;
              tool.terminal = true;
              offer(
                eventFor(state, factories.clock, {
                  kind: "tool-success",
                  toolCallId: tool.toolCallId,
                  summary: "Tool completed.",
                }),
              );
            }
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
              ...(stop === undefined ? {} : { stopReason: stop }),
            }),
          );
        } else {
          offer(
            eventFor(state, factories.clock, {
              kind: "failed",
              failure: failure(
                "provider-failed",
                result.stopReason === "refusal" && profile.refusalMessage !== undefined
                  ? profile.refusalMessage
                  : `${name} turn did not complete.`,
              ),
            }),
          );
        }
        return;
      }
      const { error } = outcome;
      void cancelForms(state);
      // A steered turn's later reply still settles its cost.
      if (state.runtime.reported !== undefined && state.openPrompts === 0)
        finishAcpReportedTurn(state.runtime.reported, undefined);
      if (state.closed || state.context.terminal) return;
      state.context.terminal = true;
      offerObservedUsage(state);
      offer(
        eventFor(state, factories.clock, {
          kind: "failed",
          failure: providerFailure(profile, error),
        }),
      );
    };

    return {
      ...(hasVerifiedCompaction(profile)
        ? {
            compact: (input: Parameters<NonNullable<ProviderConnection["compact"]>>[0]) =>
              Effect.tryPromise({
                try: async (signal) => {
                  const state = sessions.get(input.sessionId);
                  if (state === undefined || state.closed)
                    return { kind: "refused", reason: "no-session" } as const;
                  if (state.promptActive || state.compacting)
                    return { kind: "refused", reason: "turn-running" } as const;
                  if (
                    acpReleaseClaim(profile.compactionVersions, state.runtime.version) ===
                      "absent" ||
                    !state.runtime.commands.has("compact")
                  )
                    return { kind: "refused", reason: "runtime-version-unsupported" } as const;
                  // This private connection stays quarantined until the host
                  // closes its scope; later turns resume the saved history.
                  state.compacting = true;
                  state.promptActive = true;
                  const answer = await compactAcpConversation(
                    state.client,
                    state.sourceSessionId,
                    signal,
                  );
                  if (state.closed || state.runtime.isClosed())
                    return {
                      kind: "failed",
                      message: "The owned compaction session closed before its result.",
                      sessionMayHaveChanged: true,
                    } as const;
                  if (answer.kind === "compacted") {
                    state.promptActive = false;
                    offer(
                      eventFor(state, factories.clock, {
                        kind: "context-compacted",
                        trigger: "requested",
                      }),
                    );
                  }
                  return answer;
                },
                catch: (error) => providerFailure(profile, error),
              }),
          }
        : {}),
      ...(hasVerifiedFileReview(profile)
        ? {
            readFileReview: (
              input: Parameters<NonNullable<ProviderConnection["readFileReview"]>>[0],
            ) =>
              Effect.promise(async () => {
                const state = sessions.get(input.sessionId);
                if (state === undefined || state.closed)
                  return { status: "refused", reason: "no-session" } as const;
                if (state.promptActive || state.compacting)
                  return { status: "refused", reason: "turn-running" } as const;
                if (acpReleaseClaim(profile.fileReviewVersions, state.runtime.version) === "absent")
                  return { status: "refused", reason: "unsupported" } as const;
                return readAcpFileReview({
                  sourceSessionId: state.sourceSessionId,
                  path: input.path,
                  root: projectRoot,
                  ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
                  ...(input.signal === undefined ? {} : { signal: input.signal }),
                  current: () =>
                    input.current() &&
                    sessions.get(input.sessionId) === state &&
                    !state.closed &&
                    !state.promptActive &&
                    !state.runtime.isClosed(),
                  call: (method, params) => state.client.call(method, { ...params }),
                });
              }),
          }
        : {}),
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
          ...(input.answersOncePerCall === true ? { answersOncePerCall: true } : {}),
          ...(input.fullAccessSandbox === true ? { fullAccessSandbox: true } : {}),
          ...(input.strict === false ? { strict: false } : {}),
          ...(input.ownChannels === undefined ? {} : { ownChannels: input.ownChannels }),
          sourceSessionId: input.resumeCursor.value,
          ...(input.current === undefined ? {} : { current: input.current }),
          ...(input.autoApprove === undefined ? {} : { autoApprove: input.autoApprove }),
          ...(input.nativeSetup === undefined ? {} : { nativeSetup: input.nativeSetup }),
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
            error.category === "incompatible" || error.category === "unsupported"
              ? error
              : failure("stale-resume", `${name} session could not be resumed.`),
          ),
        );
      },
      send: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const { bridgeTools } = partitionTools(input.tools);
            // Each attachment goes only as a block the agent advertised: an
            // image as an image, any other file as an embedded resource. One
            // it advertised no block for is refused, not dropped.
            const { promptInputs } = state.runtime;
            if (
              input.attachments.length > 0 &&
              !promptInputs.image &&
              !promptInputs.embeddedContext &&
              !promptInputs.audio
            )
              return Effect.fail(failure("unsupported", "Native attachments are unsupported."));
            const attachments: AcpPromptAttachment[] = [];
            for (const attachment of input.attachments) {
              const block = acpPromptAttachment(attachment, promptInputs);
              if (block === undefined)
                return Effect.fail(
                  failure(
                    "unsupported",
                    promptInputs.image
                      ? `${name} takes only image attachments.`
                      : `${name} does not take image attachments.`,
                  ),
                );
              attachments.push(block);
            }
            const validationInput = { ...input, attachments: [], tools: bridgeTools };
            return rejectUnsupportedChatTurn(validationInput, {
              ...capabilities,
              appManagedTools: state.appManagedTools,
            }).pipe(
              Effect.flatMap(() => {
                const prompt = renderProviderTurnPrompt(input);
                // An agent command must open the prompt to run: the command
                // goes as its own first text block and Octant's context as
                // the next, instead of the command following the context.
                const promptBlocks =
                  profile.commandLeadsPrompt === true &&
                  input.prompt.trimStart().startsWith("/") &&
                  input.context !== undefined &&
                  input.context.length > 0
                    ? [input.prompt, renderProviderContextSections(input.context)]
                    : prompt;
                // An agent that runs only listed commands runs one its
                // session listed, or the readiness check listed until the
                // session lists any, whatever its release lists. It does so
                // in every mode; the level's tool rules decide what it does.
                const sessionListed = [...state.runtime.commands];
                const listed =
                  sessionListed.length === 0 ? factories.listedCommands.names : sessionListed;
                const opensWithSlash = prompt.trimStart().startsWith("/");
                const command = providerCommandOf(
                  input.prompt,
                  listed.map((commandName) => ({ name: commandName })),
                );
                if (
                  profile.listedCommandsOnly === true &&
                  opensWithSlash &&
                  command === undefined
                ) {
                  return Effect.fail(
                    failure(
                      "unauthorized",
                      `${name} runs only the slash commands it listed. Rephrase the request without a leading slash.`,
                    ),
                  );
                }
                if (state.context.terminal) {
                  return Effect.fail(failure("protocol", `${name} session is already terminal.`));
                }
                if (state.promptActive || state.compacting) {
                  return Effect.fail(failure("protocol", `${name} already has an active turn.`));
                }
                const catalogKey = JSON.stringify(bridgeTools);
                if (
                  (state.managedTools === undefined) !== (bridgeTools.length === 0) ||
                  (state.managedTools !== undefined && state.managedTools.catalogKey !== catalogKey)
                ) {
                  return Effect.fail(
                    failure(
                      "invalid-configuration",
                      `${name} cannot change app-managed tools while its session is active.`,
                    ),
                  );
                }
                if (state.runtime.usage !== undefined) beginAcpUsageTurn(state.runtime.usage);
                if (state.runtime.reported !== undefined)
                  beginAcpReportedTurn(state.runtime.reported);
                state.promptActive = true;
                state.openPrompts = 1;
                void state.client.prompt(state.sourceSessionId, promptBlocks, attachments).then(
                  (result) => settlePrompt(state, { status: "answered", result }),
                  (error: unknown) => settlePrompt(state, { status: "failed", error }),
                );
                return Effect.void;
              }),
            );
          }),
        ),
      ...(profile.steersMidTurn === true
        ? {
            // A note goes as another `session/prompt` on the running turn's
            // session, which the agent folds into that turn; its events
            // continue on the same turn, which ends when the last open
            // prompt answers (`settlePrompt`). A note that opens with `/`
            // would run an agent command no review admitted, so it is
            // refused, as is one with no turn running to take it.
            steer: (input: Parameters<NonNullable<ProviderConnection["steer"]>>[0]) =>
              Effect.sync(() => {
                const state = sessions.get(input.sessionId);
                if (
                  state === undefined ||
                  state.closed ||
                  state.context.terminal ||
                  state.compacting ||
                  !state.promptActive ||
                  state.openPrompts === 0 ||
                  input.message.trim().length === 0 ||
                  input.message.trimStart().startsWith("/")
                )
                  return "unsupported" as const;
                state.openPrompts += 1;
                void state.client.prompt(state.sourceSessionId, [input.message]).then(
                  (result) => settlePrompt(state, { status: "answered", result }),
                  (error: unknown) => settlePrompt(state, { status: "failed", error }),
                );
                return "steered" as const;
              }),
          }
        : {}),
      interrupt: (sessionId) =>
        stateFor(sessionId).pipe(
          Effect.flatMap((state) =>
            request(async () => {
              await cancelForms(state);
              await state.client.notify("session/cancel", { sessionId: state.sourceSessionId });
            }),
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
                options.sandboxPolicy === undefined &&
                state.completed &&
                (profile.retainsSessions === true ||
                  acpReleaseClaim(profile.retainedSessionVersions, state.runtime.version) !==
                    "absent") &&
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
      approvalCall: ({ sessionId, requestId }) => {
        const pending = sessions.get(sessionId)?.approvals.get(requestId);
        return pending?.kind === "approval" ? pending.call : undefined;
      },
      answerApproval: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const pending = state.approvals.get(input.requestId);
            if (pending === undefined) {
              return Effect.fail(failure("protocol", `${name} approval request is not pending.`));
            }
            if (state.executionPolicy === "plan" && input.approved) {
              state.approvals.delete(input.requestId);
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
            // An agent that offers its own allow-always gets it when the
            // person keeps answers for the session, so it stops asking for
            // that call, as Octant would; never for a one-call answer (an
            // automatic reviewer's, or one on a child's behalf), and never
            // when answers are kept only as the Project's default. The
            // answer's own persistence, the thread's, comes before the host's.
            const remembers =
              input.scope !== "once" &&
              pending.allowAlwaysOptionId !== undefined &&
              (input.persistence ?? permissionPersistence(options)) === "current-session";
            const allowOptionId =
              remembers && pending.allowAlwaysOptionId !== undefined
                ? pending.allowAlwaysOptionId
                : pending.allowOptionId;
            // Offered only allow-always, an approval that does not hold for
            // the session has no option to choose. Sending the reject instead
            // would let the host record an approval the agent never got, so
            // nothing is sent and the request stays pending for a denial or an
            // approval that holds for the session.
            const selected = input.approved ? allowOptionId : pending.rejectOptionId;
            if (selected === undefined) {
              return Effect.fail(
                failure(
                  "unsupported",
                  `${name} only offers Always allow here. Approve it where approvals are kept for the session, at the computer or a Full device, or deny it.`,
                ),
              );
            }
            state.approvals.delete(input.requestId);
            return request(() =>
              state.client.respondPermission(pending.providerRequestId, selected),
            );
          }),
        ),
      answerUserInput: (input) =>
        stateFor(input.sessionId).pipe(
          Effect.flatMap((state) => {
            const form = state.forms.get(input.requestId);
            if (form !== undefined) {
              if (state.closed || state.context.terminal || !state.promptActive) {
                return Effect.fail(failure("protocol", `${name} question is no longer pending.`));
              }
              const answer = answerAcpElicitation(form.form, input.answer);
              if (answer.status === "invalid")
                return Effect.fail(failure("protocol", "The questionnaire answer is invalid."));
              state.forms.delete(input.requestId);
              return request(async () => {
                try {
                  await state.client.respond(form.id, {
                    action: "accept",
                    content: answer.content,
                  });
                } catch (error) {
                  state.completed = false;
                  state.context.terminal = true;
                  offerObservedUsage(state);
                  offer(
                    eventFor(state, factories.clock, {
                      kind: "failed",
                      failure: failure(
                        "protocol",
                        "The questionnaire answer could not be delivered; its callback cannot be replayed.",
                      ),
                    }),
                  );
                  throw error;
                }
              });
            }
            // The refusal names what the probe reported for this release, so a
            // form-asking agent on a release older than its reviewed one says
            // `unavailable`.
            const questions = baseCapabilities(
              profile,
              undefined,
              state.runtime.version,
            ).userQuestions;
            if (questions !== "supported") {
              return Effect.fail(
                failure(
                  questions,
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
      ...(mapped.allowOptionId === undefined ? {} : { allowOptionId: mapped.allowOptionId }),
      ...(mapped.allowAlwaysOptionId === undefined
        ? {}
        : { allowAlwaysOptionId: mapped.allowAlwaysOptionId }),
      rejectOptionId: mapped.rejectOptionId,
      ...(mapped.call === undefined ? {} : { call: mapped.call }),
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
