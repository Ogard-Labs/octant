import type {
  AgentEligibleModelRef,
  AnthropicCompatibleProviderConfiguration,
  AzureFoundryProviderConfiguration,
  ClaudeProviderConfiguration,
  DevinProviderConfiguration,
  DiscoverySnapshot,
  GrokProviderConfiguration,
  GlmProviderConfiguration,
  GeminiProviderConfiguration,
  CopilotProviderConfiguration,
  ClineProviderConfiguration,
  QwenProviderConfiguration,
  GooseProviderConfiguration,
  KiloProviderConfiguration,
  MistralVibeProviderConfiguration,
  GeminiImageProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  OpenAiImageProviderConfiguration,
  OllamaProviderConfiguration,
  OhMyPiProviderConfiguration,
  PiProviderConfiguration,
  PermissionPersistence,
  ProviderCredentialStatus,
  ProviderAuthenticationAttempt,
  ProviderDefaults,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { ProviderCreateForm } from "./ProviderSettingsConfiguration";
import { ProviderSettingsList } from "./ProviderSettingsList";
import type { TransientProviderCredential } from "./useProviderController";

export interface ProviderSettingsViewProps {
  readonly status: "loading" | "ready" | "disconnected";
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly discoverySnapshot?: DiscoverySnapshot;
  readonly discovery?: ReactNode;
  readonly defaults: ProviderDefaults;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly probingIds: ReadonlySet<ProviderInstanceId>;
  readonly busy: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly message?: string;
  readonly onCreate: (
    driverKind:
      | "opencode"
      | "codex"
      | "kimi-code"
      | "devin"
      | "kilo"
      | "pi"
      | "oh-my-pi"
      | "goose"
      | "copilot",
    displayName: string,
    binaryPath: string,
  ) => Promise<boolean>;
  readonly onCreateOpenAiCompatible: (
    displayName: string,
    configuration: OpenAiCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateAnthropicCompatible: (
    displayName: string,
    configuration: AnthropicCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateAzureFoundry: (
    displayName: string,
    configuration: AzureFoundryProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateOpenAiImage: (
    displayName: string,
    configuration: OpenAiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateGeminiImage: (
    displayName: string,
    configuration: GeminiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateClaude: (
    displayName: string,
    configuration: ClaudeProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateMistralVibe: (
    displayName: string,
    configuration: MistralVibeProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateGrok: (
    displayName: string,
    configuration: GrokProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateGlm: (
    displayName: string,
    configuration: GlmProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateGemini: (
    displayName: string,
    configuration: GeminiProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateCline: (
    displayName: string,
    configuration: ClineProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateQwen: (
    displayName: string,
    configuration: QwenProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onCreateOllama: (
    displayName: string,
    configuration: OllamaProviderConfiguration,
  ) => Promise<boolean>;
  readonly onRename: (instanceId: ProviderInstanceId, displayName: string) => Promise<boolean>;
  readonly onChangeBinary: (instanceId: ProviderInstanceId, binaryPath: string) => Promise<boolean>;
  readonly onChangeOpenAiCompatibleConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OpenAiCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeAnthropicCompatibleConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AnthropicCompatibleProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeAzureFoundryConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: AzureFoundryProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeOpenAiImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OpenAiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeGeminiImageConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GeminiImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeClaudeConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: ClaudeProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeMistralVibeConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: MistralVibeProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeGrokConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GrokProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeGooseConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GooseProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeGlmConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GlmProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeGeminiConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: GeminiProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeCopilotConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: CopilotProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeClineConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: ClineProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeQwenConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: QwenProviderConfiguration,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onChangeDevinConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: DevinProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeKiloConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: KiloProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangePiConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: PiProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeOhMyPiConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OhMyPiProviderConfiguration,
  ) => Promise<boolean>;
  readonly onChangeOllamaConfiguration: (
    instanceId: ProviderInstanceId,
    configuration: OllamaProviderConfiguration,
  ) => Promise<boolean>;
  readonly onBeginProviderAuthentication: (
    instanceId: ProviderInstanceId,
  ) => Promise<ProviderAuthenticationAttempt | undefined>;
  readonly onCompleteProviderAuthentication: (
    instanceId: ProviderInstanceId,
    attemptId: ProviderAuthenticationAttempt["attemptId"],
  ) => Promise<boolean>;
  readonly onProviderCredentialStatus: (
    instanceId: ProviderInstanceId,
  ) => Promise<ProviderCredentialStatus>;
  readonly onClearProviderCredential: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onSetEnabled: (instanceId: ProviderInstanceId, enabled: boolean) => Promise<boolean>;
  readonly onRemove: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onProbe: (instanceId: ProviderInstanceId) => Promise<boolean>;
  readonly onVerifyFoundryTools: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => Promise<boolean>;
  readonly onPermissionPersistenceChange: (value: PermissionPersistence) => Promise<boolean>;
  readonly onProviderOrderChange: (
    providerOrder: ReadonlyArray<ProviderInstanceId>,
  ) => Promise<boolean>;
  readonly onAgentEligibleModelsChange: (
    agentEligibleModels: ReadonlyArray<AgentEligibleModelRef>,
  ) => Promise<boolean>;
  readonly onRetry: () => Promise<boolean>;
}

export function ProviderSettingsView(props: ProviderSettingsViewProps) {
  // The settings shell already renders the pane's `.setpane-title` and
  // `.setpane-note`; repeating an identity heading here read as three titles
  // in a row, so the pane goes straight to content and keeps global knobs in
  // a trailing Defaults group.
  return (
    <div className="provider-settings">
      {props.status === "loading" ? <p role="status">Loading providers…</p> : null}
      {props.status === "disconnected" ? (
        <OctantButton
          className="settings-view__action"
          onClick={() => void props.onRetry()}
          type="button"
        >
          Retry provider connection
        </OctantButton>
      ) : null}
      {props.message === undefined ? null : (
        <p className="provider-settings__alert" role="alert">
          {props.message}
        </p>
      )}
      {props.discovery}
      <ProviderSettingsList
        busy={props.busy}
        createForm={
          <ProviderCreateForm
            busy={props.busy}
            credentialManagementAvailable={props.credentialManagementAvailable}
            onCreate={props.onCreate}
            onCreateAnthropicCompatible={props.onCreateAnthropicCompatible}
            onCreateAzureFoundry={props.onCreateAzureFoundry}
            onCreateClaude={props.onCreateClaude}
            onCreateGrok={props.onCreateGrok}
            onCreateGlm={props.onCreateGlm}
            onCreateGemini={props.onCreateGemini}
            onCreateCline={props.onCreateCline}
            onCreateQwen={props.onCreateQwen}
            onCreateMistralVibe={props.onCreateMistralVibe}
            onCreateOllama={props.onCreateOllama}
            onCreateOpenAiCompatible={props.onCreateOpenAiCompatible}
            onCreateOpenAiImage={props.onCreateOpenAiImage}
            onCreateGeminiImage={props.onCreateGeminiImage}
          />
        }
        credentialManagementAvailable={props.credentialManagementAvailable}
        defaults={props.defaults}
        discoverySnapshot={props.discoverySnapshot}
        instances={props.instances}
        observedByInstance={props.observedByInstance}
        probingIds={props.probingIds}
        status={props.status}
        onAgentEligibleModelsChange={props.onAgentEligibleModelsChange}
        onBeginProviderAuthentication={props.onBeginProviderAuthentication}
        onChangeAnthropicCompatibleConfiguration={props.onChangeAnthropicCompatibleConfiguration}
        onChangeAzureFoundryConfiguration={props.onChangeAzureFoundryConfiguration}
        onChangeBinary={props.onChangeBinary}
        onChangeClaudeConfiguration={props.onChangeClaudeConfiguration}
        onChangeDevinConfiguration={props.onChangeDevinConfiguration}
        onChangeGrokConfiguration={props.onChangeGrokConfiguration}
        onChangeGooseConfiguration={props.onChangeGooseConfiguration}
        onChangeGlmConfiguration={props.onChangeGlmConfiguration}
        onChangeGeminiConfiguration={props.onChangeGeminiConfiguration}
        onChangeCopilotConfiguration={props.onChangeCopilotConfiguration}
        onChangeClineConfiguration={props.onChangeClineConfiguration}
        onChangeQwenConfiguration={props.onChangeQwenConfiguration}
        onChangeKiloConfiguration={props.onChangeKiloConfiguration}
        onChangeMistralVibeConfiguration={props.onChangeMistralVibeConfiguration}
        onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
        onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
        onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
        onChangeOpenAiImageConfiguration={props.onChangeOpenAiImageConfiguration}
        onChangeGeminiImageConfiguration={props.onChangeGeminiImageConfiguration}
        onChangePiConfiguration={props.onChangePiConfiguration}
        onClearProviderCredential={props.onClearProviderCredential}
        onCompleteProviderAuthentication={props.onCompleteProviderAuthentication}
        onProbe={props.onProbe}
        onProviderCredentialStatus={props.onProviderCredentialStatus}
        onProviderOrderChange={props.onProviderOrderChange}
        onRemove={props.onRemove}
        onRename={props.onRename}
        onSetEnabled={props.onSetEnabled}
        onVerifyFoundryTools={props.onVerifyFoundryTools}
      />
      <section aria-label="Defaults" className="settings-card-section settings-card-section--open">
        <h2>Defaults</h2>
        <div className="setgroup">
          <div className="setrow">
            <span className="setrow-label">Permission persistence</span>
            <p className="setrow-hint">
              <span>How long a granted provider approval lasts.</span>
            </p>
            <div className="setrow-control">
              <OctantSelectField
                aria-label="Permission persistence"
                className="settings-view__select window-no-drag"
                disabled={props.busy}
                onValueChange={(value) =>
                  void props.onPermissionPersistenceChange(value as PermissionPersistence)
                }
                options={[
                  { id: "current-session", label: "Current session only" },
                  { id: "project-default", label: "Remember for this Project" },
                ]}
                value={props.defaults.permissionPersistence}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
