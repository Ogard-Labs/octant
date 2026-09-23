import { type ProviderInstance } from "@octant/contracts";
import { useRef } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { SettingRow } from "../../settings/primitives";
import {
  emptyTransientCredential,
  HttpCredentialFields,
  transientCredential,
  type CredentialStatusController,
} from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import {
  configurationFrom,
  anthropicConfigurationFrom,
  foundryConfigurationFrom,
} from "./configurationValues";

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
      <SettingRow
        label="API base URL"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`API base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </SettingRow>
      <HttpCredentialFields
        authentication={props.instance.configuration.authentication}
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
      />
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
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
      </SettingRow>
      <SettingRow
        label="Manual model IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-manual-model-ids`}
      >
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts.
      </p>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save HTTP settings for ${props.instance.displayName}`}
        >
          Save
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
      <SettingRow
        label="API base URL"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`API base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </SettingRow>
      <HttpCredentialFields
        authentication={props.instance.configuration.authentication}
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
        supportsApiKey
      />
      <SettingRow
        label="Anthropic protocol version"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol-version`}
      >
        <OctantInput
          aria-label={`Anthropic protocol version for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.protocolVersion}
          name="protocolVersion"
          required
        />
      </SettingRow>
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
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
      </SettingRow>
      <SettingRow
        label="Manual model IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-manual-model-ids`}
      >
        <OctantTextarea
          aria-label={`Manual model IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        Remote endpoints require HTTPS. HTTP is allowed only for loopback hosts.
      </p>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Anthropic settings for ${props.instance.displayName}`}
        >
          Save
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
      <SettingRow
        label="Foundry OpenAI v1 base URL"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-describedby={`endpoint-guidance-${props.instance.id}`}
          aria-label={`Foundry OpenAI v1 base URL for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.baseUrl}
          name="baseUrl"
          required
          type="url"
        />
      </SettingRow>
      <HttpCredentialFields
        authentication="api-key"
        authenticationLabel={`Authentication for ${props.instance.displayName}`}
        credentialInput={credentialInput}
        credentialLabel={`API key for ${props.instance.displayName}`}
        credentialManagementAvailable={props.credentialManagementAvailable}
        fixedAuthentication
        supportsApiKey
      />
      <SettingRow
        label="Protocol preference"
        scope="host"
        settingId={`provider-${props.instance.id}-protocol`}
      >
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
      </SettingRow>
      <SettingRow
        label="Deployment IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-deployment-ids`}
      >
        <OctantTextarea
          aria-label={`Deployment IDs for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.manualModelIds.join(", ")}
          name="manualModelIds"
          rows={2}
        />
      </SettingRow>
      <p
        className="provider-settings__field-guidance"
        id={`endpoint-guidance-${props.instance.id}`}
      >
        The base URL must end with /openai/v1/. API keys are stored write-only in Keychain and sent
        as the api-key header. List deployments in the order you want them to appear.
      </p>
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Azure AI Foundry settings for ${props.instance.displayName}`}
        >
          Save
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
