import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import {
  ACP_AGENT_KINDS,
  acpAgentKindOfConfiguration,
  type AcpAgentKind,
} from "./acpAgentProfiles";
import {
  AcpAgentArguments,
  AcpAgentConfiguration,
  acpAgentChangeCommandKind,
  acpAgentCreateCommandKind,
  AcpRegistryAgentId,
  AmazonBedrockProviderConfiguration,
  AnthropicCompatibleProviderConfiguration,
  AzureFoundryProviderConfiguration,
  BflImageProviderConfiguration,
  ClaudeAccountAccent,
  ClaudeProviderConfiguration,
  CodexProviderConfiguration,
  FalVideoProviderConfiguration,
  GeminiImageProviderConfiguration,
  GeminiVideoProviderConfiguration,
  IdeogramImageProviderConfiguration,
  OhMyPiProviderConfiguration,
  OllamaProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  OpenAiImageProviderConfiguration,
  OutsideHarnessEndpointProviderConfiguration,
  OutsideImageProviderConfiguration,
  OutsideVideoProviderConfiguration,
  PermissionPersistence,
  PiProviderConfiguration,
  ProviderCatalogSnapshot,
  ProviderDataTags,
  ProviderDefaults,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderProbeResult,
  ProviderProcessDiagnostic,
  RunwayVideoProviderConfiguration,
  UniqueAgentEligibleModels,
  UniqueHiddenProviderModels,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

const ProviderInstanceCommandFields = {
  instanceId: ProviderInstanceId,
  expectedVersion: AggregateVersion,
} as const;

const CreateProviderCommandFields = {
  ...ProviderInstanceCommandFields,
  enabled: Schema.optional(Schema.Boolean),
} as const;

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
  /** The sign-in page may show a code for the person to paste back into Octant. */
  codeEntry: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type ProviderAuthenticationAttempt = typeof ProviderAuthenticationAttempt.Type;

// A pasted sign-in code: printable, no spaces, short. It is written to the
// provider CLI's input as one line, so nothing that could end the line early
// or steer a terminal is admitted.
export const ProviderAuthenticationCode = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^[\x21-\x7e]+$/),
);

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
    kind: Schema.Literal("create-gemini-video-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: GeminiVideoProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-runway-video-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: RunwayVideoProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-fal-video-provider"),
    ...CreateProviderCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: FalVideoProviderConfiguration,
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
  /**
   * Adds an image provider from an admitted outside image driver. Like the
   * harness command above it takes no `enabled`: the profile is created off.
   */
  Schema.Struct({
    kind: Schema.Literal("create-outside-image-provider"),
    ...ProviderInstanceCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OutsideImageProviderConfiguration,
  }).annotations(strict),
  /** Changes an outside image provider's address, key placement, or models; never its driver. */
  Schema.Struct({
    kind: Schema.Literal("change-outside-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideImageProviderConfiguration,
  }).annotations(strict),
  /** Adds a video provider from an admitted outside video driver; created off, as above. */
  Schema.Struct({
    kind: Schema.Literal("create-outside-video-provider"),
    ...ProviderInstanceCommandFields,
    displayName: Schema.NonEmptyTrimmedString,
    configuration: OutsideVideoProviderConfiguration,
  }).annotations(strict),
  /** Changes an outside video provider's address, key placement, or models; never its driver. */
  Schema.Struct({
    kind: Schema.Literal("change-outside-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideVideoProviderConfiguration,
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
    kind: Schema.Literal("change-gemini-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GeminiVideoProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-runway-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: RunwayVideoProviderConfiguration,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-fal-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: FalVideoProviderConfiguration,
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
   * Adds any ACP agent, installed nothing, untrusted and off. A registry agent
   * is named by its registry id alone: its name, release, distribution,
   * arguments and environment come from the host's own listing. A local agent
   * is the person's absolute executable and literal arguments; it takes no
   * environment, so no key travels in it. The host refuses it, and the
   * install and trust steps below, from a client that does not act as the
   * host's own person.
   */
  Schema.Struct({
    kind: Schema.Literal("add-acp-agent"),
    ...ProviderInstanceCommandFields,
    source: Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("registry"),
        registryId: AcpRegistryAgentId,
      }).annotations(strict),
      Schema.Struct({
        kind: Schema.Literal("local"),
        displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80)),
        command: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
        args: AcpAgentArguments,
      }).annotations(strict),
    ),
  }).annotations(strict),
  /**
   * Installs an added agent into Octant's managed folder (a registry agent) or
   * checks the person's executable is on disk (a local agent). Nothing the
   * install puts on disk is run.
   */
  Schema.Struct({
    kind: Schema.Literal("install-acp-agent"),
    ...ProviderInstanceCommandFields,
  }).annotations(strict),
  /** Trusts an installed agent, or takes that trust back. */
  Schema.Struct({
    kind: Schema.Literal("set-acp-agent-trust"),
    ...ProviderInstanceCommandFields,
    trusted: Schema.Boolean,
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
  /**
   * Turns the provider's own memory on or off for one Claude Code or Codex
   * account. Only a person at the Octant window on this host sends it.
   */
  Schema.Struct({
    kind: Schema.Literal("set-provider-own-memory"),
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
    /**
     * The code a provider's sign-in page shows when its own CLI could not
     * take the browser's answer itself; the host hands it to that CLI.
     */
    code: Schema.optional(ProviderAuthenticationCode),
  }).annotations(strict),
);
export type ProviderRegistryCommand = typeof ProviderRegistryCommand.Type;

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
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-pending"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
);
export type ProviderRegistryCommandResult = typeof ProviderRegistryCommandResult.Type;

export const decodeProviderAuthenticationAttempt = Schema.decodeUnknownSync(
  ProviderAuthenticationAttempt,
);
export const decodeProviderRegistryCommand = Schema.decodeUnknownSync(ProviderRegistryCommand);
export const decodeProviderRegistryCommandResult = Schema.decodeUnknownSync(
  ProviderRegistryCommandResult,
);

export {
  ThreadNativeSetupResult,
  ThreadProjectCodeResult,
  ThreadProviderMentionsResult,
} from "./threadNativeSetup";
