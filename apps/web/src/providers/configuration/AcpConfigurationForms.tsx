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
import { SettingRow } from "../../settings/primitives";
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="Binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Kilo settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="goose binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`goose binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Goose settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="glm-acp-agent binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`glm-acp-agent binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <SettingRow
        description={
          authentication === "api-key"
            ? undefined
            : "Run the provider-owned GLM Agent CLI login in your terminal. Octant reuses its native profile and binary."
        }
        htmlFor={`provider-${props.instance.id}-authentication-control`}
        label="Authentication"
        scope="host"
        settingId={`provider-${props.instance.id}-authentication`}
      >
        <OctantSelectField
          aria-label={`GLM authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          id={`provider-${props.instance.id}-authentication-control`}
          onValueChange={(value) => setAuthentication(value as typeof authentication)}
          options={[
            { id: "provider-owned", label: "Provider CLI login (recommended)" },
            { id: "api-key", label: "Z.AI API key" },
          ]}
          value={authentication}
        />
      </SettingRow>
      {authentication === "api-key" ? (
        <SettingRow
          htmlFor={`provider-${props.instance.id}-api-key-control`}
          label="Z.AI API key (leave blank to preserve)"
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
          <OctantInput
            aria-label={`Z.AI API key for ${props.instance.displayName}`}
            autoComplete="off"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            id={`provider-${props.instance.id}-api-key-control`}
            name="apiKey"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </SettingRow>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save GLM settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="copilot binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`copilot binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save GitHub Copilot settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label={props.binaryLabel}
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`${props.binaryLabel} for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      {props.fixedAuthentication === undefined ? (
        <SettingRow
          description={
            authentication === "api-key"
              ? undefined
              : "Authenticate with the provider-owned CLI in your terminal. Octant launches this same binary and reuses its native profile; it does not create a second login."
          }
          htmlFor={`provider-${props.instance.id}-authentication-control`}
          label="Authentication"
          scope="host"
          settingId={`provider-${props.instance.id}-authentication`}
        >
          <OctantSelectField
            aria-label={`Authentication for ${props.instance.displayName}`}
            className="settings-view__select"
            id={`provider-${props.instance.id}-authentication-control`}
            onValueChange={(value) => setAuthentication(value as typeof authentication)}
            options={[
              { id: "provider-owned", label: "Provider CLI login (recommended)" },
              { id: "api-key", label: props.apiKeyLabel },
            ]}
            value={authentication}
          />
        </SettingRow>
      ) : null}
      {authentication === "api-key" ? (
        <SettingRow
          htmlFor={`provider-${props.instance.id}-api-key-control`}
          label={`${props.apiKeyLabel} (leave blank to preserve)`}
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
          <OctantInput
            aria-label={`${props.apiKeyLabel} for ${props.instance.displayName}`}
            autoComplete="off"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            id={`provider-${props.instance.id}-api-key-control`}
            name="apiKey"
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </SettingRow>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save ${props.driverLabel} settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-base-url-control`}
        description="Literal loopback native API only. Octant never manages the shared Ollama service or its models."
        label="Ollama API base URL"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-label={`Ollama API base for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          id={`provider-${props.instance.id}-base-url-control`}
          name="baseUrl"
          required
          type="url"
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Ollama settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="vibe-acp binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`vibe-acp binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <SettingRow
        description="Mistral Vibe uses a Mistral API key. Octant's confined launch cannot read the key Vibe stores in the macOS Keychain."
        htmlFor={`provider-${props.instance.id}-api-key-control`}
        label="Mistral API key (leave blank to preserve)"
        scope="host"
        settingId={`provider-${props.instance.id}-api-key`}
      >
        <OctantInput
          aria-label={`Mistral API key for ${props.instance.displayName}`}
          autoComplete="new-password"
          className="settings-view__text-input"
          disabled={!props.credentialManagementAvailable}
          id={`provider-${props.instance.id}-api-key-control`}
          ref={credentialInput}
          spellCheck={false}
          type="password"
        />
      </SettingRow>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Mistral Vibe settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
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
      <SettingRow
        htmlFor={`provider-${props.instance.id}-binary-path-control`}
        label="grok binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`grok binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          id={`provider-${props.instance.id}-binary-path-control`}
          name="binaryPath"
          required
        />
      </SettingRow>
      <SettingRow
        description={
          authentication === "api-key"
            ? undefined
            : "Run grok login in your terminal, or grok login --device-auth on a headless host. Octant reuses the same Grok profile and binary."
        }
        htmlFor={`provider-${props.instance.id}-authentication-control`}
        label="Authentication"
        scope="host"
        settingId={`provider-${props.instance.id}-authentication`}
      >
        <OctantSelectField
          aria-label={`Grok Build authentication for ${props.instance.displayName}`}
          className="settings-view__select"
          id={`provider-${props.instance.id}-authentication-control`}
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
      </SettingRow>
      {authentication === "api-key" ? (
        <SettingRow
          htmlFor={`provider-${props.instance.id}-api-key-control`}
          label="xAI API key (leave blank to preserve)"
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
          <OctantInput
            aria-label={`xAI API key for ${props.instance.displayName}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            disabled={!props.credentialManagementAvailable}
            id={`provider-${props.instance.id}-api-key-control`}
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </SettingRow>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Grok Build settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}
