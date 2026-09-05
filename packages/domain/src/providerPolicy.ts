import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import type {
  AnthropicCompatibleProviderConfiguration,
  AnthropicCompatibleProviderInstance,
  AzureFoundryProviderConfiguration,
  AzureFoundryProviderInstance,
  ClaudeAuthentication,
  ClaudeProviderConfiguration,
  ClaudeProviderInstance,
  CodexProviderInstance,
  DevinProviderConfiguration,
  DevinProviderInstance,
  GeminiImageAspectRatio,
  GeminiImageProviderConfiguration,
  GeminiImageProviderInstance,
  GeminiImageResolution,
  GrokAuthentication,
  GrokProviderConfiguration,
  GrokProviderInstance,
  GlmAuthentication,
  GlmProviderConfiguration,
  GlmProviderInstance,
  GeminiAuthentication,
  GeminiProviderConfiguration,
  GeminiProviderInstance,
  CopilotProviderConfiguration,
  CopilotProviderInstance,
  ClineAuthentication,
  ClineProviderConfiguration,
  ClineProviderInstance,
  QwenAuthentication,
  QwenProviderConfiguration,
  QwenProviderInstance,
  GooseProviderConfiguration,
  GooseProviderInstance,
  KimiCodeProviderInstance,
  KiloProviderConfiguration,
  KiloProviderInstance,
  MistralVibeAuthentication,
  MistralVibeProviderConfiguration,
  MistralVibeProviderInstance,
  OllamaProviderConfiguration,
  OllamaProviderInstance,
  OpenAiImageProviderConfiguration,
  OpenAiImageProviderInstance,
  OpenAiImageQuality,
  OpenAiImageSize,
  PermissionPersistence,
  PiProviderConfiguration,
  PiProviderInstance,
  OhMyPiProviderInstance,
  OhMyPiProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  OpenAiCompatibleProviderInstance,
  ProviderDefaults,
  ProviderDriverKind,
  ProviderExecutionPolicy,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  OpenCodeProviderInstance,
} from "@octant/contracts/providers";

export type ProviderPolicyRejectionCode =
  | "active-sessions"
  | "disabled-provider"
  | "invalid-authentication"
  | "invalid-binary-path"
  | "invalid-version"
  | "invalid-base-url"
  | "invalid-model-id"
  | "invalid-model-ids"
  | "invalid-name"
  | "invalid-timestamp"
  | "name-conflict";

export class ProviderPolicyRejected extends Error {
  override readonly name = "ProviderPolicyRejected";

  constructor(
    readonly code: ProviderPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ProviderPolicyRejectionCode, message: string): never {
  throw new ProviderPolicyRejected(code, message);
}

export function isImageProfileDriverKind(
  driverKind: ProviderDriverKind,
): driverKind is "openai-image" | "gemini-native-image" {
  return driverKind === "openai-image" || driverKind === "gemini-native-image";
}

/**
 * The providers Octant drives with its own agent loop. They are inference
 * transports only: every tool they are offered is app-managed and every call
 * passes the server's authority choke point before it runs.
 */
export function isNativeHarnessDriverKind(
  driverKind: ProviderDriverKind,
): driverKind is "openai-compatible" | "anthropic-compatible" | "azure-foundry" {
  // Ollama joins once its driver runs the tool loop; offering it as a slot
  // candidate before then would route a lead to a model that cannot act.
  return (
    driverKind === "openai-compatible" ||
    driverKind === "anthropic-compatible" ||
    driverKind === "azure-foundry"
  );
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function normalizeName(
  name: string,
  existingInstances: ReadonlyArray<ProviderInstance>,
  currentInstanceId?: ProviderInstanceId,
): string {
  const normalized = name.trim();
  if (normalized.length === 0) reject("invalid-name", "Provider name cannot be empty.");
  const folded = normalized.toLowerCase();
  if (
    existingInstances.some(
      (instance) =>
        instance.id !== currentInstanceId && instance.displayName.trim().toLowerCase() === folded,
    )
  ) {
    reject("name-conflict", "Provider names must be unique.");
  }
  return normalized;
}

function normalizeBinaryPath(binaryPath: string): string {
  const normalized = binaryPath.trim();
  if (!normalized.startsWith("/")) {
    reject("invalid-binary-path", "Provider binary path must be absolute.");
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4Parts = /^127(?:\.\d{1,3}){3}$/.test(normalized)
    ? normalized.split(".").map(Number)
    : [];
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    (ipv4Parts.length === 4 && ipv4Parts.every((part) => part <= 255))
  );
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (normalized.includes("?") || normalized.includes("#")) {
    reject("invalid-base-url", "Provider base URL cannot include query or fragment delimiters.");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return reject("invalid-base-url", "Provider base URL is invalid.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    reject("invalid-base-url", "Provider base URL cannot include credentials, query, or fragment.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    reject("invalid-base-url", "Provider base URL must use HTTPS or loopback HTTP.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function normalizeManualModelIds(modelIds: ReadonlyArray<string>): ReadonlyArray<string> {
  const normalized = modelIds.map((modelId) => modelId.trim());
  if (normalized.some((modelId) => modelId.length === 0)) {
    reject("invalid-model-id", "Manual model IDs cannot be empty.");
  }
  return [...new Set(normalized)];
}

export interface OpenAiCompatibleConfigurationInput {
  readonly kind: OpenAiCompatibleProviderConfiguration["kind"];
  readonly baseUrl: string;
  readonly authentication: OpenAiCompatibleProviderConfiguration["authentication"];
  readonly protocol: OpenAiCompatibleProviderConfiguration["protocol"];
  readonly manualModelIds: ReadonlyArray<string>;
}

function normalizeOpenAiCompatibleConfiguration(
  configuration: OpenAiCompatibleConfigurationInput,
): OpenAiCompatibleProviderConfiguration {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(configuration.baseUrl);
  const hostname = new URL(baseUrl).hostname;
  if (configuration.authentication === "none" && !isLoopbackHostname(hostname)) {
    reject("invalid-authentication", "Unauthenticated providers must use a loopback endpoint.");
  }
  return {
    ...configuration,
    baseUrl,
    manualModelIds: normalizeManualModelIds(
      configuration.manualModelIds,
    ) as OpenAiCompatibleProviderConfiguration["manualModelIds"],
  };
}

export interface AnthropicCompatibleConfigurationInput {
  readonly kind: AnthropicCompatibleProviderConfiguration["kind"];
  readonly baseUrl: string;
  readonly authentication: AnthropicCompatibleProviderConfiguration["authentication"];
  readonly protocol: AnthropicCompatibleProviderConfiguration["protocol"];
  readonly protocolVersion: string;
  readonly manualModelIds: ReadonlyArray<string>;
}

function normalizeAnthropicCompatibleConfiguration(
  configuration: AnthropicCompatibleConfigurationInput,
): AnthropicCompatibleProviderConfiguration {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(configuration.baseUrl);
  const hostname = new URL(baseUrl).hostname;
  if (configuration.authentication === "none" && !isLoopbackHostname(hostname)) {
    reject("invalid-authentication", "Unauthenticated providers must use a loopback endpoint.");
  }
  const protocolVersion = configuration.protocolVersion.trim();
  if (protocolVersion.length === 0) {
    reject("invalid-base-url", "Anthropic protocol version cannot be empty.");
  }
  return {
    kind: configuration.kind,
    baseUrl,
    authentication: configuration.authentication,
    protocol: configuration.protocol,
    protocolVersion: protocolVersion as AnthropicCompatibleProviderConfiguration["protocolVersion"],
    manualModelIds: normalizeManualModelIds(
      configuration.manualModelIds,
    ) as AnthropicCompatibleProviderConfiguration["manualModelIds"],
  };
}

export interface AzureFoundryConfigurationInput {
  readonly kind: AzureFoundryProviderConfiguration["kind"];
  readonly baseUrl: string;
  readonly authentication: AzureFoundryProviderConfiguration["authentication"];
  readonly protocol: AzureFoundryProviderConfiguration["protocol"];
  readonly manualModelIds: ReadonlyArray<string>;
}

function normalizeAzureFoundryConfiguration(
  configuration: AzureFoundryConfigurationInput,
): AzureFoundryProviderConfiguration {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(configuration.baseUrl);
  const url = new URL(baseUrl);
  // Foundry reuses the OpenAI-compatible wire adapter against its documented
  // /openai/v1/ endpoint. Require that explicit path so a malformed resource
  // URL is rejected up front with an actionable error instead of routing
  // generic OpenAI requests at an unrelated Azure management path.
  if (!url.pathname.endsWith("/openai/v1/")) {
    reject("invalid-base-url", "Azure AI Foundry base URL must end with the /openai/v1/ path.");
  }
  if (configuration.authentication !== "api-key") {
    reject(
      "invalid-authentication",
      "Azure AI Foundry technical preview supports API-key authentication only.",
    );
  }
  const manualModelIds = normalizeManualModelIds(
    configuration.manualModelIds,
  ) as AzureFoundryProviderConfiguration["manualModelIds"];
  // Foundry deployments are exposed as manual model IDs and the driver sends
  // the selected modelId as the v1 request model. An empty list leaves the
  // profile with no usable deployment and lets non-deployment catalog IDs leak
  // into Chat/Code selection, so reject it before saving.
  if (manualModelIds.length === 0) {
    reject("invalid-model-ids", "Azure AI Foundry requires at least one deployment ID.");
  }
  return {
    kind: configuration.kind,
    baseUrl,
    authentication: configuration.authentication,
    protocol: configuration.protocol,
    manualModelIds,
  };
}

interface CreateProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly binaryPath: string;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

function normalizeProviderCreation(input: CreateProviderInput) {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    binaryPath: normalizeBinaryPath(input.binaryPath),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host" as const,
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface ClaudeConfigurationInput {
  readonly kind: ClaudeProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: ClaudeAuthentication;
}

export interface MistralVibeConfigurationInput {
  readonly kind: MistralVibeProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: MistralVibeAuthentication;
}

export interface GrokConfigurationInput {
  readonly kind: GrokProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: GrokAuthentication;
}

export interface GooseConfigurationInput {
  readonly kind: GooseProviderConfiguration["kind"];
  readonly binaryPath: string;
}

export interface GlmConfigurationInput {
  readonly kind: GlmProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: GlmAuthentication;
}

export interface GeminiConfigurationInput {
  readonly kind: GeminiProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: GeminiAuthentication;
}

export interface CopilotConfigurationInput {
  readonly kind: CopilotProviderConfiguration["kind"];
  readonly binaryPath: string;
}

export interface ClineConfigurationInput {
  readonly kind: ClineProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: ClineAuthentication;
}

export interface QwenConfigurationInput {
  readonly kind: QwenProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: QwenAuthentication;
}

export interface DevinConfigurationInput {
  readonly kind: DevinProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly authentication: DevinProviderConfiguration["authentication"];
}

export interface PiConfigurationInput {
  readonly kind: PiProviderConfiguration["kind"];
  readonly binaryPath: string;
}

export interface OhMyPiConfigurationInput {
  readonly kind: OhMyPiProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly supportedVersion: string;
}

export interface KiloConfigurationInput {
  readonly kind: KiloProviderConfiguration["kind"];
  readonly binaryPath: string;
}

export interface OllamaConfigurationInput {
  readonly kind: OllamaProviderConfiguration["kind"];
  readonly baseUrl: string;
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (normalized.includes("?") || normalized.includes("#")) {
    reject("invalid-base-url", "Ollama base URL cannot include query or fragment delimiters.");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return reject("invalid-base-url", "Ollama base URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    reject("invalid-base-url", "Ollama base URL must be an exact literal-loopback HTTP origin.");
  }
  return url.origin;
}

function normalizeOllamaConfiguration(
  configuration: OllamaConfigurationInput,
): OllamaProviderConfiguration {
  return { kind: "ollama-native-http", baseUrl: normalizeOllamaBaseUrl(configuration.baseUrl) };
}

function normalizePiConfiguration(configuration: PiConfigurationInput): PiProviderConfiguration {
  return { kind: "pi-rpc", binaryPath: normalizeBinaryPath(configuration.binaryPath) };
}

function normalizeOhMyPiConfiguration(
  configuration: OhMyPiConfigurationInput,
): OhMyPiProviderConfiguration {
  const supportedVersion = configuration.supportedVersion.trim();
  if (!/^\d+\.\d+\.\d+$/.test(supportedVersion)) {
    reject("invalid-version", "Oh My Pi supported version must be a pinned semver.");
  }
  return {
    kind: "oh-my-pi-rpc",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    supportedVersion,
  };
}

function normalizeKiloConfiguration(
  configuration: KiloConfigurationInput,
): KiloProviderConfiguration {
  return { kind: "kilo-acp", binaryPath: normalizeBinaryPath(configuration.binaryPath) };
}

function normalizeDevinConfiguration(
  configuration: DevinConfigurationInput,
): DevinProviderConfiguration {
  if (configuration.authentication !== "subscription") {
    reject("invalid-authentication", "Devin authentication must be subscription.");
  }
  return {
    kind: "devin-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: "subscription",
  };
}

function normalizeMistralVibeConfiguration(
  configuration: MistralVibeConfigurationInput,
): MistralVibeProviderConfiguration {
  if (
    configuration.authentication !== "subscription" &&
    configuration.authentication !== "api-key"
  ) {
    reject(
      "invalid-authentication",
      "Mistral Vibe authentication must be subscription or api-key.",
    );
  }
  return {
    kind: "mistral-vibe-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: configuration.authentication,
  };
}

function normalizeGrokConfiguration(
  configuration: GrokConfigurationInput,
): GrokProviderConfiguration {
  if (
    configuration.authentication !== "subscription" &&
    configuration.authentication !== "api-key"
  ) {
    reject("invalid-authentication", "Grok Build authentication must be subscription or api-key.");
  }
  return {
    kind: "grok-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: configuration.authentication,
  };
}

function normalizeGooseConfiguration(
  configuration: GooseConfigurationInput,
): GooseProviderConfiguration {
  return {
    kind: "goose-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
  };
}

function normalizeGlmConfiguration(configuration: GlmConfigurationInput): GlmProviderConfiguration {
  if (configuration.authentication !== "api-key") {
    reject("invalid-authentication", "GLM Agent authentication must be api-key.");
  }
  return {
    kind: "glm-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: "api-key",
  };
}

function normalizeGeminiConfiguration(
  configuration: GeminiConfigurationInput,
): GeminiProviderConfiguration {
  if (configuration.authentication !== "api-key") {
    reject("invalid-authentication", "Gemini CLI authentication must be api-key.");
  }
  return {
    kind: "gemini-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: "api-key",
  };
}

function normalizeCopilotConfiguration(
  configuration: CopilotConfigurationInput,
): CopilotProviderConfiguration {
  return {
    kind: "copilot-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
  };
}

function normalizeClineConfiguration(
  configuration: ClineConfigurationInput,
): ClineProviderConfiguration {
  if (configuration.authentication !== "api-key") {
    reject("invalid-authentication", "Cline authentication must be api-key.");
  }
  return {
    kind: "cline-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: "api-key",
  };
}

function normalizeQwenConfiguration(
  configuration: QwenConfigurationInput,
): QwenProviderConfiguration {
  if (configuration.authentication !== "api-key") {
    reject("invalid-authentication", "Qwen Code authentication must be api-key.");
  }
  return {
    kind: "qwen-acp",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: "api-key",
  };
}

function normalizeClaudeConfiguration(
  configuration: ClaudeConfigurationInput,
): ClaudeProviderConfiguration {
  if (
    configuration.authentication !== "subscription" &&
    configuration.authentication !== "api-key"
  ) {
    reject("invalid-authentication", "Claude authentication must be subscription or api-key.");
  }
  return {
    kind: "claude-agent-sdk",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: configuration.authentication,
  };
}

interface CreateClaudeProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: ClaudeConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createClaudeProvider(input: CreateClaudeProviderInput): ClaudeProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "claude",
    configuration: normalizeClaudeConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

interface CreateMistralVibeProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: MistralVibeConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createMistralVibeProvider(
  input: CreateMistralVibeProviderInput,
): MistralVibeProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "mistral-vibe",
    configuration: normalizeMistralVibeConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeMistralVibeConfiguration(
  provider: MistralVibeProviderInstance,
  configuration: MistralVibeConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): MistralVibeProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeMistralVibeConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateGrokProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: GrokConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createGrokProvider(input: CreateGrokProviderInput): GrokProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "grok",
    configuration: normalizeGrokConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeGrokConfiguration(
  provider: GrokProviderInstance,
  configuration: GrokConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): GrokProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeGrokConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateGooseProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: GooseConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createGooseProvider(input: CreateGooseProviderInput): GooseProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "goose",
    configuration: normalizeGooseConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeGooseConfiguration(
  provider: GooseProviderInstance,
  configuration: GooseConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): GooseProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeGooseConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateGlmProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: GlmConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createGlmProvider(input: CreateGlmProviderInput): GlmProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "glm",
    configuration: normalizeGlmConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeGlmConfiguration(
  provider: GlmProviderInstance,
  configuration: GlmConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): GlmProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeGlmConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateGeminiProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: GeminiConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createGeminiProvider(input: CreateGeminiProviderInput): GeminiProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "gemini",
    configuration: normalizeGeminiConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeGeminiConfiguration(
  provider: GeminiProviderInstance,
  configuration: GeminiConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): GeminiProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeGeminiConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateCopilotProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: CopilotConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createCopilotProvider(input: CreateCopilotProviderInput): CopilotProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "copilot",
    configuration: normalizeCopilotConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeCopilotConfiguration(
  provider: CopilotProviderInstance,
  configuration: CopilotConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): CopilotProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeCopilotConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateClineProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: ClineConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createClineProvider(input: CreateClineProviderInput): ClineProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "cline",
    configuration: normalizeClineConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeClineConfiguration(
  provider: ClineProviderInstance,
  configuration: ClineConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): ClineProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeClineConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateQwenProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: QwenConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createQwenProvider(input: CreateQwenProviderInput): QwenProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "qwen",
    configuration: normalizeQwenConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeQwenConfiguration(
  provider: QwenProviderInstance,
  configuration: QwenConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): QwenProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeQwenConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateDevinProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: DevinConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createDevinProvider(input: CreateDevinProviderInput): DevinProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "devin",
    configuration: normalizeDevinConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeDevinConfiguration(
  provider: DevinProviderInstance,
  configuration: DevinConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): DevinProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeDevinConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateKiloProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: KiloConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createKiloProvider(input: CreateKiloProviderInput): KiloProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "kilo",
    configuration: normalizeKiloConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeKiloConfiguration(
  provider: KiloProviderInstance,
  configuration: KiloConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): KiloProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeKiloConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreatePiProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: PiConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createPiProvider(input: CreatePiProviderInput): PiProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "pi",
    configuration: normalizePiConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changePiConfiguration(
  provider: PiProviderInstance,
  configuration: PiConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): PiProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizePiConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateOhMyPiProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: OhMyPiConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createOhMyPiProvider(input: CreateOhMyPiProviderInput): OhMyPiProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "oh-my-pi",
    configuration: normalizeOhMyPiConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeOhMyPiConfiguration(
  provider: OhMyPiProviderInstance,
  configuration: OhMyPiConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): OhMyPiProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeOhMyPiConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateOllamaProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: OllamaConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createOllamaProvider(input: CreateOllamaProviderInput): OllamaProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "ollama",
    configuration: normalizeOllamaConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeOllamaConfiguration(
  provider: OllamaProviderInstance,
  configuration: OllamaConfigurationInput,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): OllamaProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider endpoint.");
  }
  return {
    ...provider,
    configuration: normalizeOllamaConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
  };
}

interface CreateOpenAiCompatibleProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: OpenAiCompatibleConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createOpenAiCompatibleProvider(
  input: CreateOpenAiCompatibleProviderInput,
): OpenAiCompatibleProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "openai-compatible",
    configuration: normalizeOpenAiCompatibleConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

interface CreateAnthropicCompatibleProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: AnthropicCompatibleConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createAnthropicCompatibleProvider(
  input: CreateAnthropicCompatibleProviderInput,
): AnthropicCompatibleProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "anthropic-compatible",
    configuration: normalizeAnthropicCompatibleConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

interface CreateAzureFoundryProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: AzureFoundryConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createAzureFoundryProvider(
  input: CreateAzureFoundryProviderInput,
): AzureFoundryProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "azure-foundry",
    configuration: normalizeAzureFoundryConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface OpenAiImageConfigurationInput {
  readonly kind: OpenAiImageProviderConfiguration["kind"];
  readonly modelAllowlist: ReadonlyArray<string>;
  readonly defaultModel: string;
  readonly quality?: OpenAiImageQuality | undefined;
  readonly size?: OpenAiImageSize | undefined;
}

function normalizeImageModelSelection(
  modelAllowlist: ReadonlyArray<string>,
  defaultModel: string,
): {
  readonly modelAllowlist: OpenAiImageProviderConfiguration["modelAllowlist"];
  readonly defaultModel: ProviderModelId;
} {
  const allowlist = normalizeManualModelIds(modelAllowlist);
  if (allowlist.length === 0) {
    reject("invalid-model-ids", "Image profiles require at least one model ID.");
  }
  const normalizedDefault = defaultModel.trim();
  if (normalizedDefault.length === 0) {
    reject("invalid-model-id", "Default model cannot be empty.");
  }
  if (!allowlist.some((id) => id === normalizedDefault)) {
    reject("invalid-model-id", "Default model must be a member of the model allowlist.");
  }
  return {
    modelAllowlist: allowlist as OpenAiImageProviderConfiguration["modelAllowlist"],
    defaultModel: normalizedDefault as ProviderModelId,
  };
}

function normalizeOpenAiImageConfiguration(
  configuration: OpenAiImageConfigurationInput,
): OpenAiImageProviderConfiguration {
  const { modelAllowlist, defaultModel } = normalizeImageModelSelection(
    configuration.modelAllowlist,
    configuration.defaultModel,
  );
  return {
    kind: "openai-image-http",
    modelAllowlist,
    defaultModel,
    ...(configuration.quality === undefined ? {} : { quality: configuration.quality }),
    ...(configuration.size === undefined ? {} : { size: configuration.size }),
  };
}

export interface GeminiImageConfigurationInput {
  readonly kind: GeminiImageProviderConfiguration["kind"];
  readonly modelAllowlist: ReadonlyArray<string>;
  readonly defaultModel: string;
  readonly aspectRatio?: GeminiImageAspectRatio | undefined;
  readonly resolution?: GeminiImageResolution | undefined;
}

function normalizeGeminiImageConfiguration(
  configuration: GeminiImageConfigurationInput,
): GeminiImageProviderConfiguration {
  const { modelAllowlist, defaultModel } = normalizeImageModelSelection(
    configuration.modelAllowlist,
    configuration.defaultModel,
  );
  return {
    kind: "gemini-native-image-http",
    modelAllowlist,
    defaultModel,
    ...(configuration.aspectRatio === undefined ? {} : { aspectRatio: configuration.aspectRatio }),
    ...(configuration.resolution === undefined ? {} : { resolution: configuration.resolution }),
  };
}

interface CreateOpenAiImageProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: OpenAiImageConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createOpenAiImageProvider(
  input: CreateOpenAiImageProviderInput,
): OpenAiImageProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "openai-image",
    configuration: normalizeOpenAiImageConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

interface CreateGeminiImageProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: GeminiImageConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createGeminiImageProvider(
  input: CreateGeminiImageProviderInput,
): GeminiImageProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "gemini-native-image",
    configuration: normalizeGeminiImageConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function createOpenCodeProvider(input: CreateProviderInput): ProviderInstance {
  const { binaryPath, ...normalized } = normalizeProviderCreation(input);
  return {
    ...normalized,
    driverKind: "opencode",
    configuration: {
      kind: "opencode-cli",
      binaryPath,
    },
  };
}

export function createCodexProvider(input: CreateProviderInput): ProviderInstance {
  const { binaryPath, ...normalized } = normalizeProviderCreation(input);
  return {
    ...normalized,
    driverKind: "codex",
    configuration: {
      kind: "codex-cli",
      binaryPath,
    },
  };
}

export function createKimiCodeProvider(input: CreateProviderInput): KimiCodeProviderInstance {
  const { binaryPath, ...normalized } = normalizeProviderCreation(input);
  return {
    ...normalized,
    driverKind: "kimi-code",
    configuration: {
      kind: "kimi-code-acp",
      binaryPath,
    },
  };
}

interface RenameProviderInput {
  readonly displayName: string;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly updatedAt: UtcTimestamp;
}

export function renameProvider(
  provider: ProviderInstance,
  input: RenameProviderInput,
): ProviderInstance {
  return {
    ...provider,
    displayName: normalizeName(input.displayName, input.existingInstances, provider.id),
    version: nextVersion(provider.version),
    updatedAt: input.updatedAt,
  };
}

interface ChangeProviderBinaryInput {
  readonly binaryPath: string;
  readonly activeSessionCount?: number;
  readonly updatedAt: UtcTimestamp;
}

export function changeProviderBinary(
  provider: OpenCodeProviderInstance | CodexProviderInstance | KimiCodeProviderInstance,
  input: ChangeProviderBinaryInput,
): ProviderInstance {
  if ((input.activeSessionCount ?? 0) > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  const binaryPath = normalizeBinaryPath(input.binaryPath);
  switch (provider.driverKind) {
    case "opencode":
      return {
        ...provider,
        configuration: { ...provider.configuration, binaryPath },
        version: nextVersion(provider.version),
        updatedAt: input.updatedAt,
      };
    case "codex":
      return {
        ...provider,
        configuration: { ...provider.configuration, binaryPath },
        version: nextVersion(provider.version),
        updatedAt: input.updatedAt,
      };
    case "kimi-code":
      return {
        ...provider,
        configuration: { ...provider.configuration, binaryPath },
        version: nextVersion(provider.version),
        updatedAt: input.updatedAt,
      };
  }
}

export function changeOpenAiCompatibleConfiguration(
  current: OpenAiCompatibleProviderInstance,
  input: OpenAiCompatibleConfigurationInput,
  updatedAt: UtcTimestamp,
): OpenAiCompatibleProviderInstance {
  return {
    ...current,
    configuration: normalizeOpenAiCompatibleConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

export function changeAnthropicCompatibleConfiguration(
  current: AnthropicCompatibleProviderInstance,
  input: AnthropicCompatibleConfigurationInput,
  updatedAt: UtcTimestamp,
): AnthropicCompatibleProviderInstance {
  return {
    ...current,
    configuration: normalizeAnthropicCompatibleConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

export function changeAzureFoundryConfiguration(
  current: AzureFoundryProviderInstance,
  input: AzureFoundryConfigurationInput,
  updatedAt: UtcTimestamp,
): AzureFoundryProviderInstance {
  return {
    ...current,
    configuration: normalizeAzureFoundryConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

export function changeOpenAiImageConfiguration(
  current: OpenAiImageProviderInstance,
  input: OpenAiImageConfigurationInput,
  updatedAt: UtcTimestamp,
): OpenAiImageProviderInstance {
  return {
    ...current,
    configuration: normalizeOpenAiImageConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

export function changeGeminiImageConfiguration(
  current: GeminiImageProviderInstance,
  input: GeminiImageConfigurationInput,
  updatedAt: UtcTimestamp,
): GeminiImageProviderInstance {
  return {
    ...current,
    configuration: normalizeGeminiImageConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

interface ChangeClaudeConfigurationInput {
  readonly configuration: ClaudeConfigurationInput;
  readonly activeSessionCount: number;
  readonly updatedAt: UtcTimestamp;
}

export function changeClaudeConfiguration(
  current: ClaudeProviderInstance,
  input: ChangeClaudeConfigurationInput,
): ClaudeProviderInstance {
  if (input.activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before reconfiguring this provider.");
  }
  return {
    ...current,
    configuration: normalizeClaudeConfiguration(input.configuration),
    version: nextVersion(current.version),
    updatedAt: input.updatedAt,
  };
}

interface SetProviderEnabledInput {
  readonly enabled: boolean;
  readonly updatedAt: UtcTimestamp;
}

export function setProviderEnabled(
  provider: ProviderInstance,
  input: SetProviderEnabledInput,
): ProviderInstance {
  return {
    ...provider,
    enabled: input.enabled,
    version: nextVersion(provider.version),
    updatedAt: input.updatedAt,
  };
}

interface RemoveProviderInput {
  readonly activeSessionCount: number;
  readonly updatedAt?: UtcTimestamp;
}

export function removeProvider(
  provider: ProviderInstance,
  input: RemoveProviderInput,
): ProviderInstance {
  if (input.activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before removing this provider.");
  }
  if (input.updatedAt === undefined) {
    reject("invalid-timestamp", "Provider removal requires a timestamp.");
  }
  return {
    ...provider,
    version: nextVersion(provider.version),
    updatedAt: input.updatedAt,
  };
}

export function updateProviderDefaults(
  defaults: ProviderDefaults,
  permissionPersistence: PermissionPersistence = "current-session",
  providerOrder: ProviderDefaults["providerOrder"] = defaults.providerOrder,
  agentEligibleModels: ProviderDefaults["agentEligibleModels"] = defaults.agentEligibleModels,
): ProviderDefaults {
  return {
    permissionPersistence,
    ...(providerOrder === undefined ? {} : { providerOrder }),
    // An explicit empty list clears the Settings-defined agent-eligible
    // pool; an omitted argument preserves the stored pool unchanged.
    ...(agentEligibleModels === undefined || agentEligibleModels.length === 0
      ? {}
      : { agentEligibleModels }),
    version: nextVersion(defaults.version),
  };
}

interface EffectiveProviderAuthorityInput {
  readonly allowed: ProviderExecutionPolicy;
  readonly requested: ProviderExecutionPolicy;
  readonly enabled?: boolean;
}

export function effectiveProviderAuthority(
  input: EffectiveProviderAuthorityInput,
): ProviderExecutionPolicy {
  if (input.enabled === false) {
    reject("disabled-provider", "Enable this provider before starting a session.");
  }
  const authorityOrder: ReadonlyArray<ProviderExecutionPolicy> = [
    "plan",
    "approval-gated",
    "full-access",
  ];
  return authorityOrder[
    Math.min(authorityOrder.indexOf(input.allowed), authorityOrder.indexOf(input.requested))
  ]!;
}
