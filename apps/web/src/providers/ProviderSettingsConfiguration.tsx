import type {
  AnthropicCompatibleAuthentication,
  AnthropicCompatibleProtocol,
  AnthropicCompatibleProviderConfiguration,
  AzureFoundryProviderConfiguration,
  ClaudeAuthentication,
  ClaudeProviderConfiguration,
  GrokAuthentication,
  GrokProviderConfiguration,
  MistralVibeAuthentication,
  MistralVibeProviderConfiguration,
  OpenAiCompatibleProtocol,
  OpenAiCompatibleProviderConfiguration,
  ProviderAuthenticationAttempt,
  ProviderInstance,
} from "@octant/contracts";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import {
  ClaudeCreateAuthenticationFields,
  emptyTransientCredential,
  GrokCreateAuthenticationFields,
  HttpCredentialFields,
  transientCredential,
  VibeCreateAuthenticationFields,
  type CredentialStatusController,
} from "./ProviderSettingsCredentials";
import { driverLabel } from "./providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "./ProviderSettingsView";

export type ProviderCreateFormProps = Pick<
  ProviderSettingsViewProps,
  | "busy"
  | "credentialManagementAvailable"
  | "onCreate"
  | "onCreateOpenAiCompatible"
  | "onCreateAnthropicCompatible"
  | "onCreateAzureFoundry"
  | "onCreateClaude"
  | "onCreateMistralVibe"
  | "onCreateGrok"
  | "onCreateOllama"
>;

export function ProviderCreateForm(props: ProviderCreateFormProps) {
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
  const [grokAuthentication, setGrokAuthentication] = useState<GrokAuthentication>("subscription");
  const credentialInput = useRef<HTMLInputElement>(null);
  const selectedDriverLabel = driverLabel(providerType);
  const selectedBinaryName =
    providerType === "mistral-vibe"
      ? "vibe-acp"
      : providerType === "oh-my-pi"
        ? "omp"
        : providerType;
  return (
    <section className="provider-settings__manual" data-expanded={manualOpen ? "true" : "false"}>
      <OctantButton
        aria-expanded={manualOpen}
        className="btn btn-secondary btn-sm window-no-drag"
        onClick={() => setManualOpen((current) => !current)}
        type="button"
        variant="secondary"
      >
        <span>Add provider manually</span>
        <ChevronDown aria-hidden="true" className="provider-settings__disclosure-icon" size={16} />
      </OctantButton>
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
                  Connects to an existing user-managed Ollama service on literal loopback. Octant
                  does not install, start, stop, update, or authenticate Ollama.
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
                  Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts such as
                  localhost or 127.0.0.1.
                </p>
                {!props.credentialManagementAvailable ? (
                  <p className="provider-settings__field-guidance">
                    Manage credentials in the Octant host app. Credential changes are unavailable in
                    this browser.
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
                  endpoint. API keys are stored write-only in the Octant host Keychain and sent as
                  the api-key header. List deployments in the order you want them to appear.
                </p>
                {!props.credentialManagementAvailable ? (
                  <p className="provider-settings__field-guidance">
                    Manage credentials in the Octant host app. Credential changes are unavailable in
                    this browser.
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
                  Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts such as
                  localhost or 127.0.0.1.
                </p>
                {!props.credentialManagementAvailable ? (
                  <p className="provider-settings__field-guidance">
                    Manage credentials in the Octant host app. Credential changes are unavailable in
                    this browser.
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
                Uses provider-owned Devin subscription authentication. Run devin auth login in your
                terminal when sign-in is required.
              </p>
            ) : null}
            {providerType === "pi" ? (
              <p className="provider-settings__field-guidance">
                Uses provider-owned authentication and model credentials through Pi. Authenticate
                with the official Pi CLI, then check the connection.
              </p>
            ) : null}
            {providerType === "oh-my-pi" ? (
              <p className="provider-settings__field-guidance">
                Uses provider-owned authentication through Oh My Pi (`omp`). Octant treats Oh My Pi
                as distinct from Pi, pins a supported version for the fail-closed probe, and does
                not treat discovery as turn readiness.
              </p>
            ) : null}
            {providerType === "kilo" ? (
              <p className="provider-settings__field-guidance">
                Uses provider-owned authentication and model credentials through Kilo. Run kilo auth
                login in your terminal, then check the connection.
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

interface ClaudeConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "claude" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeClaudeConfiguration"];
}

export function ClaudeConfigurationForm(props: ClaudeConfigurationFormProps) {
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

export function DevinConfigurationForm(props: {
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

export function PiConfigurationForm(props: {
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

export function OhMyPiConfigurationForm(props: {
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

export function KiloConfigurationForm(props: {
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

export function OllamaConfigurationForm(props: {
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

export function VibeConfigurationForm(props: VibeConfigurationFormProps) {
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

export function GrokConfigurationForm(props: GrokConfigurationFormProps) {
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

export function HttpConfigurationForm(props: HttpConfigurationFormProps) {
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
            variant="destructive"
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

export function AnthropicConfigurationForm(props: AnthropicConfigurationFormProps) {
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
            variant="destructive"
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

export function FoundryConfigurationForm(props: FoundryConfigurationFormProps) {
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
            variant="destructive"
          >
            Clear stored API key for {props.instance.displayName}
          </OctantButton>
        ) : null}
      </div>
    </form>
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
