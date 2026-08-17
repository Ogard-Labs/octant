import type {
  AgentEligibleModelRef,
  AnthropicCompatibleAuthentication,
  AnthropicCompatibleProtocol,
  AnthropicCompatibleProviderConfiguration,
  AzureFoundryProviderConfiguration,
  ClaudeAuthentication,
  ClaudeProviderConfiguration,
  DevinProviderConfiguration,
  DiscoverySnapshot,
  GrokAuthentication,
  GrokProviderConfiguration,
  KiloProviderConfiguration,
  MistralVibeAuthentication,
  MistralVibeProviderConfiguration,
  OpenAiCompatibleProtocol,
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
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
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

const capabilityLabels: ReadonlyArray<
  readonly [keyof ProviderObservedState["capabilities"], string]
> = [
  ["streaming", "Streaming"],
  ["resume", "Resume"],
  ["interruption", "Interruption"],
  ["approvals", "Approvals"],
  ["userQuestions", "User questions"],
  ["reasoning", "Reasoning"],
  ["usage", "Usage"],
  ["toolActivity", "Tool activity"],
  ["fileChanges", "File changes"],
  ["diffs", "Diffs"],
  ["taskProgress", "Task progress"],
  ["nativeChildAgents", "Native child agents"],
];
const probeTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ProviderSettingsView(props: ProviderSettingsViewProps) {
  const [creating, setCreating] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [providerType, setProviderType] = useState<
    | "opencode"
    | "codex"
    | "kimi-code"
    | "claude"
    | "devin"
    | "kilo"
    | "pi"
    | "oh-my-pi"
    | "ollama"
    | "mistral-vibe"
    | "grok"
    | "openai-compatible"
    | "anthropic-compatible"
    | "azure-foundry"
  >("opencode");
  const [claudeAuthentication, setClaudeAuthentication] =
    useState<ClaudeAuthentication>("subscription");
  const [vibeAuthentication, setVibeAuthentication] =
    useState<MistralVibeAuthentication>("subscription");
  const [grokAuthentication, setGrokAuthentication] =
    useState<GrokAuthentication>("subscription");
  const credentialInput = useRef<HTMLInputElement>(null);
  const selectedDriverLabel = driverLabel(providerType);
  const selectedBinaryName =
    providerType === "mistral-vibe"
      ? "vibe-acp"
      : providerType === "oh-my-pi"
        ? "omp"
        : providerType;
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
      {props.status === "ready" ? (
        <section
          className="provider-settings__manual"
          data-expanded={manualOpen ? "true" : "false"}
        >
          <button
            aria-expanded={manualOpen}
            className="provider-settings__manual-trigger window-no-drag"
            onClick={() => setManualOpen((current) => !current)}
            type="button"
          >
            <span>Add provider manually</span>
            <ChevronDown
              aria-hidden="true"
              className="provider-settings__disclosure-icon"
              size={15}
            />
          </button>
          {manualOpen ? (
            <div className="provider-settings__manual-body">
              <div className="provider-settings__create-heading">
                <h3>Custom endpoint or binary</h3>
                <p className="provider-settings__hint">
                  Installed runtimes are detected automatically. Use this only for a custom HTTP
                  endpoint or an unusual executable location.
                </p>
              </div>
              <form
                aria-label={
                  providerType === "openai-compatible"
                    ? "Add OpenAI-compatible provider"
                    : providerType === "anthropic-compatible"
                      ? "Add Anthropic-compatible provider"
                      : providerType === "azure-foundry"
                        ? "Add Azure AI Foundry provider"
                        : providerType === "ollama"
                          ? "Add Ollama provider"
                          : providerType === "claude"
                            ? "Add Claude provider"
                            : providerType === "mistral-vibe"
                              ? "Add Mistral Vibe provider"
                              : providerType === "grok"
                                ? "Add Grok Build provider"
                                : "Add provider"
                }
                className={`provider-settings__create provider-settings__create--${providerType}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  setCreating(true);
                  let operation: Promise<boolean>;
                  if (
                    providerType === "opencode" ||
                    providerType === "codex" ||
                    providerType === "kimi-code" ||
                    providerType === "devin" ||
                    providerType === "kilo" ||
                    providerType === "pi" ||
                    providerType === "oh-my-pi"
                  ) {
                    operation = props.onCreate(
                      providerType,
                      String(data.get("displayName") ?? ""),
                      String(data.get("binaryPath") ?? ""),
                    );
                  } else if (providerType === "claude") {
                    const configuration: ClaudeProviderConfiguration = {
                      kind: "claude-agent-sdk",
                      binaryPath: String(data.get("binaryPath") ?? ""),
                      authentication: claudeAuthentication,
                    };
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateClaude(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      claudeAuthentication === "api-key"
                        ? enteredCredential
                        : emptyTransientCredential(enteredCredential),
                    );
                  } else if (providerType === "mistral-vibe") {
                    const configuration: MistralVibeProviderConfiguration = {
                      kind: "mistral-vibe-acp",
                      binaryPath: String(data.get("binaryPath") ?? ""),
                      authentication: vibeAuthentication,
                    };
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateMistralVibe(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      vibeAuthentication === "api-key"
                        ? enteredCredential
                        : emptyTransientCredential(enteredCredential),
                    );
                  } else if (providerType === "grok") {
                    const configuration: GrokProviderConfiguration = {
                      kind: "grok-acp",
                      binaryPath: String(data.get("binaryPath") ?? ""),
                      authentication: grokAuthentication,
                    };
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateGrok(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      grokAuthentication === "api-key"
                        ? enteredCredential
                        : emptyTransientCredential(enteredCredential),
                    );
                  } else if (providerType === "ollama") {
                    operation = props.onCreateOllama(String(data.get("displayName") ?? ""), {
                      kind: "ollama-native-http",
                      baseUrl: String(data.get("baseUrl") ?? ""),
                    });
                  } else if (providerType === "anthropic-compatible") {
                    const configuration = anthropicConfigurationFrom(data);
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateAnthropicCompatible(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      configuration.authentication !== "none"
                        ? enteredCredential
                        : emptyTransientCredential(enteredCredential),
                    );
                  } else if (providerType === "azure-foundry") {
                    const configuration = foundryConfigurationFrom(data);
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateAzureFoundry(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      enteredCredential,
                    );
                  } else {
                    const configuration = configurationFrom(data);
                    const enteredCredential = transientCredential(credentialInput.current);
                    operation = props.onCreateOpenAiCompatible(
                      String(data.get("displayName") ?? ""),
                      configuration,
                      configuration.authentication === "bearer"
                        ? enteredCredential
                        : emptyTransientCredential(enteredCredential),
                    );
                  }
                  void operation
                    .then((created) => {
                      if (created) form.reset();
                    })
                    .finally(() => setCreating(false));
                }}
              >
                <label>
                  <span>Provider type</span>
                  <OctantNativeSelect
                    aria-label="Provider type"
                    className="settings-view__select window-no-drag"
                    disabled={props.busy || creating}
                    onChange={(event) =>
                      setProviderType(event.currentTarget.value as typeof providerType)
                    }
                    value={providerType}
                  >
                    <option value="opencode">OpenCode CLI</option>
                    <option value="codex">Codex CLI</option>
                    <option value="kimi-code">Kimi Code CLI</option>
                    <option value="claude">Claude Agent SDK</option>
                    <option value="devin">Devin ACP</option>
                    <option value="kilo">Kilo ACP</option>
                    <option value="pi">Pi RPC</option>
                    <option value="oh-my-pi">Oh My Pi</option>
                    <option value="ollama">Ollama native HTTP</option>
                    <option value="mistral-vibe">Mistral Vibe ACP</option>
                    <option value="grok">Grok Build ACP</option>
                    <option value="openai-compatible">OpenAI-compatible HTTP</option>
                    <option value="anthropic-compatible">Anthropic-compatible HTTP</option>
                    <option value="azure-foundry">Azure AI Foundry</option>
                  </OctantNativeSelect>
                </label>
                <label>
                  <span>Provider name</span>
                  <OctantInput
                    aria-label="Provider name"
                    className="settings-view__text-input window-no-drag"
                    name="displayName"
                    required
                  />
                </label>
                {providerType !== "openai-compatible" &&
                providerType !== "anthropic-compatible" &&
                providerType !== "azure-foundry" &&
                providerType !== "ollama" ? (
                  <label>
                    <span>
                      {providerType === "mistral-vibe" ? "vibe-acp" : selectedDriverLabel} binary
                    </span>
                    <OctantInput
                      aria-label={`${providerType === "mistral-vibe" ? "vibe-acp" : selectedDriverLabel} binary`}
                      className="settings-view__text-input window-no-drag"
                      name="binaryPath"
                      placeholder={`/absolute/path/to/${selectedBinaryName}`}
                      required
                    />
                  </label>
                ) : providerType === "ollama" ? (
                  <>
                    <label>
                      <span>Ollama API base URL</span>
                      <OctantInput
                        aria-describedby="ollama-create-endpoint-guidance"
                        aria-label="Ollama API base URL"
                        className="settings-view__text-input window-no-drag"
                        defaultValue="http://127.0.0.1:11434"
                        name="baseUrl"
                        required
                        type="url"
                      />
                    </label>
                    <p
                      className="provider-settings__field-guidance"
                      id="ollama-create-endpoint-guidance"
                    >
                      Connects to an existing user-managed Ollama service on literal loopback.
                      Octant does not install, start, stop, update, or authenticate Ollama.
                    </p>
                  </>
                ) : providerType === "anthropic-compatible" ? (
                  <>
                    <label>
                      <span>API base URL</span>
                      <OctantInput
                        aria-describedby="anthropic-create-endpoint-guidance"
                        aria-label="API base URL"
                        className="settings-view__text-input window-no-drag"
                        name="baseUrl"
                        placeholder="https://api.anthropic.com/v1"
                        required
                        type="url"
                      />
                    </label>
                    <HttpCredentialFields
                      authentication="api-key"
                      authenticationLabel="Authentication"
                      controlClassName="window-no-drag"
                      credentialInput={credentialInput}
                      credentialLabel="API key"
                      credentialManagementAvailable={props.credentialManagementAvailable}
                      supportsApiKey
                    />
                    <label>
                      <span>Anthropic protocol version</span>
                      <OctantInput
                        aria-label="Anthropic protocol version"
                        className="settings-view__text-input window-no-drag"
                        name="protocolVersion"
                        placeholder="2023-06-01"
                        required
                      />
                    </label>
                    <label>
                      <span>Protocol preference</span>
                      <OctantNativeSelect
                        aria-label="Protocol preference"
                        className="settings-view__select window-no-drag"
                        defaultValue="auto"
                        name="protocol"
                      >
                        <option value="auto">Automatic</option>
                        <option value="messages">Messages</option>
                      </OctantNativeSelect>
                    </label>
                    <label className="provider-settings__models-field">
                      <span>Manual model IDs</span>
                      <OctantTextarea
                        aria-label="Manual model IDs"
                        className="settings-view__text-input window-no-drag"
                        name="manualModelIds"
                        placeholder="claude-3-5-sonnet, claude-3-opus"
                        rows={2}
                      />
                    </label>
                    <p
                      className="provider-settings__field-guidance"
                      id="anthropic-create-endpoint-guidance"
                    >
                      Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts such
                      as localhost or 127.0.0.1.
                    </p>
                    {!props.credentialManagementAvailable ? (
                      <p className="provider-settings__field-guidance">
                        Manage credentials in the Octant host app. Credential changes are
                        unavailable in this browser.
                      </p>
                    ) : null}
                  </>
                ) : providerType === "azure-foundry" ? (
                  <>
                    <label>
                      <span>Foundry OpenAI v1 base URL</span>
                      <OctantInput
                        aria-describedby="foundry-create-endpoint-guidance"
                        aria-label="Foundry OpenAI v1 base URL"
                        className="settings-view__text-input window-no-drag"
                        name="baseUrl"
                        placeholder="https://<resource>.openai.azure.com/openai/v1/"
                        required
                        type="url"
                      />
                    </label>
                    <HttpCredentialFields
                      key={`create-azure-foundry-${providerType}`}
                      authentication="api-key"
                      authenticationLabel="Authentication"
                      controlClassName="window-no-drag"
                      credentialInput={credentialInput}
                      credentialLabel="API key"
                      credentialManagementAvailable={props.credentialManagementAvailable}
                      fixedAuthentication
                      supportsApiKey
                    />
                    <label>
                      <span>Protocol preference</span>
                      <OctantNativeSelect
                        aria-label="Protocol preference"
                        className="settings-view__select window-no-drag"
                        defaultValue="auto"
                        name="protocol"
                      >
                        <option value="auto">Automatic</option>
                        <option value="responses">Responses</option>
                        <option value="chat-completions">Chat Completions</option>
                      </OctantNativeSelect>
                    </label>
                    <label className="provider-settings__models-field">
                      <span>Deployment IDs</span>
                      <OctantTextarea
                        aria-label="Deployment IDs"
                        className="settings-view__text-input window-no-drag"
                        name="manualModelIds"
                        placeholder="deployment-a, deployment-b"
                        rows={2}
                      />
                    </label>
                    <p
                      className="provider-settings__field-guidance"
                      id="foundry-create-endpoint-guidance"
                    >
                      Reuses the OpenAI-compatible transport against the documented /openai/v1/
                      endpoint. API keys are stored write-only in the Octant host Keychain and sent
                      as the api-key header. List deployments in the order you want them to appear.
                    </p>
                    {!props.credentialManagementAvailable ? (
                      <p className="provider-settings__field-guidance">
                        Manage credentials in the Octant host app. Credential changes are
                        unavailable in this browser.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <label>
                      <span>API base URL</span>
                      <OctantInput
                        aria-describedby="provider-create-endpoint-guidance"
                        aria-label="API base URL"
                        className="settings-view__text-input window-no-drag"
                        name="baseUrl"
                        placeholder="https://gateway.example/v1"
                        required
                        type="url"
                      />
                    </label>
                    <HttpCredentialFields
                      authentication="bearer"
                      authenticationLabel="Authentication"
                      controlClassName="window-no-drag"
                      credentialInput={credentialInput}
                      credentialLabel="API key"
                      credentialManagementAvailable={props.credentialManagementAvailable}
                    />
                    <label>
                      <span>Protocol preference</span>
                      <OctantNativeSelect
                        aria-label="Protocol preference"
                        className="settings-view__select window-no-drag"
                        defaultValue="auto"
                        name="protocol"
                      >
                        <option value="auto">Automatic</option>
                        <option value="responses">Responses</option>
                        <option value="chat-completions">Chat Completions</option>
                      </OctantNativeSelect>
                    </label>
                    <label className="provider-settings__models-field">
                      <span>Manual model IDs</span>
                      <OctantTextarea
                        aria-label="Manual model IDs"
                        className="settings-view__text-input window-no-drag"
                        name="manualModelIds"
                        placeholder="model-a, model-b"
                        rows={2}
                      />
                    </label>
                    <p
                      className="provider-settings__field-guidance"
                      id="provider-create-endpoint-guidance"
                    >
                      Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts such
                      as localhost or 127.0.0.1.
                    </p>
                    {!props.credentialManagementAvailable ? (
                      <p className="provider-settings__field-guidance">
                        Manage credentials in the Octant host app. Credential changes are
                        unavailable in this browser.
                      </p>
                    ) : null}
                  </>
                )}
                {providerType === "claude" ? (
                  <ClaudeCreateAuthenticationFields
                    authentication={claudeAuthentication}
                    credentialInput={credentialInput}
                    credentialManagementAvailable={props.credentialManagementAvailable}
                    onAuthenticationChange={(next) => {
                      if (next === "subscription" && credentialInput.current !== null) {
                        credentialInput.current.value = "";
                      }
                      setClaudeAuthentication(next);
                    }}
                  />
                ) : null}
                {providerType === "mistral-vibe" ? (
                  <VibeCreateAuthenticationFields
                    authentication={vibeAuthentication}
                    credentialInput={credentialInput}
                    credentialManagementAvailable={props.credentialManagementAvailable}
                    onAuthenticationChange={(next) => {
                      if (next === "subscription" && credentialInput.current !== null) {
                        credentialInput.current.value = "";
                      }
                      setVibeAuthentication(next);
                    }}
                  />
                ) : null}
                {providerType === "grok" ? (
                  <GrokCreateAuthenticationFields
                    authentication={grokAuthentication}
                    credentialInput={credentialInput}
                    credentialManagementAvailable={props.credentialManagementAvailable}
                    onAuthenticationChange={(next) => {
                      if (next === "subscription" && credentialInput.current !== null) {
                        credentialInput.current.value = "";
                      }
                      setGrokAuthentication(next);
                    }}
                  />
                ) : null}
                {providerType === "devin" ? (
                  <p className="provider-settings__field-guidance">
                    Uses provider-owned Devin subscription authentication. Run devin auth login in
                    your terminal when sign-in is required.
                  </p>
                ) : null}
                {providerType === "pi" ? (
                  <p className="provider-settings__field-guidance">
                    Uses provider-owned authentication and model credentials through Pi.
                    Authenticate with the official Pi CLI, then check the connection.
                  </p>
                ) : null}
                {providerType === "oh-my-pi" ? (
                  <p className="provider-settings__field-guidance">
                    Uses provider-owned authentication through Oh My Pi (`omp`). Octant treats Oh My
                    Pi as distinct from Pi, pins a supported version for the fail-closed probe, and
                    does not treat discovery as turn readiness.
                  </p>
                ) : null}
                {providerType === "kilo" ? (
                  <p className="provider-settings__field-guidance">
                    Uses provider-owned authentication and model credentials through Kilo. Run kilo
                    auth login in your terminal, then check the connection.
                  </p>
                ) : null}
                <OctantButton
                  className="settings-view__action window-no-drag"
                  disabled={
                    props.busy ||
                    creating ||
                    (providerType === "claude" &&
                      claudeAuthentication === "api-key" &&
                      !props.credentialManagementAvailable) ||
                    (providerType === "mistral-vibe" &&
                      vibeAuthentication === "api-key" &&
                      !props.credentialManagementAvailable) ||
                    (providerType === "grok" &&
                      grokAuthentication === "api-key" &&
                      !props.credentialManagementAvailable)
                  }
                  type="submit"
                >
                  {creating
                    ? "Adding…"
                    : providerType === "openai-compatible"
                      ? "Add OpenAI-compatible provider"
                      : providerType === "anthropic-compatible"
                        ? "Add Anthropic-compatible provider"
                        : providerType === "azure-foundry"
                          ? "Add Azure AI Foundry provider"
                          : `Add ${selectedDriverLabel}`}
                </OctantButton>
              </form>
              {providerType === "openai-compatible" ? <BedrockMantleGuide /> : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {props.status !== "ready" ? null : props.instances.length === 0 ? (
        <p className="provider-settings__empty">No providers configured.</p>
      ) : (
        <>
          <ProviderOrderControls
            busy={props.busy}
            instances={props.instances}
            providerOrder={props.defaults.providerOrder}
            onProviderOrderChange={props.onProviderOrderChange}
          />
          <AgentEligibleModelsControls
            agentEligibleModels={props.defaults.agentEligibleModels}
            busy={props.busy}
            instances={props.instances}
            observedByInstance={props.observedByInstance}
            onAgentEligibleModelsChange={props.onAgentEligibleModelsChange}
          />
          <div className="provider-settings__list">
            {props.instances.map((instance) => (
              <ProviderCard
                busy={props.busy}
                credentialManagementAvailable={props.credentialManagementAvailable}
                instance={instance}
                key={instance.id}
                {...(props.discoverySnapshot === undefined
                  ? {}
                  : { discoverySnapshot: props.discoverySnapshot })}
                {...(props.observedByInstance.get(instance.id) === undefined
                  ? {}
                  : { observed: props.observedByInstance.get(instance.id)! })}
                onChangeBinary={props.onChangeBinary}
                onChangeClaudeConfiguration={props.onChangeClaudeConfiguration}
                onChangeMistralVibeConfiguration={props.onChangeMistralVibeConfiguration}
                onChangeGrokConfiguration={props.onChangeGrokConfiguration}
                onChangeDevinConfiguration={props.onChangeDevinConfiguration}
                onChangeKiloConfiguration={props.onChangeKiloConfiguration}
                onChangePiConfiguration={props.onChangePiConfiguration}
                onChangeOhMyPiConfiguration={props.onChangeOhMyPiConfiguration}
                onChangeOllamaConfiguration={props.onChangeOllamaConfiguration}
                onChangeOpenAiCompatibleConfiguration={props.onChangeOpenAiCompatibleConfiguration}
                onChangeAnthropicCompatibleConfiguration={
                  props.onChangeAnthropicCompatibleConfiguration
                }
                onChangeAzureFoundryConfiguration={props.onChangeAzureFoundryConfiguration}
                onClearProviderCredential={props.onClearProviderCredential}
                onBeginProviderAuthentication={props.onBeginProviderAuthentication}
                onCompleteProviderAuthentication={props.onCompleteProviderAuthentication}
                onProbe={props.onProbe}
                onVerifyFoundryTools={props.onVerifyFoundryTools}
                onProviderCredentialStatus={props.onProviderCredentialStatus}
                onRemove={props.onRemove}
                onRename={props.onRename}
                onSetEnabled={props.onSetEnabled}
                probing={props.probingIds.has(instance.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProviderOrderControls(props: {
  readonly busy: boolean;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly providerOrder: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly onProviderOrderChange: (
    providerOrder: ReadonlyArray<ProviderInstanceId>,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const order = useMemo(() => {
    const explicit = props.providerOrder ?? [];
    const explicitSet = new Set(explicit);
    const ordered = explicit
      .map((id) => props.instances.find((instance) => instance.id === id))
      .filter((instance): instance is ProviderInstance => instance !== undefined);
    const remaining = props.instances.filter((instance) => !explicitSet.has(instance.id));
    return [...ordered, ...remaining];
  }, [props.instances, props.providerOrder]);

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= order.length) return;
    const reordered = [...order];
    const [moved] = reordered.splice(index, 1);
    if (moved !== undefined) reordered.splice(next, 0, moved);
    void props.onProviderOrderChange(reordered.map((instance) => instance.id));
  }

  if (order.length < 2) return null;
  return (
    <section aria-label="Provider order" className="provider-order" data-expanded={open}>
      <button
        aria-controls="provider-order-list"
        aria-expanded={open}
        aria-label="Provider order"
        className="provider-order__trigger window-no-drag"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>Provider order</span>
        <span className="provider-order__count">{order.length}</span>
        <ChevronDown aria-hidden="true" className="provider-order__disclosure-icon" size={15} />
      </button>
      {open ? (
        <div className="provider-order__body" id="provider-order-list">
          <p className="provider-settings__hint">
            Controls model-picker order. The first ready provider is the default for new threads.
          </p>
          <ol className="provider-order__list">
            {order.map((instance, index) => (
              <li className="provider-order__item" key={instance.id}>
                <span className="provider-order__name">{instance.displayName}</span>
                <OctantButton
                  aria-label={`Move ${instance.displayName} up`}
                  className="provider-order__move window-no-drag"
                  disabled={props.busy || index === 0}
                  onClick={() => move(index, -1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <ArrowUp aria-hidden="true" size={14} />
                </OctantButton>
                <OctantButton
                  aria-label={`Move ${instance.displayName} down`}
                  className="provider-order__move window-no-drag"
                  disabled={props.busy || index === order.length - 1}
                  onClick={() => move(index, 1)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <ArrowDown aria-hidden="true" size={14} />
                </OctantButton>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function agentEligibleModelKey(ref: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}): string {
  return `${ref.providerInstanceId}:${ref.modelId}`;
}

/**
 * Settings-defined default agent-eligible pool. Membership is a
 * selection default consumed by the composer pool control: toggling a model
 * never configures credentials, activates a provider, or widens authority,
 * and only configured, ready providers expose selectable models.
 */
function AgentEligibleModelsControls(props: {
  readonly busy: boolean;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly agentEligibleModels: ReadonlyArray<AgentEligibleModelRef> | undefined;
  readonly onAgentEligibleModelsChange: (
    agentEligibleModels: ReadonlyArray<AgentEligibleModelRef>,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.agentEligibleModels ?? [];
  const selectedKeys = useMemo(
    () => new Set(selected.map(agentEligibleModelKey)),
    [props.agentEligibleModels],
  );
  const available = useMemo(() => {
    const rows: Array<{
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerName: string;
      readonly modelId: ProviderModelId;
      readonly modelName: string;
    }> = [];
    for (const instance of props.instances) {
      if (!instance.enabled) continue;
      const observed = props.observedByInstance.get(instance.id);
      if (observed === undefined || observed.readiness !== "ready") continue;
      for (const model of observed.models) {
        rows.push({
          providerInstanceId: instance.id,
          providerName: instance.displayName,
          modelId: model.id,
          modelName: model.displayName,
        });
      }
    }
    return rows;
  }, [props.instances, props.observedByInstance]);
  const availableKeys = useMemo(() => new Set(available.map(agentEligibleModelKey)), [available]);
  // Stored refs whose model is no longer observed remain visible and
  // removable so a stale default never silently lingers.
  const stale = selected.filter((ref) => !availableKeys.has(agentEligibleModelKey(ref)));

  function toggle(ref: AgentEligibleModelRef, enabled: boolean) {
    const next = enabled
      ? [...selected, ref]
      : selected.filter((value) => agentEligibleModelKey(value) !== agentEligibleModelKey(ref));
    void props.onAgentEligibleModelsChange(next);
  }

  return (
    <section
      aria-label="Agent-eligible models"
      className="agent-eligible-models"
      data-expanded={open}
    >
      <button
        aria-controls="agent-eligible-models-list"
        aria-expanded={open}
        aria-label="Agent-eligible models"
        className="agent-eligible-models__trigger window-no-drag"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>Agent-eligible models</span>
        <span className="agent-eligible-models__count">{selected.length}</span>
        <ChevronDown
          aria-hidden="true"
          className="agent-eligible-models__disclosure-icon"
          size={15}
        />
      </button>
      {open ? (
        <div className="agent-eligible-models__body" id="agent-eligible-models-list">
          <p className="provider-settings__hint">
            Default pool offered by the composer&apos;s multi-model control. Membership never
            configures credentials, activates a provider, or widens authority — composers can only
            narrow this pool, and routing re-checks each model at send time.
          </p>
          {available.length === 0 && stale.length === 0 ? (
            <p className="agent-eligible-models__empty">
              No configured, ready models are available. Run a connection check on an enabled
              provider to list its models.
            </p>
          ) : (
            <ul className="agent-eligible-models__list">
              {available.map((row) => {
                const ref: AgentEligibleModelRef = {
                  providerInstanceId: row.providerInstanceId,
                  modelId: row.modelId,
                };
                const key = agentEligibleModelKey(ref);
                return (
                  <li className="agent-eligible-models__item" key={key}>
                    <label className="agent-eligible-models__option">
                      <input
                        aria-label={`${row.providerName} — ${row.modelName}`}
                        checked={selectedKeys.has(key)}
                        className="window-no-drag"
                        disabled={props.busy}
                        onChange={(event) => toggle(ref, event.currentTarget.checked)}
                        type="checkbox"
                      />
                      <span>
                        {row.providerName} — {row.modelName}
                      </span>
                    </label>
                  </li>
                );
              })}
              {stale.map((ref) => {
                const providerName =
                  props.instances.find((instance) => instance.id === ref.providerInstanceId)
                    ?.displayName ?? String(ref.providerInstanceId);
                const key = agentEligibleModelKey(ref);
                return (
                  <li className="agent-eligible-models__item" key={key}>
                    <label className="agent-eligible-models__option agent-eligible-models__option--unavailable">
                      <input
                        aria-label={`${providerName} — ${ref.modelId} (unavailable)`}
                        checked
                        className="window-no-drag"
                        disabled={props.busy}
                        onChange={() => toggle(ref, false)}
                        type="checkbox"
                      />
                      <span>
                        {providerName} — {String(ref.modelId)} (unavailable)
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function BedrockMantleGuide() {
  return (
    <section aria-labelledby="bedrock-mantle-heading" className="bedrock-mantle-guide">
      <h3 id="bedrock-mantle-heading">Amazon Bedrock Mantle setup</h3>
      <p>
        Mantle exposes Bedrock models through a regional OpenAI-compatible <code>/v1</code>{" "}
        endpoint. Add an OpenAI-compatible provider with the regional base URL and a Bedrock API
        key.
      </p>
      <ol className="bedrock-mantle-guide__steps">
        <li>
          Pick a regional Mantle base URL, for example
          <span className="bedrock-mantle-guide__code">
            {" "}
            https://mantle.us-east-1.amazonaws.com/v1
          </span>
          .
        </li>
        <li>
          Create a Bedrock API key in IAM under your user or role and store it in the Octant
          Keychain-backed credential for this provider.
        </li>
        <li>
          Add the provider with authentication set to{" "}
          <span className="bedrock-mantle-guide__code">bearer</span> and protocol{" "}
          <span className="bedrock-mantle-guide__code">responses</span>, then probe to confirm model
          discovery.
        </li>
      </ol>
      <p className="bedrock-mantle-guide__note">
        Mantle does not currently expose the full Bedrock Converse API or IAM role-session
        authentication. Tool calling and streaming are available only for models Mantle has
        verified.
      </p>
    </section>
  );
}

function ClaudeCreateAuthenticationFields(props: {
  readonly authentication: ClaudeAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: ClaudeAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Claude authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as ClaudeAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">Claude subscription</option>
          <option value="api-key">Anthropic API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <>
          <label>
            <span>Anthropic API key</span>
            <OctantInput
              aria-label="Anthropic API key"
              autoComplete="new-password"
              className="settings-view__text-input window-no-drag"
              disabled={!props.credentialManagementAvailable}
              ref={props.credentialInput}
              spellCheck={false}
              type="password"
            />
          </label>
          {!props.credentialManagementAvailable ? (
            <p className="provider-settings__field-guidance">
              Claude API-key providers can only be created in the Octant host app. Claude
              subscription providers remain available in this browser.
            </p>
          ) : null}
        </>
      ) : (
        <p className="provider-settings__field-guidance">
          Authenticate with the official Claude Code app or CLI, then check the connection.
        </p>
      )}
    </>
  );
}

function VibeCreateAuthenticationFields(props: {
  readonly authentication: MistralVibeAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: MistralVibeAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Mistral Vibe authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as MistralVibeAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">Mistral subscription</option>
          <option value="api-key">Mistral API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <label>
          <span>Mistral API key</span>
          <OctantInput
            aria-label="Mistral API key"
            autoComplete="new-password"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            ref={props.credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Create the provider, then use its browser sign-in action. Octant never receives the
          resulting OAuth credential.
        </p>
      )}
    </>
  );
}

function GrokCreateAuthenticationFields(props: {
  readonly authentication: GrokAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: GrokAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Grok Build authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as GrokAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">xAI subscription</option>
          <option value="api-key">xAI API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <label>
          <span>xAI API key</span>
          <OctantInput
            aria-label="xAI API key"
            autoComplete="new-password"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            ref={props.credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Create the provider, then use its browser sign-in action. Octant never receives the
          resulting OAuth credential.
        </p>
      )}
    </>
  );
}

interface ProviderCardProps {
  readonly instance: ProviderInstance;
  readonly observed?: ProviderObservedState;
  readonly discoverySnapshot?: DiscoverySnapshot;
  readonly busy: boolean;
  readonly probing: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onRename: ProviderSettingsViewProps["onRename"];
  readonly onChangeBinary: ProviderSettingsViewProps["onChangeBinary"];
  readonly onChangeClaudeConfiguration: ProviderSettingsViewProps["onChangeClaudeConfiguration"];
  readonly onChangeDevinConfiguration: ProviderSettingsViewProps["onChangeDevinConfiguration"];
  readonly onChangeKiloConfiguration: ProviderSettingsViewProps["onChangeKiloConfiguration"];
  readonly onChangePiConfiguration: ProviderSettingsViewProps["onChangePiConfiguration"];
  readonly onChangeOhMyPiConfiguration: ProviderSettingsViewProps["onChangeOhMyPiConfiguration"];
  readonly onChangeOllamaConfiguration: ProviderSettingsViewProps["onChangeOllamaConfiguration"];
  readonly onChangeMistralVibeConfiguration: ProviderSettingsViewProps["onChangeMistralVibeConfiguration"];
  readonly onChangeGrokConfiguration: ProviderSettingsViewProps["onChangeGrokConfiguration"];
  readonly onChangeOpenAiCompatibleConfiguration: ProviderSettingsViewProps["onChangeOpenAiCompatibleConfiguration"];
  readonly onChangeAnthropicCompatibleConfiguration: ProviderSettingsViewProps["onChangeAnthropicCompatibleConfiguration"];
  readonly onChangeAzureFoundryConfiguration: ProviderSettingsViewProps["onChangeAzureFoundryConfiguration"];
  readonly onProviderCredentialStatus: ProviderSettingsViewProps["onProviderCredentialStatus"];
  readonly onClearProviderCredential: ProviderSettingsViewProps["onClearProviderCredential"];
  readonly onBeginProviderAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteProviderAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
  readonly onSetEnabled: ProviderSettingsViewProps["onSetEnabled"];
  readonly onRemove: ProviderSettingsViewProps["onRemove"];
  readonly onProbe: ProviderSettingsViewProps["onProbe"];
  readonly onVerifyFoundryTools: ProviderSettingsViewProps["onVerifyFoundryTools"];
}

function ProviderCard(props: ProviderCardProps) {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const disabled = props.busy || props.probing;
  const readiness = props.probing ? "checking" : props.observed?.readiness;
  const autoRegisteredDisabled = isDisabledDiscoveryInstance(
    props.instance,
    props.discoverySnapshot,
  );
  const isCli =
    props.instance.driverKind === "codex" ||
    props.instance.driverKind === "opencode" ||
    props.instance.driverKind === "kimi-code";
  const isClaude = props.instance.driverKind === "claude";
  const isVibe = props.instance.driverKind === "mistral-vibe";
  const isGrok = props.instance.driverKind === "grok";
  const isDevin = props.instance.driverKind === "devin";
  const isKilo = props.instance.driverKind === "kilo";
  const isPi = props.instance.driverKind === "pi";
  const isOhMyPi = props.instance.driverKind === "oh-my-pi";
  const isOllama = props.instance.driverKind === "ollama";
  const isHttp = props.instance.driverKind === "openai-compatible";
  const isAnthropicHttp = props.instance.driverKind === "anthropic-compatible";
  const isFoundry = props.instance.driverKind === "azure-foundry";
  const usesCredential =
    isHttp ||
    isAnthropicHttp ||
    isFoundry ||
    ((isClaude || isVibe || isGrok) && props.instance.configuration.authentication === "api-key");
  const credential = useCredentialStatus(props, !usesCredential);
  const label = driverLabel(props.instance.driverKind);
  const runtimeLabel = isClaude
    ? "Agent SDK"
    : isVibe || isGrok || isDevin || isKilo
      ? "ACP"
      : isPi || isOhMyPi
        ? "RPC"
        : isCli
          ? "CLI"
          : "HTTP";
  const toggleEnabled = async () => {
    const nextEnabled = !props.instance.enabled;
    const updated = await props.onSetEnabled(props.instance.id, nextEnabled);
    if (updated && nextEnabled && autoRegisteredDisabled) {
      await props.onProbe(props.instance.id);
    }
  };
  return (
    <article aria-label={props.instance.displayName} className="provider-card">
      <header className="provider-card__header">
        <div>
          <h3>{props.instance.displayName}</h3>
          <p>
            {label} {runtimeLabel} · {props.instance.enabled ? "Enabled" : "Disabled"}
          </p>
        </div>
        <div className="provider-card__header-actions">
          {autoRegisteredDisabled ? (
            <OctantButton disabled={disabled} onClick={() => void toggleEnabled()} type="button">
              Enable {props.instance.displayName}
            </OctantButton>
          ) : null}
          <span
            className={`provider-card__status provider-card__status--${readiness ?? "unknown"}`}
          >
            {readiness === undefined ? "Not checked" : readinessLabel(readiness)}
          </span>
          <OctantButton
            aria-controls={`provider-details-${props.instance.id}`}
            aria-expanded={detailsOpen}
            aria-label={`Details for ${props.instance.displayName}`}
            className="provider-card__details-trigger window-no-drag"
            onClick={() => setDetailsOpen((current) => !current)}
            type="button"
            variant="ghost"
          >
            <span>Details</span>
            <ChevronDown aria-hidden="true" className="provider-card__details-icon" size={14} />
          </OctantButton>
        </div>
      </header>
      {detailsOpen ? (
        <div className="provider-card__details" id={`provider-details-${props.instance.id}`}>
          {props.observed === undefined ? null : (
            <div className="provider-card__facts">
              <span>Process: {titleCase(props.observed.processState)}</span>
              <span>Version: {props.observed.detectedVersion ?? "Unavailable"}</span>
              <span>Models: {props.observed.models.length}</span>
              <span>
                Last check:{" "}
                {props.observed.lastSuccessfulProbeAt === undefined ? (
                  "No successful check"
                ) : (
                  <time dateTime={props.observed.lastSuccessfulProbeAt}>
                    {formatProbeTimestamp(props.observed.lastSuccessfulProbeAt)}
                  </time>
                )}
              </span>
            </div>
          )}
          {!isHttp ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>
                Observed protocol:{" "}
                {props.observed?.observedProtocol === undefined
                  ? "Not observed by a real turn"
                  : protocolLabel(props.observed.observedProtocol)}
              </span>
              <span>Authentication: {titleCase(props.instance.configuration.authentication)}</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {!isAnthropicHttp ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>Protocol version: {props.instance.configuration.protocolVersion}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>Authentication: {titleCase(props.instance.configuration.authentication)}</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
            </div>
          )}
          {!isFoundry ? null : (
            <div className="provider-card__facts provider-card__facts--http">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>
                Configured protocol: {protocolLabel(props.instance.configuration.protocol)}
              </span>
              <span>
                Observed protocol:{" "}
                {props.observed?.observedProtocol === undefined
                  ? "Not observed by a real turn"
                  : protocolLabel(props.observed.observedProtocol)}
              </span>
              <span>Authentication: API key</span>
              <span>
                Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
              </span>
              <span>
                Tool support:{" "}
                <strong>
                  {(props.observed?.verifiedToolModelIds?.length ?? 0) > 0
                    ? `Verified (${props.observed?.verifiedToolModelIds?.length} deployment${(props.observed?.verifiedToolModelIds?.length ?? 0) > 1 ? "s" : ""})`
                    : "Unverified (non-generating Connection Check)"}
                </strong>
              </span>
              <span>Deployments:</span>
              {props.instance.configuration.manualModelIds.map((modelId) => {
                const isVerified = props.observed?.verifiedToolModelIds?.some(
                  (id) => String(id) === String(modelId),
                );
                return (
                  <span key={String(modelId)}>
                    <OctantButton
                      className="provider-card__inline-action"
                      disabled={disabled || !props.instance.enabled}
                      onClick={() => void props.onVerifyFoundryTools(props.instance.id, modelId)}
                      type="button"
                    >
                      {props.probing
                        ? "Verifying…"
                        : `Verify tools for ${modelId}${isVerified ? " (verified)" : ""}`}
                    </OctantButton>
                  </span>
                );
              })}
            </div>
          )}
          {!isClaude ? null : (
            <div className="provider-card__facts provider-card__facts--claude">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "Anthropic API key"
                  : "Claude subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isVibe ? null : (
            <div className="provider-card__facts provider-card__facts--vibe">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "Mistral API key"
                  : "Mistral subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isGrok ? null : (
            <div className="provider-card__facts provider-card__facts--grok">
              <span>
                Authentication:{" "}
                {props.instance.configuration.authentication === "api-key"
                  ? "xAI API key"
                  : "xAI subscription"}
              </span>
              {props.instance.configuration.authentication === "api-key" ? (
                <span>
                  Credential: <strong>{credentialStatusLabel(credential.status)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {!isDevin ? null : (
            <div className="provider-card__facts provider-card__facts--devin">
              <span>Authentication: Devin subscription</span>
            </div>
          )}
          {!isPi ? null : (
            <div className="provider-card__facts provider-card__facts--pi">
              <span>Authentication: provider-owned Pi credentials</span>
            </div>
          )}
          {!isOhMyPi ? null : (
            <div className="provider-card__facts provider-card__facts--oh-my-pi">
              <span>Authentication: provider-owned Oh My Pi credentials</span>
              <span>Supported version: {props.instance.configuration.supportedVersion}</span>
            </div>
          )}
          {!isKilo ? null : (
            <div className="provider-card__facts provider-card__facts--kilo">
              <span>Authentication: provider-owned Kilo credentials</span>
            </div>
          )}
          {!isOllama ? null : (
            <div className="provider-card__facts provider-card__facts--ollama">
              <span>{props.instance.configuration.baseUrl}</span>
              <span>Authentication: none (loopback only)</span>
              <span>Service lifecycle: user-managed</span>
            </div>
          )}
          {autoRegisteredDisabled ? (
            <p className="provider-card__guidance">Detected on this host — enable to use</p>
          ) : null}
          {guidance(props.instance, readiness, props.observed?.message)}
          {usesCredential && !props.credentialManagementAvailable ? (
            <p className="provider-card__guidance">
              Manage credentials in the Octant host app. Credential replacement, clearing, and
              provider removal are unavailable in this browser.
            </p>
          ) : null}
          {props.instance.driverKind === "codex" ||
          props.instance.driverKind === "kimi-code" ||
          isClaude ||
          isVibe ||
          isGrok ||
          isDevin ||
          isKilo ||
          isPi ||
          isOhMyPi ? (
            <p className="provider-card__authority-note">
              “Remember for this Project” cannot create persistent provider authority, so approvals
              stay one-shot. Select “Current session only” to allow a supported approval for the
              current session.
            </p>
          ) : null}
          <div className="provider-card__actions">
            <OctantButton
              disabled={disabled || !props.instance.enabled}
              onClick={() => void props.onProbe(props.instance.id)}
              type="button"
            >
              {props.probing
                ? "Checking connection…"
                : `Check connection for ${props.instance.displayName}`}
            </OctantButton>
            {autoRegisteredDisabled ? null : (
              <OctantButton disabled={disabled} onClick={() => void toggleEnabled()} type="button">
                {props.instance.enabled ? "Disable" : "Enable"} {props.instance.displayName}
              </OctantButton>
            )}
            <OctantButton
              aria-controls={`provider-configuration-${props.instance.id}`}
              aria-expanded={configurationOpen}
              aria-label={`Configure ${props.instance.displayName}`}
              onClick={() => setConfigurationOpen((current) => !current)}
              type="button"
              variant="ghost"
            >
              <span>Configure</span>
              <ChevronDown
                aria-hidden="true"
                className="provider-card__disclosure-icon"
                size={14}
              />
            </OctantButton>
            <OctantButton
              className="provider-card__danger"
              disabled={disabled || (usesCredential && !props.credentialManagementAvailable)}
              onClick={() => void props.onRemove(props.instance.id)}
              type="button"
            >
              Remove {props.instance.displayName}
            </OctantButton>
          </div>
          {configurationOpen ? (
            <div
              className="provider-card__configuration"
              data-expanded="true"
              id={`provider-configuration-${props.instance.id}`}
            >
              <form
                className="provider-card__edit"
                key={`name:${props.instance.version}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void props.onRename(props.instance.id, String(data.get("displayName") ?? ""));
                }}
              >
                <label>
                  <span>Display name</span>
                  <OctantInput
                    aria-label={`Display name for ${props.instance.displayName}`}
                    className="settings-view__text-input"
                    defaultValue={props.instance.displayName}
                    name="displayName"
                    required
                  />
                </label>
                <OctantButton disabled={disabled} type="submit">
                  Save name for {props.instance.displayName}
                </OctantButton>
              </form>
              {isCli ? (
                <form
                  className="provider-card__edit"
                  key={`binary:${props.instance.version}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void props.onChangeBinary(
                      props.instance.id,
                      String(data.get("binaryPath") ?? ""),
                    );
                  }}
                >
                  <label>
                    <span>Binary path</span>
                    <OctantInput
                      aria-label={`Binary path for ${props.instance.displayName}`}
                      className="settings-view__text-input"
                      defaultValue={props.instance.configuration.binaryPath}
                      name="binaryPath"
                      required
                    />
                  </label>
                  <OctantButton disabled={disabled} type="submit">
                    Save binary path for {props.instance.displayName}
                  </OctantButton>
                </form>
              ) : isClaude ? (
                <ClaudeConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`claude:${props.instance.version}`}
                  onChange={props.onChangeClaudeConfiguration}
                />
              ) : isVibe ? (
                <VibeConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`vibe:${props.instance.version}`}
                  onBeginAuthentication={props.onBeginProviderAuthentication}
                  onChange={props.onChangeMistralVibeConfiguration}
                  onCompleteAuthentication={props.onCompleteProviderAuthentication}
                />
              ) : isGrok ? (
                <GrokConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`grok:${props.instance.version}`}
                  onBeginAuthentication={props.onBeginProviderAuthentication}
                  onChange={props.onChangeGrokConfiguration}
                  onCompleteAuthentication={props.onCompleteProviderAuthentication}
                />
              ) : isDevin ? (
                <DevinConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`devin:${props.instance.version}`}
                  onChange={props.onChangeDevinConfiguration}
                />
              ) : isPi ? (
                <PiConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`pi:${props.instance.version}`}
                  onChange={props.onChangePiConfiguration}
                />
              ) : isOhMyPi ? (
                <OhMyPiConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`oh-my-pi:${props.instance.version}`}
                  onChange={props.onChangeOhMyPiConfiguration}
                />
              ) : isKilo ? (
                <KiloConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`kilo:${props.instance.version}`}
                  onChange={props.onChangeKiloConfiguration}
                />
              ) : isOllama ? (
                <OllamaConfigurationForm
                  disabled={disabled}
                  instance={props.instance}
                  key={`ollama:${props.instance.version}`}
                  onChange={props.onChangeOllamaConfiguration}
                />
              ) : isAnthropicHttp ? (
                <AnthropicConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`anthropic:${props.instance.version}`}
                  onChange={props.onChangeAnthropicCompatibleConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : isFoundry ? (
                <FoundryConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`foundry:${props.instance.version}`}
                  onChange={props.onChangeAzureFoundryConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              ) : (
                <HttpConfigurationForm
                  credential={credential}
                  credentialManagementAvailable={props.credentialManagementAvailable}
                  disabled={disabled}
                  instance={props.instance}
                  key={`http:${props.instance.version}`}
                  onChange={props.onChangeOpenAiCompatibleConfiguration}
                  onClearCredential={props.onClearProviderCredential}
                />
              )}
              {props.observed === undefined ? null : (
                <div className="provider-card__discovery">
                  <section aria-labelledby={`models-${props.instance.id}`}>
                    <h4 id={`models-${props.instance.id}`}>Models</h4>
                    {props.observed.models.length === 0 ? (
                      <p>No models reported.</p>
                    ) : (
                      <ul>
                        {props.observed.models.map((model) => (
                          <li key={model.id}>
                            {!isHttp && !isAnthropicHttp && !isFoundry
                              ? model.displayName
                              : `${model.displayName} · ${titleCase(model.source)} · ${titleCase(model.verification)}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-labelledby={`capabilities-${props.instance.id}`}>
                    <h4 id={`capabilities-${props.instance.id}`}>Capabilities</h4>
                    <dl>
                      {capabilityLabels.map(([key, label]) => (
                        <div key={key}>
                          <dt>{label}</dt>
                          <dd>{titleCase(props.observed!.capabilities[key])}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

interface ClaudeConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "claude" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeClaudeConfiguration"];
}

function ClaudeConfigurationForm(props: ClaudeConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState<ClaudeAuthentication>(
    props.instance.configuration.authentication,
  );
  return (
    <form
      className="provider-card__edit provider-card__edit--claude"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration: ClaudeProviderConfiguration = {
          kind: "claude-agent-sdk",
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication,
        };
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          authentication === "api-key"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        const generation =
          authentication === "api-key" && key.value.length > 0
            ? props.credential.beginMutation()
            : undefined;
        void props.onChange(props.instance.id, configuration, key).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <label>
        <span>Claude binary path</span>
        <OctantInput
          aria-label={`Claude binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label={`Claude authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          name="authentication"
          onChange={(event) => {
            const next = event.currentTarget.value as ClaudeAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAuthentication(next);
          }}
          value={authentication}
        >
          <option value="subscription">Claude subscription</option>
          <option value="api-key">Anthropic API key</option>
        </OctantNativeSelect>
      </label>
      {authentication === "api-key" ? (
        <label>
          <span>Anthropic API key (leave blank to preserve)</span>
          <OctantInput
            aria-label={`Anthropic API key for ${props.instance.displayName}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            name="credential"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Authenticate with the official Claude Code app or CLI, then check the connection.
        </p>
      )}
      <OctantButton disabled={props.disabled} type="submit">
        Save Claude settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function DevinConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "devin" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeDevinConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "devin-acp",
          binaryPath: String(data.get("binaryPath") ?? ""),
          authentication: "subscription",
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save Devin settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function PiConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "pi" }>;
  readonly onChange: ProviderSettingsViewProps["onChangePiConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "pi-rpc",
          binaryPath: String(data.get("binaryPath") ?? ""),
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save Pi settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function OhMyPiConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "oh-my-pi" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeOhMyPiConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "oh-my-pi-rpc",
          binaryPath: String(data.get("binaryPath") ?? ""),
          supportedVersion: props.instance.configuration.supportedVersion,
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save Oh My Pi settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function KiloConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "kilo" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeKiloConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "kilo-acp",
          binaryPath: String(data.get("binaryPath") ?? ""),
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save Kilo settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function OllamaConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "ollama" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeOllamaConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onChange(props.instance.id, {
          kind: "ollama-native-http",
          baseUrl: String(new FormData(event.currentTarget).get("baseUrl") ?? ""),
        });
      }}
    >
      <label>
        <span>Ollama API base URL</span>
        <OctantInput
          aria-label={`Ollama API base for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </label>
      <p className="provider-settings__field-guidance">
        Literal loopback native API only. Octant never manages the shared Ollama service or its
        models.
      </p>
      <OctantButton disabled={props.disabled} type="submit">
        Save Ollama settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

interface VibeConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "mistral-vibe" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeMistralVibeConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}

function VibeConfigurationForm(props: VibeConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState<MistralVibeAuthentication>(
    props.instance.configuration.authentication,
  );
  const [attempt, setAttempt] = useState<ProviderAuthenticationAttempt>();
  return (
    <form
      className="provider-card__edit provider-card__edit--vibe"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration: MistralVibeProviderConfiguration = {
          kind: "mistral-vibe-acp",
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication,
        };
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          authentication === "api-key"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        void props.onChange(props.instance.id, configuration, key);
      }}
    >
      <label>
        <span>vibe-acp binary path</span>
        <OctantInput
          aria-label={`vibe-acp binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label={`Mistral Vibe authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          onChange={(event) => {
            const next = event.currentTarget.value as MistralVibeAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAttempt(undefined);
            setAuthentication(next);
          }}
          value={authentication}
        >
          <option value="subscription">Mistral subscription</option>
          <option value="api-key">Mistral API key</option>
        </OctantNativeSelect>
      </label>
      {authentication === "api-key" ? (
        <label>
          <span>Mistral API key (leave blank to preserve)</span>
          <OctantInput
            aria-label={`Mistral API key for ${props.instance.displayName}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <div className="provider-card__credential-actions">
          <OctantButton
            disabled={props.disabled}
            onClick={() => void props.onBeginAuthentication(props.instance.id).then(setAttempt)}
            type="button"
          >
            Start Mistral browser sign-in for {props.instance.displayName}
          </OctantButton>
          {attempt === undefined ? null : (
            <>
              <a href={attempt.signInUrl} rel="noreferrer" target="_blank">
                Open Mistral sign-in
              </a>
              <OctantButton
                disabled={props.disabled}
                onClick={() =>
                  void props
                    .onCompleteAuthentication(props.instance.id, attempt.attemptId)
                    .then((completed) => {
                      if (completed) setAttempt(undefined);
                    })
                }
                type="button"
              >
                Complete Mistral browser sign-in for {props.instance.displayName}
              </OctantButton>
            </>
          )}
        </div>
      )}
      <OctantButton disabled={props.disabled} type="submit">
        Save Mistral Vibe settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

interface GrokConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "grok" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeGrokConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}

function GrokConfigurationForm(props: GrokConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState<GrokAuthentication>(
    props.instance.configuration.authentication,
  );
  const [attempt, setAttempt] = useState<ProviderAuthenticationAttempt>();
  return (
    <form
      className="provider-card__edit provider-card__edit--grok"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration: GrokProviderConfiguration = {
          kind: "grok-acp",
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication,
        };
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          authentication === "api-key"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        void props.onChange(props.instance.id, configuration, key);
      }}
    >
      <label>
        <span>grok binary path</span>
        <OctantInput
          aria-label={`grok binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label={`Grok Build authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          onChange={(event) => {
            const next = event.currentTarget.value as GrokAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAttempt(undefined);
            setAuthentication(next);
          }}
          value={authentication}
        >
          <option value="subscription">xAI subscription</option>
          <option value="api-key">xAI API key</option>
        </OctantNativeSelect>
      </label>
      {authentication === "api-key" ? (
        <label>
          <span>xAI API key (leave blank to preserve)</span>
          <OctantInput
            aria-label={`xAI API key for ${props.instance.displayName}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <div className="provider-card__credential-actions">
          <OctantButton
            disabled={props.disabled}
            onClick={() => void props.onBeginAuthentication(props.instance.id).then(setAttempt)}
            type="button"
          >
            Start xAI browser sign-in for {props.instance.displayName}
          </OctantButton>
          {attempt === undefined ? null : (
            <>
              <a href={attempt.signInUrl} rel="noreferrer" target="_blank">
                Open xAI sign-in
              </a>
              <OctantButton
                disabled={props.disabled}
                onClick={() =>
                  void props
                    .onCompleteAuthentication(props.instance.id, attempt.attemptId)
                    .then((completed) => {
                      if (completed) setAttempt(undefined);
                    })
                }
                type="button"
              >
                Complete xAI browser sign-in for {props.instance.displayName}
              </OctantButton>
            </>
          )}
        </div>
      )}
      <OctantButton disabled={props.disabled} type="submit">
        Save Grok Build settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

interface HttpConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "openai-compatible" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeOpenAiCompatibleConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

function HttpConfigurationForm(props: HttpConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = configurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          configuration.authentication === "bearer"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        const generation =
          configuration.authentication === "bearer" && key.value.length > 0
            ? props.credential.beginMutation()
            : undefined;
        void props.onChange(props.instance.id, configuration, key).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <label>
        <span>API base URL</span>
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`API base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </label>
      <HttpCredentialFields
        authentication={props.instance.configuration.authentication}
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
      />
      <label>
        <span>Protocol preference</span>
        <OctantNativeSelect
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
        >
          <option value="auto">Automatic</option>
          <option value="responses">Responses</option>
          <option value="chat-completions">Chat Completions</option>
        </OctantNativeSelect>
      </label>
      <label className="provider-settings__models-field">
        <span>Manual model IDs</span>
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </label>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts.
      </p>
      <div className="provider-card__credential-actions">
        <OctantButton disabled={props.disabled} type="submit">
          Save HTTP settings for {props.instance.displayName}
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface AnthropicConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "anthropic-compatible" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeAnthropicCompatibleConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

function AnthropicConfigurationForm(props: AnthropicConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = anthropicConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const key =
          configuration.authentication !== "none"
            ? enteredCredential
            : emptyTransientCredential(enteredCredential);
        const generation =
          configuration.authentication !== "none" && key.value.length > 0
            ? props.credential.beginMutation()
            : undefined;
        void props.onChange(props.instance.id, configuration, key).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <label>
        <span>API base URL</span>
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`API base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </label>
      <HttpCredentialFields
        authentication={props.instance.configuration.authentication}
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
        supportsApiKey
      />
      <label>
        <span>Anthropic protocol version</span>
        <OctantInput
          aria-label={`Anthropic protocol version for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.protocolVersion}
          name="protocolVersion"
          required
        />
      </label>
      <label>
        <span>Protocol preference</span>
        <OctantNativeSelect
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
        >
          <option value="auto">Automatic</option>
          <option value="messages">Messages</option>
        </OctantNativeSelect>
      </label>
      <label className="provider-settings__models-field">
        <span>Manual model IDs</span>
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </label>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts.
      </p>
      <div className="provider-card__credential-actions">
        <OctantButton disabled={props.disabled} type="submit">
          Save Anthropic settings for {props.instance.displayName}
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface FoundryConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "azure-foundry" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeAzureFoundryConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

function FoundryConfigurationForm(props: FoundryConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--http"
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = foundryConfigurationFrom(new FormData(event.currentTarget));
        const enteredCredential = transientCredential(credentialInput.current);
        const generation =
          enteredCredential.value.length > 0 ? props.credential.beginMutation() : undefined;
        void props.onChange(props.instance.id, configuration, enteredCredential).then(
          (updated) => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, updated, "stored");
          },
          () => {
            if (generation !== undefined)
              props.credential.finishMutation(generation, false, "stored");
          },
        );
      }}
    >
      <label>
        <span>Foundry OpenAI v1 base URL</span>
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`Foundry OpenAI v1 base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </label>
      <HttpCredentialFields
        authentication="api-key"
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
        fixedAuthentication
        supportsApiKey
      />
      <label>
        <span>Protocol preference</span>
        <OctantNativeSelect
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
        >
          <option value="auto">Automatic</option>
          <option value="responses">Responses</option>
          <option value="chat-completions">Chat Completions</option>
        </OctantNativeSelect>
      </label>
      <label className="provider-settings__models-field">
        <span>Deployment IDs</span>
        <OctantTextarea
          aria-label={`Deployment IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </label>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        The base URL must end with /openai/v1/. API keys are stored write-only in Keychain and sent
        as the api-key header. List deployments in the order you want them to appear.
      </p>
      <div className="provider-card__credential-actions">
        <OctantButton disabled={props.disabled} type="submit">
          Save Azure AI Foundry settings for {props.instance.displayName}
        </OctantButton>
        {props.credentialManagementAvailable ? (
          <OctantButton
            disabled={props.disabled || props.credential.status !== "stored"}
            onClick={() => {
              const generation = props.credential.beginMutation();
              void props.onClearCredential(props.instance.id).then(
                (cleared) => {
                  props.credential.finishMutation(generation, cleared, "missing");
                },
                () => props.credential.finishMutation(generation, false, "missing"),
              );
            }}
            type="button"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
  );
}

interface HttpCredentialFieldsProps {
  readonly authentication: "api-key" | "bearer" | "none";
  readonly authenticationLabel: string;
  readonly controlClassName?: string;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialLabel: string;
  readonly credentialManagementAvailable: boolean;
  readonly supportsApiKey?: boolean;
  readonly fixedAuthentication?: boolean;
}

function HttpCredentialFields(props: HttpCredentialFieldsProps) {
  const [authentication, setAuthentication] = useState(props.authentication);
  const fixed = props.fixedAuthentication === true;
  // When auth is fixed (e.g. Azure AI Foundry), always derive the effective
  // value from the prop so a stale internal `none` state from a prior form
  // cannot disable the API-key input. The selector is also disabled so the
  // user cannot change it away from the fixed value.
  const effectiveAuthentication = fixed
    ? props.authentication
    : !props.supportsApiKey && authentication === "api-key"
      ? "bearer"
      : authentication;
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label={props.authenticationLabel}
          className={`settings-view__select ${props.controlClassName ?? ""}`}
          disabled={fixed}
          name="authentication"
          onChange={(event) => {
            const next = event.currentTarget.value as "api-key" | "bearer" | "none";
            if (next === "none" && props.credentialInput.current !== null) {
              props.credentialInput.current.value = "";
            }
            setAuthentication(next);
          }}
          value={effectiveAuthentication}
        >
          {props.supportsApiKey ? (
            <option value="api-key">
              API key ({fixed ? "api-key header" : "x-api-key header"})
            </option>
          ) : null}
          {fixed ? null : (
            <>
              <option value="bearer">Bearer API key</option>
              <option value="none">No authentication (trusted loopback only)</option>
            </>
          )}
        </OctantNativeSelect>
      </label>
      <label>
        <span>API key (leave blank to preserve)</span>
        <OctantInput
          aria-label={props.credentialLabel}
          autoComplete="new-password"
          className={`settings-view__text-input ${props.controlClassName ?? ""}`}
          disabled={!props.credentialManagementAvailable || effectiveAuthentication === "none"}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
    </>
  );
}

function configurationFrom(data: FormData): OpenAiCompatibleProviderConfiguration {
  return {
    kind: "openai-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: String(data.get("authentication") ?? "bearer") as "bearer" | "none",
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

function anthropicConfigurationFrom(data: FormData): AnthropicCompatibleProviderConfiguration {
  return {
    kind: "anthropic-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: String(
      data.get("authentication") ?? "api-key",
    ) as AnthropicCompatibleAuthentication,
    protocol: String(data.get("protocol") ?? "auto") as AnthropicCompatibleProtocol,
    protocolVersion: String(data.get("protocolVersion") ?? "2023-06-01"),
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

function foundryConfigurationFrom(data: FormData): AzureFoundryProviderConfiguration {
  return {
    kind: "azure-foundry-openai-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    authentication: "api-key",
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  };
}

function parseManualModelIds(
  value: string,
): OpenAiCompatibleProviderConfiguration["manualModelIds"] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ] as unknown as OpenAiCompatibleProviderConfiguration["manualModelIds"];
}

function transientCredential(input: HTMLInputElement | null): TransientProviderCredential {
  return {
    value: input?.value ?? "",
    clear: () => {
      if (input !== null) input.value = "";
    },
  };
}

function emptyTransientCredential(
  credential: TransientProviderCredential,
): TransientProviderCredential {
  credential.clear();
  return { value: "", clear: credential.clear };
}

function readinessLabel(value: ProviderObservedState["readiness"]): string {
  return value === "unauthenticated" ? "Authentication required" : titleCase(value);
}

function isDisabledDiscoveryInstance(
  instance: ProviderInstance,
  snapshot: DiscoverySnapshot | undefined,
): boolean {
  if (instance.enabled || snapshot === undefined) return false;
  if (snapshot.autoRegisteredInstanceIds?.includes(instance.id) === true) return true;
  if (
    instance.driverKind === "ollama" &&
    snapshot.candidates.some((candidate) => candidate.driverKind === "ollama")
  ) {
    return true;
  }
  const binaryPath = providerBinaryPath(instance);
  return (
    binaryPath !== undefined &&
    snapshot.candidates.some(
      (candidate) =>
        candidate.driverKind === instance.driverKind && candidate.binaryPath === binaryPath,
    )
  );
}

function providerBinaryPath(instance: ProviderInstance): string | undefined {
  return "binaryPath" in instance.configuration ? instance.configuration.binaryPath : undefined;
}

function guidance(
  instance: ProviderInstance,
  readiness: ProviderObservedState["readiness"] | undefined,
  message?: string,
) {
  const driverKind = instance.driverKind;
  const label = driverLabel(driverKind);
  if (readiness === "unauthenticated")
    return (
      <p className="provider-card__guidance">
        {driverKind === "codex"
          ? "Run codex login in your terminal, then check the connection again."
          : driverKind === "opencode"
            ? "Authenticate with OpenCode, then check the connection again."
            : driverKind === "kimi-code"
              ? "Run kimi login for this provider's Octant-managed profile. Do not use your ordinary Kimi profile; then check the connection again."
              : driverKind === "devin"
                ? "Run devin auth login in your terminal, then check the connection again."
                : driverKind === "pi"
                  ? "Authenticate with the official Pi CLI, then check the connection again."
                  : driverKind === "oh-my-pi"
                    ? "Install and authenticate Oh My Pi (`omp`), then check the connection again. Octant treats Oh My Pi as distinct from Pi."
                    : driverKind === "kilo"
                      ? "Run kilo auth login in your terminal, then check the connection again."
                      : driverKind === "claude"
                        ? instance.configuration.authentication === "api-key"
                          ? "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again."
                          : "Authenticate with the official Claude Code app or CLI, then check the connection again."
                        : driverKind === "mistral-vibe"
                          ? instance.configuration.authentication === "api-key"
                            ? "Add or replace the Mistral API key in the Octant host, then check the connection again."
                            : "Use the Mistral browser sign-in action below, then check the connection again."
                          : driverKind === "grok"
                            ? instance.configuration.authentication === "api-key"
                              ? "Add or replace the xAI API key in the Octant host, then check the connection again."
                              : "Use the xAI browser sign-in action below, then check the connection again."
                            : driverKind === "anthropic-compatible"
                            ? "Add or replace the Anthropic API key in the Octant host. It remains write-only and is stored in Keychain, then check the connection again."
                            : driverKind === "azure-foundry"
                              ? "Add or replace the Azure AI Foundry API key in the Octant host. It is stored in Keychain and sent as the api-key header, then check the connection again."
                              : "Add a bearer API key in the Octant host, then check the connection again."}
      </p>
    );
  if (readiness === "incompatible")
    return (
      <p className="provider-card__guidance">
        {driverKind === "openai-compatible" ||
        driverKind === "anthropic-compatible" ||
        driverKind === "azure-foundry"
          ? "The endpoint returned an incompatible protocol response. Review its API compatibility."
          : driverKind === "ollama"
            ? "The loopback endpoint returned an incompatible native Ollama response. Update Ollama or verify the native API endpoint."
            : driverKind === "kimi-code"
              ? "The Kimi Code runtime or its Octant-managed safety profile is incompatible. Review the connection detail and supported version before retrying."
              : `Update your ${label} installation to a compatible version, then retry.`}
      </p>
    );
  if (readiness === "degraded")
    return (
      <p className="provider-card__guidance">
        {driverKind === "openai-compatible" ||
        driverKind === "anthropic-compatible" ||
        driverKind === "azure-foundry"
          ? "The provider remains usable with degraded discovery or streaming. Review capabilities before use."
          : driverKind === "ollama"
            ? "Ollama is reachable but no compatible installed models were reported. Manage models outside Octant, then retry."
            : "Review unavailable capabilities before starting work."}
      </p>
    );
  if (readiness === "unavailable")
    return (
      <p className="provider-card__guidance">
        {driverKind === "openai-compatible" ||
        driverKind === "anthropic-compatible" ||
        driverKind === "azure-foundry"
          ? "Verify the API base URL and endpoint availability, then retry."
          : driverKind === "ollama"
            ? "Start the user-managed Ollama service and verify the loopback API base URL, then retry."
            : `Verify the binary path and that ${label} can start, then retry.`}
      </p>
    );
  return message === undefined ? null : <p className="provider-card__guidance">{message}</p>;
}

type CredentialStatusView = ProviderCredentialStatus | "checking";

interface CredentialStatusController {
  readonly status: CredentialStatusView;
  readonly beginMutation: () => number;
  readonly finishMutation: (
    generation: number,
    succeeded: boolean,
    successStatus: ProviderCredentialStatus,
  ) => void;
}

function useCredentialStatus(
  props: ProviderCardProps,
  credentialless: boolean,
): CredentialStatusController {
  const requestGeneration = useRef(0);
  const [status, setStatus] = useState<CredentialStatusView>(
    props.observed?.credentialStatus ??
      (props.credentialManagementAvailable ? "checking" : "unavailable"),
  );

  const requestStatus = (expectedGeneration: number) => {
    if (requestGeneration.current !== expectedGeneration) return;
    const generation = ++requestGeneration.current;
    setStatus("checking");
    void props.onProviderCredentialStatus(props.instance.id).then(
      (nextStatus) => {
        if (requestGeneration.current === generation) setStatus(nextStatus);
      },
      () => {
        if (requestGeneration.current === generation) setStatus("unavailable");
      },
    );
  };

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );
  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (credentialless) return undefined;
    if (!props.credentialManagementAvailable) {
      setStatus("unavailable");
      return undefined;
    }
    if (props.observed?.credentialStatus !== undefined) {
      setStatus(props.observed.credentialStatus);
      return undefined;
    }
    setStatus("checking");
    void props.onProviderCredentialStatus(props.instance.id).then(
      (nextStatus) => {
        if (requestGeneration.current === generation) setStatus(nextStatus);
      },
      () => {
        if (requestGeneration.current === generation) setStatus("unavailable");
      },
    );
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [
    credentialless,
    props.credentialManagementAvailable,
    props.instance.id,
    props.observed?.credentialStatus,
    props.onProviderCredentialStatus,
  ]);

  return {
    status,
    beginMutation: () => {
      const generation = ++requestGeneration.current;
      setStatus("checking");
      return generation;
    },
    finishMutation: (generation, succeeded, successStatus) => {
      if (requestGeneration.current !== generation) return;
      if (succeeded) setStatus(successStatus);
      else requestStatus(generation);
    },
  };
}

function credentialStatusLabel(status: CredentialStatusView): string {
  if (status === "checking") return "Checking Keychain…";
  if (status === "stored") return "Stored in Keychain";
  if (status === "missing") return "Not configured";
  return "Unavailable";
}

function protocolLabel(value: OpenAiCompatibleProtocol | AnthropicCompatibleProtocol): string {
  if (value === "auto") return "Automatic";
  if (value === "responses") return "Responses";
  if (value === "chat-completions") return "Chat Completions";
  return "Messages";
}

function driverLabel(
  driverKind: ProviderInstance["driverKind"] | "oh-my-pi",
):
  | "OpenCode"
  | "Codex"
  | "Claude"
  | "Kimi Code"
  | "Devin"
  | "Kilo"
  | "Pi"
  | "Oh My Pi"
  | "Ollama"
  | "Mistral Vibe"
  | "Grok Build"
  | "OpenAI-compatible"
  | "Anthropic-compatible"
  | "Azure AI Foundry" {
  if (driverKind === "opencode") return "OpenCode";
  if (driverKind === "codex") return "Codex";
  if (driverKind === "claude") return "Claude";
  if (driverKind === "kimi-code") return "Kimi Code";
  if (driverKind === "devin") return "Devin";
  if (driverKind === "kilo") return "Kilo";
  if (driverKind === "pi") return "Pi";
  if (driverKind === "oh-my-pi") return "Oh My Pi";
  if (driverKind === "ollama") return "Ollama";
  if (driverKind === "mistral-vibe") return "Mistral Vibe";
  if (driverKind === "grok") return "Grok Build";
  if (driverKind === "anthropic-compatible") return "Anthropic-compatible";
  if (driverKind === "azure-foundry") return "Azure AI Foundry";
  return "OpenAI-compatible";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ");
}

function formatProbeTimestamp(value: string): string {
  return probeTimestampFormatter.format(new Date(value));
}
