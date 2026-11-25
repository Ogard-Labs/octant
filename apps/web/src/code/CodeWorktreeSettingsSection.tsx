import type { CodeSettings, CodeWorktreeSettings } from "@octant/contracts/code";
import { DEFAULT_BRANCH_PREFIX, isValidBranchPrefix } from "@octant/domain/code-worktree-naming";
import { useState } from "react";
import type { SettingsSettingId } from "@octant/contracts";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { CodeSettingsUpdate } from "./CodeSettingsView";

const NAMING_OPTIONS = [
  { id: "short-id", label: "Prefix and short id" },
  { id: "prompt", label: "Prefix and words from the prompt" },
] as const;

/** What the host does for a store with no choice: the same as before the setting existed. */
function branchNamingOf(worktrees: CodeWorktreeSettings | undefined) {
  return worktrees?.branchNaming ?? "short-id";
}

/**
 * Settings › Code › Worktrees › Naming. Every control saves as it
 * is changed, whole: the host replaces the worktree choices with what is sent.
 */
export function CodeWorktreeSettingsSection(props: {
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly settings: CodeSettings;
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
}) {
  const worktrees = props.settings.worktrees;
  const [prefix, setPrefix] = useState(worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  const [message, setMessage] = useState<string>();

  async function save(next: CodeWorktreeSettings): Promise<boolean> {
    let saved = false;
    try {
      saved = await props.onUpdate({
        defaultExecutionPolicy: props.settings.defaultExecutionPolicy,
        defaultPermissionPersistence: props.settings.defaultPermissionPersistence,
        // The host drops the editor when an update leaves it out.
        ...(props.settings.externalEditor === undefined
          ? {}
          : { externalEditor: props.settings.externalEditor }),
        worktrees: next,
      });
    } catch {
      saved = false;
    }
    setMessage(saved ? undefined : "Worktree settings could not be saved.");
    if (!saved) setPrefix(worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
    return saved;
  }

  function commitPrefix() {
    const trimmed = prefix.trim();
    if (trimmed === (worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)) return;
    if (!isValidBranchPrefix(trimmed)) {
      setMessage("Git or Windows cannot use that prefix in a branch name.");
      return;
    }
    const { branchPrefix: _previous, ...rest } = worktrees ?? {};
    void save(trimmed === DEFAULT_BRANCH_PREFIX ? rest : { ...rest, branchPrefix: trimmed });
  }

  return (
    <SettingsSection title="Worktrees">
      <div className="setgroup">
        <SettingRow
          description={`New worktrees get a branch that starts with this. The default is ${DEFAULT_BRANCH_PREFIX}`}
          focused={props.focusedSetting === "code-worktree-branch-prefix"}
          label="Branch prefix"
          scope="app"
          settingId="code-worktree-branch-prefix"
        >
          <OctantInput
            aria-label="Branch prefix"
            className="settings-view__text-input"
            id="code-worktree-branch-prefix"
            onBlur={commitPrefix}
            onChange={(event) => setPrefix(event.currentTarget.value)}
            type="text"
            value={prefix}
          />
        </SettingRow>
        <SettingRow
          description="Words come from your own prompt on this computer, with secrets and file paths left out. A model writes a name only when you ask for one in the worktree options."
          focused={props.focusedSetting === "code-worktree-branch-naming"}
          label="Branch name"
          scope="app"
          settingId="code-worktree-branch-naming"
        >
          <OctantSelectField
            aria-label="Branch name"
            className="settings-view__select window-no-drag"
            onValueChange={(value) => {
              const option = NAMING_OPTIONS.find((candidate) => candidate.id === value);
              if (option === undefined || option.id === branchNamingOf(worktrees)) return;
              void save({ ...worktrees, branchNaming: option.id });
            }}
            options={NAMING_OPTIONS}
            value={branchNamingOf(worktrees)}
          />
        </SettingRow>
      </div>
      <div className="settings-feedback-slot" aria-live="polite">
        {message === undefined ? null : (
          <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
        )}
      </div>
    </SettingsSection>
  );
}
