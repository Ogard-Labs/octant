import type { ClaudeAccountAccent, ProviderInstanceId } from "@octant/contracts";
import {
  CLAUDE_ACCOUNT_ACCENT_VALUES,
  CLAUDE_ACCOUNT_PROFILE,
  formatProviderAccountSignInCommand,
  formatProviderAccountStatusCommand,
} from "@octant/domain";
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

export function displayAssignedAccountDirectory(input: {
  readonly instanceId?: ProviderInstanceId;
  readonly storedDirectory?: string;
  readonly extraAccount: boolean;
}): {
  readonly path: string;
  readonly kind: "assigned-default" | "assigned-extra" | "legacy-custom";
} {
  const stored = input.storedDirectory?.trim() ?? "";
  if (
    stored.length > 0 &&
    input.instanceId !== undefined &&
    !stored.endsWith(`/.claude-accounts/${String(input.instanceId).toLowerCase()}`) &&
    !stored.endsWith("/.claude")
  ) {
    return { path: stored, kind: "legacy-custom" };
  }
  if (stored.length > 0) {
    return {
      path: stored,
      kind: stored.endsWith("/.claude") ? "assigned-default" : "assigned-extra",
    };
  }
  if (input.extraAccount) {
    return {
      path:
        input.instanceId === undefined
          ? `~/${CLAUDE_ACCOUNT_PROFILE.extraAccountsDirectoryName}/<assigned on create>`
          : `~/${CLAUDE_ACCOUNT_PROFILE.extraAccountsDirectoryName}/${input.instanceId}`,
      kind: "assigned-extra",
    };
  }
  return {
    path: `~/${CLAUDE_ACCOUNT_PROFILE.defaultHostDirectoryName}`,
    kind: "assigned-default",
  };
}

export function ClaudeAccountSettingsFields(props: {
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly accent: ClaudeAccountAccent | "";
  readonly onAccentChange: (accent: ClaudeAccountAccent) => void;
  readonly storedDirectory?: string;
  readonly extraAccount: boolean;
  readonly showSignInCommand?: boolean;
  readonly onReassignDirectory?: () => void;
}) {
  const settingPrefix =
    props.instanceId === undefined ? "provider-create-claude" : `provider-${props.instanceId}`;
  const binaryPath = props.binaryPath.trim();
  const displayed = displayAssignedAccountDirectory({
    extraAccount: props.extraAccount,
    ...(props.instanceId === undefined ? {} : { instanceId: props.instanceId }),
    ...(props.storedDirectory === undefined ? {} : { storedDirectory: props.storedDirectory }),
  });
  const storedDirectory = props.storedDirectory?.trim() ?? "";
  // The command names the stored directory exactly: Claude keys its login on
  // that string, so a path Octant only displays (`~/…`) must not be offered.
  // An extra account with nothing stored yet shows no command, and the
  // host-profile account runs the bare command.
  const commandReady =
    props.showSignInCommand !== false &&
    binaryPath.startsWith("/") &&
    (storedDirectory.length > 0 || !props.extraAccount);
  const commandDirectory = storedDirectory.length > 0 ? storedDirectory : undefined;
  const signInCommand = commandReady
    ? formatProviderAccountSignInCommand({
        profile: CLAUDE_ACCOUNT_PROFILE,
        binaryPath,
        ...(commandDirectory === undefined ? {} : { stateDirectory: commandDirectory }),
      })
    : undefined;
  const statusCommand = commandReady
    ? formatProviderAccountStatusCommand({
        profile: CLAUDE_ACCOUNT_PROFILE,
        binaryPath,
        ...(commandDirectory === undefined ? {} : { stateDirectory: commandDirectory }),
      })
    : undefined;
  return (
    <>
      <SettingRow
        description={
          displayed.kind === "legacy-custom"
            ? "This account still uses a directory you chose, so it keeps that login. Re-assign to Octant's directory only if you want a new login on the assigned path. Threads this account already started stay in the old directory and cannot continue after that."
            : displayed.kind === "assigned-default"
              ? "Octant assigns the first subscription account Claude's default directory."
              : "Octant assigns this account its own directory. Sign in only with the command below."
        }
        label="Account directory"
        scope="host"
        settingId={`${settingPrefix}-config-directory`}
      >
        <OctantInput
          aria-label="Account directory"
          className="settings-view__text-input"
          name="configDirectory"
          readOnly
          value={displayed.path}
        />
        {displayed.kind === "legacy-custom" && props.onReassignDirectory !== undefined ? (
          <OctantButton
            onClick={props.onReassignDirectory}
            size="sm"
            type="button"
            variant="outline"
          >
            Use Octant's assigned directory
          </OctantButton>
        ) : null}
      </SettingRow>
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
      {signInCommand === undefined ? null : (
        <SettingRow
          description="Sign in only with this unmodified command in a terminal for this account. Octant never reads, stores, or injects provider credentials. If you previously connected Claude for helpers, revoke that leftover token with Anthropic."
          label="Sign in"
          scope="host"
          settingId={`${settingPrefix}-auth-login`}
        >
          <OctantInput
            aria-label="Account sign-in command"
            className="settings-view__text-input"
            readOnly
            value={signInCommand}
          />
        </SettingRow>
      )}
      {statusCommand === undefined ? null : (
        <SettingRow
          description="Check this account's sign-in with the unmodified CLI."
          label="Status"
          scope="host"
          settingId={`${settingPrefix}-auth-status`}
        >
          <OctantInput
            aria-label="Account status command"
            className="settings-view__text-input"
            readOnly
            value={statusCommand}
          />
        </SettingRow>
      )}
    </>
  );
}
