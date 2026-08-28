import { Schema } from "effect";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const brandedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));

export const ProviderInstanceId = brandedUuid("ProviderInstanceId");
export type ProviderInstanceId = typeof ProviderInstanceId.Type;
export const ProviderSessionId = brandedUuid("ProviderSessionId");
export type ProviderSessionId = typeof ProviderSessionId.Type;
export const ProviderModelId = brandedString("ProviderModelId");
export type ProviderModelId = typeof ProviderModelId.Type;

export const ThreadProviderHandoff = Schema.Struct({
  previousProviderInstanceId: ProviderInstanceId,
  previousModelId: ProviderModelId,
  nextProviderInstanceId: ProviderInstanceId,
  nextModelId: ProviderModelId,
  changedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadProviderHandoff = typeof ThreadProviderHandoff.Type;

export const ProviderDriverKind = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "kilo",
  "pi",
  "oh-my-pi",
  "devin",
  "mistral-vibe",
  "ollama",
  "kimi-code",
  "grok",
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
  "openai-image",
  "gemini-native-image",
);
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

export const ProviderCapabilitySupport = Schema.Literal("supported", "unsupported", "unavailable");
export type ProviderCapabilitySupport = typeof ProviderCapabilitySupport.Type;
export const ProviderInputModality = Schema.Literal("text", "image", "audio", "document");
export type ProviderInputModality = typeof ProviderInputModality.Type;
const UniqueInputModalities = Schema.Array(ProviderInputModality).pipe(
  Schema.filter(
    (modalities) =>
      modalities.length > 0 &&
      modalities.length <= 4 &&
      new Set(modalities).size === modalities.length,
  ),
);
const ProviderPromptText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_000_000));
const BoundedProviderJson = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0 || value.length > 65_536) return false;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }),
);
const BoundedProviderSnippet = Schema.String.pipe(Schema.maxLength(4_096));
const BoundedProviderUrl = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2_048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);
const BoundedProviderTitle = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
const BoundedProviderQuery = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048));
const BoundedProviderRequestId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));
const BoundedProviderToolName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));
const BoundedProviderToolDescription = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048));
const BoundedProviderAttachmentId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));
const BoundedProviderDisplayName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const BoundedProviderMediaType = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const MAX_PROVIDER_JSON_BYTES = 65_536;
const MAX_PROVIDER_JSON_DEPTH = 16;
const MAX_PROVIDER_JSON_ENTRIES = 256;
const MAX_PROVIDER_JSON_KEY_LENGTH = 128;
const MAX_PROVIDER_JSON_STRING_LENGTH = 4_096;
const MAX_PROVIDER_ATTACHMENT_BYTES = 26_214_400;
const MAX_PROVIDER_ATTACHMENTS = 16;
export const MAX_PROVIDER_CONTEXT_BLOCKS = 256;
export const MAX_PROVIDER_TOOLS = 8;
const ProviderAttachmentBytes = Schema.declare(
  (input: unknown): input is Uint8Array =>
    input instanceof Uint8Array &&
    input.byteLength > 0 &&
    input.byteLength <= MAX_PROVIDER_ATTACHMENT_BYTES,
);
function isBoundedProviderJsonValue(value: unknown, depth: number, active: Set<object>): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return Array.from(value).length <= MAX_PROVIDER_JSON_STRING_LENGTH;
  if (typeof value !== "object" || depth > MAX_PROVIDER_JSON_DEPTH || active.has(value)) {
    return false;
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= MAX_PROVIDER_JSON_ENTRIES &&
        value.every((entry) => isBoundedProviderJsonValue(entry, depth + 1, active))
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_PROVIDER_JSON_ENTRIES ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          key.trim().length === 0 ||
          Array.from(key).length > MAX_PROVIDER_JSON_KEY_LENGTH,
      )
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        isBoundedProviderJsonValue(descriptor.value, depth + 1, active)
      );
    });
  } finally {
    active.delete(value);
  }
}

function isBoundedProviderJsonRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !isBoundedProviderJsonValue(input, 0, new Set())
  ) {
    return false;
  }
  try {
    const encoded = JSON.stringify(input);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <= MAX_PROVIDER_JSON_BYTES
    );
  } catch {
    return false;
  }
}

const ProviderToolInputSchema = Schema.declare(isBoundedProviderJsonRecord);
/**
 * Thread access postures, ordered from most to least authority.
 *
 * `auto-accept-edits` sits between full access and approval-gated: file writes
 * inside the bound project proceed without a prompt, while shell, network,
 * outside-project reach, and every irreversible class stay gated exactly as
 * they are under `approval-gated`.
 */
export const ProviderExecutionPolicy = Schema.Literal(
  "full-access",
  "auto-accept-edits",
  "approval-gated",
  "plan",
);
export type ProviderExecutionPolicy = typeof ProviderExecutionPolicy.Type;
export const PermissionPersistence = Schema.Literal("current-session", "project-default");
export type PermissionPersistence = typeof PermissionPersistence.Type;
export const ProviderReadiness = Schema.Literal(
  "ready",
  "unavailable",
  "unauthenticated",
  "incompatible",
  "degraded",
  "checking",
);
export type ProviderReadiness = typeof ProviderReadiness.Type;
export const ProviderProcessState = Schema.Literal("stopped", "starting", "running", "stopping");
export type ProviderProcessState = typeof ProviderProcessState.Type;

export const OpenCodeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("opencode-cli"),
  binaryPath: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type OpenCodeProviderConfiguration = typeof OpenCodeProviderConfiguration.Type;

const AbsoluteBinaryPath = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((path) => path.startsWith("/")),
);
export const KimiCodeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("kimi-code-acp"),
  binaryPath: AbsoluteBinaryPath,
}).annotations(strict);
export type KimiCodeProviderConfiguration = typeof KimiCodeProviderConfiguration.Type;

export const KiloProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("kilo-acp"),
  binaryPath: AbsoluteBinaryPath,
}).annotations(strict);
export type KiloProviderConfiguration = typeof KiloProviderConfiguration.Type;

export const MistralVibeAuthentication = Schema.Literal("subscription", "api-key");
export type MistralVibeAuthentication = typeof MistralVibeAuthentication.Type;
export const MistralVibeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("mistral-vibe-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: MistralVibeAuthentication,
}).annotations(strict);
export type MistralVibeProviderConfiguration = typeof MistralVibeProviderConfiguration.Type;

export const GrokAuthentication = Schema.Literal("subscription", "api-key");
export type GrokAuthentication = typeof GrokAuthentication.Type;
export const GrokProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("grok-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: GrokAuthentication,
}).annotations(strict);
export type GrokProviderConfiguration = typeof GrokProviderConfiguration.Type;

export const DevinProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("devin-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: Schema.Literal("subscription"),
}).annotations(strict);
export type DevinProviderConfiguration = typeof DevinProviderConfiguration.Type;

export const PiProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("pi-rpc"),
  binaryPath: AbsoluteBinaryPath,
}).annotations(strict);
export type PiProviderConfiguration = typeof PiProviderConfiguration.Type;

export const OhMyPiProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("oh-my-pi-rpc"),
  binaryPath: AbsoluteBinaryPath,
  /** Observed CLI version pin used by the fail-closed probe, e.g. 17.2.1 */
  supportedVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
}).annotations(strict);
export type OhMyPiProviderConfiguration = typeof OhMyPiProviderConfiguration.Type;

export const OllamaProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("ollama-native-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type OllamaProviderConfiguration = typeof OllamaProviderConfiguration.Type;

const OllamaHistoryText = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && value.length <= 262_144),
);
export const OllamaHistoryMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: OllamaHistoryText,
}).annotations(strict);
export type OllamaHistoryMessage = typeof OllamaHistoryMessage.Type;
const OllamaHistory = Schema.Array(OllamaHistoryMessage).pipe(
  Schema.filter(
    (history) =>
      history.length <= 256 &&
      history.reduce((total, message) => total + message.text.length, 0) <= 1_048_576,
  ),
);
export const OllamaHistorySnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  root: Schema.NonEmptyTrimmedString,
  mode: OctantMode,
  modelId: ProviderModelId,
  history: OllamaHistory,
}).annotations(strict);
export type OllamaHistorySnapshot = typeof OllamaHistorySnapshot.Type;
export const OllamaHistoryRecorded = Schema.Struct({
  snapshot: OllamaHistorySnapshot,
}).annotations(strict);
export type OllamaHistoryRecorded = typeof OllamaHistoryRecorded.Type;

export const OpenAiCompatibleProtocol = Schema.Literal("auto", "responses", "chat-completions");
export type OpenAiCompatibleProtocol = typeof OpenAiCompatibleProtocol.Type;
export const ProviderCredentialStatus = Schema.Literal("stored", "missing", "unavailable");
export type ProviderCredentialStatus = typeof ProviderCredentialStatus.Type;
const UniqueManualModelIds = Schema.Array(ProviderModelId).pipe(
  Schema.filter((modelIds) => new Set(modelIds).size === modelIds.length),
);
export const OpenAiCompatibleProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("openai-compatible-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  authentication: Schema.Literal("bearer", "none"),
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
}).annotations(strict);
export type OpenAiCompatibleProviderConfiguration =
  typeof OpenAiCompatibleProviderConfiguration.Type;
export const AnthropicCompatibleProtocol = Schema.Literal("auto", "messages");
export type AnthropicCompatibleProtocol = typeof AnthropicCompatibleProtocol.Type;
export const AnthropicCompatibleAuthentication = Schema.Literal("api-key", "bearer", "none");
export type AnthropicCompatibleAuthentication = typeof AnthropicCompatibleAuthentication.Type;
export const AnthropicCompatibleProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("anthropic-compatible-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  authentication: AnthropicCompatibleAuthentication,
  protocol: AnthropicCompatibleProtocol,
  protocolVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  manualModelIds: UniqueManualModelIds,
}).annotations(strict);
export type AnthropicCompatibleProviderConfiguration =
  typeof AnthropicCompatibleProviderConfiguration.Type;
export const AzureFoundryAuthentication = Schema.Literal("api-key");
export type AzureFoundryAuthentication = typeof AzureFoundryAuthentication.Type;
export const AzureFoundryProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("azure-foundry-openai-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  authentication: AzureFoundryAuthentication,
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
}).annotations(strict);
export type AzureFoundryProviderConfiguration = typeof AzureFoundryProviderConfiguration.Type;

/**
 * Suggested GPT Image model IDs for Settings. Image allowlists are
 * manual-entry; these names are not the only values Octant accepts and are
 * never rewritten on save.
 */
export const OPENAI_IMAGE_MODEL_PRESETS = [
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
export const OPENAI_IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const OpenAiImageQuality = Schema.Literal(...OPENAI_IMAGE_QUALITIES);
export type OpenAiImageQuality = typeof OpenAiImageQuality.Type;
export const OPENAI_IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const OpenAiImageSize = Schema.Literal(...OPENAI_IMAGE_SIZES);
export type OpenAiImageSize = typeof OpenAiImageSize.Type;
const imageAllowlistContainsDefault = (configuration: {
  readonly modelAllowlist: ReadonlyArray<string>;
  readonly defaultModel: string;
}): boolean =>
  configuration.modelAllowlist.some((id) => String(id) === String(configuration.defaultModel));
export const OpenAiImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("openai-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
  quality: Schema.optional(OpenAiImageQuality),
  size: Schema.optional(OpenAiImageSize),
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type OpenAiImageProviderConfiguration = typeof OpenAiImageProviderConfiguration.Type;

/**
 * Suggested Gemini image model IDs for Settings. `gemini-2.5-flash-image` is
 * legacy; allowlists stay manual-entry and are never rewritten on save.
 */
export const GEMINI_IMAGE_MODEL_PRESETS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
] as const;
export const GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export const GeminiImageAspectRatio = Schema.Literal(...GEMINI_IMAGE_ASPECT_RATIOS);
export type GeminiImageAspectRatio = typeof GeminiImageAspectRatio.Type;
export const GEMINI_IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export const GeminiImageResolution = Schema.Literal(...GEMINI_IMAGE_RESOLUTIONS);
export type GeminiImageResolution = typeof GeminiImageResolution.Type;
export const GeminiImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("gemini-native-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type GeminiImageProviderConfiguration = typeof GeminiImageProviderConfiguration.Type;
export const CodexProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("codex-cli"),
  binaryPath: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type CodexProviderConfiguration = typeof CodexProviderConfiguration.Type;
export const ClaudeAuthentication = Schema.Literal("subscription", "api-key");
export type ClaudeAuthentication = typeof ClaudeAuthentication.Type;
export const ClaudeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("claude-agent-sdk"),
  binaryPath: Schema.NonEmptyTrimmedString,
  authentication: ClaudeAuthentication,
}).annotations(strict);
export type ClaudeProviderConfiguration = typeof ClaudeProviderConfiguration.Type;

const ProviderInstanceFields = {
  id: ProviderInstanceId,
  displayName: Schema.NonEmptyTrimmedString,
  enabled: Schema.Boolean,
  environmentPolicy: Schema.Literal("inherit-host"),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
} as const;

export const OpenCodeProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("opencode"),
  configuration: OpenCodeProviderConfiguration,
}).annotations(strict);
export type OpenCodeProviderInstance = typeof OpenCodeProviderInstance.Type;
export const CodexProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("codex"),
  configuration: CodexProviderConfiguration,
}).annotations(strict);
export type CodexProviderInstance = typeof CodexProviderInstance.Type;
export const ClaudeProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("claude"),
  configuration: ClaudeProviderConfiguration,
}).annotations(strict);
export type ClaudeProviderInstance = typeof ClaudeProviderInstance.Type;
export const KimiCodeProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("kimi-code"),
  configuration: KimiCodeProviderConfiguration,
}).annotations(strict);
export type KimiCodeProviderInstance = typeof KimiCodeProviderInstance.Type;

export const KiloProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("kilo"),
  configuration: KiloProviderConfiguration,
}).annotations(strict);
export type KiloProviderInstance = typeof KiloProviderInstance.Type;

export const MistralVibeProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("mistral-vibe"),
  configuration: MistralVibeProviderConfiguration,
}).annotations(strict);
export type MistralVibeProviderInstance = typeof MistralVibeProviderInstance.Type;

export const GrokProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("grok"),
  configuration: GrokProviderConfiguration,
}).annotations(strict);
export type GrokProviderInstance = typeof GrokProviderInstance.Type;

export const DevinProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("devin"),
  configuration: DevinProviderConfiguration,
}).annotations(strict);
export type DevinProviderInstance = typeof DevinProviderInstance.Type;

export const PiProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("pi"),
  configuration: PiProviderConfiguration,
}).annotations(strict);
export type PiProviderInstance = typeof PiProviderInstance.Type;

export const OhMyPiProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("oh-my-pi"),
  configuration: OhMyPiProviderConfiguration,
}).annotations(strict);
export type OhMyPiProviderInstance = typeof OhMyPiProviderInstance.Type;

export const OllamaProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("ollama"),
  configuration: OllamaProviderConfiguration,
}).annotations(strict);
export type OllamaProviderInstance = typeof OllamaProviderInstance.Type;

export const OpenAiCompatibleProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("openai-compatible"),
  configuration: OpenAiCompatibleProviderConfiguration,
}).annotations(strict);
export type OpenAiCompatibleProviderInstance = typeof OpenAiCompatibleProviderInstance.Type;

export const AnthropicCompatibleProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("anthropic-compatible"),
  configuration: AnthropicCompatibleProviderConfiguration,
}).annotations(strict);
export type AnthropicCompatibleProviderInstance = typeof AnthropicCompatibleProviderInstance.Type;

export const AzureFoundryProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("azure-foundry"),
  configuration: AzureFoundryProviderConfiguration,
}).annotations(strict);
export type AzureFoundryProviderInstance = typeof AzureFoundryProviderInstance.Type;

export const OpenAiImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("openai-image"),
  configuration: OpenAiImageProviderConfiguration,
}).annotations(strict);
export type OpenAiImageProviderInstance = typeof OpenAiImageProviderInstance.Type;

export const GeminiImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("gemini-native-image"),
  configuration: GeminiImageProviderConfiguration,
}).annotations(strict);
export type GeminiImageProviderInstance = typeof GeminiImageProviderInstance.Type;

export const ProviderInstance = Schema.Union(
  OpenCodeProviderInstance,
  CodexProviderInstance,
  ClaudeProviderInstance,
  KimiCodeProviderInstance,
  KiloProviderInstance,
  MistralVibeProviderInstance,
  GrokProviderInstance,
  DevinProviderInstance,
  PiProviderInstance,
  OhMyPiProviderInstance,
  OllamaProviderInstance,
  OpenAiCompatibleProviderInstance,
  AnthropicCompatibleProviderInstance,
  AzureFoundryProviderInstance,
  OpenAiImageProviderInstance,
  GeminiImageProviderInstance,
);
export type ProviderInstance = typeof ProviderInstance.Type;

/**
 * One Settings-defined agent-eligible model reference. Membership in
 * this default pool is a selection default only: it never configures
 * credentials, activates a provider, or widens authority, and routing still
 * fail-closes per candidate at execution time.
 */
export const AgentEligibleModelRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type AgentEligibleModelRef = typeof AgentEligibleModelRef.Type;

const MAX_AGENT_ELIGIBLE_MODELS = 16;

const agentEligibleModelKey = (ref: AgentEligibleModelRef): string =>
  `${ref.providerInstanceId}:${ref.modelId}`;

const UniqueAgentEligibleModels = Schema.Array(AgentEligibleModelRef).pipe(
  Schema.filter(
    (refs) =>
      refs.length <= MAX_AGENT_ELIGIBLE_MODELS &&
      new Set(refs.map(agentEligibleModelKey)).size === refs.length,
  ),
);

export const ProviderDefaults = Schema.Struct({
  permissionPersistence: PermissionPersistence,
  providerOrder: Schema.optional(
    Schema.Array(ProviderInstanceId).pipe(Schema.filter((ids) => new Set(ids).size === ids.length)),
  ),
  /**
   * Settings-defined default agent-eligible pool. Absent means the
   * default pool has not been configured; composers then offer no
   * multi-model pool until Settings defines one.
   */
  agentEligibleModels: Schema.optional(UniqueAgentEligibleModels),
  version: AggregateVersion,
}).annotations(strict);
export type ProviderDefaults = typeof ProviderDefaults.Type;

export const ProviderInstanceCreated = Schema.Struct({ instance: ProviderInstance }).annotations(
  strict,
);
export type ProviderInstanceCreated = typeof ProviderInstanceCreated.Type;
export const ProviderInstanceRenamed = Schema.Struct({ instance: ProviderInstance }).annotations(
  strict,
);
export type ProviderInstanceRenamed = typeof ProviderInstanceRenamed.Type;
export const ProviderInstanceBinaryChanged = Schema.Struct({
  instance: Schema.Union(OpenCodeProviderInstance, CodexProviderInstance, KimiCodeProviderInstance),
}).annotations(strict);
export type ProviderInstanceBinaryChanged = typeof ProviderInstanceBinaryChanged.Type;
export const ProviderInstanceConfigurationChanged = Schema.Struct({
  instance: Schema.Union(
    OpenAiCompatibleProviderInstance,
    AnthropicCompatibleProviderInstance,
    AzureFoundryProviderInstance,
    OpenAiImageProviderInstance,
    GeminiImageProviderInstance,
    ClaudeProviderInstance,
    MistralVibeProviderInstance,
    GrokProviderInstance,
    KiloProviderInstance,
    DevinProviderInstance,
    PiProviderInstance,
    OhMyPiProviderInstance,
    OllamaProviderInstance,
  ),
}).annotations(strict);
export type ProviderInstanceConfigurationChanged = typeof ProviderInstanceConfigurationChanged.Type;
export const ProviderInstanceEnabledChanged = Schema.Struct({
  instance: ProviderInstance,
}).annotations(strict);
export type ProviderInstanceEnabledChanged = typeof ProviderInstanceEnabledChanged.Type;
export const ProviderInstanceRemoved = Schema.Struct({
  instanceId: ProviderInstanceId,
  version: AggregateVersion,
}).annotations(strict);
export type ProviderInstanceRemoved = typeof ProviderInstanceRemoved.Type;
export const ProviderDefaultsUpdated = Schema.Struct({ defaults: ProviderDefaults }).annotations(
  strict,
);
export type ProviderDefaultsUpdated = typeof ProviderDefaultsUpdated.Type;

export const PROVIDER_EVENT_NAMES = [
  "provider.instance-created@1",
  "provider.instance-renamed@1",
  "provider.instance-binary-changed@1",
  "provider.instance-configuration-changed@1",
  "provider.instance-enabled-changed@1",
  "provider.instance-removed@1",
  "provider.defaults-updated@1",
  "provider.catalog-updated@1",
] as const;

/**
 * Whether a model can read image input, as a driver-reported fact.
 *
 * Distinct from {@link ProviderCapabilitySupport} because absence of evidence
 * must stay visible: `unknown` means no driver reported the capability, and
 * honesty rules forbid treating it as `supported`. Drivers report the field
 * only when they hold genuine metadata (an observed vision capability, a
 * modality list from the provider); everything else decodes as absent and is
 * normalized to `unknown` by consumers.
 */
export const ImageInputCapability = Schema.Literal("supported", "unsupported", "unknown");
export type ImageInputCapability = typeof ImageInputCapability.Type;

export const CapabilityEvidenceSource = Schema.Literal(
  "endpoint-observation",
  "provider-metadata",
  "catalog-metadata",
  "user-metadata",
  "unknown",
);
export type CapabilityEvidenceSource = typeof CapabilityEvidenceSource.Type;

export const CapabilityEvidenceConfidence = Schema.Literal("high", "medium", "low", "unknown");
export type CapabilityEvidenceConfidence = typeof CapabilityEvidenceConfidence.Type;

export const ProviderModelCapability = Schema.Literal(
  "tool-calling",
  "parallel-tools",
  "structured-output",
  "reasoning",
  "streaming",
  "context-limit",
  "max-output-tokens",
  "input-modalities",
);
export type ProviderModelCapability = typeof ProviderModelCapability.Type;

const CapabilityEvidenceProtocol = Schema.Literal(
  "responses",
  "chat-completions",
  "anthropic-messages",
  "acp",
  "rpc",
  "native",
  "unknown",
);

export const CapabilityEvidence = Schema.Struct({
  capability: ProviderModelCapability,
  support: ProviderCapabilitySupport,
  source: CapabilityEvidenceSource,
  confidence: CapabilityEvidenceConfidence,
  protocol: CapabilityEvidenceProtocol,
  observedAt: UtcTimestamp,
  invalidated: Schema.Boolean,
  invalidatedAt: Schema.optional(UtcTimestamp),
  invalidationReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type CapabilityEvidence = typeof CapabilityEvidence.Type;

const ProviderBooleanModelOption = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  displayName: Schema.NonEmptyTrimmedString,
  kind: Schema.Literal("boolean"),
}).annotations(strict);

const ProviderSelectionModelOption = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  displayName: Schema.NonEmptyTrimmedString,
  kind: Schema.Literal("selection"),
  values: Schema.NonEmptyArray(Schema.NonEmptyTrimmedString),
}).annotations(strict);

export const ProviderModelOption = Schema.Union(
  ProviderBooleanModelOption,
  ProviderSelectionModelOption,
);
export type ProviderModelOption = typeof ProviderModelOption.Type;

export const MAX_PROVIDER_MODEL_OPTION_VALUES = 16;
const ProviderModelOptionKey = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));

/**
 * A user's chosen value per declared model option (e.g. `effort`,
 * `reasoning`, `service-tier`), keyed by `ProviderModelOption.id`. Absent keys
 * mean the provider default. Only values the selected model actually declares
 * are meaningful; the server validates against the current catalog.
 */
export const ProviderModelOptionValues = Schema.Record({
  key: ProviderModelOptionKey,
  value: ProviderModelOptionKey,
})
  .annotations(strict)
  .pipe(
    Schema.filter((values) => Object.keys(values).length <= MAX_PROVIDER_MODEL_OPTION_VALUES, {
      message: () => `At most ${MAX_PROVIDER_MODEL_OPTION_VALUES} model option values`,
    }),
  );
export type ProviderModelOptionValues = typeof ProviderModelOptionValues.Type;

const ProviderModelFields = {
  id: ProviderModelId,
  displayName: Schema.NonEmptyTrimmedString,
  orderHint: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  contextLimit: Schema.optional(Schema.Int.pipe(Schema.positive())),
  maxOutputTokens: Schema.optional(Schema.Int.pipe(Schema.positive())),
  reasoning: ProviderCapabilitySupport,
  toolCalling: Schema.optional(ProviderCapabilitySupport),
  parallelTools: Schema.optional(ProviderCapabilitySupport),
  structuredOutput: Schema.optional(ProviderCapabilitySupport),
  streaming: Schema.optional(ProviderCapabilitySupport),
  inputModalities: UniqueInputModalities,
  imageInput: Schema.optional(ImageInputCapability),
  options: Schema.Array(ProviderModelOption),
  capabilityEvidence: Schema.optional(Schema.Array(CapabilityEvidence)),
} as const;

export const ProviderModel = Schema.Union(
  Schema.Struct({
    ...ProviderModelFields,
    source: Schema.Literal("discovered"),
    verification: Schema.Literal("verified"),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderModelFields,
    source: Schema.Literal("manual"),
    verification: Schema.Literal("unverified", "verified"),
  }).annotations(strict),
);
export type ProviderModel = typeof ProviderModel.Type;

export const ProviderCatalogSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  version: AggregateVersion,
  models: Schema.Array(ProviderModel).pipe(
    Schema.filter((models) => new Set(models.map(({ id }) => String(id))).size === models.length),
  ),
  manualModelOrder: Schema.Array(ProviderModelId).pipe(
    Schema.filter((ids) => new Set(ids).size === ids.length),
  ),
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  invalidated: Schema.Boolean,
  invalidatedAt: Schema.optional(UtcTimestamp),
  invalidationReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ProviderCatalogSnapshot = typeof ProviderCatalogSnapshot.Type;

export const ProviderCatalogUpdated = Schema.Struct({
  snapshot: ProviderCatalogSnapshot,
}).annotations(strict);
export type ProviderCatalogUpdated = typeof ProviderCatalogUpdated.Type;

export const ProviderCapabilities = Schema.Struct({
  streaming: ProviderCapabilitySupport,
  resume: ProviderCapabilitySupport,
  interruption: ProviderCapabilitySupport,
  approvals: ProviderCapabilitySupport,
  userQuestions: ProviderCapabilitySupport,
  reasoning: ProviderCapabilitySupport,
  usage: ProviderCapabilitySupport,
  toolActivity: ProviderCapabilitySupport,
  fileChanges: ProviderCapabilitySupport,
  diffs: ProviderCapabilitySupport,
  taskProgress: ProviderCapabilitySupport,
  nativeChildAgents: ProviderCapabilitySupport,
  nativeAttachments: ProviderCapabilitySupport,
  nativeWebResearch: ProviderCapabilitySupport,
  appManagedTools: ProviderCapabilitySupport,
  citations: ProviderCapabilitySupport,
}).annotations(strict);
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

export const ProviderAttachmentInput = Schema.Struct({
  attachmentId: BoundedProviderAttachmentId,
  displayName: BoundedProviderDisplayName,
  mediaType: BoundedProviderMediaType,
  bytes: ProviderAttachmentBytes,
}).annotations(strict);
export type ProviderAttachmentInput = typeof ProviderAttachmentInput.Type;

export const ProviderToolDefinition = Schema.Struct({
  name: BoundedProviderToolName,
  description: Schema.optional(BoundedProviderToolDescription),
  inputSchema: ProviderToolInputSchema,
}).annotations(strict);
export type ProviderToolDefinition = typeof ProviderToolDefinition.Type;

export const ProviderContextBlock = Schema.Struct({
  kind: Schema.Literal(
    "instructions",
    "user-message",
    "assistant-message",
    "project-memory",
    "work-item",
    // Compacted earlier conversation. Distinct from a real message so the
    // model is never told a summary is something a participant actually said.
    "conversation-summary",
  ),
  text: ProviderPromptText,
}).annotations(strict);
export type ProviderContextBlock = typeof ProviderContextBlock.Type;

export const ProviderTurnInput = Schema.Struct({
  sessionId: ProviderSessionId,
  prompt: ProviderPromptText,
  context: Schema.optional(
    Schema.Array(ProviderContextBlock).pipe(
      Schema.filter((blocks) => blocks.length <= MAX_PROVIDER_CONTEXT_BLOCKS),
    ),
  ),
  attachments: Schema.Array(ProviderAttachmentInput).pipe(
    Schema.filter((attachments) => attachments.length <= MAX_PROVIDER_ATTACHMENTS),
  ),
  tools: Schema.Array(ProviderToolDefinition).pipe(
    Schema.filter((tools) => tools.length <= MAX_PROVIDER_TOOLS),
  ),
}).annotations(strict);
export type ProviderTurnInput = typeof ProviderTurnInput.Type;

export const ProviderToolAnswer = Schema.Struct({
  sessionId: ProviderSessionId,
  requestId: BoundedProviderRequestId,
  resultJson: BoundedProviderJson,
  isError: Schema.Boolean,
}).annotations(strict);
export type ProviderToolAnswer = typeof ProviderToolAnswer.Type;

export const ProviderObservedState = Schema.Struct({
  instanceId: ProviderInstanceId,
  readiness: ProviderReadiness,
  processState: ProviderProcessState,
  detectedVersion: Schema.optional(Schema.NonEmptyTrimmedString),
  observedProtocol: Schema.optional(OpenAiCompatibleProtocol),
  credentialStatus: Schema.optional(ProviderCredentialStatus),
  models: Schema.Array(ProviderModel),
  capabilities: ProviderCapabilities,
  // Foundry-specific: deployment IDs that have been explicitly verified for
  // tool support via the separate verify-foundry-tools path. The sender gates
  // tool requests per-model against this set, not against the provider-level
  // appManagedTools flag, so one verified deployment does not unlock tools
  // for other deployments in the same profile.
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  message: Schema.optional(Schema.NonEmptyTrimmedString),
  lastSuccessfulProbeAt: Schema.optional(UtcTimestamp),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ProviderObservedState = typeof ProviderObservedState.Type;

export const ProviderRegistrySnapshot = Schema.Struct({
  instances: Schema.Array(ProviderInstance),
  defaults: ProviderDefaults,
  observedStates: Schema.Array(ProviderObservedState),
  catalogs: Schema.optional(Schema.Array(ProviderCatalogSnapshot)),
}).annotations(strict);
export type ProviderRegistrySnapshot = typeof ProviderRegistrySnapshot.Type;

const ProviderInstanceCommandFields = {
  instanceId: ProviderInstanceId,
  expectedVersion: AggregateVersion,
} as const;

const CreateProviderCommandFields = {
  ...ProviderInstanceCommandFields,
  enabled: Schema.optional(Schema.Boolean),
} as const;

const ProviderAuthenticationAttemptId = brandedString("ProviderAuthenticationAttemptId");
export const ProviderAuthenticationAttempt = Schema.Struct({
  attemptId: ProviderAuthenticationAttemptId,
  signInUrl: Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }),
  ),
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type ProviderAuthenticationAttempt = typeof ProviderAuthenticationAttempt.Type;

export const ProviderRegistryCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-opencode-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    binaryPath: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-openai-compatible-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OpenAiCompatibleProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-anthropic-compatible-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: AnthropicCompatibleProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-azure-foundry-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: AzureFoundryProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-openai-image-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OpenAiImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-gemini-native-image-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GeminiImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-codex-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    binaryPath: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-kimi-code-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    binaryPath: AbsoluteBinaryPath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-claude-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: ClaudeProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-mistral-vibe-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: MistralVibeProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-grok-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GrokProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-devin-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: DevinProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-kilo-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: KiloProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-pi-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: PiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-oh-my-pi-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OhMyPiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-ollama-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OllamaProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename-provider"),
    ...ProviderInstanceCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-provider-binary"),
    ...ProviderInstanceCommandFields,
    binaryPath: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-openai-compatible-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OpenAiCompatibleProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-anthropic-compatible-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AnthropicCompatibleProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-azure-foundry-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AzureFoundryProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-openai-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OpenAiImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-gemini-native-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GeminiImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-claude-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: ClaudeProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-mistral-vibe-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: MistralVibeProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-grok-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GrokProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-devin-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: DevinProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-kilo-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: KiloProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-pi-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: PiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-oh-my-pi-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OhMyPiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-ollama-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OllamaProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-provider-enabled"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-provider"),
    ...ProviderInstanceCommandFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("update-provider-defaults"),
    expectedVersion: AggregateVersion,
    permissionPersistence: PermissionPersistence,
    providerOrder: Schema.optional(
      Schema.Array(ProviderInstanceId).pipe(
        Schema.filter((ids) => new Set(ids).size === ids.length),
      ),
    ),
    agentEligibleModels: Schema.optional(UniqueAgentEligibleModels),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("probe-provider"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("verify-foundry-tools"),
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("begin-provider-authentication"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("complete-provider-authentication"),
    instanceId: ProviderInstanceId,
    attemptId: ProviderAuthenticationAttemptId,
  }).annotations(strict),
);
export type ProviderRegistryCommand = typeof ProviderRegistryCommand.Type;

export const ProviderProbeResult = ProviderObservedState;
export type ProviderProbeResult = typeof ProviderProbeResult.Type;

export const ProviderRegistryCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("provider-created"),
    instance: ProviderInstance,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-updated"),
    instance: ProviderInstance,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-removed"),
    instanceId: ProviderInstanceId,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-defaults-updated"),
    defaults: ProviderDefaults,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-probed"),
    result: ProviderProbeResult,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("foundry-tools-verified"),
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    appManagedTools: Schema.Literal("supported", "unsupported"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-started"),
    instanceId: ProviderInstanceId,
    attempt: ProviderAuthenticationAttempt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-completed"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
);
export type ProviderRegistryCommandResult = typeof ProviderRegistryCommandResult.Type;

export const ProviderResumeCursor = Schema.Struct({
  driverKind: ProviderDriverKind,
  value: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ProviderResumeCursor = typeof ProviderResumeCursor.Type;

export const ProviderFailureCategory = Schema.Literal(
  "unavailable",
  "unauthenticated",
  "incompatible",
  "unsupported",
  "unauthorized",
  "interrupted",
  "stale-resume",
  "invalid-configuration",
  "protocol",
  "rate-limited",
  "provider-failed",
);
export type ProviderFailureCategory = typeof ProviderFailureCategory.Type;

export const ProviderFailure = Schema.Struct({
  category: ProviderFailureCategory,
  message: Schema.NonEmptyTrimmedString,
  retryAfterMs: Schema.optional(
    Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  ),
}).annotations(strict);
export type ProviderFailure = typeof ProviderFailure.Type;

const ProviderRuntimeEventFields = {
  instanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
} as const;

export const ProviderRuntimeEvent = Schema.Union(
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("text-delta"),
    text: Schema.NonEmptyString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("reasoning-delta"),
    text: Schema.NonEmptyString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-start"),
    toolCallId: Schema.NonEmptyTrimmedString,
    toolName: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-progress"),
    toolCallId: Schema.NonEmptyTrimmedString,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-success"),
    toolCallId: Schema.NonEmptyTrimmedString,
    summary: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-failure"),
    toolCallId: Schema.NonEmptyTrimmedString,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("usage"),
    inputTokens: Schema.Int.pipe(Schema.nonNegative()),
    outputTokens: Schema.Int.pipe(Schema.nonNegative()),
    reasoningTokens: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    cacheReadInputTokens: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    cacheWriteInputTokens: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    providerExecutionDurationMs: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    /**
     * What the provider says this turn cost, in US dollars. Only ever the
     * provider's own figure: Octant holds no price list and never multiplies
     * tokens by a rate it guessed, so a provider that reports no cost leaves
     * this absent rather than showing an invented number.
     */
    costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("file-change"),
    path: Schema.NonEmptyTrimmedString,
    change: Schema.Literal("created", "modified", "deleted"),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("diff"),
    diff: Schema.NonEmptyString,
  }).annotations(strict),
  /**
   * How much of a provider's usage window this account has spent.
   *
   * Providers that meter by rolling window (a five-hour and a weekly one, for
   * example) say so during a turn. Passing it through is what lets a thread
   * warn before the window closes instead of the user meeting the limit as a
   * failed turn. `window` is the provider's own name for the window, kept
   * verbatim because only the provider defines what it covers.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("rate-limit-window"),
    window: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
    status: Schema.Literal("allowed", "warning", "exhausted"),
    /** Share of the window spent, 0 to 1. Absent when the provider gives none. */
    utilization: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
    /** When the window next resets. Absent when the provider gives none. */
    resetsAt: Schema.optional(UtcTimestamp),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-progress"),
    taskId: Schema.NonEmptyTrimmedString,
    status: Schema.Literal("pending", "in-progress", "completed", "failed"),
    summary: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("child-agent-activity"),
    childAgentId: Schema.NonEmptyTrimmedString,
    status: Schema.Literal("starting", "running", "waiting", "completed", "failed"),
    summary: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("approval-request"),
    requestId: Schema.NonEmptyTrimmedString,
    action: Schema.NonEmptyTrimmedString,
    description: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("user-input-request"),
    requestId: Schema.NonEmptyTrimmedString,
    prompt: Schema.NonEmptyTrimmedString,
    options: Schema.Array(Schema.NonEmptyTrimmedString),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-request"),
    requestId: BoundedProviderRequestId,
    toolName: BoundedProviderToolName,
    inputJson: BoundedProviderJson,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("citation"),
    citationId: BoundedProviderRequestId,
    sourceTitle: BoundedProviderTitle,
    sourceUrl: BoundedProviderUrl,
    snippet: Schema.optional(BoundedProviderSnippet),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("research-started"),
    researchId: BoundedProviderRequestId,
    query: BoundedProviderQuery,
    backend: Schema.Literal("searxng", "provider-native"),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("research-completed"),
    researchId: BoundedProviderRequestId,
    sourceCount: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("interrupted"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("waiting"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("failed"),
    failure: ProviderFailure,
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("completed"),
    resumeCursor: Schema.optional(ProviderResumeCursor),
  }).annotations(strict),
);
export type ProviderRuntimeEvent = typeof ProviderRuntimeEvent.Type;

export const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
export const decodeProviderSessionId = Schema.decodeUnknownSync(ProviderSessionId);
export const decodeProviderModelId = Schema.decodeUnknownSync(ProviderModelId);
export const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
export const decodeProviderInstance = Schema.decodeUnknownSync(ProviderInstance);
export const decodeProviderDefaults = Schema.decodeUnknownSync(ProviderDefaults);
export const decodeProviderInstanceCreated = Schema.decodeUnknownSync(ProviderInstanceCreated);
export const decodeProviderInstanceRenamed = Schema.decodeUnknownSync(ProviderInstanceRenamed);
export const decodeProviderInstanceBinaryChanged = Schema.decodeUnknownSync(
  ProviderInstanceBinaryChanged,
);
export const decodeProviderInstanceConfigurationChanged = Schema.decodeUnknownSync(
  ProviderInstanceConfigurationChanged,
);
export const decodeProviderInstanceEnabledChanged = Schema.decodeUnknownSync(
  ProviderInstanceEnabledChanged,
);
export const decodeProviderInstanceRemoved = Schema.decodeUnknownSync(ProviderInstanceRemoved);
export const decodeProviderDefaultsUpdated = Schema.decodeUnknownSync(ProviderDefaultsUpdated);
export const decodeProviderCatalogSnapshot = Schema.decodeUnknownSync(ProviderCatalogSnapshot);
export const decodeProviderCatalogUpdated = Schema.decodeUnknownSync(ProviderCatalogUpdated);
export const decodeProviderModelOption = Schema.decodeUnknownSync(ProviderModelOption);
export const decodeProviderModelOptionValues = Schema.decodeUnknownSync(ProviderModelOptionValues);
export const decodeProviderModel = Schema.decodeUnknownSync(ProviderModel);
export const decodeProviderCapabilities = Schema.decodeUnknownSync(ProviderCapabilities);
export const decodeProviderObservedState = Schema.decodeUnknownSync(ProviderObservedState);
export const decodeProviderRegistrySnapshot = Schema.decodeUnknownSync(ProviderRegistrySnapshot);
export const decodeProviderAuthenticationAttempt = Schema.decodeUnknownSync(
  ProviderAuthenticationAttempt,
);
export const decodeProviderRegistryCommand = Schema.decodeUnknownSync(ProviderRegistryCommand);
export const decodeProviderRegistryCommandResult = Schema.decodeUnknownSync(
  ProviderRegistryCommandResult,
);
export const decodeProviderProbeResult = Schema.decodeUnknownSync(ProviderProbeResult);
export const decodeProviderResumeCursor = Schema.decodeUnknownSync(ProviderResumeCursor);
export const decodeProviderInputModality = Schema.decodeUnknownSync(ProviderInputModality);
export const decodeProviderAttachmentInput = Schema.decodeUnknownSync(ProviderAttachmentInput);
export const decodeProviderToolDefinition = Schema.decodeUnknownSync(ProviderToolDefinition);
export const decodeProviderContextBlock = Schema.decodeUnknownSync(ProviderContextBlock);
export const decodeProviderTurnInput = Schema.decodeUnknownSync(ProviderTurnInput);
export const decodeProviderToolAnswer = Schema.decodeUnknownSync(ProviderToolAnswer);
export const decodeProviderRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
export const decodeProviderFailure = Schema.decodeUnknownSync(ProviderFailure);
export const decodeOllamaHistorySnapshot = Schema.decodeUnknownSync(OllamaHistorySnapshot);
export const decodeOllamaHistoryRecorded = Schema.decodeUnknownSync(OllamaHistoryRecorded);
