import { Schema } from "effect";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const brandedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

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
  "goose",
  "glm",
  "gemini",
  "copilot",
  "cline",
  "qwen",
  "fx",
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
  "openai-image",
  "gemini-native-image",
  "bfl-image",
  "ideogram-image",
);
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

/** User-maintained data handling labels used by Project provider policy. */
export const ProviderDataTag = Schema.Literal("eu", "zdr");
export type ProviderDataTag = typeof ProviderDataTag.Type;
export const ProviderDataTags = Schema.Array(ProviderDataTag).pipe(
  Schema.filter((tags) => new Set(tags).size === tags.length && tags.length <= 2),
);
export type ProviderDataTags = typeof ProviderDataTags.Type;

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

/**
 * One answer a provider offers for a question it asked: what the person picks,
 * and what that choice means. The description is what makes a question
 * answerable without guessing; a provider that gives none offers bare labels.
 */
export const ProviderQuestionOption = Schema.Struct({
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
}).annotations(strict);
export type ProviderQuestionOption = typeof ProviderQuestionOption.Type;
const MAX_PROVIDER_JSON_BYTES = 65_536;
const MAX_PROVIDER_JSON_DEPTH = 16;
const MAX_PROVIDER_JSON_ENTRIES = 256;
const MAX_PROVIDER_JSON_KEY_LENGTH = 128;
const MAX_PROVIDER_JSON_STRING_LENGTH = 4_096;
const MAX_PROVIDER_ATTACHMENT_BYTES = 26_214_400;
const MAX_PROVIDER_ATTACHMENTS = 16;
export const MAX_PROVIDER_CONTEXT_BLOCKS = 256;
// The native harness offers twelve tools beside research and extension tools;
// the wire protocols this bound guards accept far more than that.
/** The largest tool result any driver encodes; larger results are previewed. */
export const MAX_PROVIDER_TOOL_RESULT_BYTES = 65_536;
export const MAX_PROVIDER_TOOLS = 32;
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

export const GooseProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("goose-acp"),
  binaryPath: AbsoluteBinaryPath,
}).annotations(strict);
export type GooseProviderConfiguration = typeof GooseProviderConfiguration.Type;

export const GlmAuthentication = Schema.Literal("provider-owned", "api-key");
export type GlmAuthentication = typeof GlmAuthentication.Type;
export const GlmProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("glm-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: GlmAuthentication,
}).annotations(strict);
export type GlmProviderConfiguration = typeof GlmProviderConfiguration.Type;

export const GeminiAuthentication = Schema.Literal("provider-owned", "api-key");
export type GeminiAuthentication = typeof GeminiAuthentication.Type;
export const GeminiProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("gemini-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: GeminiAuthentication,
}).annotations(strict);
export type GeminiProviderConfiguration = typeof GeminiProviderConfiguration.Type;

export const CopilotProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("copilot-acp"),
  binaryPath: AbsoluteBinaryPath,
}).annotations(strict);
export type CopilotProviderConfiguration = typeof CopilotProviderConfiguration.Type;

export const ClineAuthentication = Schema.Literal("provider-owned", "api-key");
export type ClineAuthentication = typeof ClineAuthentication.Type;
export const ClineProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("cline-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: ClineAuthentication,
}).annotations(strict);
export type ClineProviderConfiguration = typeof ClineProviderConfiguration.Type;

export const QwenAuthentication = Schema.Literal("provider-owned", "api-key");
export type QwenAuthentication = typeof QwenAuthentication.Type;
export const QwenProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("qwen-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: QwenAuthentication,
}).annotations(strict);
export type QwenProviderConfiguration = typeof QwenProviderConfiguration.Type;

/**
 * fx keeps its profile under `$HOME/.fx` and exposes no profile-path variable,
 * so Octant reaches it through an isolated managed home and authenticates it
 * with a Vercel AI Gateway key held by the host credential broker. There is no
 * provider-owned posture: the interactive `~/.fx` login is deliberately outside
 * the confined process.
 */
export const FxProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("fx-acp"),
  binaryPath: AbsoluteBinaryPath,
  authentication: Schema.Literal("api-key"),
}).annotations(strict);
export type FxProviderConfiguration = typeof FxProviderConfiguration.Type;

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
const OAuthDescriptorId = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export const OpenAiCompatibleProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("openai-compatible-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  authentication: Schema.Literal("bearer", "none"),
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
  /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
  oauthDescriptorId: Schema.optional(OAuthDescriptorId),
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
  /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
  oauthDescriptorId: Schema.optional(OAuthDescriptorId),
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

/**
 * Black Forest Labs FLUX endpoint-path names (`docs/decisions/0086`). BFL
 * encodes the model in the URL path, never a body field, so these are the
 * literal path segments, not a vendor catalog Octant maintains. Allowlists
 * stay manual-entry and are never rewritten on save.
 */
export const BFL_IMAGE_MODEL_PRESETS = [
  "flux-pro-1.1",
  "flux-pro-1.1-ultra",
  "flux-dev",
  "flux-kontext-pro",
  "flux-kontext-max",
  "flux-2-pro",
  "flux-2-flex",
] as const;
export const BflImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("bfl-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type BflImageProviderConfiguration = typeof BflImageProviderConfiguration.Type;

/**
 * Ideogram model-version endpoint-path names (`docs/decisions/0087`). Like
 * BFL, Ideogram encodes the model version in the URL path, never a body
 * field, so these are the literal path segments, not a vendor catalog Octant
 * maintains. Allowlists stay manual-entry and are never rewritten on save.
 */
export const IDEOGRAM_IMAGE_MODEL_PRESETS = ["ideogram-v3", "ideogram-v4"] as const;
export const IdeogramImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("ideogram-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type IdeogramImageProviderConfiguration = typeof IdeogramImageProviderConfiguration.Type;
export const CodexProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("codex-cli"),
  binaryPath: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type CodexProviderConfiguration = typeof CodexProviderConfiguration.Type;
export const ClaudeAuthentication = Schema.Literal("subscription", "api-key");
export type ClaudeAuthentication = typeof ClaudeAuthentication.Type;
/** Closed swatch set so Claude accounts stay distinguishable in the picker. */
export const CLAUDE_ACCOUNT_ACCENTS = [
  "rust",
  "gold",
  "green",
  "teal",
  "blue",
  "violet",
  "rose",
] as const;
export const ClaudeAccountAccent = Schema.Literal(...CLAUDE_ACCOUNT_ACCENTS);
export type ClaudeAccountAccent = typeof ClaudeAccountAccent.Type;
const ClaudeConfigDirectory = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((path) => {
    if (!path.startsWith("/")) return false;
    const base = path.replace(/\/+$/, "").split("/").pop();
    return base !== undefined && base !== ".credentials.json";
  }),
);
export const ClaudeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("claude-agent-sdk"),
  binaryPath: Schema.NonEmptyTrimmedString,
  authentication: ClaudeAuthentication,
  /** Claude-owned directory for this account. Absent uses Claude's default. */
  configDirectory: Schema.optional(ClaudeConfigDirectory),
  accent: Schema.optional(ClaudeAccountAccent),
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
  /** Optional so existing provider rows remain valid and default to untagged. */
  dataTags: Schema.optional(ProviderDataTags),
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

export const GooseProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("goose"),
  configuration: GooseProviderConfiguration,
}).annotations(strict);
export type GooseProviderInstance = typeof GooseProviderInstance.Type;

export const GlmProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("glm"),
  configuration: GlmProviderConfiguration,
}).annotations(strict);
export type GlmProviderInstance = typeof GlmProviderInstance.Type;

export const GeminiProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("gemini"),
  configuration: GeminiProviderConfiguration,
}).annotations(strict);
export type GeminiProviderInstance = typeof GeminiProviderInstance.Type;

export const CopilotProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("copilot"),
  configuration: CopilotProviderConfiguration,
}).annotations(strict);
export type CopilotProviderInstance = typeof CopilotProviderInstance.Type;

export const ClineProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("cline"),
  configuration: ClineProviderConfiguration,
}).annotations(strict);
export type ClineProviderInstance = typeof ClineProviderInstance.Type;

export const QwenProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("qwen"),
  configuration: QwenProviderConfiguration,
}).annotations(strict);
export type QwenProviderInstance = typeof QwenProviderInstance.Type;

export const FxProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("fx"),
  configuration: FxProviderConfiguration,
}).annotations(strict);
export type FxProviderInstance = typeof FxProviderInstance.Type;

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

export const BflImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("bfl-image"),
  configuration: BflImageProviderConfiguration,
}).annotations(strict);
export type BflImageProviderInstance = typeof BflImageProviderInstance.Type;

export const IdeogramImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("ideogram-image"),
  configuration: IdeogramImageProviderConfiguration,
}).annotations(strict);
export type IdeogramImageProviderInstance = typeof IdeogramImageProviderInstance.Type;

export const ProviderInstance = Schema.Union(
  OpenCodeProviderInstance,
  CodexProviderInstance,
  ClaudeProviderInstance,
  KimiCodeProviderInstance,
  KiloProviderInstance,
  MistralVibeProviderInstance,
  GrokProviderInstance,
  GooseProviderInstance,
  GlmProviderInstance,
  GeminiProviderInstance,
  CopilotProviderInstance,
  ClineProviderInstance,
  QwenProviderInstance,
  FxProviderInstance,
  DevinProviderInstance,
  PiProviderInstance,
  OhMyPiProviderInstance,
  OllamaProviderInstance,
  OpenAiCompatibleProviderInstance,
  AnthropicCompatibleProviderInstance,
  AzureFoundryProviderInstance,
  OpenAiImageProviderInstance,
  GeminiImageProviderInstance,
  BflImageProviderInstance,
  IdeogramImageProviderInstance,
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

/**
 * One Settings-defined model visibility override. Hidden models stay valid
 * for existing thread bindings; this list only controls new picker options.
 */
export const HiddenProviderModelRef = AgentEligibleModelRef;
export type HiddenProviderModelRef = AgentEligibleModelRef;

const UniqueHiddenProviderModels = Schema.Array(HiddenProviderModelRef).pipe(
  Schema.filter((refs) => new Set(refs.map(agentEligibleModelKey)).size === refs.length),
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
  hiddenModels: Schema.optional(UniqueHiddenProviderModels),
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
    BflImageProviderInstance,
    IdeogramImageProviderInstance,
    ClaudeProviderInstance,
    MistralVibeProviderInstance,
    GrokProviderInstance,
    GooseProviderInstance,
    GlmProviderInstance,
    GeminiProviderInstance,
    CopilotProviderInstance,
    ClineProviderInstance,
    QwenProviderInstance,
    FxProviderInstance,
    KiloProviderInstance,
    DevinProviderInstance,
    PiProviderInstance,
    OhMyPiProviderInstance,
    OllamaProviderInstance,
  ),
}).annotations(strict);
export type ProviderInstanceConfigurationChanged = typeof ProviderInstanceConfigurationChanged.Type;
export const ProviderInstanceDataTagsChanged = Schema.Struct({
  instance: ProviderInstance,
}).annotations(strict);
export type ProviderInstanceDataTagsChanged = typeof ProviderInstanceDataTagsChanged.Type;
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
  "provider.instance-data-tags-changed@1",
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

/** Display choices identify advertised variants; selecting one still binds its real model id. */
const ProviderModelConfiguration = Schema.Struct({
  family: Schema.NonEmptyTrimmedString,
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.NonEmptyTrimmedString,
      displayName: Schema.NonEmptyTrimmedString,
      value: Schema.NonEmptyTrimmedString,
    }).annotations(strict),
  ).pipe(
    Schema.filter((choices) => new Set(choices.map((choice) => choice.id)).size === choices.length),
  ),
}).annotations(strict);

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
  configuration: Schema.optional(ProviderModelConfiguration),
  capabilityEvidence: Schema.optional(Schema.Array(CapabilityEvidence)),
  /** User-maintained residency/privacy labels; absent means untagged. */
  dataTags: Schema.optional(ProviderDataTags),
  /**
   * The context window a person typed into the model's details. It wins over
   * every automatic source; absent means the window is resolved automatically.
   */
  contextWindowOverride: Schema.optional(PositiveInt),
  /**
   * The window the endpoint's own refusals and larger successful requests
   * taught Octant: a refusal that names a limit lowers it, a request that
   * fit above it raises it. Kept with the catalogue so it outlives a restart.
   */
  learnedContextWindow: Schema.optional(PositiveInt),
  /**
   * The `model` the endpoint named in its responses. A deployment can carry a
   * name of its own; this is how its model, and that model's profile, is known.
   */
  servedModelId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
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
  /**
   * The driver natively serves ACP client filesystem and terminal methods
   * (`fs/read_text_file`, `fs/write_text_file`, `terminal/*`) over its own
   * connection, independently of the app-managed tool bridge.
   */
  acpClientCapabilities: Schema.optional(ProviderCapabilitySupport),
  /**
   * The driver can carry an existing native session on to another model of
   * the same provider instance: a resumed session takes the thread's current
   * model, and the conversation the provider holds continues. Absent reads as
   * unsupported, so a host keeps refusing a turn whose model differs from the
   * one its session was opened with rather than discarding that conversation.
   */
  modelSwitch: Schema.optional(ProviderCapabilitySupport),
  citations: ProviderCapabilitySupport,
  harnessAutoReview: ProviderCapabilitySupport,
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

export const ProviderToolImage = Schema.Struct({
  mimeType: Schema.Literal("image/png", "image/jpeg"),
  data: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(2_097_152),
    Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
}).annotations(strict);
export type ProviderToolImage = typeof ProviderToolImage.Type;

export const ProviderToolAnswer = Schema.Struct({
  sessionId: ProviderSessionId,
  requestId: BoundedProviderRequestId,
  resultJson: BoundedProviderJson,
  isError: Schema.Boolean,
  images: Schema.optional(Schema.Array(ProviderToolImage).pipe(Schema.maxItems(4))),
}).annotations(strict);
export type ProviderToolAnswer = typeof ProviderToolAnswer.Type;

const ProviderDiagnosticVersion = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
);

/**
 * Bounded process facts that are safe to show on any authenticated client.
 * Raw stdout, stderr, argv, environment, prompts, credentials, and filesystem
 * paths are deliberately not representable.
 */
export const ProviderProcessDiagnostic = Schema.Struct({
  stage: Schema.Literal(
    "version-check",
    "launch",
    "initialization",
    "authentication",
    "model-discovery",
    "update",
    "post-update-probe",
    "cleanup",
  ),
  kind: Schema.Literal(
    "spawn-failed",
    "exited",
    "signaled",
    "timed-out",
    "version-mismatch",
    "confinement-denied",
    "protocol-failed",
    "authentication-failed",
    "cleanup-unconfirmed",
  ),
  exitCode: Schema.optional(Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(255))),
  signal: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32), Schema.pattern(/^SIG[A-Z0-9]+$/)),
  ),
  detectedVersion: Schema.optional(ProviderDiagnosticVersion),
  supportedVersion: Schema.optional(ProviderDiagnosticVersion),
  stderrContext: Schema.optional(
    Schema.Literal(
      "Provider process was denied by host permissions or confinement.",
      "Provider process rejected its configured arguments.",
      "Provider authentication is required.",
      "Provider TLS trust verification failed.",
      "Provider network connection failed.",
      "Provider process wrote redacted diagnostic output.",
      "Provider reported an incompatible installed version.",
      "Provider refused the ACP request because its configuration was invalid.",
      "Provider refused the ACP request for the managed workspace.",
      "Provider refused the ACP request because no usable model was available.",
      "Provider could not reach its remote service.",
      "Provider refused the ACP request without a classified reason.",
    ),
  ),
}).annotations(strict);
export type ProviderProcessDiagnostic = typeof ProviderProcessDiagnostic.Type;

/**
 * Octant-authored probe refusal. The client maps this closed set to copy and
 * next-step guidance. Free-form driver or provider text is not representable.
 */
export const ProviderRefusalReason = Schema.Literal(
  "runtime-incompatible",
  "authentication-required",
  "runtime-unavailable",
  "no-usable-model",
);
export type ProviderRefusalReason = typeof ProviderRefusalReason.Type;

export const ProviderObservedState = Schema.Struct({
  instanceId: ProviderInstanceId,
  readiness: ProviderReadiness,
  processState: ProviderProcessState,
  detectedVersion: Schema.optional(Schema.NonEmptyTrimmedString),
  observedProtocol: Schema.optional(OpenAiCompatibleProtocol),
  credentialStatus: Schema.optional(ProviderCredentialStatus),
  models: Schema.Array(ProviderModel),
  capabilities: ProviderCapabilities,
  // Models a person explicitly verified for tool support through the
  // verify-model-tools command, on any endpoint profile (OpenAI-compatible,
  // Anthropic-compatible, Azure AI Foundry). The sender gates tool requests
  // per model against this set as well as the provider-level appManagedTools
  // flag, so one verified model does not unlock tools for the other models
  // of the same profile.
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  message: Schema.optional(Schema.NonEmptyTrimmedString),
  reason: Schema.optional(ProviderRefusalReason),
  diagnostic: Schema.optional(ProviderProcessDiagnostic),
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
    kind: Schema.Literal("create-bfl-image-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: BflImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-ideogram-image-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: IdeogramImageProviderConfiguration,
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
    kind: Schema.Literal("create-goose-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GooseProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-glm-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GlmProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-gemini-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GeminiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-copilot-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: CopilotProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-cline-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: ClineProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-qwen-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: QwenProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-fx-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: FxProviderConfiguration,
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
    kind: Schema.Literal("change-bfl-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: BflImageProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-ideogram-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: IdeogramImageProviderConfiguration,
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
    kind: Schema.Literal("change-goose-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GooseProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-glm-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GlmProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-gemini-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GeminiProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-copilot-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: CopilotProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-cline-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: ClineProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-qwen-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: QwenProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-fx-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: FxProviderConfiguration,
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
    kind: Schema.Literal("set-provider-data-tags"),
    ...ProviderInstanceCommandFields,
    dataTags: ProviderDataTags,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-provider-model-data-tags"),
    ...ProviderInstanceCommandFields,
    modelId: ProviderModelId,
    dataTags: ProviderDataTags,
  }).annotations(strict),
  /** Sets the model's context window override; leaving `contextWindow` out clears it. */
  Schema.Struct({
    kind: Schema.Literal("set-provider-model-context-window"),
    ...ProviderInstanceCommandFields,
    modelId: ProviderModelId,
    contextWindow: Schema.optional(PositiveInt),
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
    hiddenModels: Schema.optional(UniqueHiddenProviderModels),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("probe-provider"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("update-provider-cli"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("verify-model-tools"),
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
    kind: Schema.Literal("provider-model-tags-updated"),
    snapshot: ProviderCatalogSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-model-updated"),
    snapshot: ProviderCatalogSnapshot,
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
    kind: Schema.Literal("provider-cli-updated"),
    instanceId: ProviderInstanceId,
    status: Schema.Literal("updated", "already-current", "version-unknown", "probe-failed"),
    previousVersion: Schema.optional(Schema.NonEmptyTrimmedString),
    currentVersion: Schema.optional(Schema.NonEmptyTrimmedString),
    message: Schema.optional(Schema.NonEmptyTrimmedString),
    diagnostic: Schema.optional(ProviderProcessDiagnostic),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("model-tools-verified"),
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
  /** Host-persisted identity; never authority supplied by a new turn. */
  binding: Schema.optional(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      sessionId: ProviderSessionId,
      projectRoot: Schema.NonEmptyTrimmedString,
      mode: Schema.Literal("chat", "work", "code"),
      modelId: ProviderModelId,
    }).annotations(strict),
  ),
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

/**
 * A provider's structured reason for stopping a turn on its usage limit.
 * `temporary` is a rolling rate limit that lifts on its own; `exhausted` is an
 * allowance that is spent until the provider refills it; `billing` means the
 * account has a credit or plan problem no waiting resolves. `resetsAt` is the
 * provider's own reset instant — absent when it discloses none, and never
 * guessed from wall-clock heuristics.
 */
export const ProviderUsageLimit = Schema.Struct({
  kind: Schema.Literal("temporary", "exhausted", "billing"),
  resetsAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ProviderUsageLimit = typeof ProviderUsageLimit.Type;

export const ProviderFailure = Schema.Struct({
  category: ProviderFailureCategory,
  message: Schema.NonEmptyTrimmedString,
  reason: Schema.optional(ProviderRefusalReason),
  diagnostic: Schema.optional(ProviderProcessDiagnostic),
  retryAfterMs: Schema.optional(
    Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  ),
  /**
   * Present only when the provider's own protocol signal says this stop is a
   * usage limit. Message-text matching never produces it.
   */
  usageLimit: Schema.optional(ProviderUsageLimit),
}).annotations(strict);
export type ProviderFailure = typeof ProviderFailure.Type;

/**
 * Why a completed reply stopped, when the runtime said so. Absent means the
 * runtime did not say — a normal finish is not guessed into one of these.
 * `max-tokens` is the output limit; `content-filter` is a filter stop.
 */
export const ProviderOutputStopReason = Schema.Literal("max-tokens", "content-filter");
export type ProviderOutputStopReason = typeof ProviderOutputStopReason.Type;

/**
 * What fills a provider-run window, by kind. A kind is the provider's own
 * category where it reports one, or something Octant itself puts in the
 * window and can count (`octant-tools`, `octant-instructions`, `attachments`,
 * and `skills` when Octant sent them). The set is closed so a surface can give
 * each kind one name and one colour.
 */
export const ProviderContextPartKind = Schema.Literal(
  "system-prompt",
  "octant-instructions",
  "system-tools",
  "octant-tools",
  "mcp-tools",
  "memory-files",
  "skills",
  "agents",
  "messages",
  "attachments",
  "reserved",
);
export type ProviderContextPartKind = typeof ProviderContextPartKind.Type;

/**
 * One part of the window with the honesty of its number. `provider-reported`
 * is the runtime's own count; the other accuracies are Octant's estimate and
 * must be shown as one. `count` is how many things the part holds (tools,
 * files, agents), where that is known.
 */
export const ProviderContextPart = Schema.Struct({
  kind: ProviderContextPartKind,
  tokens: Schema.Int.pipe(Schema.nonNegative()),
  accuracy: Schema.Literal(
    "provider-reported",
    "exact-tokenizer",
    "model-family-estimate",
    "conservative-heuristic",
  ),
  count: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}).annotations(strict);
export type ProviderContextPart = typeof ProviderContextPart.Type;

/**
 * Tools the runtime knows about but has not loaded into the window. They hold
 * no share of it, so only how many there are, where known, is carried.
 */
export const ProviderDeferredContextPart = Schema.Struct({
  kind: Schema.Literal("system-tools", "mcp-tools"),
  /** Absent when the runtime named the group but not how many it holds. */
  count: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}).annotations(strict);
export type ProviderDeferredContextPart = typeof ProviderDeferredContextPart.Type;

/**
 * The parts of a provider-run window, as of the report that carries it. A
 * runtime that reports categories supplies them as `provider-reported`; for
 * one that does not, Octant supplies only what it can count itself. The parts
 * never claim the whole window: whatever the occupancy holds beyond them is
 * the reader's remainder, not a part.
 */
/**
 * Whether the instructions, skills and attachments Octant sent with each turn
 * of this provider session are counted among the parts. A runtime that keeps
 * every turn's prompt holds one copy per turn, so Octant counts them only while
 * it can account for every copy. `uncounted` says why it cannot: the runtime
 * does not say whether it keeps earlier prompts (`retention-unknown`), it
 * compacted the session and kept a share Octant cannot measure (`compacted`),
 * or a turn of the session went by without a count (`history-unknown`). Once
 * uncounted, a session stays uncounted, and what was sent is part of the
 * remainder.
 */
export const ProviderSentContextAccounting = Schema.Union(
  Schema.Struct({ status: Schema.Literal("counted") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("uncounted"),
    reason: Schema.Literal("retention-unknown", "compacted", "history-unknown"),
  }).annotations(strict),
);
export type ProviderSentContextAccounting = typeof ProviderSentContextAccounting.Type;

export const ProviderContextBreakdown = Schema.Struct({
  parts: Schema.Array(ProviderContextPart).pipe(Schema.maxItems(16)),
  deferred: Schema.optional(Schema.Array(ProviderDeferredContextPart).pipe(Schema.maxItems(4))),
  /** Absent when the runtime reported its own categories, or before Octant counted any. */
  sentContext: Schema.optional(ProviderSentContextAccounting),
}).annotations(strict);
export type ProviderContextBreakdown = typeof ProviderContextBreakdown.Type;

const ProviderRuntimeEventFields = {
  instanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
} as const;

/** A provider report is observation only; it carries no execution authority. */
export const ProviderChildActivityEvent = Schema.Struct({
  ...ProviderRuntimeEventFields,
  kind: Schema.Literal("child-agent-activity"),
  childAgentId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  parentChildAgentId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  modelId: Schema.optional(ProviderModelId),
  task: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  status: Schema.Literal("starting", "running", "waiting", "completed", "failed"),
  summary: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ProviderChildActivityEvent = typeof ProviderChildActivityEvent.Type;

export const MAX_PROVIDER_CHILD_OBSERVATIONS = 16;
export const MAX_PROVIDER_CHILD_HISTORY = 8;
export const ProviderChildObservation = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  childAgentId: ProviderChildActivityEvent.fields.childAgentId,
  parentChildAgentId: ProviderChildActivityEvent.fields.parentChildAgentId,
  modelId: Schema.optional(ProviderModelId),
  task: ProviderChildActivityEvent.fields.task,
  lifecycleStatus: Schema.Literal(
    "starting",
    "running",
    "waiting",
    "completed",
    "failed",
    "unknown",
  ),
  latestSummary: Schema.String.pipe(Schema.maxLength(512)),
  firstObservedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  historyStatus: Schema.Literal("partial", "truncated", "conflicted"),
  history: Schema.Array(
    Schema.Struct({
      sequence: Schema.Int.pipe(Schema.positive()),
      occurredAt: UtcTimestamp,
      status: ProviderChildActivityEvent.fields.status,
      summary: Schema.String.pipe(Schema.maxLength(512)),
    }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_PROVIDER_CHILD_HISTORY)),
}).annotations(strict);
export type ProviderChildObservation = typeof ProviderChildObservation.Type;
export const ProviderChildObservationState = Schema.Struct({
  children: Schema.Array(ProviderChildObservation).pipe(
    Schema.maxItems(MAX_PROVIDER_CHILD_OBSERVATIONS),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ProviderChildObservationState = typeof ProviderChildObservationState.Type;
export const decodeProviderChildObservationState = Schema.decodeUnknownSync(
  ProviderChildObservationState,
);

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
    /**
     * What the tool was asked to do: the first line of the command a shell
     * tool runs, the checkout-relative path a file tool edits. The adapter
     * reduces it to one redacted, bounded line before it crosses, so a raw
     * command or path never rides on a normalized event, and a consumer still
     * redacts before showing it. Optional because many providers report none;
     * never file contents.
     */
    argument: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))),
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
     * When the one model request this report covers was sent. Present only on
     * a report for exactly one request, which is what lets its timing be exact
     * with the tool time between requests left out. A report without it covers
     * the whole turn: a later one replaces an earlier one, and the turn's
     * speed is approximate whenever tools ran inside it.
     */
    requestStartedAt: Schema.optional(UtcTimestamp),
    /**
     * What the provider says this turn cost, in US dollars. Only ever the
     * provider's own figure: an adapter never multiplies tokens by a rate, so
     * a provider that reports no cost leaves this absent rather than an
     * invented number. The host's standard-rate estimate is recorded apart
     * from it, as an `api-estimate`, never in this field.
     */
    costUsd: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
    /**
     * The model's context window and how much of it the last request occupied,
     * when the provider reports them alongside usage. A runtime the host does
     * not plan a context for (a CLI it drives) has no other account of the
     * window, so this is what its meter shows.
     */
    contextWindow: Schema.optional(Schema.Int.pipe(Schema.positive())),
    contextTokens: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    /**
     * Where the runtime compacts the conversation by itself, in tokens of the
     * window the last request filled. Present only when the runtime said
     * compaction is on and will fire at that point; absent means the runtime
     * said nothing, said it is off, or the host could not read the unit, and
     * no reader may infer a figure from the model's window.
     */
    autoCompactThreshold: Schema.optional(Schema.Int.pipe(Schema.positive())),
    /**
     * What the window held after this report, when the runtime reported its
     * make-up or Octant could count what it adds. Absent means neither.
     */
    contextBreakdown: Schema.optional(ProviderContextBreakdown),
    /**
     * What the runtime does with the prompt of each turn, which is where Octant
     * puts the instructions, skills and attachments it sends. `kept`: every
     * turn's prompt stays in the session's window as sent, and the runtime has
     * not compacted the window during this turn. `compacted`: it compacted the
     * window during this turn, keeping a share of earlier prompts that Octant
     * cannot measure. Absent: the adapter cannot say, and nothing Octant sent is
     * counted as a part.
     */
    promptRetention: Schema.optional(Schema.Literal("kept", "compacted")),
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
  /**
   * An absolute quota bucket the provider disclosed on a response it already
   * sent, such as the rate-limit headers of the HTTP providers. Only the two
   * buckets `ProviderServiceLimits` can hold exist here; a bucket whose
   * remaining count exceeds its limit is refused rather than clamped because
   * the provider, not Octant, owns those numbers.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("rate-limit-bucket"),
    bucket: Schema.Literal("requests", "tokens"),
    limit: Schema.Int.pipe(Schema.positive()),
    remaining: Schema.Int.pipe(Schema.nonNegative()),
    /** When the bucket refills. Absent when the provider gives none. */
    resetsAt: Schema.optional(UtcTimestamp),
  })
    .annotations(strict)
    .pipe(Schema.filter((event) => event.remaining <= event.limit)),
  /**
   * A direct endpoint failed in a way that usually passes and the request is
   * going out again once `delayMs` has elapsed. It is sent before the wait, so
   * a surface can say "retrying 2/5 in 4 s" while the turn is quiet. `attempt`
   * is the attempt about to start, counted from 1; the turn is still running.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("retrying"),
    attempt: Schema.Int.pipe(Schema.between(2, 16)),
    maxAttempts: Schema.Int.pipe(Schema.between(2, 16)),
    delayMs: Schema.Int.pipe(Schema.between(0, 3_600_000)),
    reason: Schema.Literal("rate-limited", "unavailable", "stream-interrupted", "empty-completion"),
  })
    .annotations(strict)
    .pipe(Schema.filter((event) => event.attempt <= event.maxAttempts)),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-progress"),
    taskId: Schema.NonEmptyTrimmedString,
    status: Schema.Literal("pending", "in-progress", "completed", "failed"),
    summary: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  ProviderChildActivityEvent,
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("approval-request"),
    requestId: Schema.NonEmptyTrimmedString,
    action: Schema.NonEmptyTrimmedString,
    description: Schema.NonEmptyTrimmedString,
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
    options: Schema.Array(ProviderQuestionOption),
    /**
     * Where this question sits in a set the provider asked at once, so a
     * person can see "1 of 2" while answering. Absent for a single question.
     * Each question has its own request identity and can be answered once.
     * The driver collects answers in question order and replies to the
     * provider once the complete set has been answered.
     */
    questionIndex: Schema.optional(PositiveInt),
    questionCount: Schema.optional(PositiveInt),
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (event) => (event.questionIndex === undefined) === (event.questionCount === undefined),
      ),
    ),
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
    /** Present only when the runtime said why this reply stopped. */
    stopReason: Schema.optional(ProviderOutputStopReason),
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
export const decodeProviderInstanceDataTagsChanged = Schema.decodeUnknownSync(
  ProviderInstanceDataTagsChanged,
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
