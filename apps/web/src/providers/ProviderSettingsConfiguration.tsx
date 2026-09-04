import {
  GEMINI_IMAGE_MODEL_PRESETS,
  OPENAI_IMAGE_MODEL_PRESETS,
  type AnthropicCompatibleAuthentication,
  type AnthropicCompatibleProtocol,
  type AnthropicCompatibleProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type ClaudeAuthentication,
  type ClaudeProviderConfiguration,
  type GeminiImageAspectRatio,
  type GeminiImageProviderConfiguration,
  type GeminiImageResolution,
  type GrokAuthentication,
  type GrokProviderConfiguration,
  type GlmProviderConfiguration,
  type GeminiProviderConfiguration,
  type ClineProviderConfiguration,
  type QwenProviderConfiguration,
  type MistralVibeAuthentication,
  type MistralVibeProviderConfiguration,
  type OpenAiCompatibleProtocol,
  type OpenAiCompatibleProviderConfiguration,
  type OpenAiImageProviderConfiguration,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderAuthenticationAttempt,
  type ProviderInstance,
} from "@octant/contracts";
import { ChevronDown } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
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
import type { TransientProviderCredential } from "./useProviderController";

export type ProviderCreateFormProps = Pick<
  ProviderSettingsViewProps,
  | "busy"
  | "credentialManagementAvailable"
  | "onCreate"
  | "onCreateOpenAiCompatible"
  | "onCreateAnthropicCompatible"
  | "onCreateAzureFoundry"
  | "onCreateOpenAiImage"
  | "onCreateGeminiImage"
  | "onCreateClaude"
  | "onCreateMistralVibe"
  | "onCreateGrok"
  | "onCreateGlm"
  | "onCreateGemini"
  | "onCreateCline"
  | "onCreateQwen"
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
    | "goose"
    | "glm"
    | "gemini"
    | "copilot"
    | "cline"
    | "qwen"
    | "openai-compatible"
    | "anthropic-compatible"
    | "azure-foundry"
    | "openai-image"
    | "gemini-native-image"
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
      : providerType === "glm"
        ? "glm-acp-agent"
        : providerType === "oh-my-pi"
          ? "omp"
          : providerType;
  return (
    <section className="provider-settings__manual" data-expanded={manualOpen ? "true" : "false"}>
      <OctantButton
        size="sm"
        aria-expanded={manualOpen}
        className="window-no-drag"
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
                    : providerType === "openai-image"
                      ? "Add OpenAI image profile"
                      : providerType === "gemini-native-image"
                        ? "Add Gemini image profile"
                        : providerType === "ollama"
                          ? "Add Ollama provider"
                          : providerType === "claude"
                            ? "Add Claude provider"
                            : providerType === "mistral-vibe"
                              ? "Add Mistral Vibe provider"
                              : providerType === "grok"
                                ? "Add Grok Build provider"
                                : providerType === "goose"
                                  ? "Add Goose provider"
                                  : providerType === "glm"
                                    ? "Add GLM Agent provider"
                                    : "Add provider"
            }
            className={`provider-settings__create provider-settings__create--${providerType}`}
            noValidate
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
                providerType === "goose" ||
                providerType === "copilot" ||
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
              } else if (providerType === "glm") {
                const configuration: GlmProviderConfiguration = {
                  kind: "glm-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: "api-key",
                };
                operation = props.onCreateGlm(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  transientCredential(credentialInput.current),
                );
              } else if (providerType === "gemini") {
                const configuration: GeminiProviderConfiguration = {
                  kind: "gemini-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: "api-key",
                };
                operation = props.onCreateGemini(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  transientCredential(credentialInput.current),
                );
              } else if (providerType === "cline") {
                const configuration: ClineProviderConfiguration = {
                  kind: "cline-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: "api-key",
                };
                operation = props.onCreateCline(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  transientCredential(credentialInput.current),
                );
              } else if (providerType === "qwen") {
                const configuration: QwenProviderConfiguration = {
                  kind: "qwen-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: "api-key",
                };
                operation = props.onCreateQwen(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  transientCredential(credentialInput.current),
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
              } else if (providerType === "openai-image") {
                const configuration = openAiImageConfigurationFrom(data);
                const enteredCredential = transientCredential(credentialInput.current);
                operation = props.onCreateOpenAiImage(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  enteredCredential,
                );
              } else if (providerType === "gemini-native-image") {
                const configuration = geminiImageConfigurationFrom(data);
                const enteredCredential = transientCredential(credentialInput.current);
                operation = props.onCreateGeminiImage(
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
              <OctantSelectField
                aria-label="Provider type"
                className="settings-view__select window-no-drag"
                disabled={props.busy || creating}
                onValueChange={(value) => setProviderType(value as typeof providerType)}
                options={[
                  { id: "opencode", label: "OpenCode CLI" },
                  { id: "codex", label: "Codex CLI" },
                  { id: "kimi-code", label: "Kimi Code CLI" },
                  { id: "claude", label: "Claude Agent SDK" },
                  { id: "devin", label: "Devin ACP" },
                  { id: "kilo", label: "Kilo ACP" },
                  { id: "pi", label: "Pi RPC" },
                  { id: "oh-my-pi", label: "Oh My Pi" },
                  { id: "ollama", label: "Ollama native HTTP" },
                  { id: "mistral-vibe", label: "Mistral Vibe ACP" },
                  { id: "grok", label: "Grok Build ACP" },
                  { id: "goose", label: "Goose ACP" },
                  { id: "glm", label: "GLM Agent ACP" },
                  { id: "gemini", label: "Gemini CLI ACP" },
                  { id: "copilot", label: "GitHub Copilot ACP" },
                  { id: "cline", label: "Cline ACP" },
                  { id: "qwen", label: "Qwen Code ACP" },
                  { id: "openai-compatible", label: "OpenAI-compatible HTTP" },
                  { id: "anthropic-compatible", label: "Anthropic-compatible HTTP" },
                  { id: "azure-foundry", label: "Azure AI Foundry" },
                  { id: "openai-image", label: "OpenAI Image" },
                  { id: "gemini-native-image", label: "Gemini Image" },
                ]}
                value={providerType}
              />
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
            providerType !== "openai-image" &&
            providerType !== "gemini-native-image" &&
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
                  <OctantSelectField
                    aria-label="Protocol preference"
                    className="settings-view__select window-no-drag"
                    defaultValue="auto"
                    name="protocol"
                    options={[
                      { id: "auto", label: "Automatic" },
                      { id: "messages", label: "Messages" },
                    ]}
                  />
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
                  <OctantSelectField
                    aria-label="Protocol preference"
                    className="settings-view__select window-no-drag"
                    defaultValue="auto"
                    name="protocol"
                    options={[
                      { id: "auto", label: "Automatic" },
                      { id: "responses", label: "Responses" },
                      { id: "chat-completions", label: "Chat Completions" },
                    ]}
                  />
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
            ) : providerType === "openai-image" ? (
              <OpenAiImageFields
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
              />
            ) : providerType === "gemini-native-image" ? (
              <GeminiImageFields
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
              />
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
                  <OctantSelectField
                    aria-label="Protocol preference"
                    className="settings-view__select window-no-drag"
                    defaultValue="auto"
                    name="protocol"
                    options={[
                      { id: "auto", label: "Automatic" },
                      { id: "responses", label: "Responses" },
                      { id: "chat-completions", label: "Chat Completions" },
                    ]}
                  />
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
            {providerType === "glm" ? (
              <label>
                <span>Z.AI API key</span>
                <OctantInput
                  aria-label="Z.AI API key"
                  autoComplete="off"
                  className="settings-view__text-input window-no-drag"
                  name="apiKey"
                  ref={credentialInput}
                  required
                  spellCheck={false}
                  type="password"
                />
              </label>
            ) : null}
            {providerType === "gemini" ? (
              <label>
                <span>Gemini API key</span>
                <OctantInput
                  aria-label="Gemini API key"
                  autoComplete="off"
                  className="settings-view__text-input window-no-drag"
                  name="apiKey"
                  ref={credentialInput}
                  required
                  spellCheck={false}
                  type="password"
                />
              </label>
            ) : null}
            {providerType === "cline" ? (
              <label>
                <span>Cline API key</span>
                <OctantInput
                  aria-label="Cline API key"
                  autoComplete="off"
                  className="settings-view__text-input window-no-drag"
                  name="apiKey"
                  ref={credentialInput}
                  required
                  spellCheck={false}
                  type="password"
                />
              </label>
            ) : null}
            {providerType === "qwen" ? (
              <label>
                <span>OpenAI-compatible API key</span>
                <OctantInput
                  aria-label="OpenAI-compatible API key"
                  autoComplete="off"
                  className="settings-view__text-input window-no-drag"
                  name="apiKey"
                  ref={credentialInput}
                  required
                  spellCheck={false}
                  type="password"
                />
              </label>
            ) : null}
            {providerType === "goose" ? (
              <p className="provider-settings__field-guidance">
                Uses provider-owned Goose authentication. Run `goose configure` in your terminal,
                then check the connection.
              </p>
            ) : null}
            {providerType === "copilot" ? (
              <p className="provider-settings__field-guidance">
                Uses provider-owned GitHub Copilot authentication. Run `copilot login` in your
                terminal, then check the connection.
              </p>
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
                  !props.credentialManagementAvailable) ||
                (providerType === "glm" && !props.credentialManagementAvailable) ||
                ((providerType === "gemini" ||
                  providerType === "cline" ||
                  providerType === "qwen") &&
                  !props.credentialManagementAvailable) ||
                ((providerType === "openai-image" || providerType === "gemini-native-image") &&
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
                      : providerType === "openai-image"
                        ? "Add OpenAI image profile"
                        : providerType === "gemini-native-image"
                          ? "Add Gemini image profile"
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
      noValidate
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
        <OctantSelectField
          aria-label={`Claude authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          name="authentication"
          onValueChange={(value) => {
            const next = value as ClaudeAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAuthentication(next);
          }}
          options={[
            { id: "subscription", label: "Claude subscription" },
            { id: "api-key", label: "Anthropic API key" },
          ]}
          value={authentication}
        />
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
      noValidate
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
      noValidate
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
      noValidate
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
      noValidate
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

export function GooseConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "goose" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeGooseConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "goose-acp",
          binaryPath: String(data.get("binaryPath") ?? ""),
        });
      }}
    >
      <label>
        <span>goose binary path</span>
        <OctantInput
          aria-label={`goose binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save Goose settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

export function GlmConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "glm" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeGlmConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [attempt, setAttempt] = useState<ProviderAuthenticationAttempt>();
  return (
    <form
      className="provider-card__edit provider-card__edit--glm"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration: GlmProviderConfiguration = {
          kind: "glm-acp",
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication: "api-key",
        };
        void props.onChange(props.instance.id, configuration, transientCredential(credentialInput.current));
      }}
    >
      <label>
        <span>glm-acp-agent binary path</span>
        <OctantInput
          aria-label={`glm-acp-agent binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <label>
        <span>Z.AI API key (leave blank to preserve)</span>
        <OctantInput
          aria-label={`Z.AI API key for ${props.instance.displayName}`}
          autoComplete="off"
          className="settings-view__text-input"
          name="apiKey"
          ref={credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
      <OctantButton
        disabled={props.disabled}
        onClick={() =>
          void props.onBeginAuthentication(props.instance.id).then((started) => {
            if (started !== undefined) setAttempt(started);
          })
        }
        type="button"
        variant="secondary"
      >
        Start GLM browser sign-in for {props.instance.displayName}
      </OctantButton>
      {attempt === undefined ? null : (
        <>
          <a href={attempt.signInUrl} rel="noreferrer" target="_blank">
            Open GLM sign-in
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
            Complete GLM browser sign-in for {props.instance.displayName}
          </OctantButton>
        </>
      )}
      <OctantButton disabled={props.disabled} type="submit">
        Save GLM settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

export function CopilotConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "copilot" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeCopilotConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "copilot-acp",
          binaryPath: String(data.get("binaryPath") ?? ""),
        });
      }}
    >
      <label>
        <span>copilot binary path</span>
        <OctantInput
          aria-label={`copilot binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton disabled={props.disabled} type="submit">
        Save GitHub Copilot settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

function ApiKeyAcpConfigurationForm<
  T extends GeminiProviderConfiguration | ClineProviderConfiguration | QwenProviderConfiguration,
>(props: {
  readonly disabled: boolean;
  readonly instance: ProviderInstance;
  readonly driverLabel: string;
  readonly binaryLabel: string;
  readonly apiKeyLabel: string;
  readonly signInLabel: string;
  readonly configuration: T;
  readonly onChange: (
    instanceId: ProviderInstance["id"],
    configuration: T,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [attempt, setAttempt] = useState<ProviderAuthenticationAttempt>();
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = {
          ...props.configuration,
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
        } as T;
        void props.onChange(
          props.instance.id,
          configuration,
          transientCredential(credentialInput.current),
        );
      }}
    >
      <label>
        <span>{props.binaryLabel}</span>
        <OctantInput
          aria-label={`${props.binaryLabel} for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <label>
        <span>{props.apiKeyLabel}</span>
        <OctantInput
          aria-label={`${props.apiKeyLabel} for ${props.instance.displayName}`}
          autoComplete="off"
          className="settings-view__text-input"
          name="apiKey"
          ref={credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
      <OctantButton
        disabled={props.disabled}
        onClick={() =>
          void props.onBeginAuthentication(props.instance.id).then((started) => {
            if (started !== undefined) setAttempt(started);
          })
        }
        type="button"
        variant="secondary"
      >
        {props.signInLabel}
      </OctantButton>
      {attempt === undefined ? null : (
        <>
          <a href={attempt.signInUrl} rel="noreferrer" target="_blank">
            Open sign-in
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
            Complete browser sign-in for {props.instance.displayName}
          </OctantButton>
        </>
      )}
      <OctantButton disabled={props.disabled} type="submit">
        Save {props.driverLabel} settings for {props.instance.displayName}
      </OctantButton>
    </form>
  );
}

export function GeminiConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "gemini" }>;
  readonly disabled: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeGeminiConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="Gemini API key (leave blank to preserve)"
      binaryLabel="gemini binary path"
      configuration={props.instance.configuration}
      disabled={props.disabled}
      driverLabel="Gemini CLI"
      instance={props.instance}
      onBeginAuthentication={props.onBeginAuthentication}
      onChange={props.onChange}
      onCompleteAuthentication={props.onCompleteAuthentication}
      signInLabel={`Start Gemini browser sign-in for ${props.instance.displayName}`}
    />
  );
}

export function ClineConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "cline" }>;
  readonly disabled: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeClineConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="Cline API key (leave blank to preserve)"
      binaryLabel="cline binary path"
      configuration={props.instance.configuration}
      disabled={props.disabled}
      driverLabel="Cline"
      instance={props.instance}
      onBeginAuthentication={props.onBeginAuthentication}
      onChange={props.onChange}
      onCompleteAuthentication={props.onCompleteAuthentication}
      signInLabel={`Start Cline browser sign-in for ${props.instance.displayName}`}
    />
  );
}

export function QwenConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "qwen" }>;
  readonly disabled: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeQwenConfiguration"];
  readonly onBeginAuthentication: ProviderSettingsViewProps["onBeginProviderAuthentication"];
  readonly onCompleteAuthentication: ProviderSettingsViewProps["onCompleteProviderAuthentication"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="OpenAI-compatible API key (leave blank to preserve)"
      binaryLabel="qwen binary path"
      configuration={props.instance.configuration}
      disabled={props.disabled}
      driverLabel="Qwen Code"
      instance={props.instance}
      onBeginAuthentication={props.onBeginAuthentication}
      onChange={props.onChange}
      onCompleteAuthentication={props.onCompleteAuthentication}
      signInLabel={`Start Qwen browser sign-in for ${props.instance.displayName}`}
    />
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
      noValidate
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
      noValidate
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
        <OctantSelectField
          aria-label={`Mistral Vibe authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          onValueChange={(value) => {
            const next = value as MistralVibeAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAttempt(undefined);
            setAuthentication(next);
          }}
          options={[
            { id: "subscription", label: "Mistral subscription" },
            { id: "api-key", label: "Mistral API key" },
          ]}
          value={authentication}
        />
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
      noValidate
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
        <OctantSelectField
          aria-label={`Grok Build authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          onValueChange={(value) => {
            const next = value as GrokAuthentication;
            if (next === "subscription" && credentialInput.current !== null) {
              credentialInput.current.value = "";
            }
            setAttempt(undefined);
            setAuthentication(next);
          }}
          options={[
            { id: "subscription", label: "xAI subscription" },
            { id: "api-key", label: "xAI API key" },
          ]}
          value={authentication}
        />
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
      noValidate
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
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "responses", label: "Responses" },
            { id: "chat-completions", label: "Chat Completions" },
          ]}
        />
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
      noValidate
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
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "messages", label: "Messages" },
          ]}
        />
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
      noValidate
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
        <OctantSelectField
          aria-label={`Protocol preference for ${props.instance.displayName}`}
          className="settings-view__select"
          defaultValue={props.instance.configuration.protocol}
          name="protocol"
          options={[
            { id: "auto", label: "Automatic" },
            { id: "responses", label: "Responses" },
            { id: "chat-completions", label: "Chat Completions" },
          ]}
        />
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

function OpenAiImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "openai-image" }>;
}) {
  const configuration = props.instance?.configuration;
  return (
    <>
      <label className="provider-settings__models-field">
        <span>Model allowlist</span>
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={OPENAI_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </label>
      <label>
        <span>Default model</span>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="gpt-image-2"
          required
        />
      </label>
      <label>
        <span>Quality</span>
        <OctantSelectField
          aria-label={
            props.instance === undefined ? "Quality" : `Quality for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.quality ?? ""}
          name="quality"
          options={[
            { id: "", label: "Provider default" },
            { id: "auto", label: "auto" },
            { id: "low", label: "low" },
            { id: "medium", label: "medium" },
            { id: "high", label: "high" },
          ]}
        />
      </label>
      <label>
        <span>Size</span>
        <OctantSelectField
          aria-label={
            props.instance === undefined ? "Size" : `Size for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.size ?? ""}
          name="size"
          options={[
            { id: "", label: "Provider default" },
            { id: "auto", label: "auto" },
            { id: "1024x1024", label: "1024x1024" },
            { id: "1536x1024", label: "1536x1024" },
            { id: "1024x1536", label: "1024x1536" },
          ]}
        />
      </label>
      <label>
        <span>
          {props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        </span>
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {OPENAI_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. GPT Image models require
        OpenAI Organization Verification. The API key is stored write-only in Keychain. This profile
        has no editable base URL.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

function GeminiImageFields(props: {
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly instance?: Extract<ProviderInstance, { driverKind: "gemini-native-image" }>;
}) {
  const configuration = props.instance?.configuration;
  return (
    <>
      <label className="provider-settings__models-field">
        <span>Model allowlist</span>
        <OctantTextarea
          aria-label={
            props.instance === undefined
              ? "Model allowlist"
              : `Model allowlist for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.modelAllowlist.join(", ")}
          name="modelAllowlist"
          placeholder={GEMINI_IMAGE_MODEL_PRESETS.join(", ")}
          required
          rows={2}
        />
      </label>
      <label>
        <span>Default model</span>
        <OctantInput
          aria-label={
            props.instance === undefined
              ? "Default model"
              : `Default model for ${props.instance.displayName}`
          }
          className="settings-view__text-input window-no-drag"
          defaultValue={configuration?.defaultModel}
          name="defaultModel"
          placeholder="gemini-3.1-flash-image"
          required
        />
      </label>
      <label>
        <span>Aspect ratio</span>
        <OctantSelectField
          aria-label={
            props.instance === undefined
              ? "Aspect ratio"
              : `Aspect ratio for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.aspectRatio ?? ""}
          name="aspectRatio"
          options={[
            { id: "", label: "Provider default" },
            { id: "1:1", label: "1:1" },
            { id: "2:3", label: "2:3" },
            { id: "3:2", label: "3:2" },
            { id: "3:4", label: "3:4" },
            { id: "4:3", label: "4:3" },
            { id: "4:5", label: "4:5" },
            { id: "5:4", label: "5:4" },
            { id: "9:16", label: "9:16" },
            { id: "16:9", label: "16:9" },
            { id: "21:9", label: "21:9" },
          ]}
        />
      </label>
      <label>
        <span>Resolution</span>
        <OctantSelectField
          aria-label={
            props.instance === undefined
              ? "Resolution"
              : `Resolution for ${props.instance.displayName}`
          }
          className="settings-view__select window-no-drag"
          defaultValue={configuration?.resolution ?? ""}
          name="resolution"
          options={[
            { id: "", label: "Provider default" },
            { id: "1K", label: "1K" },
            { id: "2K", label: "2K" },
            { id: "4K", label: "4K" },
          ]}
        />
      </label>
      <label>
        <span>
          {props.instance === undefined ? "API key" : "API key (leave blank to preserve)"}
        </span>
        <OctantInput
          aria-label={
            props.instance === undefined ? "API key" : `API key for ${props.instance.displayName}`
          }
          autoComplete="new-password"
          className="settings-view__text-input window-no-drag"
          disabled={!props.credentialManagementAvailable}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
      <p className="provider-settings__field-guidance">
        Suggested models are data, not a catalog Octant maintains:{" "}
        {GEMINI_IMAGE_MODEL_PRESETS.join(", ")}. Enter any model IDs. gemini-2.5-flash-image is a
        legacy suggestion. The API key is stored write-only in Keychain. This profile has no
        editable base URL.
      </p>
      {!props.credentialManagementAvailable ? (
        <p className="provider-settings__field-guidance">
          Manage credentials in the Octant host app. Credential changes are unavailable in this
          browser.
        </p>
      ) : null}
    </>
  );
}

interface OpenAiImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "openai-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeOpenAiImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function OpenAiImageConfigurationForm(props: OpenAiImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = openAiImageConfigurationFrom(new FormData(event.currentTarget));
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
      <OpenAiImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__credential-actions">
        <OctantButton disabled={props.disabled} type="submit">
          Save OpenAI image settings for {props.instance.displayName}
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

interface GeminiImageConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "gemini-native-image" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly credential: CredentialStatusController;
  readonly onChange: ProviderSettingsViewProps["onChangeGeminiImageConfiguration"];
  readonly onClearCredential: ProviderSettingsViewProps["onClearProviderCredential"];
}

export function GeminiImageConfigurationForm(props: GeminiImageConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="provider-card__edit provider-card__edit--image"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = geminiImageConfigurationFrom(new FormData(event.currentTarget));
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
      <GeminiImageFields
        credentialInput={credentialInput}
        credentialManagementAvailable={props.credentialManagementAvailable}
        instance={props.instance}
      />
      <div className="provider-card__credential-actions">
        <OctantButton disabled={props.disabled} type="submit">
          Save Gemini image settings for {props.instance.displayName}
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

function optionalSelectValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function openAiImageConfigurationFrom(data: FormData): OpenAiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const quality = optionalSelectValue(String(data.get("quality") ?? "")) as
    | OpenAiImageQuality
    | undefined;
  const size = optionalSelectValue(String(data.get("size") ?? "")) as OpenAiImageSize | undefined;
  return {
    kind: "openai-image-http",
    modelAllowlist: modelAllowlist as unknown as OpenAiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as OpenAiImageProviderConfiguration["defaultModel"],
    ...(quality === undefined ? {} : { quality }),
    ...(size === undefined ? {} : { size }),
  };
}

function geminiImageConfigurationFrom(data: FormData): GeminiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const aspectRatio = optionalSelectValue(String(data.get("aspectRatio") ?? "")) as
    | GeminiImageAspectRatio
    | undefined;
  const resolution = optionalSelectValue(String(data.get("resolution") ?? "")) as
    | GeminiImageResolution
    | undefined;
  return {
    kind: "gemini-native-image-http",
    modelAllowlist: modelAllowlist as unknown as GeminiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as GeminiImageProviderConfiguration["defaultModel"],
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
  };
}
