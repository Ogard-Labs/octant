import {
  type GrokAuthentication,
  type GrokProviderConfiguration,
  type GlmProviderConfiguration,
  type GeminiProviderConfiguration,
  type ClineProviderConfiguration,
  type QwenProviderConfiguration,
  type FxProviderConfiguration,
  type MistralVibeAuthentication,
  type MistralVibeProviderConfiguration,
  type ProviderInstance,
} from "@octant/contracts";
import { useRef, useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import {
  emptyTransientCredential,
  transientCredential,
  type CredentialStatusController,
} from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import type { TransientProviderCredential } from "../useProviderController";

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
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Kilo settings for ${props.instance.displayName}`}
      >
        Save
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
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Goose settings for ${props.instance.displayName}`}
      >
        Save
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
}) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState(props.instance.configuration.authentication);
  return (
    <form
      className="provider-card__edit provider-card__edit--glm"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration: GlmProviderConfiguration = {
          kind: "glm-acp",
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication,
        };
        void props.onChange(
          props.instance.id,
          configuration,
          authentication === "api-key"
            ? transientCredential(credentialInput.current)
            : emptyTransientCredential(transientCredential(credentialInput.current)),
        );
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
        <span>Authentication</span>
        <OctantSelectField
          aria-label={`GLM authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          onValueChange={(value) => setAuthentication(value as typeof authentication)}
          options={[
            { id: "provider-owned", label: "Provider CLI login (recommended)" },
            { id: "api-key", label: "Z.AI API key" },
          ]}
          value={authentication}
        />
      </label>
      {authentication === "api-key" ? (
        <label>
          <span>Z.AI API key (leave blank to preserve)</span>
          <OctantInput
            aria-label={`Z.AI API key for ${props.instance.displayName}`}
            autoComplete="off"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            name="apiKey"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Run the provider-owned GLM Agent CLI login in your terminal. Octant reuses its native
          profile and binary.
        </p>
      )}
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save GLM settings for ${props.instance.displayName}`}
      >
        Save
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
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save GitHub Copilot settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}

export function ApiKeyAcpConfigurationForm<
  T extends
    | GeminiProviderConfiguration
    | ClineProviderConfiguration
    | QwenProviderConfiguration
    | FxProviderConfiguration,
>(props: {
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly instance: ProviderInstance;
  readonly driverLabel: string;
  readonly binaryLabel: string;
  readonly apiKeyLabel: string;
  readonly configuration: T;
  /**
   * Drivers whose contract carries exactly one authentication posture set this
   * so the form draws no selector and always submits that literal. Offering a
   * choice would build a configuration the server refuses to decode.
   */
  readonly fixedAuthentication?: T["authentication"];
  readonly onChange: (
    instanceId: ProviderInstance["id"],
    configuration: T,
    credential: TransientProviderCredential,
  ) => Promise<boolean>;
}) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState<T["authentication"]>(
    props.fixedAuthentication ?? props.configuration.authentication,
  );
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const configuration = {
          ...props.configuration,
          binaryPath: String(new FormData(event.currentTarget).get("binaryPath") ?? ""),
          authentication,
        } as T;
        void props.onChange(
          props.instance.id,
          configuration,
          authentication === "api-key"
            ? transientCredential(credentialInput.current)
            : emptyTransientCredential(transientCredential(credentialInput.current)),
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
      {props.fixedAuthentication === undefined ? (
        <label>
          <span>Authentication</span>
          <OctantSelectField
            aria-label={`Authentication for ${props.instance.displayName}`}
            className="settings-view__select"
            onValueChange={(value) => setAuthentication(value as typeof authentication)}
            options={[
              { id: "provider-owned", label: "Provider CLI login (recommended)" },
              { id: "api-key", label: props.apiKeyLabel },
            ]}
            value={authentication}
          />
        </label>
      ) : null}
      {authentication === "api-key" ? (
        <label>
          <span>{props.apiKeyLabel} (leave blank to preserve)</span>
          <OctantInput
            aria-label={`${props.apiKeyLabel} for ${props.instance.displayName}`}
            autoComplete="off"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            name="apiKey"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Authenticate with the provider-owned CLI in your terminal. Octant launches this same
          binary and reuses its native profile; it does not create a second login.
        </p>
      )}
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save ${props.driverLabel} settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}

export function GeminiConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "gemini" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeGeminiConfiguration"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="Gemini API key (leave blank to preserve)"
      binaryLabel="gemini binary path"
      configuration={props.instance.configuration}
      credentialManagementAvailable={props.credentialManagementAvailable}
      disabled={props.disabled}
      driverLabel="Gemini CLI"
      instance={props.instance}
      onChange={props.onChange}
    />
  );
}

export function ClineConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "cline" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeClineConfiguration"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="Cline API key (leave blank to preserve)"
      binaryLabel="cline binary path"
      configuration={props.instance.configuration}
      credentialManagementAvailable={props.credentialManagementAvailable}
      disabled={props.disabled}
      driverLabel="Cline"
      instance={props.instance}
      onChange={props.onChange}
    />
  );
}

export function QwenConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "qwen" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeQwenConfiguration"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="OpenAI-compatible API key (leave blank to preserve)"
      binaryLabel="qwen binary path"
      configuration={props.instance.configuration}
      credentialManagementAvailable={props.credentialManagementAvailable}
      disabled={props.disabled}
      driverLabel="Qwen Code"
      instance={props.instance}
      onChange={props.onChange}
    />
  );
}

export function FxConfigurationForm(props: {
  readonly instance: Extract<ProviderInstance, { driverKind: "fx" }>;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeFxConfiguration"];
}) {
  return (
    <ApiKeyAcpConfigurationForm
      apiKeyLabel="Vercel AI Gateway API key (leave blank to preserve)"
      binaryLabel="fx binary path"
      configuration={props.instance.configuration}
      credentialManagementAvailable={props.credentialManagementAvailable}
      disabled={props.disabled}
      driverLabel="fx"
      fixedAuthentication="api-key"
      instance={props.instance}
      onChange={props.onChange}
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
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Ollama settings for ${props.instance.displayName}`}
      >
        Save
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
}

export function VibeConfigurationForm(props: VibeConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const authentication: MistralVibeAuthentication = "api-key";
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
      <p className="provider-settings__field-guidance">
        Mistral Vibe requires a Mistral API key entered in Settings → Providers. The confined launch
        does not read the macOS Keychain.
      </p>
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
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Mistral Vibe settings for ${props.instance.displayName}`}
      >
        Save
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
}

export function GrokConfigurationForm(props: GrokConfigurationFormProps) {
  const credentialInput = useRef<HTMLInputElement>(null);
  const [authentication, setAuthentication] = useState<GrokAuthentication>(
    props.instance.configuration.authentication,
  );
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
            setAuthentication(next);
          }}
          options={[
            { id: "subscription", label: "Provider CLI login (recommended)" },
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
        <p className="provider-settings__field-guidance">
          Run <code>grok login</code> in your terminal, or <code>grok login --device-auth</code> on
          a headless host. Octant reuses the same Grok profile and binary.
        </p>
      )}
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Grok Build settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}
