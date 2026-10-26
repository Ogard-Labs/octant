import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  acpAgentChangeCommandKind,
  acpAgentCreateCommandKind,
  CLAUDE_ACCOUNT_ACCENTS,
} from "@octant/contracts/providers";
import {
  assignedProviderAccountDirectory,
  CLAUDE_ACCOUNT_PROFILE,
  CODEX_ACCOUNT_PROFILE,
  formatProviderAccountSignInCommand,
} from "./providerAccountProfile";
import {
  ACP_AGENT_KINDS,
  acpAgentKindOfConfiguration,
  acpAgentProfile,
  isAcpAgentKind,
} from "@octant/contracts/acp-agent-profiles";
import { isAzureFoundryDirectoryHost } from "./directorySignIn";
import type {
  AcpAgentConfiguration,
  AcpAgentProviderInstance,
  ChangeAcpAgentConfigurationCommand,
  CreateAcpAgentProviderCommand,
  ProviderRegistryCommand,
  AnthropicCompatibleProviderConfiguration,
  AnthropicCompatibleProviderInstance,
  AzureFoundryProviderConfiguration,
  DirectoryBinding,
  AzureFoundryProviderInstance,
  BflImageProviderConfiguration,
  BflImageProviderInstance,
  ClaudeAccountAccent,
  ClaudeAuthentication,
  ClaudeProviderConfiguration,
  ClaudeProviderInstance,
  CodexProviderConfiguration,
  CodexProviderInstance,
  GeminiImageAspectRatio,
  GeminiImageProviderConfiguration,
  GeminiImageProviderInstance,
  GeminiImageResolution,
  IdeogramImageProviderConfiguration,
  IdeogramImageProviderInstance,
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
  ProviderDataTags,
  ProviderDriverKind,
  ProviderExecutionPolicy,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderModel,
  OpenCodeProviderInstance,
} from "@octant/contracts/providers";

export type ProviderPolicyRejectionCode =
  | "active-sessions"
  | "disabled-provider"
  | "invalid-authentication"
  | "invalid-binary-path"
  | "invalid-configuration"
  | "invalid-version"
  | "invalid-base-url"
  | "invalid-model-id"
  | "invalid-model-ids"
  | "invalid-name"
  | "invalid-config-directory"
  | "invalid-accent"
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
): driverKind is "openai-image" | "gemini-native-image" | "bfl-image" | "ideogram-image" {
  return (
    driverKind === "openai-image" ||
    driverKind === "gemini-native-image" ||
    driverKind === "bfl-image" ||
    driverKind === "ideogram-image"
  );
}

/**
 * Verified provider-owned self-update argv from the official CLI docs and the
 * binaries' own help output. Gemini CLI has no documented update subcommand
 * (installs via npm; /upgrade is a billing-tier action), so it stays
 * unavailable. OpenCode is updated on the managed tool channel instead, so a
 * provider-owned upgrade is not offered: that command would replace a binary
 * outside Octant's managed location.
 */
const PROVIDER_CLI_UPDATE_COMMANDS: Partial<Record<ProviderDriverKind, ReadonlyArray<string>>> = {
  codex: ["update"],
  claude: ["update"],
};

/** Returns the provider-owned update command, when the CLI documents one. */
export function providerCliUpdateArgs(
  driverKind: ProviderDriverKind,
): ReadonlyArray<string> | undefined {
  return isAcpAgentKind(driverKind)
    ? acpAgentProfile(driverKind).cliUpdateArgs
    : PROVIDER_CLI_UPDATE_COMMANDS[driverKind];
}

export function supportsProviderCliUpdate(driverKind: ProviderDriverKind): boolean {
  return providerCliUpdateArgs(driverKind) !== undefined;
}

/**
 * The agent runtimes "Locate binary" can point at an executable the person
 * picked: every runtime whose configuration names a binary and whose version
 * probe the host can run to check the pick. An ACP agent with no version flag
 * (GLM Agent: run bare, it starts and waits on stdin) is left out, because the
 * host could never accept a picked file.
 */
const LOCATABLE_RUNTIME_DRIVER_KINDS: ReadonlySet<ProviderDriverKind> = new Set([
  "codex",
  "opencode",
  "claude",
  "pi",
  "oh-my-pi",
  ...ACP_AGENT_KINDS.filter((kind) => acpAgentProfile(kind).versionProbeArgs.length > 0),
]);

export function canLocateRuntimeBinary(driverKind: ProviderDriverKind): boolean {
  return LOCATABLE_RUNTIME_DRIVER_KINDS.has(driverKind);
}

/**
 * The providers Octant drives with its own agent loop. They are inference
 * transports only: every tool they are offered is app-managed and every call
 * passes the server's authority choke point before it runs.
 */
export function isNativeHarnessDriverKind(
  driverKind: ProviderDriverKind,
): driverKind is "openai-compatible" | "anthropic-compatible" | "azure-foundry" | "ollama" {
  return (
    driverKind === "openai-compatible" ||
    driverKind === "anthropic-compatible" ||
    driverKind === "azure-foundry" ||
    driverKind === "ollama"
  );
}

/**
 * Whether the provider keeps a thread's conversation in its own session, so a
 * follow-up must resume that session rather than replay history the host
 * holds. Mirrors each driver's `conversationOwnership`, which the server's
 * driver factory test pins: Chat and Work refuse a follow-up that moves a
 * thread between the two kinds, and a picker that offered the move led to that
 * refusal.
 */
export function providerKeepsConversation(driverKind: ProviderDriverKind): boolean {
  return !(isNativeHarnessDriverKind(driverKind) || isImageProfileDriverKind(driverKind));
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
  readonly oauthDescriptorId?: OpenAiCompatibleProviderConfiguration["oauthDescriptorId"];
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
    ...(configuration.oauthDescriptorId === undefined
      ? {}
      : { oauthDescriptorId: configuration.oauthDescriptorId }),
  };
}

export interface AnthropicCompatibleConfigurationInput {
  readonly kind: AnthropicCompatibleProviderConfiguration["kind"];
  readonly baseUrl: string;
  readonly authentication: AnthropicCompatibleProviderConfiguration["authentication"];
  readonly protocol: AnthropicCompatibleProviderConfiguration["protocol"];
  readonly protocolVersion: string;
  readonly manualModelIds: ReadonlyArray<string>;
  readonly oauthDescriptorId?: AnthropicCompatibleProviderConfiguration["oauthDescriptorId"];
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
    ...(configuration.oauthDescriptorId === undefined
      ? {}
      : { oauthDescriptorId: configuration.oauthDescriptorId }),
  };
}

export interface AzureFoundryConfigurationInput {
  readonly kind: AzureFoundryProviderConfiguration["kind"];
  readonly baseUrl: string;
  readonly authentication: AzureFoundryProviderConfiguration["authentication"];
  readonly protocol: AzureFoundryProviderConfiguration["protocol"];
  readonly manualModelIds: ReadonlyArray<string>;
  /** The organization's tenant and client; present exactly for `directory-oauth`. */
  readonly directory?: { readonly tenantId: string; readonly clientId: string };
  /** Whether the host-local command may sign this organization sign-in in with a device code. */
  readonly deviceCodeSignIn?: boolean | undefined;
}

const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A directory sign-in's tenant and client, refused unless each is a lowercase
 * GUID and the address lies under the Foundry host list: a typo or a crafted
 * address must not become a place a directory bearer is sent.
 */
function azureFoundryDirectoryBinding(
  baseUrl: string,
  directory: AzureFoundryConfigurationInput["directory"],
): DirectoryBinding {
  if (
    directory === undefined ||
    !DIRECTORY_GUID.test(directory.tenantId) ||
    !DIRECTORY_GUID.test(directory.clientId)
  ) {
    reject(
      "invalid-authentication",
      "Organization sign-in needs your directory's tenant ID and the application (client) ID your organization registered, each a GUID.",
    );
  }
  if (!isAzureFoundryDirectoryHost(baseUrl)) {
    reject(
      "invalid-base-url",
      "Organization sign-in works only with an Azure AI Foundry address under openai.azure.com, services.ai.azure.com, or cognitiveservices.azure.com.",
    );
  }
  return {
    tenantId: directory.tenantId as DirectoryBinding["tenantId"],
    clientId: directory.clientId as DirectoryBinding["clientId"],
  };
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
  if (
    configuration.authentication !== "api-key" &&
    configuration.authentication !== "directory-oauth"
  ) {
    reject(
      "invalid-authentication",
      "Azure AI Foundry signs in with an API key or an organization account.",
    );
  }
  // An API-key instance carries no directory binding: one left from an
  // earlier sign-in would read as a sign-in the instance no longer uses.
  if (configuration.authentication === "api-key" && configuration.directory !== undefined) {
    reject("invalid-authentication", "An API-key endpoint does not name a directory tenant.");
  }
  if (configuration.authentication === "api-key" && configuration.deviceCodeSignIn === true) {
    reject(
      "invalid-authentication",
      "Signing in with a device code needs an organization account; an API-key endpoint has no sign-in.",
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
  const shared = {
    kind: configuration.kind,
    baseUrl,
    protocol: configuration.protocol,
    manualModelIds,
  };
  if (configuration.authentication === "directory-oauth") {
    return {
      ...shared,
      authentication: "directory-oauth",
      directory: azureFoundryDirectoryBinding(baseUrl, configuration.directory),
      // Off is the absence of the opt-in, so one spelling reaches the journal.
      ...(configuration.deviceCodeSignIn === true ? { deviceCodeSignIn: true } : {}),
    };
  }
  return { ...shared, authentication: "api-key" };
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
  readonly configDirectory?: string | undefined;
  readonly accent?: ClaudeAccountAccent | undefined;
}

/** Closed accent set mirrored from the contract so Settings can list it. */
export const CLAUDE_ACCOUNT_ACCENT_VALUES: ReadonlyArray<ClaudeAccountAccent> =
  CLAUDE_ACCOUNT_ACCENTS;

/**
 * Directory Claude owns for an additional account. The first/default instance
 * omits this and keeps Claude's usual `~/.claude` (or host `CLAUDE_CONFIG_DIR`).
 */
export function assignedClaudeAccountConfigDirectory(
  homeDirectory: string,
  instanceId: ProviderInstanceId,
): string {
  const home = stripTrailingSlashes(homeDirectory.trim());
  if (!isPosixAbsolutePath(home)) {
    reject("invalid-config-directory", "Claude account home must be an absolute directory.");
  }
  return assignedProviderAccountDirectory(CLAUDE_ACCOUNT_PROFILE, home, instanceId);
}

export function assignedCodexHome(homeDirectory: string, instanceId: ProviderInstanceId): string {
  const home = stripTrailingSlashes(homeDirectory.trim());
  if (!isPosixAbsolutePath(home)) {
    reject("invalid-config-directory", "Codex account home must be an absolute directory.");
  }
  return assignedProviderAccountDirectory(CODEX_ACCOUNT_PROFILE, home, instanceId);
}

/**
 * The directory a Claude account launches with, or `undefined` for the host
 * profile. An API-key account always has its assigned leaf, including one
 * stored before accounts carried a directory: the probe, the launch, resume
 * lookup and usage history must all name the same folder for it.
 */
export function effectiveClaudeAccountConfigDirectory(
  instance: Extract<ProviderInstance, { readonly driverKind: "claude" }>,
  homeDirectory: string,
): string | undefined {
  if (instance.configuration.configDirectory !== undefined) {
    return instance.configuration.configDirectory;
  }
  return instance.configuration.authentication === "api-key"
    ? assignedClaudeAccountConfigDirectory(homeDirectory, instance.id)
    : undefined;
}

/** Unmodified Claude CLI sign-in. Octant never wraps or replaces this flow. */
export function claudeAuthLoginArgv(binaryPath: string): ReadonlyArray<string> {
  return [normalizeBinaryPath(binaryPath), ...CLAUDE_ACCOUNT_PROFILE.signInArgv];
}

export function formatClaudeAuthLoginCommand(input: {
  readonly binaryPath: string;
  readonly configDirectory?: string;
}): string {
  return formatProviderAccountSignInCommand({
    profile: CLAUDE_ACCOUNT_PROFILE,
    binaryPath: normalizeBinaryPath(input.binaryPath),
    ...(input.configDirectory === undefined ? {} : { stateDirectory: input.configDirectory }),
  });
}

/** Linear scan. A `/+$` replace is polynomial in the trailing slashes. */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

function isPosixAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

function pathBasename(path: string): string {
  const trimmed = stripTrailingSlashes(path);
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function normalizeClaudeConfigDirectory(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.trim();
  if (normalized.length === 0) return undefined;
  if (!isPosixAbsolutePath(normalized)) {
    reject("invalid-config-directory", "Claude config directory must be an absolute path.");
  }
  if (pathBasename(normalized) === ".credentials.json") {
    reject("invalid-config-directory", "Claude config directory cannot be a credential file.");
  }
  return normalized;
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

function normalizeClaudeConfiguration(
  configuration: ClaudeConfigurationInput,
): ClaudeProviderConfiguration {
  if (
    configuration.authentication !== "subscription" &&
    configuration.authentication !== "api-key"
  ) {
    reject("invalid-authentication", "Claude authentication must be subscription or api-key.");
  }
  if (
    configuration.accent !== undefined &&
    !CLAUDE_ACCOUNT_ACCENT_VALUES.includes(configuration.accent)
  ) {
    reject("invalid-accent", "Claude account accent must be one of the named swatches.");
  }
  const configDirectory = normalizeClaudeConfigDirectory(configuration.configDirectory);
  return {
    kind: "claude-agent-sdk",
    binaryPath: normalizeBinaryPath(configuration.binaryPath),
    authentication: configuration.authentication,
    ...(configDirectory === undefined ? {} : { configDirectory }),
    ...(configuration.accent === undefined ? {} : { accent: configuration.accent }),
  };
}

export function isAcpAgentInstance(
  instance: ProviderInstance,
): instance is AcpAgentProviderInstance {
  return isAcpAgentKind(instance.driverKind);
}

const acpAgentCreateCommandKinds: ReadonlySet<string> = new Set(
  ACP_AGENT_KINDS.map(acpAgentCreateCommandKind),
);
const acpAgentChangeCommandKinds: ReadonlySet<string> = new Set(
  ACP_AGENT_KINDS.map(acpAgentChangeCommandKind),
);

export function isCreateAcpAgentProviderCommand(
  command: ProviderRegistryCommand,
): command is CreateAcpAgentProviderCommand {
  return acpAgentCreateCommandKinds.has(command.kind);
}

export function isChangeAcpAgentConfigurationCommand(
  command: ProviderRegistryCommand,
): command is ChangeAcpAgentConfigurationCommand {
  return acpAgentChangeCommandKinds.has(command.kind);
}

/**
 * Checks an ACP agent configuration against its profile: an absolute binary
 * and, when the profile lists postures, one of them; an agent whose profile
 * lists none takes no posture.
 */
function normalizeAcpAgentConfiguration(
  configuration: AcpAgentConfiguration,
): AcpAgentConfiguration {
  const profile = acpAgentProfile(acpAgentKindOfConfiguration(configuration.kind));
  const binaryPath = normalizeBinaryPath(configuration.binaryPath);
  const { authentication } = configuration;
  if (profile.authentication.length === 0) {
    if (authentication !== undefined) {
      reject("invalid-authentication", `${profile.name} takes no authentication setting.`);
    }
    return { kind: configuration.kind, binaryPath };
  }
  if (authentication === undefined || !profile.authentication.includes(authentication)) {
    return reject(
      "invalid-authentication",
      `${profile.name} authentication must be ${profile.authentication.join(" or ")}.`,
    );
  }
  return { kind: configuration.kind, binaryPath, authentication };
}

interface CreateAcpAgentProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: AcpAgentConfiguration;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

/** Creates an instance of the ACP agent its configuration names. */
export function createAcpAgentProvider(
  input: CreateAcpAgentProviderInput,
): AcpAgentProviderInstance {
  const configuration = normalizeAcpAgentConfiguration(input.configuration);
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: acpAgentKindOfConfiguration(configuration.kind),
    configuration,
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function changeAcpAgentConfiguration(
  provider: AcpAgentProviderInstance,
  configuration: AcpAgentConfiguration,
  updatedAt: UtcTimestamp,
  activeSessionCount = 0,
): AcpAgentProviderInstance {
  if (activeSessionCount > 0) {
    reject("active-sessions", "Stop active sessions before changing this provider runtime.");
  }
  if (configuration.kind !== provider.configuration.kind) {
    reject("invalid-configuration", "The configuration names a different provider runtime.");
  }
  return {
    ...provider,
    configuration: normalizeAcpAgentConfiguration(configuration),
    version: nextVersion(provider.version),
    updatedAt,
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

export interface BflImageConfigurationInput {
  readonly kind: BflImageProviderConfiguration["kind"];
  readonly modelAllowlist: ReadonlyArray<string>;
  readonly defaultModel: string;
  readonly baseUrl?: string | undefined;
}

function normalizeBflImageConfiguration(
  configuration: BflImageConfigurationInput,
): BflImageProviderConfiguration {
  const { modelAllowlist, defaultModel } = normalizeImageModelSelection(
    configuration.modelAllowlist,
    configuration.defaultModel,
  );
  return {
    kind: "bfl-image-http",
    modelAllowlist,
    defaultModel,
    ...(configuration.baseUrl === undefined
      ? {}
      : { baseUrl: normalizeOpenAiCompatibleBaseUrl(configuration.baseUrl) }),
  };
}

export interface IdeogramImageConfigurationInput {
  readonly kind: IdeogramImageProviderConfiguration["kind"];
  readonly modelAllowlist: ReadonlyArray<string>;
  readonly defaultModel: string;
  readonly baseUrl?: string | undefined;
}

function normalizeIdeogramImageConfiguration(
  configuration: IdeogramImageConfigurationInput,
): IdeogramImageProviderConfiguration {
  const { modelAllowlist, defaultModel } = normalizeImageModelSelection(
    configuration.modelAllowlist,
    configuration.defaultModel,
  );
  return {
    kind: "ideogram-image-http",
    modelAllowlist,
    defaultModel,
    ...(configuration.baseUrl === undefined
      ? {}
      : { baseUrl: normalizeOpenAiCompatibleBaseUrl(configuration.baseUrl) }),
  };
}

interface CreateIdeogramImageProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: IdeogramImageConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createIdeogramImageProvider(
  input: CreateIdeogramImageProviderInput,
): IdeogramImageProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "ideogram-image",
    configuration: normalizeIdeogramImageConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

interface CreateBflImageProviderInput {
  readonly id: ProviderInstanceId;
  readonly displayName: string;
  readonly configuration: BflImageConfigurationInput;
  readonly existingInstances: ReadonlyArray<ProviderInstance>;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
  readonly enabled?: boolean;
}

export function createBflImageProvider(
  input: CreateBflImageProviderInput,
): BflImageProviderInstance {
  return {
    id: input.id,
    displayName: normalizeName(input.displayName, input.existingInstances),
    driverKind: "bfl-image",
    configuration: normalizeBflImageConfiguration(input.configuration),
    enabled: input.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: nextVersion(input.expectedVersion),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
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

export function createCodexProvider(
  input: CreateProviderInput & {
    readonly accent?: ClaudeAccountAccent;
    readonly codexHome?: string;
  },
): ProviderInstance {
  const { binaryPath, ...normalized } = normalizeProviderCreation(input);
  return {
    ...normalized,
    driverKind: "codex",
    configuration: {
      kind: "codex-cli",
      binaryPath,
      ...(input.accent === undefined ? {} : { accent: input.accent }),
      ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
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
  provider: OpenCodeProviderInstance | CodexProviderInstance,
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

export function changeBflImageConfiguration(
  current: BflImageProviderInstance,
  input: BflImageConfigurationInput,
  updatedAt: UtcTimestamp,
): BflImageProviderInstance {
  return {
    ...current,
    configuration: normalizeBflImageConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

export function changeIdeogramImageConfiguration(
  current: IdeogramImageProviderInstance,
  input: IdeogramImageConfigurationInput,
  updatedAt: UtcTimestamp,
): IdeogramImageProviderInstance {
  return {
    ...current,
    configuration: normalizeIdeogramImageConfiguration(input),
    version: nextVersion(current.version),
    updatedAt,
  };
}

interface ChangeClaudeConfigurationInput {
  readonly configuration: ClaudeConfigurationInput;
  readonly activeSessionCount: number;
  readonly updatedAt: UtcTimestamp;
}

export interface CodexConfigurationInput {
  readonly kind: CodexProviderConfiguration["kind"];
  readonly binaryPath: string;
  readonly codexHome?: string | undefined;
  readonly accent?: ClaudeAccountAccent | undefined;
}

interface ChangeCodexConfigurationInput {
  readonly configuration: CodexConfigurationInput;
  readonly activeSessionCount: number;
  readonly updatedAt: UtcTimestamp;
}

type CodexRuntimeInputs = Pick<CodexConfigurationInput, "binaryPath" | "codexHome">;

/**
 * Whether a change leaves alone everything a Codex process reads: its binary
 * and its account home. Only the accent is left, and that is how Octant draws
 * the account, so a running session is unaffected.
 */
export function codexChangeKeepsRuntime(
  current: CodexRuntimeInputs,
  next: CodexRuntimeInputs,
): boolean {
  return current.binaryPath === next.binaryPath && current.codexHome === next.codexHome;
}

export function changeCodexConfiguration(
  current: CodexProviderInstance,
  input: ChangeCodexConfigurationInput,
): CodexProviderInstance {
  const configuration =
    input.configuration.codexHome === undefined && current.configuration.codexHome !== undefined
      ? {
          ...input.configuration,
          codexHome: current.configuration.codexHome,
        }
      : input.configuration;
  if (
    input.activeSessionCount > 0 &&
    !codexChangeKeepsRuntime(current.configuration, configuration)
  ) {
    reject("active-sessions", "Stop active sessions before reconfiguring this provider.");
  }
  return {
    ...current,
    configuration: {
      kind: "codex-cli",
      binaryPath: normalizeBinaryPath(configuration.binaryPath),
      ...(configuration.accent === undefined ? {} : { accent: configuration.accent }),
      ...(configuration.codexHome === undefined ? {} : { codexHome: configuration.codexHome }),
    },
    version: nextVersion(current.version),
    updatedAt: input.updatedAt,
  };
}

type ClaudeRuntimeInputs = Pick<
  ClaudeConfigurationInput,
  "binaryPath" | "authentication" | "configDirectory"
>;

/**
 * Whether a change leaves alone everything a Claude process reads: its binary,
 * its authentication, and its account directory. Only the accent is left, and
 * that is how Octant draws the account, so a running session is unaffected.
 */
export function claudeChangeKeepsRuntime(
  current: ClaudeRuntimeInputs,
  next: ClaudeRuntimeInputs,
): boolean {
  return (
    current.binaryPath === next.binaryPath &&
    current.authentication === next.authentication &&
    current.configDirectory === next.configDirectory
  );
}

export function changeClaudeConfiguration(
  current: ClaudeProviderInstance,
  input: ChangeClaudeConfigurationInput,
): ClaudeProviderInstance {
  const configuration =
    input.configuration.configDirectory === undefined &&
    current.configuration.configDirectory !== undefined
      ? {
          ...input.configuration,
          configDirectory: current.configuration.configDirectory,
        }
      : input.configuration;
  if (
    input.activeSessionCount > 0 &&
    !claudeChangeKeepsRuntime(current.configuration, configuration)
  ) {
    reject("active-sessions", "Stop active sessions before reconfiguring this provider.");
  }
  return {
    ...current,
    configuration: normalizeClaudeConfiguration(configuration),
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

export function setProviderDataTags(
  provider: ProviderInstance,
  dataTags: ProviderDataTags,
  updatedAt: UtcTimestamp,
): ProviderInstance {
  return {
    ...provider,
    dataTags,
    version: nextVersion(provider.version),
    updatedAt,
  };
}

export function setProviderModelDataTags(
  model: ProviderModel,
  dataTags: ProviderDataTags,
): ProviderModel {
  return { ...model, dataTags };
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
  hiddenModels: ProviderDefaults["hiddenModels"] = defaults.hiddenModels,
): ProviderDefaults {
  return {
    permissionPersistence,
    ...(providerOrder === undefined ? {} : { providerOrder }),
    // An explicit empty list clears the Settings-defined agent-eligible
    // pool; an omitted argument preserves the stored pool unchanged.
    ...(agentEligibleModels === undefined || agentEligibleModels.length === 0
      ? {}
      : { agentEligibleModels }),
    // An explicit empty list clears model visibility overrides; an omitted
    // argument preserves the stored list through unrelated defaults changes.
    ...(hiddenModels === undefined || hiddenModels.length === 0 ? {} : { hiddenModels }),
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
