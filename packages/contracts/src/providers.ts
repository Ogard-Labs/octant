import { Schema } from "effect";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionPackageId,
  ExtensionPackageVersion,
  ExtensionPublisherKeyFingerprint,
  ToolExtensionId,
} from "./extensionIdentity";
import { ExtensionNpmSource } from "./extensionIdentity";
import { OctantMode } from "./modes";
import { ThreadPublishedPage } from "./threadToolSteps";
import {
  ACP_AGENT_KINDS,
  AcpAgentAuthentication,
  acpAgentConfigurationKind,
  acpAgentKindOfConfiguration,
  acpAgentProfile,
  type AcpAgentKind,
} from "./acpAgentProfiles";

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

/**
 * The closed driver vocabulary. ACP agents join it through their profile row
 * in `acpAgentProfiles.ts`; every other driver is named here.
 */
export const ProviderDriverKind = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "pi",
  "oh-my-pi",
  "ollama",
  ...ACP_AGENT_KINDS,
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
  "amazon-bedrock",
  "openai-image",
  "gemini-native-image",
  "bfl-image",
  "ideogram-image",
  // The one family for every driver package that does not ship with Octant.
  // Which driver an instance runs is package data in its configuration, never
  // a new value here, so the exhaustive checks over this set stay closed.
  "outside-harness-endpoint",
);
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

/**
 * The key providers: the runtimes that run inside Octant as they run on their
 * own, with their own subagents, web tools, skills, configuration, and a
 * trusted Project's code, once the person allows it.
 */
export const KEY_PROVIDER_DRIVER_KINDS = ["claude", "codex", "opencode", "mistral-vibe"] as const;
export const KeyProviderDriverKind = Schema.Literal(...KEY_PROVIDER_DRIVER_KINDS);
export type KeyProviderDriverKind = typeof KeyProviderDriverKind.Type;
export const KeyProviderDriverKinds = Schema.Array(KeyProviderDriverKind).pipe(
  Schema.filter(
    (kinds) =>
      kinds.length <= KEY_PROVIDER_DRIVER_KINDS.length && new Set(kinds).size === kinds.length,
  ),
);
export type KeyProviderDriverKinds = typeof KeyProviderDriverKinds.Type;

/**
 * What a key provider's session may load of its own, as the host resolved it
 * for one session from the thread's level and mode, the account's switch, and
 * the Project's trust. Each field turns one thing on; a driver applies the
 * fields it can and reports the rest in its `nativeSetup` capability. Absent
 * on a session means every field is off, which is how every other provider
 * and every single-use request starts.
 */
export const ProviderNativeSetup = Schema.Struct({
  /** The runtime's own subagents. */
  subagents: Schema.Boolean,
  /** The runtime's own web search and page fetch. */
  webTools: Schema.Boolean,
  /** Skills the runtime finds in the account's home and in the Project. */
  skills: Schema.Boolean,
  /** MCP servers and plugins the person set up in the account's home configuration. */
  toolServers: Schema.Boolean,
  /** The account's home settings with their hooks; never in Chat or Plan. */
  hooks: Schema.Boolean,
  /**
   * The Project's own settings, hooks, MCP servers, plugins, and tools, in a
   * Project the person trusted for this provider; never in Chat or Plan.
   */
  projectCode: Schema.Boolean,
}).annotations(strict);
export type ProviderNativeSetup = typeof ProviderNativeSetup.Type;
export const PROVIDER_NATIVE_SETUP_FEATURES = [
  "subagents",
  "webTools",
  "skills",
  "toolServers",
  "hooks",
  "projectCode",
] as const satisfies ReadonlyArray<keyof ProviderNativeSetup>;
export type ProviderNativeSetupFeature = (typeof PROVIDER_NATIVE_SETUP_FEATURES)[number];

/** User-maintained data handling labels used by Project provider policy. */
export const ProviderDataTag = Schema.Literal("eu", "zdr");
export type ProviderDataTag = typeof ProviderDataTag.Type;
export const ProviderDataTags = Schema.Array(ProviderDataTag).pipe(
  Schema.filter((tags) => new Set(tags).size === tags.length && tags.length <= 2),
);
export type ProviderDataTags = typeof ProviderDataTags.Type;

export const ProviderCapabilitySupport = Schema.Literal("supported", "unsupported", "unavailable");
export type ProviderCapabilitySupport = typeof ProviderCapabilitySupport.Type;
/**
 * Why a runtime's own artifact tool is not available to an account's threads:
 * the person has not enabled it (`turned-off`), the account signs in with no
 * account to publish to (`no-publishing-account`), or the host's own switch
 * for the runtime's non-essential traffic keeps it off
 * (`host-traffic-disabled`).
 */
export const ProviderNativeArtifactsUnsupportedReason = Schema.Literal(
  "turned-off",
  "no-publishing-account",
  "host-traffic-disabled",
);
export type ProviderNativeArtifactsUnsupportedReason =
  typeof ProviderNativeArtifactsUnsupportedReason.Type;
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

/**
 * How much a thread's tool calls are guarded, from most to least. Guarded asks
 * the person; Provider review lets the provider's own reviewer answer; Full
 * access runs with no sandbox and asks nobody, as it does in the providers'
 * own apps. A thread's level is derived from its stored posture (see
 * `guardrailPolicy` in the domain), so journals written before levels existed,
 * and the retired Trusted and Off forms of Full access, replay onto it.
 */
export const GuardrailLevel = Schema.Literal("guarded", "provider-review", "full-access");
export type GuardrailLevel = typeof GuardrailLevel.Type;

/**
 * The words a person picks a thread's mode by, in picker order. Auto is
 * Provider review, Ask first and Accept edits are Guarded, Plan is the
 * read-only overlay, and Full access is Full access.
 */
export const PermissionMode = Schema.Literal(
  "auto",
  "ask-first",
  "accept-edits",
  "plan",
  "full-access",
);
export type PermissionMode = typeof PermissionMode.Type;
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
/**
 * One configuration shape for every ACP agent: its kind, the binary it runs,
 * and, for an agent whose profile lists postures, which one it signs in with.
 * The posture must be one its profile lists, and an agent whose profile lists
 * none carries no posture field.
 */
export const AcpAgentConfiguration = Schema.Struct({
  kind: Schema.Literal(...ACP_AGENT_KINDS.map(acpAgentConfigurationKind)),
  binaryPath: AbsoluteBinaryPath,
  authentication: Schema.optional(AcpAgentAuthentication),
})
  .annotations(strict)
  .pipe(
    Schema.filter((configuration) => {
      const postures = acpAgentProfile(
        acpAgentKindOfConfiguration(configuration.kind),
      ).authentication;
      return configuration.authentication === undefined
        ? postures.length === 0
        : postures.includes(configuration.authentication);
    }),
  );
export type AcpAgentConfiguration = typeof AcpAgentConfiguration.Type;

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
/**
 * An organization's own OpenID Connect issuer, exactly as its identity tokens
 * name it in `iss` (a trailing slash matters). It is the address the person
 * signs in at, so it is https with no credentials, query, or fragment.
 */
export const DirectoryIssuer = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length > 256 || !value.startsWith("https://") || /[\s?#]/.test(value)) {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
  Schema.brand("DirectoryIssuer"),
);
export type DirectoryIssuer = typeof DirectoryIssuer.Type;
/** The public client an organization registered with its own issuer. */
export const DirectoryIssuerClientId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/),
  Schema.brand("DirectoryIssuerClientId"),
);
export type DirectoryIssuerClientId = typeof DirectoryIssuerClientId.Type;
/** Identity scopes the broker requests itself; none of them names a resource. */
const DIRECTORY_IDENTITY_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "profile",
  "offline_access",
  "email",
]);
/**
 * The one scope an organization's gateway requires (an RFC 6749
 * scope-token): the resource its issuer's token is for. An identity scope
 * names no resource, so it is refused.
 */
export const DirectoryResourceScope = Schema.String.pipe(
  Schema.pattern(/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/),
  Schema.filter((value) => !DIRECTORY_IDENTITY_SCOPES.has(value)),
  Schema.brand("DirectoryResourceScope"),
);
export type DirectoryResourceScope = typeof DirectoryResourceScope.Type;
/**
 * An organization's own issuer, client, and gateway scope for a host-driven
 * sign-in to its model gateway. None of it is secret: the client is a public
 * client the organization registered with its own issuer.
 */
export const DirectoryIssuerBinding = Schema.Struct({
  issuer: DirectoryIssuer,
  clientId: DirectoryIssuerClientId,
  scope: DirectoryResourceScope,
}).annotations(strict);
export type DirectoryIssuerBinding = typeof DirectoryIssuerBinding.Type;

const OpenAiCompatibleConfigurationFields = {
  kind: Schema.Literal("openai-compatible-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
};
/**
 * `directory-oauth` signs in with the organization's own issuer in place of a
 * key and names that issuer, client, and scope. It is never also a catalog
 * subscription sign-in.
 */
export const OpenAiCompatibleProviderConfiguration = Schema.Union(
  Schema.Struct({
    ...OpenAiCompatibleConfigurationFields,
    authentication: Schema.Literal("bearer", "none"),
    /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
    oauthDescriptorId: Schema.optional(OAuthDescriptorId),
  }).annotations(strict),
  Schema.Struct({
    ...OpenAiCompatibleConfigurationFields,
    authentication: Schema.Literal("directory-oauth"),
    directory: DirectoryIssuerBinding,
  }).annotations(strict),
);
export type OpenAiCompatibleProviderConfiguration =
  typeof OpenAiCompatibleProviderConfiguration.Type;
export const AnthropicCompatibleProtocol = Schema.Literal("auto", "messages");
export type AnthropicCompatibleProtocol = typeof AnthropicCompatibleProtocol.Type;
export const AnthropicCompatibleAuthentication = Schema.Literal(
  "api-key",
  "bearer",
  "none",
  "directory-oauth",
);
export type AnthropicCompatibleAuthentication = typeof AnthropicCompatibleAuthentication.Type;
const AnthropicCompatibleConfigurationFields = {
  kind: Schema.Literal("anthropic-compatible-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  protocol: AnthropicCompatibleProtocol,
  protocolVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  manualModelIds: UniqueManualModelIds,
};
/** As the OpenAI-compatible configuration: `directory-oauth` names the issuer binding. */
export const AnthropicCompatibleProviderConfiguration = Schema.Union(
  Schema.Struct({
    ...AnthropicCompatibleConfigurationFields,
    authentication: Schema.Literal("api-key", "bearer", "none"),
    /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
    oauthDescriptorId: Schema.optional(OAuthDescriptorId),
  }).annotations(strict),
  Schema.Struct({
    ...AnthropicCompatibleConfigurationFields,
    authentication: Schema.Literal("directory-oauth"),
    directory: DirectoryIssuerBinding,
  }).annotations(strict),
);
export type AnthropicCompatibleProviderConfiguration =
  typeof AnthropicCompatibleProviderConfiguration.Type;
/**
 * A directory tenant or application (client) id, in the lowercase GUID form a
 * directory issues. A multi-tenant alias (`common`, `organizations`) or a
 * domain name is refused: it would let an account from any tenant answer the
 * sign-in, and the binding compares these values exactly.
 */
const DirectoryGuid = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
export const DirectoryTenantId = DirectoryGuid.pipe(Schema.brand("DirectoryTenantId"));
export type DirectoryTenantId = typeof DirectoryTenantId.Type;
export const DirectoryClientId = DirectoryGuid.pipe(Schema.brand("DirectoryClientId"));
export type DirectoryClientId = typeof DirectoryClientId.Type;
/**
 * The organization's own directory binding for a host-driven sign-in. Neither
 * value is secret: the client is a public client the organization registered
 * in its own tenant, so no client secret exists to store.
 */
export const DirectoryBinding = Schema.Struct({
  tenantId: DirectoryTenantId,
  clientId: DirectoryClientId,
}).annotations(strict);
export type DirectoryBinding = typeof DirectoryBinding.Type;

export const AzureFoundryAuthentication = Schema.Literal("api-key", "directory-oauth");
export type AzureFoundryAuthentication = typeof AzureFoundryAuthentication.Type;
const AzureFoundryConfigurationFields = {
  kind: Schema.Literal("azure-foundry-openai-http"),
  baseUrl: Schema.NonEmptyTrimmedString,
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
};
/**
 * `directory-oauth` signs in with the organization's directory instead of a
 * key and carries the tenant and client it binds to; an API-key instance
 * carries no directory binding.
 */
export const AzureFoundryProviderConfiguration = Schema.Union(
  Schema.Struct({
    ...AzureFoundryConfigurationFields,
    authentication: Schema.Literal("api-key"),
  }).annotations(strict),
  Schema.Struct({
    ...AzureFoundryConfigurationFields,
    authentication: Schema.Literal("directory-oauth"),
    directory: DirectoryBinding,
    /**
     * Present only when the person opted this instance in to a device-code
     * sign-in from the host-local `octant provider sign-in` command, for a
     * host without the desktop app. Absent is off: many organizations block
     * the flow, and it is the easier one to phish.
     */
    deviceCodeSignIn: Schema.optional(Schema.Literal(true)),
  }).annotations(strict),
);
export type AzureFoundryProviderConfiguration = typeof AzureFoundryProviderConfiguration.Type;

/**
 * A region of the cloud's commercial partition, such as `us-east-1`. The
 * government (`us-gov-…`), isolated (`us-iso…`), sovereign (`eusc-…`), and
 * China (`cn-…`) partitions sign in and sign requests under other hosts and
 * keys; they wait for an organization that needs one.
 */
const CLOUD_REGION = /^(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]$/;
export const CloudIamRegion = Schema.String.pipe(
  Schema.pattern(CLOUD_REGION),
  Schema.brand("CloudIamRegion"),
);
export type CloudIamRegion = typeof CloudIamRegion.Type;
/**
 * The access portal a person signs in at, exactly as the organization's
 * single sign-on instance publishes it: `https://<alias>.awsapps.com/start`
 * or `https://ssoins-<id>.portal.<region>.app.aws`. Both are the cloud's own
 * hosts, so a configuration cannot name a look-alike page.
 */
export const CloudIamStartUrl = Schema.String.pipe(
  Schema.filter(
    (value) =>
      /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.awsapps\.com\/start$/.test(value) ||
      /^https:\/\/ssoins-[0-9a-f]{16}\.portal\.(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]\.app\.aws$/.test(
        value,
      ),
  ),
  Schema.brand("CloudIamStartUrl"),
);
export type CloudIamStartUrl = typeof CloudIamStartUrl.Type;
export const CloudAccountId = Schema.String.pipe(
  Schema.pattern(/^[0-9]{12}$/),
  Schema.brand("CloudAccountId"),
);
export type CloudAccountId = typeof CloudAccountId.Type;
/** A role (permission set) name the account grants through single sign-on. */
export const CloudRoleName = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9+=,.@_-]{1,64}$/),
  Schema.brand("CloudRoleName"),
);
export type CloudRoleName = typeof CloudRoleName.Type;
/**
 * Where a `cloud-iam` instance's identity comes from: the organization's
 * single sign-on portal and region, and the one account and role the broker
 * mints temporary credentials for. None of it is secret.
 */
export const CloudIamSourceIdentity = Schema.Struct({
  startUrl: CloudIamStartUrl,
  ssoRegion: CloudIamRegion,
  accountId: CloudAccountId,
  roleName: CloudRoleName,
}).annotations(strict);
export type CloudIamSourceIdentity = typeof CloudIamSourceIdentity.Type;
/**
 * The requests a `cloud-iam` grant may sign, fixed when it is signed in. The
 * vocabulary is closed: one partition, one service, the service's own host in
 * the grant's region, one path prefix, and one method. The broker refuses to
 * sign anything outside it, so a signer that holds a grant cannot be turned
 * into a general cloud oracle.
 */
export const CloudIamSigningScope = Schema.Struct({
  partition: Schema.Literal("aws"),
  region: CloudIamRegion,
  service: Schema.Literal("bedrock"),
  host: Schema.String,
  pathPrefix: Schema.Literal("/model/"),
  method: Schema.Literal("POST"),
})
  .annotations(strict)
  .pipe(
    Schema.filter((scope) => scope.host === `bedrock-runtime.${scope.region}.amazonaws.com`, {
      description: "the host is the service's own runtime host in the scope's region",
    }),
  );
export type CloudIamSigningScope = typeof CloudIamSigningScope.Type;

/**
 * Amazon Bedrock's Converse API, signed per request by the host credential
 * broker (`cloud-iam`). The endpoint is built from the region alone, so no
 * configuration names a host; the models are the instance's own list, since
 * listing them needs a permission a model request does not. A Bedrock API key
 * stays available through an OpenAI-compatible instance.
 */
export const AmazonBedrockProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("amazon-bedrock-converse-http"),
  region: CloudIamRegion,
  authentication: Schema.Literal("cloud-iam"),
  cloudIam: CloudIamSourceIdentity,
  manualModelIds: UniqueManualModelIds.pipe(Schema.minItems(1), Schema.maxItems(64)),
}).annotations(strict);
export type AmazonBedrockProviderConfiguration = typeof AmazonBedrockProviderConfiguration.Type;

/**
 * The exact package an outside driver instance runs. The instance binds the
 * version and content digest it was added with: a package with any other
 * digest is not the driver this instance names, whatever its name.
 */
export const OutsideProviderDriverReference = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
}).annotations(strict);
export type OutsideProviderDriverReference = typeof OutsideProviderDriverReference.Type;
/**
 * Headers the key may never travel in, whatever the person chooses:
 * `proxy-authorization` is read by a proxy rather than the endpoint, and
 * `cookie`, `set-cookie`, and `host` put it where intermediaries route and log.
 */
const OUTSIDE_DRIVER_REFUSED_KEY_HEADERS: ReadonlySet<string> = new Set([
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
]);
/**
 * How the person said the key is sent: the one header, in lowercase, and
 * whether it goes as `Bearer <key>`. A brokered request carries the key only
 * when the driver asks for exactly this placement.
 */
export const OutsideDriverKeyPlacement = Schema.Struct({
  header: Schema.String.pipe(
    Schema.pattern(/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/),
    Schema.filter((header) => !OUTSIDE_DRIVER_REFUSED_KEY_HEADERS.has(header)),
  ),
  scheme: Schema.optional(Schema.Literal("Bearer")),
}).annotations(strict);
export type OutsideDriverKeyPlacement = typeof OutsideDriverKeyPlacement.Type;
/**
 * An outside harness endpoint as the person added it: the exact driver
 * package, the address its brokered requests may reach, how the key is sent
 * (absent: no key), and the models the person listed, which are the only
 * models it offers.
 */
export const OutsideHarnessEndpointProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("outside-harness-endpoint"),
  driver: OutsideProviderDriverReference,
  baseUrl: Schema.NonEmptyTrimmedString,
  key: Schema.optional(OutsideDriverKeyPlacement),
  modelIds: Schema.Array(ProviderModelId).pipe(
    Schema.minItems(1),
    Schema.maxItems(64),
    Schema.filter((modelIds) => new Set(modelIds).size === modelIds.length),
  ),
}).annotations(strict);
export type OutsideHarnessEndpointProviderConfiguration =
  typeof OutsideHarnessEndpointProviderConfiguration.Type;

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
 * Black Forest Labs FLUX endpoint-path names. BFL
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
  /** A proxy or regional endpoint in place of the provider's own. Absent means the provider's own. */
  baseUrl: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type BflImageProviderConfiguration = typeof BflImageProviderConfiguration.Type;

/**
 * Ideogram model-version endpoint-path names. Like
 * BFL, Ideogram encodes the model version in the URL path, never a body
 * field, so these are the literal path segments, not a vendor catalog Octant
 * maintains. Allowlists stay manual-entry and are never rewritten on save.
 */
export const IDEOGRAM_IMAGE_MODEL_PRESETS = ["ideogram-v3", "ideogram-v4"] as const;
export const IdeogramImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("ideogram-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
  /** A proxy or regional endpoint in place of the provider's own. Absent means the provider's own. */
  baseUrl: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .pipe(Schema.filter(imageAllowlistContainsDefault))
  .annotations(strict);
export type IdeogramImageProviderConfiguration = typeof IdeogramImageProviderConfiguration.Type;
export const ClaudeAuthentication = Schema.Literal("subscription", "api-key");
export type ClaudeAuthentication = typeof ClaudeAuthentication.Type;

export const ClaudeResumeIdentityRecord = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  octantSessionId: ProviderSessionId,
  sdkSessionId: Schema.NonEmptyString.pipe(Schema.maxLength(4096)),
  projectRoot: Schema.NonEmptyString.pipe(Schema.maxLength(16 * 1024)),
  modelId: ProviderModelId,
  authentication: ClaudeAuthentication,
}).annotations(strict);
export type ClaudeResumeIdentityRecord = typeof ClaudeResumeIdentityRecord.Type;
/** An absent identity is the durable record that a resume identity was removed. */
export const ClaudeResumeIdentityRecorded = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  octantSessionId: ProviderSessionId,
  sdkSessionId: Schema.NonEmptyString.pipe(Schema.maxLength(4096)),
  identity: Schema.optional(ClaudeResumeIdentityRecord),
}).annotations(strict);
export type ClaudeResumeIdentityRecorded = typeof ClaudeResumeIdentityRecorded.Type;
/** Closed swatch set so multi-account drivers stay distinguishable in the picker. */
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
function codexHomeBasename(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  const slash = path.lastIndexOf("/", end - 1);
  return slash === -1 ? path.slice(0, end) : path.slice(slash + 1, end);
}

const CodexHomeDirectory = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((path) => {
    if (!path.startsWith("/")) return false;
    const leaf = codexHomeBasename(path);
    return leaf !== "auth.json" && leaf !== ".auth.json";
  }),
);
export const CodexProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("codex-cli"),
  binaryPath: Schema.NonEmptyTrimmedString,
  /** Codex-owned directory for this account. Absent uses Codex's default. */
  codexHome: Schema.optional(CodexHomeDirectory),
  accent: Schema.optional(ClaudeAccountAccent),
}).annotations(strict);
export type CodexProviderConfiguration = typeof CodexProviderConfiguration.Type;
/** Linear scan. A `/+$` replace is polynomial in the trailing slashes. */
function claudeConfigDirectoryBasename(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  const slash = path.lastIndexOf("/", end - 1);
  return slash === -1 ? path.slice(0, end) : path.slice(slash + 1, end);
}

const ClaudeConfigDirectory = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((path) => {
    if (!path.startsWith("/")) return false;
    return claudeConfigDirectoryBasename(path) !== ".credentials.json";
  }),
);
export const ClaudeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("claude-agent-sdk"),
  binaryPath: Schema.NonEmptyTrimmedString,
  authentication: ClaudeAuthentication,
  /** Claude-owned directory for this account. Absent uses Claude's default. */
  configDirectory: Schema.optional(ClaudeConfigDirectory),
  accent: Schema.optional(ClaudeAccountAccent),
  /**
   * The person enabled Claude artifacts for this account: its Work and Code
   * threads may each choose Claude's own Artifact tool, which publishes to
   * their claude.ai account, instead of a Canvas. Absent is off. Only
   * `set-claude-artifact-delivery` changes it; a configuration change or a
   * new account never carries it.
   */
  artifactDelivery: Schema.optional(Schema.Literal(true)),
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

/**
 * A key provider account the person let run as itself: its own subagents,
 * web tools, skills, and home configuration load in its threads at Guarded
 * and Reviewed, as they do at Full access. Absent is off. Only
 * `set-provider-native-setup`, sent from a window on this host, changes it; a
 * configuration change or a new account never carries it.
 */
const KeyProviderInstanceFields = {
  ...ProviderInstanceFields,
  nativeSetup: Schema.optional(Schema.Literal(true)),
} as const;

export const OpenCodeProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literal("opencode"),
  configuration: OpenCodeProviderConfiguration,
}).annotations(strict);
export type OpenCodeProviderInstance = typeof OpenCodeProviderInstance.Type;
export const CodexProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literal("codex"),
  configuration: CodexProviderConfiguration,
}).annotations(strict);
export type CodexProviderInstance = typeof CodexProviderInstance.Type;
export const ClaudeProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literal("claude"),
  configuration: ClaudeProviderConfiguration,
}).annotations(strict);
export type ClaudeProviderInstance = typeof ClaudeProviderInstance.Type;
/**
 * An instance of any ACP agent; its configuration kind must match its driver
 * kind. Of the ACP agents only Mistral Vibe is a key provider, so only its
 * instance may carry `nativeSetup`.
 */
export const AcpAgentProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literal(...ACP_AGENT_KINDS),
  configuration: AcpAgentConfiguration,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (instance) =>
        instance.configuration.kind === acpAgentConfigurationKind(instance.driverKind) &&
        (instance.nativeSetup === undefined || instance.driverKind === "mistral-vibe"),
    ),
  );
export type AcpAgentProviderInstance = typeof AcpAgentProviderInstance.Type;

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

export const AmazonBedrockProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("amazon-bedrock"),
  configuration: AmazonBedrockProviderConfiguration,
}).annotations(strict);
export type AmazonBedrockProviderInstance = typeof AmazonBedrockProviderInstance.Type;

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

/**
 * The host's hold on an outside instance's driver at one digest. The process
 * owner sets it when the driver crashes past its limit (a third crash within
 * a minute). It is journaled, so a host restart does not hand the driver a
 * fresh crash budget, and it is not configuration: no command sets or clears
 * it. Only binding another digest leaves it behind.
 */
export const OutsideDriverQuarantine = Schema.Struct({
  reason: Schema.Literal("crash-limit"),
  digest: ExtensionContentDigest,
  quarantinedAt: UtcTimestamp,
}).annotations(strict);
export type OutsideDriverQuarantine = typeof OutsideDriverQuarantine.Type;

export const OutsideHarnessEndpointProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("outside-harness-endpoint"),
  configuration: OutsideHarnessEndpointProviderConfiguration,
  driverQuarantine: Schema.optional(OutsideDriverQuarantine),
}).annotations(strict);
export type OutsideHarnessEndpointProviderInstance =
  typeof OutsideHarnessEndpointProviderInstance.Type;

export const ProviderInstance = Schema.Union(
  OpenCodeProviderInstance,
  CodexProviderInstance,
  ClaudeProviderInstance,
  AcpAgentProviderInstance,
  PiProviderInstance,
  OhMyPiProviderInstance,
  OllamaProviderInstance,
  OpenAiCompatibleProviderInstance,
  AnthropicCompatibleProviderInstance,
  AzureFoundryProviderInstance,
  AmazonBedrockProviderInstance,
  OpenAiImageProviderInstance,
  GeminiImageProviderInstance,
  BflImageProviderInstance,
  IdeogramImageProviderInstance,
  OutsideHarnessEndpointProviderInstance,
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
/**
 * Kimi Code changed its binary through this event before ACP agents took
 * configuration commands; the journal still holds those events, so they
 * decode. No other ACP agent ever recorded one.
 */
const KimiCodeBinaryChangedInstance = AcpAgentProviderInstance.pipe(
  Schema.filter((instance) => instance.driverKind === "kimi-code"),
);
export const ProviderInstanceBinaryChanged = Schema.Struct({
  instance: Schema.Union(
    OpenCodeProviderInstance,
    CodexProviderInstance,
    KimiCodeBinaryChangedInstance,
  ),
}).annotations(strict);
export type ProviderInstanceBinaryChanged = typeof ProviderInstanceBinaryChanged.Type;
export const ProviderInstanceConfigurationChanged = Schema.Struct({
  instance: Schema.Union(
    OpenAiCompatibleProviderInstance,
    AnthropicCompatibleProviderInstance,
    AzureFoundryProviderInstance,
    AmazonBedrockProviderInstance,
    OpenAiImageProviderInstance,
    GeminiImageProviderInstance,
    BflImageProviderInstance,
    IdeogramImageProviderInstance,
    ClaudeProviderInstance,
    AcpAgentProviderInstance,
    PiProviderInstance,
    OhMyPiProviderInstance,
    OllamaProviderInstance,
    OutsideHarnessEndpointProviderInstance,
  ),
}).annotations(strict);
export type ProviderInstanceConfigurationChanged = typeof ProviderInstanceConfigurationChanged.Type;
/**
 * An outside instance moved to another digest of its own driver. Only the host
 * writes it, once the person has trusted that digest; the person's own change
 * of the instance's address, key placement, or models travels in
 * `provider.instance-configuration-changed@1`, which keeps the driver as bound.
 */
export const ProviderInstanceDriverRebound = Schema.Struct({
  instance: OutsideHarnessEndpointProviderInstance,
}).annotations(strict);
export type ProviderInstanceDriverRebound = typeof ProviderInstanceDriverRebound.Type;
/**
 * An outside instance's driver crashed past its limit and is held at the
 * digest it binds. Only the host writes it; the instance it carries holds the
 * quarantine.
 */
export const ProviderInstanceDriverQuarantined = Schema.Struct({
  instance: OutsideHarnessEndpointProviderInstance.pipe(
    Schema.filter((instance) => instance.driverQuarantine !== undefined),
  ),
}).annotations(strict);
export type ProviderInstanceDriverQuarantined = typeof ProviderInstanceDriverQuarantined.Type;
export const ProviderInstanceDataTagsChanged = Schema.Struct({
  instance: ProviderInstance,
}).annotations(strict);
export type ProviderInstanceDataTagsChanged = typeof ProviderInstanceDataTagsChanged.Type;
export const ProviderInstanceEnabledChanged = Schema.Struct({
  instance: ProviderInstance,
}).annotations(strict);
export type ProviderInstanceEnabledChanged = typeof ProviderInstanceEnabledChanged.Type;
/** A person turned a key provider account's own setup on or off from a local window. */
export const ProviderInstanceNativeSetupChanged = Schema.Struct({
  instance: Schema.Union(
    OpenCodeProviderInstance,
    CodexProviderInstance,
    ClaudeProviderInstance,
    AcpAgentProviderInstance.pipe(
      Schema.filter((instance) => instance.driverKind === "mistral-vibe"),
    ),
  ),
}).annotations(strict);
export type ProviderInstanceNativeSetupChanged = typeof ProviderInstanceNativeSetupChanged.Type;
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
  "provider.instance-driver-rebound@1",
  "provider.instance-driver-quarantined@1",
  "provider.instance-data-tags-changed@1",
  "provider.instance-enabled-changed@1",
  "provider.instance-native-setup-changed@1",
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
   * The longest window the model was trained for, when its runtime names it
   * apart from the window it reports for use. A runtime that never loads more
   * (Ollama clamps `num_ctx` to it) makes it the ceiling on the override.
   */
  trainedContextWindow: Schema.optional(PositiveInt),
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
  /**
   * Whether one session's runtime process can be killed on its own, through
   * the connection's `forceStop`. A runtime that serves several threads from
   * one process reports `unsupported`, since killing it would end the others.
   * Absent reads as unsupported.
   */
  forceStop: Schema.optional(ProviderCapabilitySupport),
  /**
   * Whether the runtime compacts a session it holds when asked, per mode,
   * through the connection's `compact`: `unavailable` when this install is too
   * old for the request. Absent reads as unsupported in every mode. A host
   * that plans a mode's conversation itself compacts it without the runtime,
   * so this answers only for the sessions the runtime keeps.
   */
  sessionCompaction: Schema.optional(
    Schema.Struct({
      chat: ProviderCapabilitySupport,
      work: ProviderCapabilitySupport,
      code: ProviderCapabilitySupport,
    }).annotations(strict),
  ),
  citations: ProviderCapabilitySupport,
  harnessAutoReview: ProviderCapabilitySupport,
  /**
   * Whether a thread may choose the runtime's own tool that publishes a
   * document to the person's account with the model's provider, outside this
   * host, per mode. Absent reads as unsupported in every mode. Supported means
   * the person enabled it for this account and nothing on the host keeps it
   * off; the runtime may still leave the tool out of a session (the
   * provider's own plan checks), and such a turn delivers a Canvas instead.
   * `unsupportedReason` says why Work and Code read unsupported.
   */
  nativeArtifacts: Schema.optional(
    Schema.Struct({
      chat: ProviderCapabilitySupport,
      work: ProviderCapabilitySupport,
      code: ProviderCapabilitySupport,
      unsupportedReason: Schema.optional(ProviderNativeArtifactsUnsupportedReason),
    }).annotations(strict),
  ),
  /**
   * Which of its own features a key provider's driver can turn on when a
   * session's `nativeSetup` asks for them. Absent reads as unsupported for
   * every feature, which is every provider that is not a key provider.
   * Supported says the driver loads the feature and Octant still sees what it
   * does (a native child run, a native web read); it does not say the person
   * turned it on.
   */
  nativeSetup: Schema.optional(
    Schema.Struct({
      subagents: ProviderCapabilitySupport,
      webTools: ProviderCapabilitySupport,
      skills: ProviderCapabilitySupport,
      toolServers: ProviderCapabilitySupport,
      hooks: ProviderCapabilitySupport,
      projectCode: ProviderCapabilitySupport,
    }).annotations(strict),
  ),
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
 * `driver-not-admitted`: the instance's driver package is not effective on the
 * activation ladder, so the instance contributes no models or capabilities.
 * `driver-incompatible`: an outside driver agreed no protocol version with the
 * host or wrote a message the host could not read, so the host stopped it and
 * the instance contributes nothing.
 */
export const ProviderRefusalReason = Schema.Literal(
  "runtime-incompatible",
  "authentication-required",
  "runtime-unavailable",
  "no-usable-model",
  "driver-not-admitted",
  "driver-incompatible",
);
export type ProviderRefusalReason = typeof ProviderRefusalReason.Type;

/**
 * How Octant's own tools reach a runtime's session. Every transport is owned by
 * the provider connection and lives only as long as that session; none writes
 * the provider's MCP or hook configuration.
 *
 * - `request-tool-calls`: a direct endpoint receives the tool definitions in
 *   each request and answers with structured tool calls.
 * - `sdk-tool-server`: an in-process tool server the provider SDK connection
 *   owns.
 * - `app-server-dynamic-tools`: tools registered on the app-server thread when
 *   it starts.
 * - `session-mcp-bridge`: a loopback HTTP MCP server registered with one
 *   session.
 * - `session-tool-bridge`: a loopback bridge the runtime's own extension calls
 *   for one session.
 */
export const ProviderToolTransport = Schema.Literal(
  "request-tool-calls",
  "sdk-tool-server",
  "app-server-dynamic-tools",
  "session-mcp-bridge",
  "session-tool-bridge",
);
export type ProviderToolTransport = typeof ProviderToolTransport.Type;

/**
 * Why Octant's tools are not available on a runtime. `not-confirmed`: the last
 * connection check did not establish it either way. `model-verification-required`:
 * a direct endpoint offers tools only to models a person verified.
 * `runtime-not-confirmed`: the transport exists, but this runtime's version,
 * platform, or setup did not confirm it. `no-transport`: Octant has no way to
 * offer its tools to this runtime.
 */
export const ProviderToolsUnavailableReason = Schema.Literal(
  "not-confirmed",
  "model-verification-required",
  "runtime-not-confirmed",
  "no-transport",
);
export type ProviderToolsUnavailableReason = typeof ProviderToolsUnavailableReason.Type;

/** What a live session reports while a turn runs. */
export const ProviderObservedActivity = Schema.Literal(
  "replies",
  "tool-calls",
  "approvals",
  "file-changes",
  "task-progress",
);
export type ProviderObservedActivity = typeof ProviderObservedActivity.Type;

/**
 * How a follow-up continues an earlier conversation. `precise`: the runtime
 * reopens its own session by id. `best-effort`: the endpoint holds no session,
 * so Octant sends the thread's history from its journal again, fitted to the
 * model's context window. `none`: the runtime cannot continue a previous
 * session.
 */
export const ProviderResumeQuality = Schema.Literal("precise", "best-effort", "none");
export type ProviderResumeQuality = typeof ProviderResumeQuality.Type;

/**
 * Whether a runtime reports what its turns occupy and spend. `reported`: its
 * turns carry usage, so a thread can show a context window. `not-reported`:
 * the driver declares it never reports usage (ACP agents), so a thread on it
 * shows no window and a spend ceiling leaves its turns out. `not-confirmed`:
 * the last connection check did not establish it.
 */
export const ProviderUsageReporting = Schema.Literal("reported", "not-reported", "not-confirmed");
export type ProviderUsageReporting = typeof ProviderUsageReporting.Type;

/**
 * Who can compact a thread's conversation when a person asks. `octant`: the
 * host plans the conversation from its journal and summarizes it itself.
 * `runtime`: the runtime keeps the conversation and takes a compaction request
 * in at least one mode. `runtime-update-required`: it would, but this install
 * is too old. `none`: the runtime keeps the conversation and Octant has no
 * compaction request for it (ACP agents), so what it keeps or drops is its own
 * and Octant cannot see or change it. `not-confirmed`: the runtime is not
 * ready, so its last check did not say whether it compacts.
 */
export const ProviderCompactionOwner = Schema.Literal(
  "octant",
  "runtime",
  "runtime-update-required",
  "none",
  "not-confirmed",
);
export type ProviderCompactionOwner = typeof ProviderCompactionOwner.Type;

/**
 * The integration a runtime actually has, derived by the server from the
 * driver and its last connection check so a client never guesses it.
 * `activity.source` reuses the fleet vocabulary: `session` is a live provider
 * session the host holds and journals; `none` means no session runs here, so
 * nothing is observed.
 */
export const ProviderRuntimeIntegration = Schema.Struct({
  tools: Schema.Union(
    Schema.Struct({
      status: Schema.Literal("available"),
      transport: ProviderToolTransport,
    }).annotations(strict),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      transport: Schema.optional(ProviderToolTransport),
      reason: ProviderToolsUnavailableReason,
    }).annotations(strict),
  ),
  activity: Schema.Union(
    Schema.Struct({
      source: Schema.Literal("session"),
      observes: Schema.Array(ProviderObservedActivity).pipe(
        Schema.filter((values) => new Set(values).size === values.length),
      ),
    }).annotations(strict),
    Schema.Struct({ source: Schema.Literal("none") }).annotations(strict),
  ),
  resume: ProviderResumeQuality,
  context: Schema.Struct({
    usage: ProviderUsageReporting,
    compaction: ProviderCompactionOwner,
  }).annotations(strict),
}).annotations(strict);
export type ProviderRuntimeIntegration = typeof ProviderRuntimeIntegration.Type;

/**
 * Why a host-driven sign-in reads `unauthenticated`, so Settings can tell a
 * sign-in that ended from one the organization wants repeated in person, or
 * from an account with no role on the endpoint.
 */
export const ProviderUnauthenticatedReason = Schema.Literal(
  "missing",
  "expired",
  "revoked",
  "interaction-required",
  "not-authorized",
);
export type ProviderUnauthenticatedReason = typeof ProviderUnauthenticatedReason.Type;

/**
 * The directory binding a probe checked before it asked for a token: a tenant
 * of the closed directory, or an organization's own issuer. None of it is
 * secret.
 */
export const ProviderObservedDirectoryBinding = Schema.Union(
  Schema.Struct({
    tenantId: DirectoryTenantId,
    clientId: DirectoryClientId,
    endpointOrigin: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    issuer: DirectoryIssuer,
    clientId: DirectoryIssuerClientId,
    endpointOrigin: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type ProviderObservedDirectoryBinding = typeof ProviderObservedDirectoryBinding.Type;

/**
 * The kind of account a provider's own app reports it is signed in with, in
 * one vocabulary for every driver. Only `subscription` is a person's plan
 * sign-in; `other` is an account the driver cannot name as any of the rest.
 */
export const ProviderAccountAuthentication = Schema.Literal(
  "subscription",
  "api-key",
  "none",
  "other",
);
export type ProviderAccountAuthentication = typeof ProviderAccountAuthentication.Type;

export const ProviderObservedState = Schema.Struct({
  instanceId: ProviderInstanceId,
  readiness: ProviderReadiness,
  processState: ProviderProcessState,
  /** What the probe found the account to be; absent when the driver does not say. */
  accountAuthentication: Schema.optional(ProviderAccountAuthentication),
  detectedVersion: Schema.optional(Schema.NonEmptyTrimmedString),
  observedProtocol: Schema.optional(OpenAiCompatibleProtocol),
  credentialStatus: Schema.optional(ProviderCredentialStatus),
  /** Present only with `unauthenticated` readiness, when the driver knows why. */
  unauthenticatedReason: Schema.optional(ProviderUnauthenticatedReason),
  /** Present only for a directory sign-in: the binding its probe checked. */
  directoryBinding: Schema.optional(ProviderObservedDirectoryBinding),
  models: Schema.Array(ProviderModel),
  capabilities: ProviderCapabilities,
  // Models a person explicitly verified for tool support through the
  // verify-model-tools command, on any endpoint profile (OpenAI-compatible,
  // Anthropic-compatible, Azure AI Foundry). The sender gates tool requests
  // per model against this set as well as the provider-level appManagedTools
  // flag, so one verified model does not unlock tools for the other models
  // of the same profile.
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  /**
   * Attached by the server when it reports a runtime to a client; a driver
   * never sets it. Absent for image profiles, which run no turns.
   */
  integration: Schema.optional(ProviderRuntimeIntegration),
  message: Schema.optional(Schema.NonEmptyTrimmedString),
  reason: Schema.optional(ProviderRefusalReason),
  diagnostic: Schema.optional(ProviderProcessDiagnostic),
  lastSuccessfulProbeAt: Schema.optional(UtcTimestamp),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ProviderObservedState = typeof ProviderObservedState.Type;

/**
 * One outside driver the activation ladder admits on this host, as the
 * provider catalog lists it: the exact package a provider would bind, the
 * package's own name, and the package facts the catalog repeats. Only a
 * local folder or an npm package yields a driver. A folder is developer input,
 * unsigned unless it carries a signature the host verified; an npm package is
 * always signed. The verified key is `publisherKey`, and `npm` is where the host
 * fetched an npm package from.
 */
export const OutsideProviderDriverListing = Schema.Struct({
  driver: OutsideProviderDriverReference,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  source: Schema.Literal("local-folder", "npm"),
  npm: Schema.optional(ExtensionNpmSource),
  installed: Schema.Boolean,
  trusted: Schema.Boolean,
  publisherKey: Schema.optional(ExtensionPublisherKeyFingerprint),
}).annotations(strict);
export type OutsideProviderDriverListing = typeof OutsideProviderDriverListing.Type;

export const ProviderRegistrySnapshot = Schema.Struct({
  instances: Schema.Array(ProviderInstance),
  defaults: ProviderDefaults,
  observedStates: Schema.Array(ProviderObservedState),
  catalogs: Schema.optional(Schema.Array(ProviderCatalogSnapshot)),
  /** Absent from a host that admits no outside driver. */
  outsideDrivers: Schema.optional(
    Schema.Array(OutsideProviderDriverListing).pipe(Schema.maxItems(256)),
  ),
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

export type AcpAgentCreateCommandKind = `create-${AcpAgentKind}-provider`;
export type AcpAgentChangeCommandKind = `change-${AcpAgentKind}-configuration`;

export function acpAgentCreateCommandKind(kind: AcpAgentKind): AcpAgentCreateCommandKind {
  return `create-${kind}-provider`;
}

export function acpAgentChangeCommandKind(kind: AcpAgentKind): AcpAgentChangeCommandKind {
  return `change-${kind}-configuration`;
}

/**
 * Every ACP agent is created and reconfigured through commands named for its
 * driver kind that carry the shared configuration shape. The configuration
 * must name the same agent as the command.
 */
export const CreateAcpAgentProviderCommand = Schema.Struct({
  kind: Schema.Literal(...ACP_AGENT_KINDS.map(acpAgentCreateCommandKind)),
  ...CreateProviderCommandFields,
  displayName: Schema.NonEmptyTrimmedString,
  configuration: AcpAgentConfiguration,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (command) =>
        command.kind ===
        acpAgentCreateCommandKind(acpAgentKindOfConfiguration(command.configuration.kind)),
    ),
  );
export type CreateAcpAgentProviderCommand = typeof CreateAcpAgentProviderCommand.Type;

export const ChangeAcpAgentConfigurationCommand = Schema.Struct({
  kind: Schema.Literal(...ACP_AGENT_KINDS.map(acpAgentChangeCommandKind)),
  ...ProviderInstanceCommandFields,
  configuration: AcpAgentConfiguration,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (command) =>
        command.kind ===
        acpAgentChangeCommandKind(acpAgentKindOfConfiguration(command.configuration.kind)),
    ),
  );
export type ChangeAcpAgentConfigurationCommand = typeof ChangeAcpAgentConfigurationCommand.Type;

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
    kind: Schema.Literal("create-amazon-bedrock-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: AmazonBedrockProviderConfiguration,
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
    accent: Schema.optional(ClaudeAccountAccent),
  }).annotations(strict),
  CreateAcpAgentProviderCommand,
  Schema.Struct({
    kind: Schema.Literal("create-claude-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: ClaudeProviderConfiguration,
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
  /**
   * Adds a provider from an admitted outside driver. It takes no `enabled`:
   * the instance is created off, and nothing starts the driver until the
   * person turns it on and checks the connection.
   */
  Schema.Struct({
    kind: Schema.Literal("create-outside-harness-endpoint-provider"),
    ...ProviderInstanceCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OutsideHarnessEndpointProviderConfiguration,
  }).annotations(strict),
  /**
   * Changes the address, key placement, or listed models of an outside
   * provider. The configuration must name the driver the provider already
   * binds, exactly; it never installs, trusts, enables, or switches a driver.
   */
  Schema.Struct({
    kind: Schema.Literal("change-outside-harness-endpoint-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideHarnessEndpointProviderConfiguration,
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
    kind: Schema.Literal("change-amazon-bedrock-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AmazonBedrockProviderConfiguration,
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
    /** Replaces a legacy custom directory with Octant's assigned leaf. */
    reassignAccountDirectory: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-codex-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: CodexProviderConfiguration,
    /** Replaces a leftover custom directory with Octant's assigned leaf. */
    reassignAccountDirectory: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  ChangeAcpAgentConfigurationCommand,
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
  /**
   * Enables or disables Claude artifacts for one Claude account. Only a person
   * at the Octant window on this host sends it.
   */
  Schema.Struct({
    kind: Schema.Literal("set-claude-artifact-delivery"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }).annotations(strict),
  /**
   * Lets one key provider account run as itself, or turns that off. Only a
   * person at the Octant window on this host sends it.
   */
  Schema.Struct({
    kind: Schema.Literal("set-provider-native-setup"),
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
    kind: Schema.Literal("check-provider-latest-version"),
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
    kind: Schema.Literal("provider-latest-version"),
    instanceId: ProviderInstanceId,
    /** Absent when the check is off, offline, or the provider has no sanctioned source. */
    latestVersion: Schema.optional(Schema.NonEmptyTrimmedString),
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

export const MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH = 8_192;

/**
 * The pending call an approval request is about, as the runtime described it:
 * its tool, the argument fields a reviewer judges as bounded JSON with
 * credentials redacted, and where it runs. It never carries the call's output.
 * A driver hands it to the host through `ProviderConnection.approvalCall` for
 * an automatic reviewer only: it is never put on an event, journaled, or
 * shown.
 */
export const ProviderApprovalCall = Schema.Struct({
  tool: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  input: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH)),
  ),
  workingDirectory: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096))),
}).annotations(strict);
export type ProviderApprovalCall = typeof ProviderApprovalCall.Type;

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
  /**
   * The runtime is running one of its own tools that puts outside content in
   * front of the model: its built-in web search or page fetch, or a tool the
   * model's provider runs on its own servers (`hosted-tool`). Octant never
   * sees the result, so the adapter sends this when it first learns of the
   * call; a call that later fails, is denied, or is cancelled may still have
   * handed the model a page. `target` is the query or address, reduced by the
   * adapter to one bounded line, when the runtime reported one. It never
   * carries page content. A driver may send it whether or not it reports tool
   * activity.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("outside-content-read"),
    toolCallId: Schema.NonEmptyTrimmedString,
    /** The runtime's own name for the tool. */
    toolName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
    source: Schema.Literal("web-search", "web-fetch", "hosted-tool"),
    target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))),
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
    /**
     * The page the tool published outside this host, when it is a tool whose
     * whole result is such a page (a Claude artifact). Only the address and
     * title cross; the adapter checks the address belongs to the service the
     * tool publishes to.
     */
    published: Schema.optional(ThreadPublishedPage),
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
    /** Host estimate across known request boundaries; null means incomplete/unpriced. */
    estimatedCostUsd: Schema.optional(
      Schema.NullOr(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())),
    ),
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
    /** Extra-usage posture the process reported with this window, when it did. */
    overage: Schema.optional(
      Schema.Struct({
        status: Schema.Literal("allowed", "warning", "exhausted"),
        inUse: Schema.optional(Schema.Boolean),
        resetsAt: Schema.optional(UtcTimestamp),
        disabledReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
      }).annotations(strict),
    ),
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
  /**
   * The runtime compacted the session's window: `requested` when the
   * connection's `compact` asked for it, `automatic` when the runtime did it
   * by itself. Token figures are present only when the runtime reported them.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("context-compacted"),
    trigger: Schema.Literal("requested", "automatic"),
    tokensBefore: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    tokensAfter: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  }).annotations(strict),
  /**
   * The provider's stream is still moving but has nothing a person can see
   * yet: a tool call's input is being written, or a keep-alive arrived. It
   * carries no content. The turn runners count it as activity so a long tool
   * call is not mistaken for silence; every other consumer ignores it, and it
   * never reaches a transcript, the journal, usage, or a turn's event budget.
   * An adapter sends it at most once every few seconds.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("liveness"),
  }).annotations(strict),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-progress"),
    taskId: Schema.NonEmptyTrimmedString,
    status: Schema.Literal("pending", "in-progress", "completed", "failed"),
    summary: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  /**
   * The provider restated its whole plan: the turn's tasks are now exactly
   * these ids, in this order. It follows the restatement's `task-progress`
   * events, so a task the provider dropped leaves the panel and a moved one
   * moves. A provider that only reports single tasks never sends it.
   */
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-list"),
    taskIds: Schema.Array(Schema.NonEmptyTrimmedString),
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
export const decodeDirectoryTenantId = Schema.decodeUnknownSync(DirectoryTenantId);
export const decodeDirectoryClientId = Schema.decodeUnknownSync(DirectoryClientId);
export const decodeDirectoryIssuer = Schema.decodeUnknownSync(DirectoryIssuer);
export const decodeDirectoryIssuerClientId = Schema.decodeUnknownSync(DirectoryIssuerClientId);
export const decodeDirectoryResourceScope = Schema.decodeUnknownSync(DirectoryResourceScope);
export const decodeCloudIamRegion = Schema.decodeUnknownSync(CloudIamRegion);
export const decodeCloudIamStartUrl = Schema.decodeUnknownSync(CloudIamStartUrl);
export const decodeCloudAccountId = Schema.decodeUnknownSync(CloudAccountId);
export const decodeCloudRoleName = Schema.decodeUnknownSync(CloudRoleName);
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
export const decodeProviderInstanceDriverRebound = Schema.decodeUnknownSync(
  ProviderInstanceDriverRebound,
);
export const decodeProviderInstanceDriverQuarantined = Schema.decodeUnknownSync(
  ProviderInstanceDriverQuarantined,
);
export const decodeProviderInstanceEnabledChanged = Schema.decodeUnknownSync(
  ProviderInstanceEnabledChanged,
);
export const decodeProviderInstanceNativeSetupChanged = Schema.decodeUnknownSync(
  ProviderInstanceNativeSetupChanged,
);
export const decodeProviderNativeSetup = Schema.decodeUnknownSync(ProviderNativeSetup);
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
export const decodeClaudeResumeIdentityRecorded = Schema.decodeUnknownSync(
  ClaudeResumeIdentityRecorded,
);
