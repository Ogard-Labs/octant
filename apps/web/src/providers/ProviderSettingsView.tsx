import type {
  AgentEligibleModelRef,
  AnthropicCompatibleProviderConfiguration,
  AzureFoundryProviderConfiguration,
  ClaudeProviderConfiguration,
  DevinProviderConfiguration,
  DiscoverySnapshot,
  GrokProviderConfiguration,
  KiloProviderConfiguration,
  MistralVibeProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
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
import { OctantNativeSelect } from "../ui/base/OctantSelect";
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
    driverKind: "opencode" | "codex" | "kimi-code" | "devin" | "kilo" | "pi" | "oh-my-pi",
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
  return (
    <div className="provider-settings">
      <div className="provider-settings__intro">
        <div>
          <h2>Providers</h2>
          <p>Configure provider runtimes and inspect their normalized capabilities.</p>
        </div>
        <label className="provider-settings__permission">
          <span>Permission persistence</span>
          <OctantNativeSelect
            aria-label="Permission persistence"
            className="settings-view__select window-no-drag"
            disabled={props.busy}
            onChange={(event) =>
              void props.onPermissionPersistenceChange(
                event.currentTarget.value as PermissionPersistence,
              )
            }
            value={props.defaults.permissionPersistence}
          >
            <option value="current-session">Current session only</option>
            <option value="project-default">Remember for this Project</option>
          </OctantNativeSelect>
        </label>
      </div>
      <p className="provider-settings__hint">
        CLI authentication remains provider-managed. Compatible HTTP credentials are stored
        write-only in the Octant host Keychain.
      </p>
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
            onCreateMistralVibe={props.onCreateMistralVibe}
            onCreateOllama={props.onCreateOllama}
            onCreateOpenAiCompatible={props.onCreateOpenAiCompatible}
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
        onChangeKiloConfiguration={props.onChangeKiloConfiguration}
        onChangeMistralVibeConfiguration={props.onChangeMistralVibeConfiguration}
        onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
        onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
        onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
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
    </div>
  );
}
