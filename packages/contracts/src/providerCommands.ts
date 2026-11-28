import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

const brandedString = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand<B>(brand));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

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
  kind: Schema.Literals(ACP_AGENT_KINDS.map(acpAgentCreateCommandKind)),
  ...CreateProviderCommandFields,
  displayName: NonEmptyTrimmedString,
  configuration: AcpAgentConfiguration,
}).check(
  Schema.makeFilter(
    (command) =>
      command.kind ===
      acpAgentCreateCommandKind(acpAgentKindOfConfiguration(command.configuration.kind)),
  ),
);
export type CreateAcpAgentProviderCommand = typeof CreateAcpAgentProviderCommand.Type;

export const ChangeAcpAgentConfigurationCommand = Schema.Struct({
  kind: Schema.Literals(ACP_AGENT_KINDS.map(acpAgentChangeCommandKind)),
  ...ProviderInstanceCommandFields,
  configuration: AcpAgentConfiguration,
}).check(
  Schema.makeFilter(
    (command) =>
      command.kind ===
      acpAgentChangeCommandKind(acpAgentKindOfConfiguration(command.configuration.kind)),
  ),
);
export type ChangeAcpAgentConfigurationCommand = typeof ChangeAcpAgentConfigurationCommand.Type;

const ProviderAuthenticationAttemptId = brandedString("ProviderAuthenticationAttemptId");
export const ProviderAuthenticationAttempt = Schema.Struct({
  attemptId: ProviderAuthenticationAttemptId,
  signInUrl: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => {
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
});
export type ProviderAuthenticationAttempt = typeof ProviderAuthenticationAttempt.Type;

// A pasted sign-in code: printable, no spaces, short. It is written to the
// provider CLI's input as one line, so nothing that could end the line early
// or steer a terminal is admitted.
export const ProviderAuthenticationCode = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[\x21-\x7e]+$/),
);

export const ProviderRegistryCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-opencode-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    binaryPath: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-openai-compatible-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OpenAiCompatibleProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-anthropic-compatible-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: AnthropicCompatibleProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-azure-foundry-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: AzureFoundryProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-amazon-bedrock-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: AmazonBedrockProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-openai-image-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OpenAiImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-gemini-native-image-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: GeminiImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-bfl-image-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: BflImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-ideogram-image-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: IdeogramImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-gemini-video-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: GeminiVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-runway-video-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: RunwayVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-fal-video-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: FalVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-codex-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    binaryPath: NonEmptyTrimmedString,
    accent: Schema.optional(ClaudeAccountAccent),
  }),
  CreateAcpAgentProviderCommand,
  Schema.Struct({
    kind: Schema.Literal("create-claude-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: ClaudeProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-pi-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: PiProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-oh-my-pi-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OhMyPiProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-ollama-provider"),
    ...CreateProviderCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OllamaProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-outside-harness-endpoint-provider"),
    ...ProviderInstanceCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OutsideHarnessEndpointProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-outside-harness-endpoint-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideHarnessEndpointProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-outside-image-provider"),
    ...ProviderInstanceCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OutsideImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-outside-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("create-outside-video-provider"),
    ...ProviderInstanceCommandFields,
    displayName: NonEmptyTrimmedString,
    configuration: OutsideVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-outside-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OutsideVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("rename-provider"),
    ...ProviderInstanceCommandFields,
    displayName: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-provider-binary"),
    ...ProviderInstanceCommandFields,
    binaryPath: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-openai-compatible-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OpenAiCompatibleProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-anthropic-compatible-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AnthropicCompatibleProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-azure-foundry-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AzureFoundryProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-amazon-bedrock-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: AmazonBedrockProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-openai-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OpenAiImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-gemini-native-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GeminiImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-bfl-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: BflImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-ideogram-image-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: IdeogramImageProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-gemini-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: GeminiVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-runway-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: RunwayVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-fal-video-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: FalVideoProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-claude-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: ClaudeProviderConfiguration,
    /** Replaces a legacy custom directory with Octant's assigned leaf. */
    reassignAccountDirectory: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("change-codex-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: CodexProviderConfiguration,
    /** Replaces a leftover custom directory with Octant's assigned leaf. */
    reassignAccountDirectory: Schema.optional(Schema.Boolean),
  }),
  ChangeAcpAgentConfigurationCommand,
  Schema.Struct({
    kind: Schema.Literal("change-pi-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: PiProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-oh-my-pi-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OhMyPiProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-ollama-configuration"),
    ...ProviderInstanceCommandFields,
    configuration: OllamaProviderConfiguration,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-enabled"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("add-acp-agent"),
    ...ProviderInstanceCommandFields,
    source: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("registry"),
        registryId: AcpRegistryAgentId,
      }),
      Schema.Struct({
        kind: Schema.Literal("local"),
        displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
        command: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
        args: AcpAgentArguments,
      }),
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("install-acp-agent"),
    ...ProviderInstanceCommandFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-acp-agent-trust"),
    ...ProviderInstanceCommandFields,
    trusted: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-claude-artifact-delivery"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-native-setup"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-own-memory"),
    ...ProviderInstanceCommandFields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-data-tags"),
    ...ProviderInstanceCommandFields,
    dataTags: ProviderDataTags,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-model-data-tags"),
    ...ProviderInstanceCommandFields,
    modelId: ProviderModelId,
    dataTags: ProviderDataTags,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-provider-model-context-window"),
    ...ProviderInstanceCommandFields,
    modelId: ProviderModelId,
    contextWindow: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-provider"),
    ...ProviderInstanceCommandFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("update-provider-defaults"),
    expectedVersion: AggregateVersion,
    permissionPersistence: PermissionPersistence,
    providerOrder: Schema.optional(
      Schema.Array(ProviderInstanceId).check(
        Schema.makeFilter((ids) => new Set(ids).size === ids.length),
      ),
    ),
    agentEligibleModels: Schema.optional(UniqueAgentEligibleModels),
    hiddenModels: Schema.optional(UniqueHiddenProviderModels),
  }),
  Schema.Struct({
    kind: Schema.Literal("probe-provider"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("update-provider-cli"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("check-provider-latest-version"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("verify-model-tools"),
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }),
  Schema.Struct({
    kind: Schema.Literal("begin-provider-authentication"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("complete-provider-authentication"),
    instanceId: ProviderInstanceId,
    attemptId: ProviderAuthenticationAttemptId,
    /**
     * The code a provider's sign-in page shows when its own CLI could not
     * take the browser's answer itself; the host hands it to that CLI.
     */
    code: Schema.optional(ProviderAuthenticationCode),
  }),
]);
export type ProviderRegistryCommand = typeof ProviderRegistryCommand.Type;

export const ProviderRegistryCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("provider-created"),
    instance: ProviderInstance,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-updated"),
    instance: ProviderInstance,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-model-tags-updated"),
    snapshot: ProviderCatalogSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-model-updated"),
    snapshot: ProviderCatalogSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-removed"),
    instanceId: ProviderInstanceId,
    version: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-defaults-updated"),
    defaults: ProviderDefaults,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-probed"),
    result: ProviderProbeResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-cli-updated"),
    instanceId: ProviderInstanceId,
    status: Schema.Literals(["updated", "already-current", "version-unknown", "probe-failed"]),
    previousVersion: Schema.optional(NonEmptyTrimmedString),
    currentVersion: Schema.optional(NonEmptyTrimmedString),
    message: Schema.optional(NonEmptyTrimmedString),
    diagnostic: Schema.optional(ProviderProcessDiagnostic),
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-latest-version"),
    instanceId: ProviderInstanceId,
    /** Absent when the check is off, offline, or the provider has no sanctioned source. */
    latestVersion: Schema.optional(NonEmptyTrimmedString),
  }),
  Schema.Struct({
    kind: Schema.Literal("model-tools-verified"),
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    appManagedTools: Schema.Literals(["supported", "unsupported"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-started"),
    instanceId: ProviderInstanceId,
    attempt: ProviderAuthenticationAttempt,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-completed"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-authentication-pending"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderRegistryCommandResult = typeof ProviderRegistryCommandResult.Type;

export const decodeProviderAuthenticationAttempt = Schema.decodeUnknownSync(
  ProviderAuthenticationAttempt,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderRegistryCommand = Schema.decodeUnknownSync(
  ProviderRegistryCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderRegistryCommandResult = Schema.decodeUnknownSync(
  ProviderRegistryCommandResult,
  STRICT_DECODE_OPTIONS,
);

export {
  ThreadNativeSetupResult,
  ThreadProjectCodeResult,
  ThreadProviderMentionsResult,
} from "./threadNativeSetup";
