import {
  type ClaudeAccountAccent,
  type ClaudeAuthentication,
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
import { ClaudeAccountSettingsFields } from "./ClaudeAccountFields";
import { claudeConfigurationFromFields } from "./claudeAccountValues";

interface ClaudeConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "claude" }>;
  readonly extraAccount: boolean;
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
  const [accent, setAccent] = useState<ClaudeAccountAccent | "">(
    props.instance.configuration.accent ?? "",
  );
  const [binaryPath, setBinaryPath] = useState(props.instance.configuration.binaryPath);
  return (
    <form
      className="provider-card__edit provider-card__edit--claude"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const configuration = claudeConfigurationFromFields({
          binaryPath: String(data.get("binaryPath") ?? ""),
          authentication,
          accent: String(data.get("accent") ?? ""),
        });
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
          name="binaryPath"
          onChange={(event) => setBinaryPath(event.currentTarget.value)}
          required
          value={binaryPath}
        />
      </SettingRow>
      <SettingRow
        description={
          authentication === "subscription"
            ? "Sign in with the official Claude Code CLI using the unmodified command shown below, then check the connection."
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
      <ClaudeAccountSettingsFields
        accent={accent}
        binaryPath={binaryPath}
        extraAccount={props.extraAccount}
        instanceId={props.instance.id}
        onAccentChange={setAccent}
        onReassignDirectory={() => {
          const configuration = claudeConfigurationFromFields({
            binaryPath,
            authentication,
            accent,
            reassignDirectory: true,
          });
          void props.onChange(props.instance.id, configuration, emptyTransientCredential(), {
            reassignAccountDirectory: true,
          });
        }}
        showSignInCommand={authentication === "subscription"}
        {...(props.instance.configuration.configDirectory === undefined
          ? {}
          : { storedDirectory: props.instance.configuration.configDirectory })}
      />
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
