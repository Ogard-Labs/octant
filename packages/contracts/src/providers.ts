import { OwnerApprovalAction } from "./providerApprovalAction";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { Schema } from "effect";
import { Questionnaire } from "./questionnaire";
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
import { ThreadForgeReferences, ThreadPublishedPage } from "./threadToolSteps";
import { MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS } from "./threadToolCallRecords";
import {
  ACP_AGENT_KINDS,
  AcpAgentAuthentication,
  acpAgentConfigurationKind,
  acpAgentKindOfConfiguration,
  acpAgentProfile,
  type AcpAgentKind,
} from "./acpAgentProfiles";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const brandedString = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand<B>(brand));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

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
  /**
   * The turn this change released: the thread's latest turn had stopped on
   * its account's usage limit, and moving off that account means the stop no
   * longer holds the thread. The turn keeps its limit in history; the queue,
   * the host's admission and the composer read this to stop waiting on it.
   */
  releasedStopId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  /**
   * Set when the host moved a coordinator's running worker on to its role's
   * next model because its own stopped: the host-written reason, naming the
   * old and new model and account and why. The transcript shows it where
   * the move happened, whether or not the turn that continues the work was
   * admitted.
   */
  continuedOnFallback: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  ),
});
export type ThreadProviderHandoff = typeof ThreadProviderHandoff.Type;

/**
 * The closed driver vocabulary. ACP agents join it through their profile row
 * in `acpAgentProfiles.ts`; every other driver is named here.
 */
export const ProviderDriverKind = Schema.Literals([
  "codex",
  "claude",
  "opencode",
  "pi",
  "oh-my-pi",
  "ollama",
  ...ACP_AGENT_KINDS,
  "acp-agent",
  "openai-compatible",
  "anthropic-compatible",
  "azure-foundry",
  "amazon-bedrock",
  "openai-image",
  "gemini-native-image",
  "bfl-image",
  "ideogram-image",
  "gemini-video",
  "runway-video",
  "fal-video",
  "outside-harness-endpoint",
  "outside-image",
  "outside-video",
]);
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

/**
 * The key providers: the runtimes that run inside Octant as they run on their
 * own, with their own subagents, web tools, skills, configuration, and a
 * trusted Project's code, once the person allows it. Every ACP agent is one
 * (maintainer decision, 2026-11-14): each reports in its `nativeSetup`
 * capability which of those features its launch can load.
 */
export const KEY_PROVIDER_DRIVER_KINDS = [
  "claude",
  "codex",
  "opencode",
  ...ACP_AGENT_KINDS,
] as const;
export const KeyProviderDriverKind = Schema.Literals(KEY_PROVIDER_DRIVER_KINDS);
export type KeyProviderDriverKind = typeof KeyProviderDriverKind.Type;
export const KeyProviderDriverKinds = Schema.Array(KeyProviderDriverKind).check(
  Schema.makeFilter(
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
});
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
export const ProviderDataTag = Schema.Literals(["eu", "zdr"]);
export type ProviderDataTag = typeof ProviderDataTag.Type;
export const ProviderDataTags = Schema.Array(ProviderDataTag).check(
  Schema.makeFilter((tags) => new Set(tags).size === tags.length && tags.length <= 2),
);
export type ProviderDataTags = typeof ProviderDataTags.Type;

export const ProviderCapabilitySupport = Schema.Literals([
  "supported",
  "unsupported",
  "unavailable",
]);
export type ProviderCapabilitySupport = typeof ProviderCapabilitySupport.Type;
/**
 * Why a runtime's own artifact tool is not available to an account's threads:
 * the person has not enabled it (`turned-off`), the account signs in with no
 * account to publish to (`no-publishing-account`), or the host's own switch
 * for the runtime's non-essential traffic keeps it off
 * (`host-traffic-disabled`).
 */
export const ProviderNativeArtifactsUnsupportedReason = Schema.Literals([
  "turned-off",
  "no-publishing-account",
  "host-traffic-disabled",
]);
export type ProviderNativeArtifactsUnsupportedReason =
  typeof ProviderNativeArtifactsUnsupportedReason.Type;
export const ProviderInputModality = Schema.Literals(["text", "image", "audio", "document"]);
export type ProviderInputModality = typeof ProviderInputModality.Type;
const UniqueInputModalities = Schema.Array(ProviderInputModality).check(
  Schema.makeFilter(
    (modalities) =>
      modalities.length > 0 &&
      modalities.length <= 4 &&
      new Set(modalities).size === modalities.length,
  ),
);
const ProviderPromptText = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000_000));
const BoundedProviderJson = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length === 0 || value.length > 65_536) return false;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }),
);
const BoundedProviderSnippet = Schema.String.check(Schema.isMaxLength(4_096));
const BoundedProviderUrl = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
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
const BoundedProviderTitle = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const BoundedProviderQuery = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048));
const BoundedProviderRequestId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const BoundedProviderToolName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const BoundedProviderToolDescription = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
);
const BoundedProviderAttachmentId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);
const BoundedProviderDisplayName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
);
const BoundedProviderMediaType = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255));
const BoundedProviderContextKey = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);

/**
 * One answer a provider offers for a question it asked: what the person picks,
 * and what that choice means. The description is what makes a question
 * answerable without guessing; a provider that gives none offers bare labels.
 */
export const ProviderQuestionOption = Schema.Struct({
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  description: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  ),
});
export type ProviderQuestionOption = typeof ProviderQuestionOption.Type;
const MAX_PROVIDER_JSON_BYTES = 65_536;
const MAX_PROVIDER_JSON_DEPTH = 16;
const MAX_PROVIDER_JSON_ENTRIES = 256;
const MAX_PROVIDER_JSON_KEY_LENGTH = 128;
const MAX_PROVIDER_JSON_STRING_LENGTH = 4_096;
const MAX_PROVIDER_ATTACHMENT_BYTES = 26_214_400;
export const MAX_PROVIDER_ATTACHMENTS = 16;
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
export const ProviderExecutionPolicy = Schema.Literals([
  "full-access",
  "auto-accept-edits",
  "approval-gated",
  "plan",
]);
export type ProviderExecutionPolicy = typeof ProviderExecutionPolicy.Type;

/**
 * How much a thread's tool calls are guarded, from most to least. Guarded asks
 * the person; Provider review lets the provider's own reviewer answer; Full
 * access runs with no sandbox and asks nobody, as it does in the providers'
 * own apps. A thread's level is derived from its stored posture (see
 * `guardrailPolicy` in the domain), so journals written before levels existed,
 * and the retired Trusted and Off forms of Full access, replay onto it.
 */
export const GuardrailLevel = Schema.Literals(["guarded", "provider-review", "full-access"]);
export type GuardrailLevel = typeof GuardrailLevel.Type;

/**
 * The words a person picks a thread's mode by, in picker order. Auto is
 * Provider review, Ask first and Accept edits are Guarded, Plan is the
 * read-only overlay, and Full access is Full access.
 */
export const PermissionMode = Schema.Literals([
  "auto",
  "ask-first",
  "accept-edits",
  "plan",
  "full-access",
]);
export type PermissionMode = typeof PermissionMode.Type;
export const PermissionPersistence = Schema.Literals(["current-session", "project-default"]);
export type PermissionPersistence = typeof PermissionPersistence.Type;
export const ProviderReadiness = Schema.Literals([
  "ready",
  "unavailable",
  "unauthenticated",
  "incompatible",
  "degraded",
  "checking",
]);
export type ProviderReadiness = typeof ProviderReadiness.Type;
export const ProviderProcessState = Schema.Literals(["stopped", "starting", "running", "stopping"]);
export type ProviderProcessState = typeof ProviderProcessState.Type;

export const OpenCodeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("opencode-cli"),
  binaryPath: NonEmptyTrimmedString,
});
export type OpenCodeProviderConfiguration = typeof OpenCodeProviderConfiguration.Type;

const AbsoluteBinaryPath = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => path.startsWith("/")),
);
/**
 * The Google Cloud project and location an `agent-platform` instance signs in
 * to, as Google documents them for `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION`: a project id (or a domain-scoped `example.com:id`)
 * and a region such as `us-central1` or `global`. Neither is a secret; the
 * credentials are the host's own Application Default Credentials.
 */
export const AcpAgentGoogleCloud = Schema.Struct({
  project: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z0-9][a-z0-9.:-]*$/u),
  ),
  location: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u),
  ),
});
export type AcpAgentGoogleCloud = typeof AcpAgentGoogleCloud.Type;

/**
 * One configuration shape for every ACP agent: its kind, the binary it runs,
 * and, for an agent whose profile lists postures, which one it signs in with.
 * The posture must be one its profile lists, and an agent whose profile lists
 * none carries no posture field; one that declares a personal sign-in may
 * also carry none, which is that sign-in. `googleCloud` travels with the
 * `agent-platform` posture and with nothing else.
 */
export const AcpAgentConfiguration = Schema.Struct({
  kind: Schema.Literals(ACP_AGENT_KINDS.map(acpAgentConfigurationKind)),
  binaryPath: AbsoluteBinaryPath,
  authentication: Schema.optional(AcpAgentAuthentication),
  googleCloud: Schema.optional(AcpAgentGoogleCloud),
}).check(
  Schema.makeFilter((configuration) => {
    const profile = acpAgentProfile(acpAgentKindOfConfiguration(configuration.kind));
    const postures = profile.authentication;
    const posture =
      configuration.authentication === undefined
        ? postures.length === 0 || profile.personalSignIn !== undefined
        : postures.includes(configuration.authentication);
    return (
      posture &&
      (configuration.authentication === "agent-platform") ===
        (configuration.googleCloud !== undefined)
    );
  }),
);
export type AcpAgentConfiguration = typeof AcpAgentConfiguration.Type;

// oxlint-disable-next-line no-control-regex -- an added agent's argv refuses control characters.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const AcpAgentArgument = Schema.String.check(
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => !CONTROL_CHARACTER.test(value)),
);
export const AcpAgentArguments = Schema.Array(AcpAgentArgument).check(Schema.isMaxLength(32));
export const AcpRegistryAgentId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
);

/**
 * How the install step vouched for the executable an added agent runs:
 * `package-manager` (npm or uv installed the exact pinned release),
 * `sha256-verified` (the archive matched the ACP registry's checksum),
 * `unverified-download` (the registry lists no checksum; only HTTPS vouched
 * for it), or `local-command` (the person's own executable).
 */
export const AcpAgentInstallIntegrity = Schema.Literals([
  "package-manager",
  "sha256-verified",
  "unverified-download",
  "local-command",
]);
export type AcpAgentInstallIntegrity = typeof AcpAgentInstallIntegrity.Type;

/**
 * Where an added agent came from. A registry agent names the registry entry
 * and the exact release the host's listing pinned when it was added; a local
 * agent names the person's own absolute executable. Package names, archive
 * URLs and checksums are never stored here: the host reads them from its own
 * listing, so no client can point an install anywhere else.
 */
export const AcpAgentSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("registry"),
    registryId: AcpRegistryAgentId,
    version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    distribution: Schema.Literals(["npx", "uvx", "binary"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    command: AbsoluteBinaryPath.check(
      Schema.isMaxLength(4_096),
      Schema.makeFilter((value) => !CONTROL_CHARACTER.test(value)),
    ),
  }),
]);
export type AcpAgentSource = typeof AcpAgentSource.Type;

/**
 * An agent the person added (Provider runtimes: "Any ACP agent"). The three
 * steps are separate: `install` is present once the executable is on disk,
 * `trusted` records the Trust step, and the instance's own `enabled` the
 * last. `args` and the registry entry's `environment` are copied from the
 * host's listing when the agent is added; a local agent carries only the
 * arguments the person typed, and never an environment, so nothing a client
 * sends can place a key in the journal.
 */
export const AddedAcpAgentConfiguration = Schema.Struct({
  kind: Schema.Literal("acp-agent"),
  source: AcpAgentSource,
  args: AcpAgentArguments,
  environment: Schema.optional(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,127}$/u)),
      AcpAgentArgument,
    ),
  ),
  install: Schema.optional(
    Schema.Struct({
      executable: AbsoluteBinaryPath.check(Schema.isMaxLength(4_096)),
      integrity: AcpAgentInstallIntegrity,
      /** Whether an installed package declares install scripts (e.g. npm lifecycle scripts). */
      hasInstallScripts: Schema.optional(Schema.Boolean),
      /** True once this install's package install scripts completed when trusted. */
      installScriptsCompleted: Schema.optional(Schema.Boolean),
    }),
  ),
  trusted: Schema.Boolean,
}).check(
  Schema.makeFilter((configuration) => {
    if (configuration.source.kind === "local") {
      return (
        configuration.environment === undefined &&
        (configuration.install === undefined ||
          (configuration.install.integrity === "local-command" &&
            configuration.install.executable === configuration.source.command &&
            configuration.install.hasInstallScripts === undefined &&
            configuration.install.installScriptsCompleted === undefined))
      );
    }
    return configuration.install?.integrity !== "local-command";
  }),
  Schema.makeFilter(
    (configuration) => configuration.install !== undefined || !configuration.trusted,
  ),
);
export type AddedAcpAgentConfiguration = typeof AddedAcpAgentConfiguration.Type;

export const PiProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("pi-rpc"),
  binaryPath: AbsoluteBinaryPath,
});
export type PiProviderConfiguration = typeof PiProviderConfiguration.Type;

export const OhMyPiProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("oh-my-pi-rpc"),
  binaryPath: AbsoluteBinaryPath,
  /** Observed CLI version pin used by the fail-closed probe, e.g. 17.2.1 */
  supportedVersion: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
});
export type OhMyPiProviderConfiguration = typeof OhMyPiProviderConfiguration.Type;

export const OllamaProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("ollama-native-http"),
  baseUrl: NonEmptyTrimmedString,
});
export type OllamaProviderConfiguration = typeof OllamaProviderConfiguration.Type;

const OllamaHistoryText = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && value.length <= 262_144),
);
export const OllamaHistoryMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: OllamaHistoryText,
});
export type OllamaHistoryMessage = typeof OllamaHistoryMessage.Type;
const OllamaHistory = Schema.Array(OllamaHistoryMessage).check(
  Schema.makeFilter(
    (history) =>
      history.length <= 256 &&
      history.reduce((total, message) => total + message.text.length, 0) <= 1_048_576,
  ),
);
export const OllamaHistorySnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  root: NonEmptyTrimmedString,
  mode: OctantMode,
  modelId: ProviderModelId,
  history: OllamaHistory,
});
export type OllamaHistorySnapshot = typeof OllamaHistorySnapshot.Type;
export const OllamaHistoryRecorded = Schema.Struct({
  snapshot: OllamaHistorySnapshot,
});
export type OllamaHistoryRecorded = typeof OllamaHistoryRecorded.Type;

export const OpenAiCompatibleProtocol = Schema.Literals(["auto", "responses", "chat-completions"]);
export type OpenAiCompatibleProtocol = typeof OpenAiCompatibleProtocol.Type;
export const ProviderCredentialStatus = Schema.Literals(["stored", "missing", "unavailable"]);
export type ProviderCredentialStatus = typeof ProviderCredentialStatus.Type;
const UniqueManualModelIds = Schema.Array(ProviderModelId).check(
  Schema.makeFilter((modelIds) => new Set(modelIds).size === modelIds.length),
);
const OAuthDescriptorId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
/**
 * An organization's own OpenID Connect issuer, exactly as its identity tokens
 * name it in `iss` (a trailing slash matters). It is the address the person
 * signs in at, so it is https with no credentials, query, or fragment.
 */
export const DirectoryIssuer = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
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
  ),
  Schema.brand("DirectoryIssuer"),
);
export type DirectoryIssuer = typeof DirectoryIssuer.Type;
/** The public client an organization registered with its own issuer. */
export const DirectoryIssuerClientId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/)),
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
  Schema.check(
    Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/),
    Schema.makeFilter((value) => !DIRECTORY_IDENTITY_SCOPES.has(value)),
  ),
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
});
export type DirectoryIssuerBinding = typeof DirectoryIssuerBinding.Type;

const OpenAiCompatibleConfigurationFields = {
  kind: Schema.Literal("openai-compatible-http"),
  baseUrl: NonEmptyTrimmedString,
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
};
/**
 * `directory-oauth` signs in with the organization's own issuer in place of a
 * key and names that issuer, client, and scope. It is never also a catalog
 * subscription sign-in.
 */
export const OpenAiCompatibleProviderConfiguration = Schema.Union([
  Schema.Struct({
    ...OpenAiCompatibleConfigurationFields,
    authentication: Schema.Literals(["bearer", "none"]),
    /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
    oauthDescriptorId: Schema.optional(OAuthDescriptorId),
  }),
  Schema.Struct({
    ...OpenAiCompatibleConfigurationFields,
    authentication: Schema.Literal("directory-oauth"),
    directory: DirectoryIssuerBinding,
  }),
]);
export type OpenAiCompatibleProviderConfiguration =
  typeof OpenAiCompatibleProviderConfiguration.Type;
export const AnthropicCompatibleProtocol = Schema.Literals(["auto", "messages"]);
export type AnthropicCompatibleProtocol = typeof AnthropicCompatibleProtocol.Type;
export const AnthropicCompatibleAuthentication = Schema.Literals([
  "api-key",
  "bearer",
  "none",
  "directory-oauth",
]);
export type AnthropicCompatibleAuthentication = typeof AnthropicCompatibleAuthentication.Type;
const AnthropicCompatibleConfigurationFields = {
  kind: Schema.Literal("anthropic-compatible-http"),
  baseUrl: NonEmptyTrimmedString,
  protocol: AnthropicCompatibleProtocol,
  protocolVersion: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  manualModelIds: UniqueManualModelIds,
};
/** As the OpenAI-compatible configuration: `directory-oauth` names the issuer binding. */
export const AnthropicCompatibleProviderConfiguration = Schema.Union([
  Schema.Struct({
    ...AnthropicCompatibleConfigurationFields,
    authentication: Schema.Literals(["api-key", "bearer", "none"]),
    /** Expected host-driven sign-in binding. Absent means no subscription sign-in. */
    oauthDescriptorId: Schema.optional(OAuthDescriptorId),
  }),
  Schema.Struct({
    ...AnthropicCompatibleConfigurationFields,
    authentication: Schema.Literal("directory-oauth"),
    directory: DirectoryIssuerBinding,
  }),
]);
export type AnthropicCompatibleProviderConfiguration =
  typeof AnthropicCompatibleProviderConfiguration.Type;
/**
 * A directory tenant or application (client) id, in the lowercase GUID form a
 * directory issues. A multi-tenant alias (`common`, `organizations`) or a
 * domain name is refused: it would let an account from any tenant answer the
 * sign-in, and the binding compares these values exactly.
 */
const DirectoryGuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
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
});
export type DirectoryBinding = typeof DirectoryBinding.Type;

export const AzureFoundryAuthentication = Schema.Literals(["api-key", "directory-oauth"]);
export type AzureFoundryAuthentication = typeof AzureFoundryAuthentication.Type;
const AzureFoundryConfigurationFields = {
  kind: Schema.Literal("azure-foundry-openai-http"),
  baseUrl: NonEmptyTrimmedString,
  protocol: OpenAiCompatibleProtocol,
  manualModelIds: UniqueManualModelIds,
};
/**
 * `directory-oauth` signs in with the organization's directory instead of a
 * key and carries the tenant and client it binds to; an API-key instance
 * carries no directory binding.
 */
export const AzureFoundryProviderConfiguration = Schema.Union([
  Schema.Struct({
    ...AzureFoundryConfigurationFields,
    authentication: Schema.Literal("api-key"),
  }),
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
  }),
]);
export type AzureFoundryProviderConfiguration = typeof AzureFoundryProviderConfiguration.Type;

/**
 * A region of the cloud's commercial partition, such as `us-east-1`. The
 * government (`us-gov-…`), isolated (`us-iso…`), sovereign (`eusc-…`), and
 * China (`cn-…`) partitions sign in and sign requests under other hosts and
 * keys; they wait for an organization that needs one.
 */
const CLOUD_REGION = /^(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]$/;
export const CloudIamRegion = Schema.String.pipe(
  Schema.check(Schema.isPattern(CLOUD_REGION)),
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
  Schema.check(
    Schema.makeFilter(
      (value) =>
        /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.awsapps\.com\/start$/.test(value) ||
        /^https:\/\/ssoins-[0-9a-f]{16}\.portal\.(?!cn-)[a-z]{2}-[a-z]{4,9}-[1-9]\.app\.aws$/.test(
          value,
        ),
    ),
  ),
  Schema.brand("CloudIamStartUrl"),
);
export type CloudIamStartUrl = typeof CloudIamStartUrl.Type;
export const CloudAccountId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9]{12}$/)),
  Schema.brand("CloudAccountId"),
);
export type CloudAccountId = typeof CloudAccountId.Type;
/** A role (permission set) name the account grants through single sign-on. */
export const CloudRoleName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9+=,.@_-]{1,64}$/)),
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
});
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
}).check(
  Schema.makeFilter((scope) => scope.host === `bedrock-runtime.${scope.region}.amazonaws.com`, {
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
  manualModelIds: UniqueManualModelIds.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
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
});
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
  header: Schema.String.check(
    Schema.isPattern(/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/),
    Schema.makeFilter((header) => !OUTSIDE_DRIVER_REFUSED_KEY_HEADERS.has(header)),
  ),
  scheme: Schema.optional(Schema.Literal("Bearer")),
});
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
  baseUrl: NonEmptyTrimmedString,
  key: Schema.optional(OutsideDriverKeyPlacement),
  modelIds: Schema.Array(ProviderModelId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((modelIds) => new Set(modelIds).size === modelIds.length),
  ),
});
export type OutsideHarnessEndpointProviderConfiguration =
  typeof OutsideHarnessEndpointProviderConfiguration.Type;

const outsideMediaConfigurationFields = {
  driver: OutsideProviderDriverReference,
  baseUrl: NonEmptyTrimmedString,
  key: Schema.optional(OutsideDriverKeyPlacement),
  modelAllowlist: Schema.Array(ProviderModelId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.makeFilter((modelIds) => new Set(modelIds).size === modelIds.length),
  ),
  defaultModel: ProviderModelId,
};

/**
 * An outside image generator as the person added it: the exact driver
 * package, the address its brokered requests may reach, how the key is sent
 * (absent: no key), and the image models the person listed, each of which
 * the package must also declare. The default model is one of them.
 */
export const OutsideImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("outside-image"),
  ...outsideMediaConfigurationFields,
}).check(
  Schema.makeFilter((configuration) =>
    configuration.modelAllowlist.some((id) => String(id) === String(configuration.defaultModel)),
  ),
);
export type OutsideImageProviderConfiguration = typeof OutsideImageProviderConfiguration.Type;

/**
 * An outside video generator as the person added it: the exact driver
 * package, the address its brokered requests may reach, how the key is sent
 * (absent: no key), and the video models the person listed, each of which the
 * package must also declare.
 */
export const OutsideVideoProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("outside-video"),
  ...outsideMediaConfigurationFields,
}).check(
  Schema.makeFilter((configuration) =>
    configuration.modelAllowlist.some((id) => String(id) === String(configuration.defaultModel)),
  ),
);
export type OutsideVideoProviderConfiguration = typeof OutsideVideoProviderConfiguration.Type;

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
export const OpenAiImageQuality = Schema.Literals(OPENAI_IMAGE_QUALITIES);
export type OpenAiImageQuality = typeof OpenAiImageQuality.Type;
export const OPENAI_IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const OpenAiImageSize = Schema.Literals(OPENAI_IMAGE_SIZES);
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
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
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
export const GeminiImageAspectRatio = Schema.Literals(GEMINI_IMAGE_ASPECT_RATIOS);
export type GeminiImageAspectRatio = typeof GeminiImageAspectRatio.Type;
export const GEMINI_IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export const GeminiImageResolution = Schema.Literals(GEMINI_IMAGE_RESOLUTIONS);
export type GeminiImageResolution = typeof GeminiImageResolution.Type;
export const GeminiImageProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("gemini-native-image-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
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
  baseUrl: Schema.optional(NonEmptyTrimmedString),
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
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
  baseUrl: Schema.optional(NonEmptyTrimmedString),
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
export type IdeogramImageProviderConfiguration = typeof IdeogramImageProviderConfiguration.Type;

/** Suggested Gemini video model IDs for Settings; the allowlist stays manual-entry. */
export const GEMINI_VIDEO_MODEL_PRESETS = ["gemini-omni-1.2-flash"] as const;
export const GeminiVideoProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("gemini-video-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
export type GeminiVideoProviderConfiguration = typeof GeminiVideoProviderConfiguration.Type;

/** Runway's own video models, as Settings suggests them. */
export const RUNWAY_VIDEO_MODEL_PRESETS = ["gen4.5", "gen4_turbo"] as const;
export const RunwayVideoProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("runway-video-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
export type RunwayVideoProviderConfiguration = typeof RunwayVideoProviderConfiguration.Type;

/**
 * fal endpoint ids Settings suggests; any fal video endpoint id may be listed,
 * and the driver reads its options from fal's published schema.
 */
export const FAL_VIDEO_MODEL_PRESETS = ["fal-ai/veo3.1", "fal-ai/veo3.1/image-to-video"] as const;
export const FalVideoProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("fal-video-http"),
  modelAllowlist: UniqueManualModelIds,
  defaultModel: ProviderModelId,
}).check(Schema.makeFilter(imageAllowlistContainsDefault));
export type FalVideoProviderConfiguration = typeof FalVideoProviderConfiguration.Type;
/**
 * How a Claude account signs in: its own claude.ai login, an Anthropic API
 * key, or a gateway (an address the runtime calls as `ANTHROPIC_BASE_URL`
 * with a token sent as `ANTHROPIC_AUTH_TOKEN`). The key and the gateway
 * token live in the host credential store, never in this configuration.
 */
export const ClaudeAuthentication = Schema.Literals(["subscription", "api-key", "gateway"]);
export type ClaudeAuthentication = typeof ClaudeAuthentication.Type;

export const ClaudeResumeIdentityRecord = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  octantSessionId: ProviderSessionId,
  sdkSessionId: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  projectRoot: Schema.NonEmptyString.check(Schema.isMaxLength(16 * 1024)),
  modelId: ProviderModelId,
  authentication: ClaudeAuthentication,
});
export type ClaudeResumeIdentityRecord = typeof ClaudeResumeIdentityRecord.Type;
/** An absent identity is the durable record that a resume identity was removed. */
export const ClaudeResumeIdentityRecorded = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  octantSessionId: ProviderSessionId,
  sdkSessionId: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  identity: Schema.optional(ClaudeResumeIdentityRecord),
});
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
export const ClaudeAccountAccent = Schema.Literals(CLAUDE_ACCOUNT_ACCENTS);
export type ClaudeAccountAccent = typeof ClaudeAccountAccent.Type;
function codexHomeBasename(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  const slash = path.lastIndexOf("/", end - 1);
  return slash === -1 ? path.slice(0, end) : path.slice(slash + 1, end);
}

const CodexHomeDirectory = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => {
    if (!path.startsWith("/")) return false;
    const leaf = codexHomeBasename(path);
    return leaf !== "auth.json" && leaf !== ".auth.json";
  }),
);
export const CodexProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("codex-cli"),
  binaryPath: NonEmptyTrimmedString,
  /** Codex-owned directory for this account. Absent uses Codex's default. */
  codexHome: Schema.optional(CodexHomeDirectory),
  accent: Schema.optional(ClaudeAccountAccent),
});
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

const ClaudeConfigDirectory = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => {
    if (!path.startsWith("/")) return false;
    return claudeConfigDirectoryBasename(path) !== ".credentials.json";
  }),
);
export const ClaudeProviderConfiguration = Schema.Struct({
  kind: Schema.Literal("claude-agent-sdk"),
  binaryPath: NonEmptyTrimmedString,
  authentication: ClaudeAuthentication,
  /**
   * The gateway a `gateway` account's runtime calls instead of Anthropic's
   * own API. Present exactly when the account signs in through a gateway;
   * the host checks its scheme and reach when it is saved.
   */
  gatewayBaseUrl: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  ),
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
}).check(
  Schema.makeFilter(
    (configuration) =>
      (configuration.authentication === "gateway") === (configuration.gatewayBaseUrl !== undefined),
  ),
);
export type ClaudeProviderConfiguration = typeof ClaudeProviderConfiguration.Type;

const ProviderInstanceFields = {
  id: ProviderInstanceId,
  displayName: NonEmptyTrimmedString,
  enabled: Schema.Boolean,
  environmentPolicy: Schema.Literal("inherit-host"),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  /** Optional so existing provider rows remain valid and default to untagged. */
  dataTags: Schema.optional(ProviderDataTags),
} as const;

/**
 * Whether a key provider account runs as itself: its own subagents, web
 * tools, skills, and home configuration load in its threads at every level,
 * as they do in the provider's own app. Absent is on, the default; `false`
 * means the person turned it off for this account. An earlier default kept it
 * off until the person turned it on, so a record may still carry `true`,
 * which reads as on. Only `set-provider-native-setup`, sent from a window on
 * this host, changes it; a configuration change or a new account never
 * carries it.
 */
const KeyProviderInstanceFields = {
  ...ProviderInstanceFields,
  nativeSetup: Schema.optional(Schema.Boolean),
} as const;

/**
 * The key providers whose runtime keeps a memory of its own behind a switch
 * Octant sets at launch: Claude Code's auto-memory and Codex's memories.
 * OpenCode and Mistral Vibe have no such memory, so their accounts carry no
 * setting for one.
 */
export const OWN_MEMORY_PROVIDER_DRIVER_KINDS = [
  "claude",
  "codex",
] as const satisfies ReadonlyArray<KeyProviderDriverKind>;
export type OwnMemoryProviderDriverKind = (typeof OWN_MEMORY_PROVIDER_DRIVER_KINDS)[number];

/**
 * Whether a Claude Code or Codex account keeps the provider's own memory: the
 * runtime reads and writes it by its own rules, across Projects and outside
 * Octant's journal, in the account's Work and Code sessions outside Plan.
 * Absent is on, the default (maintainer decision, 2026-11-14); `false` means
 * the person turned it off for this account. An earlier default kept it off
 * until the person turned it on, so a record may still carry `true`, which
 * reads as on. Only `set-provider-own-memory`, sent from a window on this
 * host, changes it; "Run as itself" and Full access never do.
 */
const OwnMemoryProviderInstanceFields = {
  ...KeyProviderInstanceFields,
  ownMemory: Schema.optional(Schema.Boolean),
} as const;

export const OpenCodeProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literal("opencode"),
  configuration: OpenCodeProviderConfiguration,
});
export type OpenCodeProviderInstance = typeof OpenCodeProviderInstance.Type;
export const CodexProviderInstance = Schema.Struct({
  ...OwnMemoryProviderInstanceFields,
  driverKind: Schema.Literal("codex"),
  configuration: CodexProviderConfiguration,
});
export type CodexProviderInstance = typeof CodexProviderInstance.Type;
export const ClaudeProviderInstance = Schema.Struct({
  ...OwnMemoryProviderInstanceFields,
  driverKind: Schema.Literal("claude"),
  configuration: ClaudeProviderConfiguration,
});
export type ClaudeProviderInstance = typeof ClaudeProviderInstance.Type;
/**
 * An instance of any ACP agent; its configuration kind must match its driver
 * kind. Every ACP agent is a key provider, so any instance may carry
 * `nativeSetup`.
 */
export const AcpAgentProviderInstance = Schema.Struct({
  ...KeyProviderInstanceFields,
  driverKind: Schema.Literals(ACP_AGENT_KINDS),
  configuration: AcpAgentConfiguration,
}).check(
  Schema.makeFilter(
    (instance) => instance.configuration.kind === acpAgentConfigurationKind(instance.driverKind),
  ),
);
export type AcpAgentProviderInstance = typeof AcpAgentProviderInstance.Type;

/**
 * An agent the person added. It is not a key provider: Octant holds no
 * switch for its own setup, so it carries no `nativeSetup`. The host turns it
 * on only once it is installed and trusted; untrusting it later leaves it on,
 * starting in Octant's sandbox and remembering nothing, so a stored instance
 * may be on and untrusted but never on and not installed.
 */
export const AddedAcpAgentProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("acp-agent"),
  configuration: AddedAcpAgentConfiguration,
}).check(
  Schema.makeFilter(
    (instance) => !instance.enabled || instance.configuration.install !== undefined,
  ),
);
export type AddedAcpAgentProviderInstance = typeof AddedAcpAgentProviderInstance.Type;

export const PiProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("pi"),
  configuration: PiProviderConfiguration,
});
export type PiProviderInstance = typeof PiProviderInstance.Type;

export const OhMyPiProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("oh-my-pi"),
  configuration: OhMyPiProviderConfiguration,
});
export type OhMyPiProviderInstance = typeof OhMyPiProviderInstance.Type;

export const OllamaProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("ollama"),
  configuration: OllamaProviderConfiguration,
});
export type OllamaProviderInstance = typeof OllamaProviderInstance.Type;

export const OpenAiCompatibleProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("openai-compatible"),
  configuration: OpenAiCompatibleProviderConfiguration,
});
export type OpenAiCompatibleProviderInstance = typeof OpenAiCompatibleProviderInstance.Type;

export const AnthropicCompatibleProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("anthropic-compatible"),
  configuration: AnthropicCompatibleProviderConfiguration,
});
export type AnthropicCompatibleProviderInstance = typeof AnthropicCompatibleProviderInstance.Type;

export const AzureFoundryProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("azure-foundry"),
  configuration: AzureFoundryProviderConfiguration,
});
export type AzureFoundryProviderInstance = typeof AzureFoundryProviderInstance.Type;

export const AmazonBedrockProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("amazon-bedrock"),
  configuration: AmazonBedrockProviderConfiguration,
});
export type AmazonBedrockProviderInstance = typeof AmazonBedrockProviderInstance.Type;

export const OpenAiImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("openai-image"),
  configuration: OpenAiImageProviderConfiguration,
});
export type OpenAiImageProviderInstance = typeof OpenAiImageProviderInstance.Type;

export const GeminiImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("gemini-native-image"),
  configuration: GeminiImageProviderConfiguration,
});
export type GeminiImageProviderInstance = typeof GeminiImageProviderInstance.Type;

export const BflImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("bfl-image"),
  configuration: BflImageProviderConfiguration,
});
export type BflImageProviderInstance = typeof BflImageProviderInstance.Type;

export const IdeogramImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("ideogram-image"),
  configuration: IdeogramImageProviderConfiguration,
});
export type IdeogramImageProviderInstance = typeof IdeogramImageProviderInstance.Type;

export const GeminiVideoProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("gemini-video"),
  configuration: GeminiVideoProviderConfiguration,
});
export type GeminiVideoProviderInstance = typeof GeminiVideoProviderInstance.Type;

export const RunwayVideoProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("runway-video"),
  configuration: RunwayVideoProviderConfiguration,
});
export type RunwayVideoProviderInstance = typeof RunwayVideoProviderInstance.Type;

export const FalVideoProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("fal-video"),
  configuration: FalVideoProviderConfiguration,
});
export type FalVideoProviderInstance = typeof FalVideoProviderInstance.Type;

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
});
export type OutsideDriverQuarantine = typeof OutsideDriverQuarantine.Type;

export const OutsideHarnessEndpointProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("outside-harness-endpoint"),
  configuration: OutsideHarnessEndpointProviderConfiguration,
  driverQuarantine: Schema.optional(OutsideDriverQuarantine),
});
export type OutsideHarnessEndpointProviderInstance =
  typeof OutsideHarnessEndpointProviderInstance.Type;

export const OutsideImageProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("outside-image"),
  configuration: OutsideImageProviderConfiguration,
  driverQuarantine: Schema.optional(OutsideDriverQuarantine),
});
export type OutsideImageProviderInstance = typeof OutsideImageProviderInstance.Type;

export const OutsideVideoProviderInstance = Schema.Struct({
  ...ProviderInstanceFields,
  driverKind: Schema.Literal("outside-video"),
  configuration: OutsideVideoProviderConfiguration,
  driverQuarantine: Schema.optional(OutsideDriverQuarantine),
});
export type OutsideVideoProviderInstance = typeof OutsideVideoProviderInstance.Type;

/** An instance whose driver is an outside package, of any family. */
export const OutsideDriverProviderInstance = Schema.Union([
  OutsideHarnessEndpointProviderInstance,
  OutsideImageProviderInstance,
  OutsideVideoProviderInstance,
]);
export type OutsideDriverProviderInstance = typeof OutsideDriverProviderInstance.Type;

export function isOutsideDriverProviderInstance(
  instance: ProviderInstance,
): instance is OutsideDriverProviderInstance {
  return (
    instance.driverKind === "outside-harness-endpoint" ||
    instance.driverKind === "outside-image" ||
    instance.driverKind === "outside-video"
  );
}

export const ProviderInstance = Schema.Union([
  OpenCodeProviderInstance,
  CodexProviderInstance,
  ClaudeProviderInstance,
  AcpAgentProviderInstance,
  AddedAcpAgentProviderInstance,
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
  GeminiVideoProviderInstance,
  RunwayVideoProviderInstance,
  FalVideoProviderInstance,
  OutsideHarnessEndpointProviderInstance,
  OutsideImageProviderInstance,
  OutsideVideoProviderInstance,
]);
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
});
export type AgentEligibleModelRef = typeof AgentEligibleModelRef.Type;

const MAX_AGENT_ELIGIBLE_MODELS = 16;

const agentEligibleModelKey = (ref: AgentEligibleModelRef): string =>
  `${ref.providerInstanceId}:${ref.modelId}`;

export const UniqueAgentEligibleModels = Schema.Array(AgentEligibleModelRef).check(
  Schema.makeFilter(
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

export const UniqueHiddenProviderModels = Schema.Array(HiddenProviderModelRef).check(
  Schema.makeFilter((refs) => new Set(refs.map(agentEligibleModelKey)).size === refs.length),
);

export const ProviderDefaults = Schema.Struct({
  permissionPersistence: PermissionPersistence,
  providerOrder: Schema.optional(
    Schema.Array(ProviderInstanceId).check(
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
  ),
  /**
   * Settings-defined default agent-eligible pool. Absent means the
   * default pool has not been configured; composers then offer no
   * multi-model pool until Settings defines one.
   */
  agentEligibleModels: Schema.optional(UniqueAgentEligibleModels),
  hiddenModels: Schema.optional(UniqueHiddenProviderModels),
  version: AggregateVersion,
});
export type ProviderDefaults = typeof ProviderDefaults.Type;

export const ProviderInstanceCreated = Schema.Struct({ instance: ProviderInstance });
export type ProviderInstanceCreated = typeof ProviderInstanceCreated.Type;
export const ProviderInstanceRenamed = Schema.Struct({ instance: ProviderInstance });
export type ProviderInstanceRenamed = typeof ProviderInstanceRenamed.Type;
/**
 * Kimi Code changed its binary through this event before ACP agents took
 * configuration commands; the journal still holds those events, so they
 * decode. No other ACP agent ever recorded one.
 */
const KimiCodeBinaryChangedInstance = AcpAgentProviderInstance.check(
  Schema.makeFilter((instance) => instance.driverKind === "kimi-code"),
);
export const ProviderInstanceBinaryChanged = Schema.Struct({
  instance: Schema.Union([
    OpenCodeProviderInstance,
    CodexProviderInstance,
    KimiCodeBinaryChangedInstance,
  ]),
});
export type ProviderInstanceBinaryChanged = typeof ProviderInstanceBinaryChanged.Type;
export const ProviderInstanceConfigurationChanged = Schema.Struct({
  instance: Schema.Union([
    OpenAiCompatibleProviderInstance,
    AnthropicCompatibleProviderInstance,
    AzureFoundryProviderInstance,
    AmazonBedrockProviderInstance,
    OpenAiImageProviderInstance,
    GeminiImageProviderInstance,
    BflImageProviderInstance,
    IdeogramImageProviderInstance,
    GeminiVideoProviderInstance,
    RunwayVideoProviderInstance,
    FalVideoProviderInstance,
    ClaudeProviderInstance,
    AcpAgentProviderInstance,
    AddedAcpAgentProviderInstance,
    PiProviderInstance,
    OhMyPiProviderInstance,
    OllamaProviderInstance,
    OutsideHarnessEndpointProviderInstance,
    OutsideImageProviderInstance,
    OutsideVideoProviderInstance,
  ]),
});
export type ProviderInstanceConfigurationChanged = typeof ProviderInstanceConfigurationChanged.Type;
/**
 * An outside instance moved to another digest of its own driver. Only the host
 * writes it, once the person has trusted that digest; the person's own change
 * of the instance's address, key placement, or models travels in
 * `provider.instance-configuration-changed@1`, which keeps the driver as bound.
 */
export const ProviderInstanceDriverRebound = Schema.Struct({
  instance: OutsideDriverProviderInstance,
});
export type ProviderInstanceDriverRebound = typeof ProviderInstanceDriverRebound.Type;
/**
 * An outside instance's driver crashed past its limit and is held at the
 * digest it binds. Only the host writes it; the instance it carries holds the
 * quarantine.
 */
export const ProviderInstanceDriverQuarantined = Schema.Struct({
  instance: OutsideDriverProviderInstance.check(
    Schema.makeFilter((instance) => instance.driverQuarantine !== undefined),
  ),
});
export type ProviderInstanceDriverQuarantined = typeof ProviderInstanceDriverQuarantined.Type;
export const ProviderInstanceDataTagsChanged = Schema.Struct({
  instance: ProviderInstance,
});
export type ProviderInstanceDataTagsChanged = typeof ProviderInstanceDataTagsChanged.Type;
export const ProviderInstanceEnabledChanged = Schema.Struct({
  instance: ProviderInstance,
});
export type ProviderInstanceEnabledChanged = typeof ProviderInstanceEnabledChanged.Type;
/** A person turned a key provider account's own setup on or off from a local window. */
export const ProviderInstanceNativeSetupChanged = Schema.Struct({
  instance: Schema.Union([
    OpenCodeProviderInstance,
    CodexProviderInstance,
    ClaudeProviderInstance,
    AcpAgentProviderInstance,
  ]),
});
export type ProviderInstanceNativeSetupChanged = typeof ProviderInstanceNativeSetupChanged.Type;
/** A person turned a Claude Code or Codex account's own memory on or off from a local window. */
export const ProviderInstanceOwnMemoryChanged = Schema.Struct({
  instance: Schema.Union([CodexProviderInstance, ClaudeProviderInstance]),
});
export type ProviderInstanceOwnMemoryChanged = typeof ProviderInstanceOwnMemoryChanged.Type;
export const ProviderInstanceRemoved = Schema.Struct({
  instanceId: ProviderInstanceId,
  version: AggregateVersion,
});
export type ProviderInstanceRemoved = typeof ProviderInstanceRemoved.Type;
export const ProviderDefaultsUpdated = Schema.Struct({ defaults: ProviderDefaults });
export type ProviderDefaultsUpdated = typeof ProviderDefaultsUpdated.Type;

export const AcpAgentInstallScriptsFailureReason = Schema.Literals([
  "package-manager-missing",
  "sandbox-unavailable",
  "script-failed",
  "timed-out",
  "executable-missing",
  "invalid-install-folder",
]);
export type AcpAgentInstallScriptsFailureReason = typeof AcpAgentInstallScriptsFailureReason.Type;

export const PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN =
  "provider.acp-agent-install-scripts-ran@1" as const;

/**
 * Journaled record of running an added ACP package agent's install scripts
 * when the person clicks Trust. Actor and occurredAt live on the event
 * envelope; `sandboxed` records whether Octant confined the run under Strict.
 */
export const ProviderAcpAgentInstallScriptsRan = Schema.Struct({
  instanceId: ProviderInstanceId,
  registryId: AcpRegistryAgentId,
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  distribution: Schema.Literals(["npx", "uvx"]),
  outcome: Schema.Literals(["succeeded", "failed"]),
  sandboxed: Schema.Boolean,
  completedAt: UtcTimestamp,
  reason: Schema.optional(AcpAgentInstallScriptsFailureReason),
}).check(
  Schema.makeFilter(
    (record) =>
      (record.outcome === "succeeded" && record.reason === undefined) ||
      (record.outcome === "failed" && record.reason !== undefined),
  ),
);
export type ProviderAcpAgentInstallScriptsRan = typeof ProviderAcpAgentInstallScriptsRan.Type;

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
export const ImageInputCapability = Schema.Literals(["supported", "unsupported", "unknown"]);
export type ImageInputCapability = typeof ImageInputCapability.Type;

export const CapabilityEvidenceSource = Schema.Literals([
  "endpoint-observation",
  "provider-metadata",
  "catalog-metadata",
  "user-metadata",
  "unknown",
]);
export type CapabilityEvidenceSource = typeof CapabilityEvidenceSource.Type;

export const CapabilityEvidenceConfidence = Schema.Literals(["high", "medium", "low", "unknown"]);
export type CapabilityEvidenceConfidence = typeof CapabilityEvidenceConfidence.Type;

export const ProviderModelCapability = Schema.Literals([
  "tool-calling",
  "parallel-tools",
  "structured-output",
  "reasoning",
  "streaming",
  "context-limit",
  "max-output-tokens",
  "input-modalities",
]);
export type ProviderModelCapability = typeof ProviderModelCapability.Type;

const CapabilityEvidenceProtocol = Schema.Literals([
  "responses",
  "chat-completions",
  "anthropic-messages",
  "acp",
  "rpc",
  "native",
  "unknown",
]);

export const CapabilityEvidence = Schema.Struct({
  capability: ProviderModelCapability,
  support: ProviderCapabilitySupport,
  source: CapabilityEvidenceSource,
  confidence: CapabilityEvidenceConfidence,
  protocol: CapabilityEvidenceProtocol,
  observedAt: UtcTimestamp,
  invalidated: Schema.Boolean,
  invalidatedAt: Schema.optional(UtcTimestamp),
  invalidationReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
});
export type CapabilityEvidence = typeof CapabilityEvidence.Type;

const ProviderBooleanModelOption = Schema.Struct({
  id: NonEmptyTrimmedString,
  displayName: NonEmptyTrimmedString,
  kind: Schema.Literal("boolean"),
});

const ProviderSelectionModelOption = Schema.Struct({
  id: NonEmptyTrimmedString,
  displayName: NonEmptyTrimmedString,
  kind: Schema.Literal("selection"),
  values: Schema.NonEmptyArray(NonEmptyTrimmedString),
});

export const ProviderModelOption = Schema.Union([
  ProviderBooleanModelOption,
  ProviderSelectionModelOption,
]);
export type ProviderModelOption = typeof ProviderModelOption.Type;

export const MAX_PROVIDER_MODEL_OPTION_VALUES = 16;
const ProviderModelOptionKey = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));

/**
 * A user's chosen value per declared model option (e.g. `effort`,
 * `reasoning`, `service-tier`), keyed by `ProviderModelOption.id`. Absent keys
 * mean the provider default. Only values the selected model actually declares
 * are meaningful; the server validates against the current catalog.
 */
export const ProviderModelOptionValues = Schema.Record(
  ProviderModelOptionKey,
  ProviderModelOptionKey,
).check(
  Schema.makeFilter((values) => Object.keys(values).length <= MAX_PROVIDER_MODEL_OPTION_VALUES, {
    message: `At most ${MAX_PROVIDER_MODEL_OPTION_VALUES} model option values`,
  }),
);
export type ProviderModelOptionValues = typeof ProviderModelOptionValues.Type;

/** Display choices identify advertised variants; selecting one still binds its real model id. */
const ProviderModelConfiguration = Schema.Struct({
  family: NonEmptyTrimmedString,
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      id: NonEmptyTrimmedString,
      displayName: NonEmptyTrimmedString,
      value: NonEmptyTrimmedString,
    }),
  ).check(
    Schema.makeFilter(
      (choices) => new Set(choices.map((choice) => choice.id)).size === choices.length,
    ),
  ),
});

const ProviderModelFields = {
  id: ProviderModelId,
  displayName: NonEmptyTrimmedString,
  orderHint: Schema.optional(NonNegativeInt),
  contextLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  maxOutputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
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
  servedModelId: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
} as const;

export const ProviderModel = Schema.Union([
  Schema.Struct({
    ...ProviderModelFields,
    source: Schema.Literal("discovered"),
    verification: Schema.Literal("verified"),
  }),
  Schema.Struct({
    ...ProviderModelFields,
    source: Schema.Literal("manual"),
    verification: Schema.Literals(["unverified", "verified"]),
  }),
]);
export type ProviderModel = typeof ProviderModel.Type;

export const ProviderCatalogSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  version: AggregateVersion,
  models: Schema.Array(ProviderModel).check(
    Schema.makeFilter(
      (models) => new Set(models.map(({ id }) => String(id))).size === models.length,
    ),
  ),
  manualModelOrder: Schema.Array(ProviderModelId).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  invalidated: Schema.Boolean,
  invalidatedAt: Schema.optional(UtcTimestamp),
  invalidationReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
  updatedAt: UtcTimestamp,
});
export type ProviderCatalogSnapshot = typeof ProviderCatalogSnapshot.Type;

export const ProviderCatalogUpdated = Schema.Struct({
  snapshot: ProviderCatalogSnapshot,
});
export type ProviderCatalogUpdated = typeof ProviderCatalogUpdated.Type;

export const ProviderCapabilities = Schema.Struct({
  cloudSessions: Schema.optional(ProviderCapabilitySupport),
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
   * Reported by a runtime that Full access launches where it cannot prove
   * Octant's tools are the only ones entering it: a Full access thread is
   * still offered them, labelled as mixed with tools Octant did not supply.
   * `appManagedTools` keeps answering for every guarded level. Absent means
   * Full access changes nothing for this runtime.
   */
  appManagedToolsAtFullAccess: Schema.optional(Schema.Literal("mixed")),
  /**
   * Reported by a runtime whose Work and Code launches outside Strict run
   * with no Octant sandbox beside the person's own setup, where it cannot
   * prove Octant's tools are the only ones entering it: such a thread below
   * Full access is still offered them, labelled as mixed. `appManagedTools`
   * keeps answering under Strict and in Plan. Absent means Strict changes
   * nothing for this runtime's tools.
   */
  appManagedToolsOutsideStrict: Schema.optional(Schema.Literal("mixed")),
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
   * Whether the runtime can cut a session it holds back to an earlier turn,
   * so a thread rewound in place continues that session without the removed
   * turns. Absent reads as unsupported: a rewound thread then starts a fresh
   * session with a disclosed text handoff of the turns it kept.
   */
  sessionRollback: Schema.optional(ProviderCapabilitySupport),
  /**
   * Where this host lets the runtime run turns, when that is narrower than
   * every mode: `chat` for Chat, `plan` for Plan in Work and Code, `work` and
   * `code` for those modes at any other level. `unsupportedReason` says why a
   * mode reads unsupported. Absent means every mode the other capabilities
   * allow.
   */
  turnModes: Schema.optional(
    Schema.Struct({
      chat: ProviderCapabilitySupport,
      plan: ProviderCapabilitySupport,
      work: ProviderCapabilitySupport,
      code: ProviderCapabilitySupport,
      unsupportedReason: Schema.optional(Schema.Literal("host-confinement")),
    }),
  ),
  /**
   * Whether one session's runtime process can be killed on its own, through
   * the connection's `forceStop`. A runtime that serves several threads from
   * one process reports `unsupported`, since killing it would end the others.
   * Absent reads as unsupported.
   */
  forceStop: Schema.optional(ProviderCapabilitySupport),
  /**
   * Whether the runtime can run a Code turn on a server Project's server over
   * the host's SSH connection, with no Octant there: its own program runs on
   * the server and speaks to the host over that connection's standard
   * streams, and everything Octant adds travels inside its own protocol. A
   * runtime whose Octant tools reach this host's loopback cannot. Absent
   * reads as unsupported.
   */
  serverPlacement: Schema.optional(ProviderCapabilitySupport),
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
    }),
  ),
  /**
   * Whether the runtime takes the person's compaction point for a session it
   * opens, so it also compacts at that share inside a long turn. Absent or
   * unsupported: only the host's between-turn rule applies.
   */
  compactionPoint: Schema.optional(ProviderCapabilitySupport),
  citations: ProviderCapabilitySupport,
  harnessAutoReview: ProviderCapabilitySupport,
  /**
   * Which per-call verdicts the runtime's own reviewer reports at Reviewed:
   * `allow` for a call it approved without asking, `deny` for one it refused.
   * A verdict the runtime does not report reads unsupported; Octant never
   * infers one. Absent reads as unsupported for both.
   */
  reviewVerdicts: Schema.optional(
    Schema.Struct({
      allow: ProviderCapabilitySupport,
      deny: ProviderCapabilitySupport,
    }),
  ),
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
    }),
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
    }),
  ),
});
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

export const ProviderAttachmentInput = Schema.Struct({
  attachmentId: BoundedProviderAttachmentId,
  displayName: BoundedProviderDisplayName,
  mediaType: BoundedProviderMediaType,
  bytes: ProviderAttachmentBytes,
});
export type ProviderAttachmentInput = typeof ProviderAttachmentInput.Type;

export const ProviderToolDefinition = Schema.Struct({
  name: BoundedProviderToolName,
  description: Schema.optional(BoundedProviderToolDescription),
  inputSchema: ProviderToolInputSchema,
});
export type ProviderToolDefinition = typeof ProviderToolDefinition.Type;

export const ProviderContextBlock = Schema.Struct({
  kind: Schema.Literals([
    "instructions",
    "turn-instructions",
    "skill-instructions",
    "user-message",
    "assistant-message",
    "person-instructions",
    "project-instructions",
    "orchestration-instructions",
    "person-memory",
    "project-memory",
    "work-item",
    "conversation-summary",
  ]),
  text: ProviderPromptText,
  /**
   * Names standing context Octant re-reads every turn, such as a Project's
   * status file. A session holding an older version under the same key gets
   * the newer one appended; it is not a withdrawal, so nothing is restated.
   */
  key: Schema.optional(BoundedProviderContextKey),
  /**
   * The app tool this block describes, such as the Canvas delivery rule or the
   * Browser note. A driver whose session cannot call that tool leaves the
   * block out, so the model is never told about a tool it does not have.
   */
  tool: Schema.optional(BoundedProviderToolName),
});
export type ProviderContextBlock = typeof ProviderContextBlock.Type;

export const ProviderTurnInput = Schema.Struct({
  sessionId: ProviderSessionId,
  prompt: ProviderPromptText,
  context: Schema.optional(
    Schema.Array(ProviderContextBlock).check(
      Schema.makeFilter((blocks) => blocks.length <= MAX_PROVIDER_CONTEXT_BLOCKS),
    ),
  ),
  attachments: Schema.Array(ProviderAttachmentInput).check(
    Schema.makeFilter((attachments) => attachments.length <= MAX_PROVIDER_ATTACHMENTS),
  ),
  tools: Schema.Array(ProviderToolDefinition).check(
    Schema.makeFilter((tools) => tools.length <= MAX_PROVIDER_TOOLS),
  ),
  /**
   * The host let the native harness offer the provider's own web search this
   * turn, as its research route chose. `withdrawAfterFirstStep` (below Full access)
   * leaves it out of every request after the turn's first search or first
   * tool answer, which may have read outside content the provider's own
   * search could carry out in a query Octant never sees.
   */
  providerWebSearch: Schema.optional(
    Schema.Struct({
      withdrawAfterFirstStep: Schema.Boolean,
    }),
  ),
});
export type ProviderTurnInput = typeof ProviderTurnInput.Type;

/** The longest base64 payload one tool image may carry. */
export const MAX_PROVIDER_TOOL_IMAGE_BASE64_LENGTH = 2_097_152;

export const ProviderToolImage = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_PROVIDER_TOOL_IMAGE_BASE64_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
});
export type ProviderToolImage = typeof ProviderToolImage.Type;

export const ProviderToolAnswer = Schema.Struct({
  sessionId: ProviderSessionId,
  requestId: BoundedProviderRequestId,
  resultJson: BoundedProviderJson,
  isError: Schema.Boolean,
  images: Schema.optional(Schema.Array(ProviderToolImage).check(Schema.isMaxLength(4))),
});
export type ProviderToolAnswer = typeof ProviderToolAnswer.Type;

const ProviderDiagnosticVersion = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
);

/**
 * Bounded process facts that are safe to show on any authenticated client.
 * Raw stdout, stderr, argv, environment, prompts, credentials, and filesystem
 * paths are deliberately not representable.
 */
export const ProviderProcessDiagnostic = Schema.Struct({
  stage: Schema.Literals([
    "version-check",
    "launch",
    "initialization",
    "authentication",
    "model-discovery",
    "update",
    "post-update-probe",
    "cleanup",
  ]),
  kind: Schema.Literals([
    "spawn-failed",
    "exited",
    "signaled",
    "timed-out",
    "version-mismatch",
    "confinement-denied",
    "protocol-failed",
    "authentication-failed",
    "cleanup-unconfirmed",
  ]),
  exitCode: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255)),
  ),
  signal: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(32),
      Schema.isPattern(/^SIG[A-Z0-9]+$/),
    ),
  ),
  detectedVersion: Schema.optional(ProviderDiagnosticVersion),
  supportedVersion: Schema.optional(ProviderDiagnosticVersion),
  stderrContext: Schema.optional(
    Schema.Literals([
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
    ]),
  ),
});
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
export const ProviderRefusalReason = Schema.Literals([
  "runtime-incompatible",
  "authentication-required",
  "runtime-unavailable",
  "no-usable-model",
  "driver-not-admitted",
  "driver-incompatible",
]);
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
export const ProviderToolTransport = Schema.Literals([
  "request-tool-calls",
  "sdk-tool-server",
  "app-server-dynamic-tools",
  "session-mcp-bridge",
  "session-tool-bridge",
]);
export type ProviderToolTransport = typeof ProviderToolTransport.Type;

/**
 * Why Octant's tools are not available on a runtime. `not-confirmed`: the last
 * connection check did not establish it either way. `model-verification-required`:
 * a direct endpoint offers tools only to models a person verified.
 * `runtime-not-confirmed`: the transport exists, but this runtime's version,
 * platform, or setup did not confirm it. `no-transport`: Octant has no way to
 * offer its tools to this runtime.
 */
export const ProviderToolsUnavailableReason = Schema.Literals([
  "not-confirmed",
  "model-verification-required",
  "runtime-not-confirmed",
  "no-transport",
]);
export type ProviderToolsUnavailableReason = typeof ProviderToolsUnavailableReason.Type;

/** What a live session reports while a turn runs. */
export const ProviderObservedActivity = Schema.Literals([
  "replies",
  "tool-calls",
  "approvals",
  "file-changes",
  "task-progress",
]);
export type ProviderObservedActivity = typeof ProviderObservedActivity.Type;

/**
 * How a follow-up continues an earlier conversation. `precise`: the runtime
 * reopens its own session by id. `best-effort`: the endpoint holds no session,
 * so Octant sends the thread's history from its journal again, fitted to the
 * model's context window. `none`: the runtime cannot continue a previous
 * session.
 */
export const ProviderResumeQuality = Schema.Literals(["precise", "best-effort", "none"]);
export type ProviderResumeQuality = typeof ProviderResumeQuality.Type;

/**
 * Whether a runtime reports what its turns occupy and spend. `reported`: its
 * turns carry usage, so a thread can show a context window. `not-reported`:
 * the driver declares it never reports usage (ACP agents), so a thread on it
 * shows no window and a spend ceiling leaves its turns out. `not-confirmed`:
 * the last connection check did not establish it.
 */
export const ProviderUsageReporting = Schema.Literals([
  "reported",
  "not-reported",
  "not-confirmed",
]);
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
export const ProviderCompactionOwner = Schema.Literals([
  "octant",
  "runtime",
  "runtime-update-required",
  "none",
  "not-confirmed",
]);
export type ProviderCompactionOwner = typeof ProviderCompactionOwner.Type;

/**
 * The integration a runtime actually has, derived by the server from the
 * driver and its last connection check so a client never guesses it.
 * `activity.source` reuses the fleet vocabulary: `session` is a live provider
 * session the host holds and journals; `none` means no session runs here, so
 * nothing is observed.
 */
export const ProviderRuntimeIntegration = Schema.Struct({
  tools: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("available"),
      transport: ProviderToolTransport,
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      transport: Schema.optional(ProviderToolTransport),
      reason: ProviderToolsUnavailableReason,
    }),
  ]),
  activity: Schema.Union([
    Schema.Struct({
      source: Schema.Literal("session"),
      observes: Schema.Array(ProviderObservedActivity).check(
        Schema.makeFilter((values) => new Set(values).size === values.length),
      ),
    }),
    Schema.Struct({ source: Schema.Literal("none") }),
  ]),
  resume: ProviderResumeQuality,
  context: Schema.Struct({
    usage: ProviderUsageReporting,
    compaction: ProviderCompactionOwner,
  }),
});
export type ProviderRuntimeIntegration = typeof ProviderRuntimeIntegration.Type;

/**
 * Why a host-driven sign-in reads `unauthenticated`, so Settings can tell a
 * sign-in that ended from one the organization wants repeated in person, or
 * from an account with no role on the endpoint.
 */
export const ProviderUnauthenticatedReason = Schema.Literals([
  "missing",
  "expired",
  "revoked",
  "interaction-required",
  "not-authorized",
]);
export type ProviderUnauthenticatedReason = typeof ProviderUnauthenticatedReason.Type;

/**
 * The directory binding a probe checked before it asked for a token: a tenant
 * of the closed directory, or an organization's own issuer. None of it is
 * secret.
 */
export const ProviderObservedDirectoryBinding = Schema.Union([
  Schema.Struct({
    tenantId: DirectoryTenantId,
    clientId: DirectoryClientId,
    endpointOrigin: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    issuer: DirectoryIssuer,
    clientId: DirectoryIssuerClientId,
    endpointOrigin: NonEmptyTrimmedString,
  }),
]);
export type ProviderObservedDirectoryBinding = typeof ProviderObservedDirectoryBinding.Type;

/**
 * The kind of account a provider's own app reports it is signed in with, in
 * one vocabulary for every driver. Only `subscription` is a person's plan
 * sign-in; `other` is an account the driver cannot name as any of the rest.
 */
export const ProviderAccountAuthentication = Schema.Literals([
  "subscription",
  "api-key",
  "none",
  "other",
]);
export type ProviderAccountAuthentication = typeof ProviderAccountAuthentication.Type;

/**
 * A Verify tools run that left a model without Octant's tools, and why: the
 * model answered without calling the test tool (`unsupported`), or the run
 * did not finish (`failed`: the endpoint refused, timed out, or was
 * interrupted). The host runs the check when a person presses Verify tools
 * and by itself the first time a model is used, so this is where the result
 * of a run nobody was watching is read.
 */
export const ProviderModelToolCheck = Schema.Struct({
  modelId: ProviderModelId,
  outcome: Schema.Literals(["unsupported", "failed"]),
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  checkedAt: UtcTimestamp,
});
export type ProviderModelToolCheck = typeof ProviderModelToolCheck.Type;

/**
 * One of the provider's own slash commands, as its runtime listed it: Claude
 * Code's commands and skills, an ACP agent's `available_commands_update`,
 * OpenCode's commands. Choosing it in a composer sends `/name` to the
 * runtime as the prompt.
 */
export const ProviderSlashCommand = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/u),
    Schema.isMaxLength(128),
  ),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  argumentHint: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type ProviderSlashCommand = typeof ProviderSlashCommand.Type;
export const MAX_PROVIDER_SLASH_COMMANDS = 256;

/** Where a provider's own skill or plugin lives: `project` for a thread's folder, `account` (or absent) for the account. */
export const ProviderMentionScope = Schema.Literals(["account", "project"]);
export type ProviderMentionScope = typeof ProviderMentionScope.Type;

/**
 * One of the provider's own skills or plugins a composer's `@` menu offers,
 * as its runtime listed it: Codex's `skills/list` and `plugin/installed`.
 * Choosing it writes the runtime's own reference into the draft (`$name` for
 * a skill, `@name` for a plugin); the driver resolves that reference against
 * its own listing at send and grants nothing on the client's word.
 */
export const ProviderMention = Schema.Struct({
  kind: Schema.Literals(["skill", "plugin"]),
  name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/u),
    Schema.isMaxLength(128),
  ),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  scope: Schema.optional(ProviderMentionScope),
});
export type ProviderMention = typeof ProviderMention.Type;
export const MAX_PROVIDER_MENTIONS = 256;

export const ProviderObservedState = Schema.Struct({
  instanceId: ProviderInstanceId,
  readiness: ProviderReadiness,
  processState: ProviderProcessState,
  /** What the probe found the account to be; absent when the driver does not say. */
  accountAuthentication: Schema.optional(ProviderAccountAuthentication),
  detectedVersion: Schema.optional(NonEmptyTrimmedString),
  observedProtocol: Schema.optional(OpenAiCompatibleProtocol),
  credentialStatus: Schema.optional(ProviderCredentialStatus),
  /** Present only with `unauthenticated` readiness, when the driver knows why. */
  unauthenticatedReason: Schema.optional(ProviderUnauthenticatedReason),
  /** Present only for a directory sign-in: the binding its probe checked. */
  directoryBinding: Schema.optional(ProviderObservedDirectoryBinding),
  models: Schema.Array(ProviderModel),
  capabilities: ProviderCapabilities,
  /**
   * The provider's own slash commands its runtime last listed, by the probe
   * or by a session that reported a change. Absent when it lists none or
   * cannot say.
   */
  commands: Schema.optional(
    Schema.Array(ProviderSlashCommand).check(Schema.isMaxLength(MAX_PROVIDER_SLASH_COMMANDS)),
  ),
  /**
   * The provider's own skills and plugins its runtime last listed for the
   * account (not a Project's), offered in the composer's `@` menu. Absent
   * when it lists none or cannot say.
   */
  mentions: Schema.optional(
    Schema.Array(ProviderMention).check(Schema.isMaxLength(MAX_PROVIDER_MENTIONS)),
  ),
  // Models a person explicitly verified for tool support through the
  // verify-model-tools command, on any endpoint profile (OpenAI-compatible,
  // Anthropic-compatible, Azure AI Foundry). The sender gates tool requests
  // per model against this set as well as the provider-level appManagedTools
  // flag, so one verified model does not unlock tools for the other models
  // of the same profile.
  verifiedToolModelIds: Schema.optional(Schema.Array(ProviderModelId)),
  /**
   * Attached by the server when it reports a runtime to a client; a driver
   * never sets it. The models whose last Verify tools run left them without
   * tools, each with its reason. It grants and withholds nothing: admission
   * reads `verifiedToolModelIds` alone.
   */
  toolChecks: Schema.optional(Schema.Array(ProviderModelToolCheck)),
  /**
   * Attached by the server when it reports a runtime to a client; a driver
   * never sets it. Absent for image profiles, which run no turns.
   */
  integration: Schema.optional(ProviderRuntimeIntegration),
  message: Schema.optional(NonEmptyTrimmedString),
  reason: Schema.optional(ProviderRefusalReason),
  /**
   * The agent never listed the sign-in the instance is configured with, so
   * the fix is the agent's version or another sign-in, not the credential.
   * The reason stays `authentication-required`: a client that predates this
   * field still decodes the catalog and shows the generic sign-in advice.
   */
  signInNotOffered: Schema.optional(Schema.Literal(true)),
  diagnostic: Schema.optional(ProviderProcessDiagnostic),
  lastSuccessfulProbeAt: Schema.optional(UtcTimestamp),
  observedAt: UtcTimestamp,
});
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
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  source: Schema.Literals(["local-folder", "npm"]),
  npm: Schema.optional(ExtensionNpmSource),
  installed: Schema.Boolean,
  trusted: Schema.Boolean,
  publisherKey: Schema.optional(ExtensionPublisherKeyFingerprint),
  /**
   * Present when this host has no confinement for the driver's process, so it
   * runs without one (Linux). Absent where the host confines it (macOS).
   */
  hostConfinement: Schema.optional(Schema.Literal("unconfined")),
  /**
   * Present for a driver that generates images: the models its package
   * declares, with the published price per image where it states one. Absent
   * for a harness endpoint.
   */
  imageGeneration: Schema.optional(
    Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          modelId: ProviderModelId,
          usdMicrosPerImage: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  ),
  /** Present for a driver that generates video: the models its package declares. */
  videoGeneration: Schema.optional(
    Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          modelId: ProviderModelId,
          displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
          /** False for a model an active spend limit refuses. The card shows each clip's price. */
          publishesPrice: Schema.Boolean,
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  ),
});
export type OutsideProviderDriverListing = typeof OutsideProviderDriverListing.Type;

export const ProviderRegistrySnapshot = Schema.Struct({
  instances: Schema.Array(ProviderInstance),
  defaults: ProviderDefaults,
  observedStates: Schema.Array(ProviderObservedState),
  catalogs: Schema.optional(Schema.Array(ProviderCatalogSnapshot)),
  /** Absent from a host that admits no outside driver. */
  outsideDrivers: Schema.optional(
    Schema.Array(OutsideProviderDriverListing).check(Schema.isMaxLength(256)),
  ),
});
export type ProviderRegistrySnapshot = typeof ProviderRegistrySnapshot.Type;

export const ProviderProbeResult = ProviderObservedState;
export type ProviderProbeResult = typeof ProviderProbeResult.Type;

export type AcpAgentCreateCommandKind = `create-${AcpAgentKind}-provider`;
export type AcpAgentChangeCommandKind = `change-${AcpAgentKind}-configuration`;

export function acpAgentCreateCommandKind(kind: AcpAgentKind): AcpAgentCreateCommandKind {
  return `create-${kind}-provider`;
}

export function acpAgentChangeCommandKind(kind: AcpAgentKind): AcpAgentChangeCommandKind {
  return `change-${kind}-configuration`;
}

export const ProviderResumeCursor = Schema.Struct({
  driverKind: ProviderDriverKind,
  value: NonEmptyTrimmedString,
  /** Host-persisted identity; never authority supplied by a new turn. */
  binding: Schema.optional(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      sessionId: ProviderSessionId,
      projectRoot: NonEmptyTrimmedString,
      mode: Schema.Literals(["chat", "work", "code"]),
      modelId: ProviderModelId,
    }),
  ),
  /**
   * The app tools a runtime fixed for this session when it started and cannot
   * change later (Codex keeps a thread's starting tools across every resume),
   * so a resumed session still knows which tool rules it can carry. Absent
   * means unknown, and every rule is kept.
   */
  tools: Schema.optional(Schema.Array(BoundedProviderToolName).check(Schema.isMaxLength(256))),
  /** Fingerprints of the immutable starting definitions; schemas and secrets are never retained here. */
  toolDefinitions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: BoundedProviderToolName,
        digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      }),
    ).check(Schema.isMaxLength(256)),
  ),
  /**
   * The session began outside Octant and was taken up as it stood, with the
   * runtime's own tools and none of Octant's app tools, which a runtime that
   * fixes its tools at start (Codex) cannot add later. Its turns run without
   * them rather than handing the conversation over as text, and a copy of it
   * keeps the mark.
   */
  adopted: Schema.optional(Schema.Literal(true)),
});
export type ProviderResumeCursor = typeof ProviderResumeCursor.Type;

export const ProviderFailureCategory = Schema.Literals([
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
]);
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
  kind: Schema.Literals(["temporary", "exhausted", "billing"]),
  resetsAt: Schema.optional(UtcTimestamp),
});
export type ProviderUsageLimit = typeof ProviderUsageLimit.Type;

export const ProviderFailure = Schema.Struct({
  toolCatalogHandoffRequired: Schema.optional(Schema.Literal(true)),
  /**
   * The agent never listed the sign-in the instance is configured with, so
   * the fix is the agent's version or another sign-in, not the credential.
   * The reason stays `authentication-required`: a client that predates this
   * field still decodes the catalog and shows the generic sign-in advice.
   */
  signInNotOffered: Schema.optional(Schema.Literal(true)),
  category: ProviderFailureCategory,
  message: NonEmptyTrimmedString,
  reason: Schema.optional(ProviderRefusalReason),
  diagnostic: Schema.optional(ProviderProcessDiagnostic),
  retryAfterMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000)),
  ),
  /**
   * Present only when the provider's own protocol signal says this stop is a
   * usage limit. Message-text matching never produces it.
   */
  usageLimit: Schema.optional(ProviderUsageLimit),
});
export type ProviderFailure = typeof ProviderFailure.Type;

/**
 * Why a completed reply stopped, when the runtime said so. Absent means the
 * runtime did not say — a normal finish is not guessed into one of these.
 * `max-tokens` is the output limit; `content-filter` is a filter stop.
 */
export const ProviderOutputStopReason = Schema.Literals(["max-tokens", "content-filter"]);
export type ProviderOutputStopReason = typeof ProviderOutputStopReason.Type;

/**
 * What fills a provider-run window, by kind. A kind is the provider's own
 * category where it reports one, or something Octant itself puts in the
 * window and can count (`octant-tools`, `octant-instructions`, `attachments`,
 * and `skills` when Octant sent them). The set is closed so a surface can give
 * each kind one name and one colour.
 */
export const ProviderContextPartKind = Schema.Literals([
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
]);
export type ProviderContextPartKind = typeof ProviderContextPartKind.Type;

/**
 * One part of the window with the honesty of its number. `provider-reported`
 * is the runtime's own count; the other accuracies are Octant's estimate and
 * must be shown as one. `count` is how many things the part holds (tools,
 * files, agents), where that is known.
 */
export const ProviderContextPart = Schema.Struct({
  kind: ProviderContextPartKind,
  tokens: NonNegativeInt,
  accuracy: Schema.Literals([
    "provider-reported",
    "exact-tokenizer",
    "model-family-estimate",
    "conservative-heuristic",
  ]),
  count: Schema.optional(NonNegativeInt),
});
export type ProviderContextPart = typeof ProviderContextPart.Type;

/**
 * Tools the runtime knows about but has not loaded into the window. They hold
 * no share of it, so only how many there are, where known, is carried.
 */
export const ProviderDeferredContextPart = Schema.Struct({
  kind: Schema.Literals(["system-tools", "mcp-tools"]),
  /** Absent when the runtime named the group but not how many it holds. */
  count: Schema.optional(NonNegativeInt),
});
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
export const ProviderSentContextAccounting = Schema.Union([
  Schema.Struct({ status: Schema.Literal("counted") }),
  Schema.Struct({
    status: Schema.Literal("uncounted"),
    reason: Schema.Literals(["retention-unknown", "compacted", "history-unknown"]),
  }),
]);
export type ProviderSentContextAccounting = typeof ProviderSentContextAccounting.Type;

export const ProviderContextBreakdown = Schema.Struct({
  parts: Schema.Array(ProviderContextPart).check(Schema.isMaxLength(16)),
  deferred: Schema.optional(Schema.Array(ProviderDeferredContextPart).check(Schema.isMaxLength(4))),
  /** Absent when the runtime reported its own categories, or before Octant counted any. */
  sentContext: Schema.optional(ProviderSentContextAccounting),
});
export type ProviderContextBreakdown = typeof ProviderContextBreakdown.Type;

const ProviderRuntimeEventFields = {
  instanceId: ProviderInstanceId,
  sessionId: ProviderSessionId,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
  /**
   * Set when the adapter folded stored or replayed provider output into this
   * event rather than reporting a live instant: `occurredAt` then names the
   * batch, not the moment, so nothing downstream may time a span by it.
   */
  synthesized: Schema.optional(Schema.Literal(true)),
} as const;

/**
 * Token counts a runtime reported for one of its own subagents. Each count is
 * present only when the runtime reported it: some runtimes report only a total.
 */
export const ProviderChildUsage = Schema.Struct({
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
});
export type ProviderChildUsage = typeof ProviderChildUsage.Type;
export const MAX_PROVIDER_CHILD_FINAL_SUMMARY = 2048;

/** A provider report is observation only; it carries no execution authority. */
export const ProviderChildActivityEvent = Schema.Struct({
  ...ProviderRuntimeEventFields,
  kind: Schema.Literal("child-agent-activity"),
  childAgentId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  parentChildAgentId: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  ),
  modelId: Schema.optional(ProviderModelId),
  task: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  status: Schema.Literals(["starting", "running", "waiting", "completed", "failed"]),
  summary: NonEmptyTrimmedString,
  /**
   * The subagent's own closing report, as the runtime relayed it. It is
   * outside content: it is shown to the person and never sent to a model.
   */
  finalSummary: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_PROVIDER_CHILD_FINAL_SUMMARY)),
  ),
  usage: Schema.optional(ProviderChildUsage),
});
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
  lifecycleStatus: Schema.Literals([
    "starting",
    "running",
    "waiting",
    "completed",
    "failed",
    "unknown",
  ]),
  latestSummary: Schema.String.check(Schema.isMaxLength(512)),
  finalSummary: ProviderChildActivityEvent.fields.finalSummary,
  usage: ProviderChildActivityEvent.fields.usage,
  firstObservedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  historyStatus: Schema.Literals(["partial", "truncated", "conflicted"]),
  history: Schema.Array(
    Schema.Struct({
      sequence: Schema.Int.check(Schema.isGreaterThan(0)),
      occurredAt: UtcTimestamp,
      status: ProviderChildActivityEvent.fields.status,
      summary: Schema.String.check(Schema.isMaxLength(512)),
    }),
  ).check(Schema.isMaxLength(MAX_PROVIDER_CHILD_HISTORY)),
});
export type ProviderChildObservation = typeof ProviderChildObservation.Type;
export const ProviderChildObservationState = Schema.Struct({
  children: Schema.Array(ProviderChildObservation).check(
    Schema.isMaxLength(MAX_PROVIDER_CHILD_OBSERVATIONS),
  ),
  truncated: Schema.Boolean,
});
export type ProviderChildObservationState = typeof ProviderChildObservationState.Type;
export const decodeProviderChildObservationState = Schema.decodeUnknownSync(
  ProviderChildObservationState,
  STRICT_DECODE_OPTIONS,
);

export const MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH = 8_192;

/**
 * The pending call an approval request is about, as the runtime described it:
 * its tool, the argument fields a reviewer judges as bounded JSON with
 * credentials redacted, and where it runs. It never carries the call's output.
 * A driver hands it to the host through `ProviderConnection.approvalCall` for
 * an automatic reviewer. Judged input is never put on an event or journaled.
 * Optional ownerAction is a separate complete file-operation consent body,
 * shown only through fresh owner authorization and never journaled.
 */
export const ProviderApprovalCall = Schema.Struct({
  /** Complete, unredacted file-operation consent facts, absent when unavailable. Never journal. */
  ownerAction: Schema.optional(OwnerApprovalAction),
  tool: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  input: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH)),
  ),
  workingDirectory: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  ),
});
export type ProviderApprovalCall = typeof ProviderApprovalCall.Type;

/** The most of a runtime tool's result the Watcher is handed. */
export const OUTSIDE_CONTENT_RESULT_MAX_CHARACTERS = 65_536;

/** A point in a runtime's own session, as the runtime names it. */
export const ProviderNativeAnchor = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
);
export type ProviderNativeAnchor = typeof ProviderNativeAnchor.Type;

/** The most of a plan a runtime may put before the person when it asks to leave Plan. */
export const MAX_PROVIDER_PLAN_CHARACTERS = 32_768;
export const ProviderLevelChangeRequest = Schema.Struct({
  kind: Schema.Literals(["enter-plan", "exit-plan"]),
  plan: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_PLAN_CHARACTERS))),
});
export type ProviderLevelChangeRequest = typeof ProviderLevelChangeRequest.Type;

export const ProviderRuntimeEvent = Schema.Union([
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("text-delta"),
    text: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("reasoning-delta"),
    text: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-start"),
    toolCallId: NonEmptyTrimmedString,
    toolName: NonEmptyTrimmedString,
    /**
     * What the tool was asked to do: the first line of the command a shell
     * tool runs, the checkout-relative path a file tool edits. The adapter
     * reduces it to one redacted, bounded line before it crosses, so a raw
     * command or path never rides on a normalized event, and a consumer still
     * redacts before showing it. Optional because many providers report none;
     * never file contents.
     */
    argument: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("outside-content-read"),
    toolCallId: NonEmptyTrimmedString,
    /** The runtime's own name for the tool. */
    toolName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    source: Schema.Literals(["web-search", "web-fetch", "hosted-tool"]),
    target: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("outside-content-result"),
    toolCallId: NonEmptyTrimmedString,
    toolName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    /** `remote-command`: what a server printed for an `ssh`, `scp`, or `rsync` command the runtime ran. */
    source: Schema.Literals(["web-search", "web-fetch", "hosted-tool", "remote-command"]),
    text: Schema.NonEmptyString.check(Schema.isMaxLength(OUTSIDE_CONTENT_RESULT_MAX_CHARACTERS)),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-call-content"),
    toolCallId: NonEmptyTrimmedString,
    part: Schema.Literals(["input", "output"]),
    text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS)),
    truncated: Schema.optional(Schema.Boolean),
    /**
     * Set when the adapter intentionally omitted fields from the input (such
     * as file contents on Edit/Write/NotebookEdit), so consumers know the text
     * is not the tool's complete arguments.
     */
    partial: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-progress"),
    toolCallId: NonEmptyTrimmedString,
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-success"),
    toolCallId: NonEmptyTrimmedString,
    summary: NonEmptyTrimmedString,
    /** A shell tool's exit status, when the runtime reports one. */
    exitCode: Schema.optional(Schema.Int),
    /**
     * The page the tool published outside this host, when it is a tool whose
     * whole result is such a page (a Claude artifact). Only the address and
     * title cross; the adapter checks the address belongs to the service the
     * tool publishes to.
     */
    published: Schema.optional(ThreadPublishedPage),
    /**
     * The pull requests and issues the call wrote to (created, merged,
     * reviewed, commented on, edited, closed or reopened), read by the
     * adapter from the call's own command and result with the shared
     * `forgeReferencesFromToolCall` rules. A call that only read one carries
     * none. The thread is linked to each of them.
     */
    forgeReferences: Schema.optional(ThreadForgeReferences),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-failure"),
    toolCallId: NonEmptyTrimmedString,
    message: NonEmptyTrimmedString,
    /** A shell tool's exit status, when the runtime reports one. */
    exitCode: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("usage"),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
    reasoningTokens: Schema.optional(NonNegativeInt),
    cacheReadInputTokens: Schema.optional(NonNegativeInt),
    cacheWriteInputTokens: Schema.optional(NonNegativeInt),
    providerExecutionDurationMs: Schema.optional(NonNegativeInt),
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
    costUsd: Schema.optional(
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
    ),
    /** Host estimate across known request boundaries; null means incomplete/unpriced. */
    estimatedCostUsd: Schema.optional(
      Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite())),
    ),
    /**
     * The model's context window and how much of it the last request occupied,
     * when the provider reports them alongside usage. A runtime the host does
     * not plan a context for (a CLI it drives) has no other account of the
     * window, so this is what its meter shows.
     */
    contextWindow: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    contextTokens: Schema.optional(NonNegativeInt),
    /**
     * Where the runtime compacts the conversation by itself, in tokens of the
     * window the last request filled. Present only when the runtime said
     * compaction is on and will fire at that point; absent means the runtime
     * said nothing, said it is off, or the host could not read the unit, and
     * no reader may infer a figure from the model's window.
     */
    autoCompactThreshold: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
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
    promptRetention: Schema.optional(Schema.Literals(["kept", "compacted"])),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("file-change"),
    path: NonEmptyTrimmedString,
    change: Schema.Literals(["created", "modified", "deleted"]),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("diff"),
    diff: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("rate-limit-window"),
    window: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    status: Schema.Literals(["allowed", "warning", "exhausted"]),
    /** Share of the window spent, 0 to 1. Absent when the provider gives none. */
    utilization: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
    /** When the window next resets. Absent when the provider gives none. */
    resetsAt: Schema.optional(UtcTimestamp),
    /** Extra-usage posture the process reported with this window, when it did. */
    overage: Schema.optional(
      Schema.Struct({
        status: Schema.Literals(["allowed", "warning", "exhausted"]),
        inUse: Schema.optional(Schema.Boolean),
        resetsAt: Schema.optional(UtcTimestamp),
        disabledReason: Schema.optional(
          Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
        ),
      }),
    ),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("rate-limit-bucket"),
    bucket: Schema.Literals(["requests", "tokens"]),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
    remaining: NonNegativeInt,
    /** When the bucket refills. Absent when the provider gives none. */
    resetsAt: Schema.optional(UtcTimestamp),
  }).check(Schema.makeFilter((event) => event.remaining <= event.limit)),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("retrying"),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
    maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
    delayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 })),
    reason: Schema.Literals([
      "rate-limited",
      "unavailable",
      "stream-interrupted",
      "empty-completion",
    ]),
  }).check(Schema.makeFilter((event) => event.attempt <= event.maxAttempts)),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("context-compacted"),
    trigger: Schema.Literals(["requested", "automatic"]),
    tokensBefore: Schema.optional(NonNegativeInt),
    tokensAfter: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("liveness"),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("runtime-turn-started"),
    trigger: Schema.Literals(["background-task", "person-message"]),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-progress"),
    taskId: NonEmptyTrimmedString,
    status: Schema.Literals(["pending", "in-progress", "completed", "failed"]),
    summary: NonEmptyTrimmedString,
    /** The provider's wording for the task while it runs ("Running the tests"); absent when it has none. */
    runningSummary: Schema.optional(NonEmptyTrimmedString),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("task-list"),
    taskIds: Schema.Array(NonEmptyTrimmedString),
  }),
  ProviderChildActivityEvent,
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("approval-request"),
    /** This action always needs the person; an automatic reviewer cannot answer. */
    requiresUser: Schema.optional(Schema.Boolean),
    requestId: NonEmptyTrimmedString,
    action: NonEmptyTrimmedString,
    description: NonEmptyTrimmedString,
    /**
     * The runtime's own identity for the call this ask gates, when it sent
     * one (a tool_use id, a toolCall id, an item id). Forwarded to the
     * journaled ask so the person's wait is attributed to that call alone;
     * absent means nothing is attributed by adjacency.
     */
    toolCallId: Schema.optional(NonEmptyTrimmedString),
    /**
     * The runtime asks to change the thread's level rather than to run a
     * tool: `enter-plan` to plan read-only first, `exit-plan` to leave Plan
     * and carry out `plan`. Only a session started with `levelChanges` asks
     * this; the runtime never changes its own mode, and an approval applies
     * from the thread's next session.
     */
    levelChange: Schema.optional(ProviderLevelChangeRequest),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("review-verdict"),
    verdict: Schema.Literals(["allow", "deny"]),
    toolCallId: Schema.optional(NonEmptyTrimmedString),
    argument: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
    riskLevel: Schema.optional(Schema.Literals(["low", "medium", "high", "critical"])),
    reason: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(280))),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("user-input-request"),
    questionnaire: Schema.optional(Questionnaire),
    requestId: NonEmptyTrimmedString,
    prompt: NonEmptyTrimmedString,
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
    /**
     * The answer is a secret (a password or key): it is typed into a masked
     * field and goes to the provider in memory only, never into a journal,
     * evidence, log or transcript. A surface that cannot keep it out of its
     * record never receives such a question; the driver refuses it instead.
     */
    secret: Schema.optional(Schema.Literal(true)),
  }).check(
    Schema.makeFilter(
      (event) => (event.questionIndex === undefined) === (event.questionCount === undefined),
    ),
  ),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("tool-request"),
    requestId: BoundedProviderRequestId,
    toolName: BoundedProviderToolName,
    inputJson: BoundedProviderJson,
    /**
     * The `toolCallId` of the runtime's own `tool-start` report of this call,
     * when the adapter can tell which report it is. A runtime that names its
     * calls freely (an ACP agent) reports a host tool once as its own call
     * and once as this request; the host records the request itself, so the
     * report it names here is not left to hold the thread after a restart.
     * Absent when the adapter cannot tell.
     */
    toolCallId: Schema.optional(NonEmptyTrimmedString),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("citation"),
    citationId: BoundedProviderRequestId,
    sourceTitle: BoundedProviderTitle,
    sourceUrl: BoundedProviderUrl,
    snippet: Schema.optional(BoundedProviderSnippet),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("research-started"),
    researchId: BoundedProviderRequestId,
    query: BoundedProviderQuery,
    backend: Schema.Literals(["searxng", "provider-native"]),
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("research-completed"),
    researchId: BoundedProviderRequestId,
    sourceCount: NonNegativeInt,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("interrupted"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("waiting"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("failed"),
    failure: ProviderFailure,
  }),
  Schema.Struct({
    ...ProviderRuntimeEventFields,
    kind: Schema.Literal("completed"),
    resumeCursor: Schema.optional(ProviderResumeCursor),
    /** Present only when the runtime said why this reply stopped. */
    stopReason: Schema.optional(ProviderOutputStopReason),
    /**
     * Where this turn ends in the runtime's own session, in the runtime's own
     * terms (Claude's last assistant message id, a Codex turn id), so a fork
     * or rewind can ask the runtime to cut its session there. Absent when the
     * runtime names no such point.
     */
    nativeAnchor: Schema.optional(ProviderNativeAnchor),
  }),
]);
export type ProviderRuntimeEvent = typeof ProviderRuntimeEvent.Type;

export const decodeProviderInstanceId = Schema.decodeUnknownSync(
  ProviderInstanceId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderSessionId = Schema.decodeUnknownSync(
  ProviderSessionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeDirectoryTenantId = Schema.decodeUnknownSync(
  DirectoryTenantId,
  STRICT_DECODE_OPTIONS,
);
export const decodeDirectoryClientId = Schema.decodeUnknownSync(
  DirectoryClientId,
  STRICT_DECODE_OPTIONS,
);
export const decodeDirectoryIssuer = Schema.decodeUnknownSync(
  DirectoryIssuer,
  STRICT_DECODE_OPTIONS,
);
export const decodeDirectoryIssuerClientId = Schema.decodeUnknownSync(
  DirectoryIssuerClientId,
  STRICT_DECODE_OPTIONS,
);
export const decodeDirectoryResourceScope = Schema.decodeUnknownSync(
  DirectoryResourceScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeCloudIamRegion = Schema.decodeUnknownSync(CloudIamRegion, STRICT_DECODE_OPTIONS);
export const decodeCloudIamStartUrl = Schema.decodeUnknownSync(
  CloudIamStartUrl,
  STRICT_DECODE_OPTIONS,
);
export const decodeCloudAccountId = Schema.decodeUnknownSync(CloudAccountId, STRICT_DECODE_OPTIONS);
export const decodeCloudRoleName = Schema.decodeUnknownSync(CloudRoleName, STRICT_DECODE_OPTIONS);
export const decodeProviderModelId = Schema.decodeUnknownSync(
  ProviderModelId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderDriverKind = Schema.decodeUnknownSync(
  ProviderDriverKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstance = Schema.decodeUnknownSync(
  ProviderInstance,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderDefaults = Schema.decodeUnknownSync(
  ProviderDefaults,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceCreated = Schema.decodeUnknownSync(
  ProviderInstanceCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceRenamed = Schema.decodeUnknownSync(
  ProviderInstanceRenamed,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceBinaryChanged = Schema.decodeUnknownSync(
  ProviderInstanceBinaryChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceConfigurationChanged = Schema.decodeUnknownSync(
  ProviderInstanceConfigurationChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceDriverRebound = Schema.decodeUnknownSync(
  ProviderInstanceDriverRebound,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceDriverQuarantined = Schema.decodeUnknownSync(
  ProviderInstanceDriverQuarantined,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceEnabledChanged = Schema.decodeUnknownSync(
  ProviderInstanceEnabledChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceNativeSetupChanged = Schema.decodeUnknownSync(
  ProviderInstanceNativeSetupChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceOwnMemoryChanged = Schema.decodeUnknownSync(
  ProviderInstanceOwnMemoryChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderNativeSetup = Schema.decodeUnknownSync(
  ProviderNativeSetup,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceDataTagsChanged = Schema.decodeUnknownSync(
  ProviderInstanceDataTagsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInstanceRemoved = Schema.decodeUnknownSync(
  ProviderInstanceRemoved,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderDefaultsUpdated = Schema.decodeUnknownSync(
  ProviderDefaultsUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCatalogSnapshot = Schema.decodeUnknownSync(
  ProviderCatalogSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCatalogUpdated = Schema.decodeUnknownSync(
  ProviderCatalogUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderAcpAgentInstallScriptsRan = Schema.decodeUnknownSync(
  ProviderAcpAgentInstallScriptsRan,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderModelOption = Schema.decodeUnknownSync(
  ProviderModelOption,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderModelOptionValues = Schema.decodeUnknownSync(
  ProviderModelOptionValues,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderModel = Schema.decodeUnknownSync(ProviderModel, STRICT_DECODE_OPTIONS);
export const decodeProviderCapabilities = Schema.decodeUnknownSync(
  ProviderCapabilities,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderObservedState = Schema.decodeUnknownSync(
  ProviderObservedState,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderModelToolCheck = Schema.decodeUnknownSync(
  ProviderModelToolCheck,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderRegistrySnapshot = Schema.decodeUnknownSync(
  ProviderRegistrySnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderProbeResult = Schema.decodeUnknownSync(
  ProviderProbeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderResumeCursor = Schema.decodeUnknownSync(
  ProviderResumeCursor,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderInputModality = Schema.decodeUnknownSync(
  ProviderInputModality,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderAttachmentInput = Schema.decodeUnknownSync(
  ProviderAttachmentInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderToolDefinition = Schema.decodeUnknownSync(
  ProviderToolDefinition,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderContextBlock = Schema.decodeUnknownSync(
  ProviderContextBlock,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderTurnInput = Schema.decodeUnknownSync(
  ProviderTurnInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderToolAnswer = Schema.decodeUnknownSync(
  ProviderToolAnswer,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderRuntimeEvent = Schema.decodeUnknownSync(
  ProviderRuntimeEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderFailure = Schema.decodeUnknownSync(
  ProviderFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeOllamaHistorySnapshot = Schema.decodeUnknownSync(
  OllamaHistorySnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeOllamaHistoryRecorded = Schema.decodeUnknownSync(
  OllamaHistoryRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeClaudeResumeIdentityRecorded = Schema.decodeUnknownSync(
  ClaudeResumeIdentityRecorded,
  STRICT_DECODE_OPTIONS,
);
