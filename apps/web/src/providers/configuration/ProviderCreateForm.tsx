import {
  type ClaudeAuthentication,
  type ClaudeProviderConfiguration,
  type GrokAuthentication,
  type GrokProviderConfiguration,
  type GeminiAuthentication,
  type GlmAuthentication,
  type GlmProviderConfiguration,
  type GeminiProviderConfiguration,
  type ClineAuthentication,
  type ClineProviderConfiguration,
  type QwenAuthentication,
  type QwenProviderConfiguration,
  type FxProviderConfiguration,
  type MistralVibeAuthentication,
  type MistralVibeProviderConfiguration,
} from "@octant/contracts";
import { ChevronDown } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import {
  ClaudeCreateAuthenticationFields,
  emptyTransientCredential,
  GrokCreateAuthenticationFields,
  HttpCredentialFields,
  transientCredential,
  VibeCreateAuthenticationFields,
} from "../ProviderSettingsCredentials";
import { driverLabel } from "../providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import {
  configurationFrom,
  anthropicConfigurationFrom,
  foundryConfigurationFrom,
  openAiImageConfigurationFrom,
  geminiImageConfigurationFrom,
  bflImageConfigurationFrom,
  ideogramImageConfigurationFrom,
} from "./configurationValues";
import {
  BflImageFields,
  GeminiImageFields,
  IdeogramImageFields,
  OpenAiImageFields,
} from "./ImageConfigurationForms";

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
  | "onCreateBflImage"
  | "onCreateIdeogramImage"
  | "onCreateClaude"
  | "onCreateMistralVibe"
  | "onCreateGrok"
  | "onCreateGlm"
  | "onCreateGemini"
  | "onCreateCline"
  | "onCreateQwen"
  | "onCreateFx"
  | "onCreateOllama"
>;

export type ProviderCreateProviderType =
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
  | "fx"
  | "openai-compatible"
  | "anthropic-compatible"
  | "azure-foundry"
  | "openai-image"
  | "gemini-native-image"
  | "bfl-image"
  | "ideogram-image";

/**
 * Optional presentation limits for embedded creation flows. Settings can
 * expose the same credential-authorized provider lifecycle in a focused
 * context (for example, image generation) without cloning the form or
 * inventing a second provider configuration path.
 */
export interface ProviderCreateFormPresentationProps {
  readonly initialProviderType?: ProviderCreateProviderType;
  readonly allowedProviderTypes?: ReadonlyArray<ProviderCreateProviderType>;
  readonly triggerLabel?: string;
  readonly heading?: string;
  readonly hint?: string;
}

export function ProviderCreateForm(
  props: ProviderCreateFormProps & ProviderCreateFormPresentationProps,
) {
  const [creating, setCreating] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const initialProviderType =
    props.initialProviderType ?? props.allowedProviderTypes?.[0] ?? "opencode";
  const [providerType, setProviderType] = useState<ProviderCreateProviderType>(initialProviderType);
  const [claudeAuthentication, setClaudeAuthentication] =
    useState<ClaudeAuthentication>("subscription");
  const [vibeAuthentication] = useState<MistralVibeAuthentication>("api-key");
  const [grokAuthentication, setGrokAuthentication] = useState<GrokAuthentication>("subscription");
  const [glmAuthentication, setGlmAuthentication] = useState<GlmAuthentication>("provider-owned");
  const [geminiAuthentication, setGeminiAuthentication] =
    useState<GeminiAuthentication>("provider-owned");
  const [clineAuthentication, setClineAuthentication] =
    useState<ClineAuthentication>("provider-owned");
  const [qwenAuthentication, setQwenAuthentication] =
    useState<QwenAuthentication>("provider-owned");
  const credentialInput = useRef<HTMLInputElement>(null);
  const selectedDriverLabel = driverLabel(providerType);
  const allowedProviderTypes = props.allowedProviderTypes;
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
        <span>{props.triggerLabel ?? "Add provider manually"}</span>
        <ChevronDown aria-hidden="true" className="provider-settings__disclosure-icon" size={16} />
      </OctantButton>
      {manualOpen ? (
        <div className="provider-settings__manual-body">
          <div className="provider-settings__create-heading">
            <h3>{props.heading ?? "Custom endpoint or binary"}</h3>
            <p className="provider-settings__hint">
              {props.hint ??
                "Installed runtimes are detected automatically. Use this only for a custom HTTP endpoint or an unusual executable location."}
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
                        : providerType === "bfl-image"
                          ? "Add Black Forest Labs image profile"
                          : providerType === "ideogram-image"
                            ? "Add Ideogram image profile"
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
                  authentication: glmAuthentication,
                };
                operation = props.onCreateGlm(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  glmAuthentication === "api-key"
                    ? transientCredential(credentialInput.current)
                    : emptyTransientCredential(transientCredential(credentialInput.current)),
                );
              } else if (providerType === "gemini") {
                const configuration: GeminiProviderConfiguration = {
                  kind: "gemini-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: geminiAuthentication,
                };
                operation = props.onCreateGemini(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  geminiAuthentication === "api-key"
                    ? transientCredential(credentialInput.current)
                    : emptyTransientCredential(transientCredential(credentialInput.current)),
                );
              } else if (providerType === "cline") {
                const configuration: ClineProviderConfiguration = {
                  kind: "cline-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: clineAuthentication,
                };
                operation = props.onCreateCline(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  clineAuthentication === "api-key"
                    ? transientCredential(credentialInput.current)
                    : emptyTransientCredential(transientCredential(credentialInput.current)),
                );
              } else if (providerType === "qwen") {
                const configuration: QwenProviderConfiguration = {
                  kind: "qwen-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: qwenAuthentication,
                };
                operation = props.onCreateQwen(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  qwenAuthentication === "api-key"
                    ? transientCredential(credentialInput.current)
                    : emptyTransientCredential(transientCredential(credentialInput.current)),
                );
              } else if (providerType === "fx") {
                const configuration: FxProviderConfiguration = {
                  kind: "fx-acp",
                  binaryPath: String(data.get("binaryPath") ?? ""),
                  authentication: "api-key",
                };
                operation = props.onCreateFx(
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
              } else if (providerType === "bfl-image") {
                const configuration = bflImageConfigurationFrom(data);
                const enteredCredential = transientCredential(credentialInput.current);
                operation = props.onCreateBflImage(
                  String(data.get("displayName") ?? ""),
                  configuration,
                  enteredCredential,
                );
              } else if (providerType === "ideogram-image") {
                const configuration = ideogramImageConfigurationFrom(data);
                const enteredCredential = transientCredential(credentialInput.current);
                operation = props.onCreateIdeogramImage(
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
                  { id: "opencode", group: "Coding agents", label: "OpenCode CLI" },
                  { id: "codex", group: "Coding agents", label: "Codex CLI" },
                  { id: "kimi-code", group: "Coding agents", label: "Kimi Code CLI" },
                  { id: "claude", group: "Coding agents", label: "Claude Agent SDK" },
                  { id: "devin", group: "Coding agents", label: "Devin ACP" },
                  { id: "kilo", group: "Coding agents", label: "Kilo ACP" },
                  { id: "pi", group: "Coding agents", label: "Pi RPC" },
                  { id: "oh-my-pi", group: "Coding agents", label: "Oh My Pi" },
                  { id: "mistral-vibe", group: "Coding agents", label: "Mistral Vibe ACP" },
                  { id: "grok", group: "Coding agents", label: "Grok Build ACP" },
                  { id: "goose", group: "Coding agents", label: "Goose ACP" },
                  { id: "glm", group: "Coding agents", label: "GLM Agent ACP" },
                  { id: "gemini", group: "Coding agents", label: "Gemini CLI ACP" },
                  { id: "copilot", group: "Coding agents", label: "GitHub Copilot ACP" },
                  { id: "cline", group: "Coding agents", label: "Cline ACP" },
                  { id: "qwen", group: "Coding agents", label: "Qwen Code ACP" },
                  { id: "fx", group: "Coding agents", label: "fx ACP" },
                  {
                    id: "openai-compatible",
                    group: "Chat, voice & custom image APIs",
                    label: "OpenAI-compatible HTTP",
                  },
                  {
                    id: "anthropic-compatible",
                    group: "Chat, voice & custom image APIs",
                    label: "Anthropic-compatible HTTP",
                  },
                  {
                    id: "azure-foundry",
                    group: "Chat, voice & custom image APIs",
                    label: "Azure AI Foundry",
                  },
                  {
                    id: "ollama",
                    group: "Chat, voice & custom image APIs",
                    label: "Ollama native HTTP",
                  },
                  { id: "openai-image", group: "Image generation", label: "OpenAI Image" },
                  {
                    id: "gemini-native-image",
                    group: "Image generation",
                    label: "Gemini Image",
                  },
                  {
                    id: "bfl-image",
                    group: "Image generation",
                    label: "Black Forest Labs Image",
                  },
                  { id: "ideogram-image", group: "Image generation", label: "Ideogram Image" },
                ].filter(
                  (option) =>
                    allowedProviderTypes === undefined ||
                    allowedProviderTypes.includes(option.id as ProviderCreateProviderType),
                )}
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
            providerType !== "bfl-image" &&
            providerType !== "ideogram-image" &&
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
            ) : providerType === "bfl-image" ? (
              <BflImageFields
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
              />
            ) : providerType === "ideogram-image" ? (
              <IdeogramImageFields
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
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
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
              <ProviderOwnedApiKeyCreateFields
                apiKeyLabel="Z.AI API key"
                authentication={glmAuthentication}
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
                onAuthenticationChange={setGlmAuthentication}
              />
            ) : null}
            {providerType === "gemini" ? (
              <ProviderOwnedApiKeyCreateFields
                apiKeyLabel="Gemini API key"
                authentication={geminiAuthentication}
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
                onAuthenticationChange={setGeminiAuthentication}
              />
            ) : null}
            {providerType === "cline" ? (
              <ProviderOwnedApiKeyCreateFields
                apiKeyLabel="Cline API key"
                authentication={clineAuthentication}
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
                onAuthenticationChange={setClineAuthentication}
              />
            ) : null}
            {providerType === "qwen" ? (
              <ProviderOwnedApiKeyCreateFields
                apiKeyLabel="OpenAI-compatible API key"
                authentication={qwenAuthentication}
                credentialInput={credentialInput}
                credentialManagementAvailable={props.credentialManagementAvailable}
                onAuthenticationChange={setQwenAuthentication}
              />
            ) : null}
            {providerType === "fx" ? (
              <label>
                <span>Vercel AI Gateway API key</span>
                <OctantInput
                  aria-label="Vercel AI Gateway API key"
                  autoComplete="off"
                  className="settings-view__text-input window-no-drag"
                  disabled={!props.credentialManagementAvailable}
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
                (providerType === "glm" &&
                  glmAuthentication === "api-key" &&
                  !props.credentialManagementAvailable) ||
                ((providerType === "gemini" ||
                  providerType === "cline" ||
                  providerType === "qwen") &&
                  ((providerType === "gemini" && geminiAuthentication === "api-key") ||
                    (providerType === "cline" && clineAuthentication === "api-key") ||
                    (providerType === "qwen" && qwenAuthentication === "api-key")) &&
                  !props.credentialManagementAvailable) ||
                ((providerType === "openai-image" ||
                  providerType === "gemini-native-image" ||
                  providerType === "bfl-image" ||
                  providerType === "ideogram-image") &&
                  !props.credentialManagementAvailable) ||
                (providerType === "fx" && !props.credentialManagementAvailable)
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
                          : providerType === "bfl-image"
                            ? "Add Black Forest Labs image profile"
                            : providerType === "ideogram-image"
                              ? "Add Ideogram image profile"
                              : `Add ${selectedDriverLabel}`}
            </OctantButton>
          </form>
          {providerType === "openai-compatible" ? <BedrockMantleGuide /> : null}
        </div>
      ) : null}
    </section>
  );
}

function ProviderOwnedApiKeyCreateFields(props: {
  readonly apiKeyLabel: string;
  readonly authentication:
    | GlmAuthentication
    | GeminiAuthentication
    | ClineAuthentication
    | QwenAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (value: "provider-owned" | "api-key") => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantSelectField
          aria-label="Provider authentication"
          className="settings-view__select window-no-drag"
          onValueChange={(value) =>
            props.onAuthenticationChange(value as "provider-owned" | "api-key")
          }
          options={[
            { id: "provider-owned", label: "Provider CLI login (recommended)" },
            { id: "api-key", label: props.apiKeyLabel },
          ]}
          value={props.authentication}
        />
      </label>
      {props.authentication === "api-key" ? (
        <label>
          <span>{props.apiKeyLabel}</span>
          <OctantInput
            aria-label={props.apiKeyLabel}
            autoComplete="off"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            name="apiKey"
            ref={props.credentialInput}
            required
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Authenticate with the provider-owned CLI in your terminal. Octant will reuse its native
          profile and binary.
        </p>
      )}
    </>
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
