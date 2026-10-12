import { type ClaudeAccountAccent, type ProviderInstance } from "@octant/contracts";
import { useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { SettingRow } from "../../settings/primitives";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";
import { CodexAccountSettingsFields } from "./ClaudeAccountFields";
import { parseClaudeAccountAccent } from "./claudeAccountValues";

interface CodexConfigurationFormProps {
  readonly instance: Extract<ProviderInstance, { driverKind: "codex" }>;
  readonly extraAccount: boolean;
  readonly disabled: boolean;
  readonly onChange: ProviderSettingsViewProps["onChangeCodexConfiguration"];
}

export function CodexConfigurationForm(props: CodexConfigurationFormProps) {
  const [accent, setAccent] = useState<ClaudeAccountAccent | "">(
    props.instance.configuration.accent ?? "",
  );
  const [binaryPath, setBinaryPath] = useState(props.instance.configuration.binaryPath);
  return (
    <form
      className="provider-card__edit provider-card__edit--codex"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const parsedAccent = parseClaudeAccountAccent(String(data.get("accent") ?? ""));
        void props.onChange(props.instance.id, {
          kind: "codex-cli",
          binaryPath: String(data.get("binaryPath") ?? ""),
          ...(parsedAccent === undefined ? {} : { accent: parsedAccent }),
          ...(props.instance.configuration.codexHome === undefined
            ? {}
            : { codexHome: props.instance.configuration.codexHome }),
        });
      }}
    >
      <SettingRow
        label="Codex binary path"
        scope="host"
        settingId={`provider-${props.instance.id}-binary-path`}
      >
        <OctantInput
          aria-label={`Codex binary for ${props.instance.displayName}`}
          className="settings-view__text-input"
          name="binaryPath"
          onChange={(event) => setBinaryPath(event.currentTarget.value)}
          required
          value={binaryPath}
        />
      </SettingRow>
      <CodexAccountSettingsFields
        accent={accent}
        binaryPath={binaryPath}
        extraAccount={props.extraAccount}
        instanceId={props.instance.id}
        onAccentChange={setAccent}
        onReassignDirectory={() => {
          const parsedAccent = parseClaudeAccountAccent(accent);
          void props.onChange(
            props.instance.id,
            {
              kind: "codex-cli",
              binaryPath,
              ...(parsedAccent === undefined ? {} : { accent: parsedAccent }),
            },
            { reassignAccountDirectory: true },
          );
        }}
        {...(props.instance.configuration.codexHome === undefined
          ? {}
          : { storedDirectory: props.instance.configuration.codexHome })}
      />
      <div className="provider-card__edit-actions">
        <OctantButton
          disabled={props.disabled}
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Save Codex settings for ${props.instance.displayName}`}
        >
          Save
        </OctantButton>
      </div>
    </form>
  );
}
