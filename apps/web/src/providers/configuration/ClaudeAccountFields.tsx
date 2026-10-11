import type { ClaudeAccountAccent } from "@octant/contracts";
import { CLAUDE_ACCOUNT_ACCENT_VALUES, formatClaudeAuthLoginCommand } from "@octant/domain";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { SettingRow } from "../../settings/primitives";
import { CLAUDE_ACCOUNT_ACCENT_LABELS } from "./claudeAccountValues";

export function ClaudeAccountAccentPicker(props: {
  readonly id: string;
  readonly label: string;
  readonly value: ClaudeAccountAccent | "";
  readonly onChange: (accent: ClaudeAccountAccent) => void;
}) {
  return (
    <div className="claude-account-accent-picker" role="radiogroup" aria-label={props.label}>
      {CLAUDE_ACCOUNT_ACCENT_VALUES.map((accent) => (
        <OctantButton
          aria-checked={props.value === accent}
          aria-label={CLAUDE_ACCOUNT_ACCENT_LABELS[accent]}
          className="claude-account-accent-picker__swatch"
          data-accent={accent}
          data-selected={props.value === accent ? "true" : "false"}
          key={accent}
          onClick={() => props.onChange(accent)}
          role="radio"
          type="button"
          variant="bare"
        />
      ))}
    </div>
  );
}

export function ClaudeAccountSettingsFields(props: {
  readonly instanceId?: string;
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly accent: ClaudeAccountAccent | "";
  readonly onAccentChange: (accent: ClaudeAccountAccent) => void;
  readonly onConfigDirectoryChange?: (directory: string) => void;
  readonly includeConfigDirectoryInput?: boolean;
  readonly showSignInCommand?: boolean;
  readonly preserveExistingDirectory?: boolean;
}) {
  const settingPrefix =
    props.instanceId === undefined ? "provider-create-claude" : `provider-${props.instanceId}`;
  const signInCommand = formatClaudeAuthLoginCommand({
    binaryPath: props.binaryPath.trim() || "/usr/local/bin/claude",
    ...(props.configDirectory.trim().length === 0
      ? {}
      : { configDirectory: props.configDirectory.trim() }),
  });
  return (
    <>
      {props.includeConfigDirectoryInput === false ? null : (
        <SettingRow
          description={
            props.instanceId === undefined
              ? "Leave blank to use Claude's default directory for the first account. Additional accounts get their own directory automatically."
              : props.preserveExistingDirectory === true
                ? "Leave blank to keep this account's current directory."
                : "Leave blank to keep Claude's default directory for this account."
          }
          label="Claude config directory"
          scope="host"
          settingId={`${settingPrefix}-config-directory`}
        >
          <OctantInput
            aria-label="Claude config directory"
            className="settings-view__text-input"
            name="configDirectory"
            onChange={
              props.onConfigDirectoryChange === undefined
                ? undefined
                : (event) => props.onConfigDirectoryChange?.(event.currentTarget.value)
            }
            placeholder="/absolute/path/to/claude-account"
            {...(props.onConfigDirectoryChange === undefined
              ? { defaultValue: props.configDirectory }
              : { value: props.configDirectory })}
          />
        </SettingRow>
      )}
      <SettingRow
        description="Shown as a color on this account in the model picker."
        label="Account accent"
        scope="host"
        settingId={`${settingPrefix}-accent`}
      >
        <OctantInput name="accent" type="hidden" value={props.accent} />
        <ClaudeAccountAccentPicker
          id={`${settingPrefix}-accent`}
          label="Account accent"
          onChange={props.onAccentChange}
          value={props.accent}
        />
      </SettingRow>
      {props.showSignInCommand === false ? null : (
        <SettingRow
          description="Sign in only with this unmodified Claude command in a terminal for this account. Octant never reads Claude credential files."
          label="Sign in"
          scope="host"
          settingId={`${settingPrefix}-auth-login`}
        >
          <OctantInput
            aria-label="Claude sign-in command"
            className="settings-view__text-input"
            readOnly
            value={signInCommand}
          />
        </SettingRow>
      )}
    </>
  );
}
