import {
  type ClaudeAuthentication,
  type ClaudeProviderConfiguration,
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
      <SettingRow
        label="Claude binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`Claude binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </SettingRow>
      <SettingRow
        description={
          authentication === "subscription"
            ? "Authenticate with the official Claude Code app or CLI, then check the connection."
            : undefined
        }
        label="Authentication"
        scope="host"
        settingId={`provider-${props.instance.id}-authentication`}
      >
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
      </SettingRow>
      {authentication === "api-key" ? (
        <SettingRow
          label="Anthropic API key (leave blank to preserve)"
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
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
        </SettingRow>
      ) : null}
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Claude settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}
