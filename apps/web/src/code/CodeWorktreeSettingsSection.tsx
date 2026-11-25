import type { CodeSettings, CodeWorktreeSettings } from "@octant/contracts/code";
import { DEFAULT_BRANCH_PREFIX, isValidBranchPrefix } from "@octant/domain/code-worktree-naming";
import { useState } from "react";
import type { SettingsSettingId } from "@octant/contracts";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import type { CodeSettingsUpdate } from "./CodeSettingsView";

const NAMING_OPTIONS = [
  { id: "short-id", label: "Prefix and short id" },
  { id: "prompt", label: "Prefix and words from the prompt" },
] as const;

const DEFAULT_INACTIVITY_DAYS = 30;

/** What the host does for a store with no choice: the same as before the setting existed. */
function branchNamingOf(worktrees: CodeWorktreeSettings | undefined) {
  return worktrees?.branchNaming ?? "short-id";
}

/**
 * Settings › Code › Worktrees › Naming and Cleanup. Every control saves as it
 * is changed, whole: the host replaces the worktree choices with what is sent.
 * A host that has these choices always answers with them, empty for the
 * defaults. One that does not never does, and rejects an update that names
 * them, so its window shows no controls rather than ones that cannot save.
 */
export function CodeWorktreeSettingsSection(props: {
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly settings: CodeSettings;
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
}) {
  if (props.settings.worktrees === undefined) return null;
  return <WorktreeSettingsControls {...props} worktrees={props.settings.worktrees} />;
}

function WorktreeSettingsControls(props: {
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly settings: CodeSettings;
  readonly worktrees: CodeWorktreeSettings;
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
}) {
  const { worktrees } = props;
  const [prefix, setPrefix] = useState(worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  const [days, setDays] = useState(
    String(worktrees?.cleanup?.inactivityDays ?? DEFAULT_INACTIVITY_DAYS),
  );
  const [message, setMessage] = useState<string>();
  const cleanup = worktrees?.cleanup;
  const inactivityOn = cleanup?.inactivityDays !== undefined;

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
    if (!saved) {
      setPrefix(worktrees?.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
      setDays(String(worktrees?.cleanup?.inactivityDays ?? DEFAULT_INACTIVITY_DAYS));
    }
    return saved;
  }

  function withCleanup(change: Partial<NonNullable<CodeWorktreeSettings["cleanup"]>>) {
    const merged = { ...cleanup, ...change };
    return { ...worktrees, cleanup: merged } satisfies CodeWorktreeSettings;
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

  function commitDays() {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setMessage("Inactivity is a whole number of days from 1 to 365.");
      return;
    }
    if (parsed === cleanup?.inactivityDays) return;
    void save(withCleanup({ inactivityDays: parsed }));
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
        <SettingRow
          description="When you archive a thread, remove its worktree folder if everything is committed and pushed or merged. The branch stays."
          label="Clean up when a thread is archived"
          scope="app"
          focused={props.focusedSetting === "code-worktree-cleanup-archive"}
          settingId="code-worktree-cleanup-archive"
        >
          <OctantSwitch
            checked={cleanup?.onArchive !== false}
            label="Clean up when a thread is archived"
            onCheckedChange={(checked) => void save(withCleanup({ onArchive: checked }))}
          />
        </SettingRow>
        <SettingRow
          description="Also remove the worktree folder of a thread that is still open, a day after its last activity, once everything is committed and pushed or merged. The branch stays, and Cleaned-up worktrees below brings the folder back."
          label="Clean up merged worktrees"
          scope="app"
          focused={props.focusedSetting === "code-worktree-cleanup-merged"}
          settingId="code-worktree-cleanup-merged"
        >
          <OctantSwitch
            checked={cleanup?.whenMerged === true}
            label="Clean up merged worktrees"
            onCheckedChange={(checked) => void save(withCleanup({ whenMerged: checked }))}
          />
        </SettingRow>
        <SettingRow
          description="Remove the worktree folder of a thread nobody has used for a while, open or archived. Only a folder with no uncommitted, untracked or ignored files goes. The branch, the thread and its checkpoints stay, and the thread takes no new turn until you restore the folder under Cleaned-up worktrees."
          label="Clean up after inactivity"
          scope="app"
          focused={props.focusedSetting === "code-worktree-cleanup-inactivity"}
          settingId="code-worktree-cleanup-inactivity"
        >
          <OctantSwitch
            checked={inactivityOn}
            label="Clean up after inactivity"
            onCheckedChange={(checked) => {
              if (checked) {
                void save(withCleanup({ inactivityDays: Number(days) || DEFAULT_INACTIVITY_DAYS }));
                return;
              }
              const { inactivityDays: _off, ...rest } = cleanup ?? {};
              void save({ ...worktrees, cleanup: rest });
            }}
          />
        </SettingRow>
        {inactivityOn ? (
          <SettingRow
            description="Days without a turn or a change before the folder is removed."
            label="Days of inactivity"
            scope="app"
            focused={props.focusedSetting === "code-worktree-cleanup-days"}
            settingId="code-worktree-cleanup-days"
          >
            <OctantInput
              aria-label="Days of inactivity"
              className="settings-view__text-input"
              id="code-worktree-cleanup-days"
              inputMode="numeric"
              onBlur={commitDays}
              onChange={(event) => setDays(event.currentTarget.value)}
              type="text"
              value={days}
            />
          </SettingRow>
        ) : null}
      </div>
      <div className="settings-feedback-slot" aria-live="polite">
        {message === undefined ? null : (
          <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
        )}
      </div>
    </SettingsSection>
  );
}
