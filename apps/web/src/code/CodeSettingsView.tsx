import type { CodeSettings } from "@octant/contracts/code";
import { useState } from "react";
import { SettingRow } from "../settings/primitives";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

export interface CodeSettingsUpdate {
  readonly defaultExecutionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly defaultPermissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly externalEditor?: NonNullable<CodeSettings["externalEditor"]>;
  readonly requireGitRepository?: boolean;
  readonly allowDefaultFolderThreads?: boolean;
}

interface CodeSettingsDraft {
  readonly executionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly permissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly requireGitRepository: boolean;
  readonly allowDefaultFolderThreads: boolean;
  readonly executable: string;
  readonly argumentsText: string;
}

export interface CodeSettingsViewProps {
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
  readonly settings: CodeSettings;
}

const ACCESS_OPTIONS: ReadonlyArray<{
  readonly id: CodeSettings["defaultExecutionPolicy"];
  readonly label: string;
}> = [
  { id: "approval-gated", label: "Ask for approvals" },
  { id: "auto-accept-edits", label: "Auto-accept edits" },
  { id: "plan", label: "Plan · read-only" },
  { id: "full-access", label: "Full access" },
];

export function CodeSettingsView(props: CodeSettingsViewProps) {
  const [executionPolicy, setExecutionPolicy] = useState(props.settings.defaultExecutionPolicy);
  const [permissionPersistence, setPermissionPersistence] = useState(
    props.settings.defaultPermissionPersistence,
  );
  const [requireGitRepository, setRequireGitRepository] = useState(
    props.settings.requireGitRepository,
  );
  const [allowDefaultFolderThreads, setAllowDefaultFolderThreads] = useState(
    props.settings.allowDefaultFolderThreads,
  );
  const [executable, setExecutable] = useState(props.settings.externalEditor?.executable ?? "");
  const [argumentsText, setArgumentsText] = useState(
    props.settings.externalEditor?.arguments.join("\n") ?? "",
  );
  const [previousSettings, setPreviousSettings] = useState(props.settings);
  if (previousSettings !== props.settings) {
    setPreviousSettings(props.settings);
    setExecutionPolicy((current) =>
      current === previousSettings.defaultExecutionPolicy
        ? props.settings.defaultExecutionPolicy
        : current,
    );
    setPermissionPersistence((current) =>
      current === previousSettings.defaultPermissionPersistence
        ? props.settings.defaultPermissionPersistence
        : current,
    );
    setRequireGitRepository((current) =>
      current === previousSettings.requireGitRepository
        ? props.settings.requireGitRepository
        : current,
    );
    setAllowDefaultFolderThreads((current) =>
      current === previousSettings.allowDefaultFolderThreads
        ? props.settings.allowDefaultFolderThreads
        : current,
    );
    setExecutable((current) =>
      current === (previousSettings.externalEditor?.executable ?? "")
        ? (props.settings.externalEditor?.executable ?? "")
        : current,
    );
    setArgumentsText((current) =>
      current === (previousSettings.externalEditor?.arguments.join("\n") ?? "")
        ? (props.settings.externalEditor?.arguments.join("\n") ?? "")
        : current,
    );
  }
  const [message, setMessage] = useState<string>();

  /**
   * Every page in Settings keeps what you change; a Save button here meant a
   * choice could look made and not be. A pick commits as it is made, and free
   * text commits when it is finished, because a path is not valid halfway
   * through typing it.
   */
  async function commit(change: Partial<CodeSettingsDraft>) {
    const draft: CodeSettingsDraft = {
      executionPolicy,
      permissionPersistence,
      requireGitRepository,
      allowDefaultFolderThreads,
      executable,
      argumentsText,
      ...change,
    };
    const arguments_ = draft.argumentsText
      .split("\n")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    const trimmedExecutable = draft.executable.trim();
    if (trimmedExecutable !== "" && !trimmedExecutable.startsWith("/")) {
      setMessage("External editor executable must be an absolute path.");
      return;
    }
    if (arguments_.length > 32) {
      setMessage("External editor arguments are limited to 32 entries.");
      return;
    }
    let updated = false;
    try {
      updated = await props.onUpdate({
        defaultExecutionPolicy: draft.executionPolicy,
        defaultPermissionPersistence: draft.permissionPersistence,
        requireGitRepository: draft.requireGitRepository,
        allowDefaultFolderThreads: draft.allowDefaultFolderThreads,
        ...(trimmedExecutable === ""
          ? {}
          : {
              externalEditor: {
                executable: trimmedExecutable,
                arguments: arguments_,
              },
            }),
      });
    } catch {
      updated = false;
    }
    setMessage(updated ? undefined : "Code defaults could not be saved.");
  }

  return (
    <section aria-label="Code defaults" className="code-settings">
      <h2 className="sr-only">Code defaults</h2>
      <div className="settings-card-section settings-card-section--open">
        <h2>Thread defaults</h2>
        <p className="settings-section-note">
          These defaults apply only to new Code threads. Existing threads keep their access.
        </p>
        <div className="setgroup">
          <SettingRow
            description="The authority a new Code thread requests at creation."
            label="Default Code access"
            scope="mode"
            settingId="code-default-access"
          >
            <OctantSelectField
              aria-label="Default Code access"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const option = ACCESS_OPTIONS.find((candidate) => candidate.id === value);
                if (option === undefined) return;
                setExecutionPolicy(option.id);
                void commit({ executionPolicy: option.id });
              }}
              options={ACCESS_OPTIONS}
              value={executionPolicy}
            />
          </SettingRow>
          <SettingRow
            description="Whether approvals end with the session or follow the Project default."
            label="Default approval persistence"
            scope="mode"
            settingId="code-approval-persistence"
          >
            <OctantToggleGroup<CodeSettings["defaultPermissionPersistence"]>
              aria-label="Default approval persistence"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected === undefined) return;
                setPermissionPersistence(selected);
                void commit({ permissionPersistence: selected });
              }}
              value={[permissionPersistence]}
            >
              <OctantToggleGroupItem value="current-session">Session</OctantToggleGroupItem>
              <OctantToggleGroupItem value="project-default">Project</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
          <SettingRow
            description="Off lets a Code thread start in a plain folder. Branches, worktrees, diffs, and pull requests stay unavailable there until the folder becomes a repository."
            label="Require a Git repository"
            scope="mode"
            settingId="code-require-git"
          >
            <OctantSwitch
              checked={requireGitRepository}
              label="Require a Git repository"
              onCheckedChange={(checked) => {
                setRequireGitRepository(checked);
                // The default folder is not a repository, so requiring Git
                // again takes threads without a Project with it.
                const next = checked ? { allowDefaultFolderThreads: false } : {};
                if (checked) setAllowDefaultFolderThreads(false);
                void commit({ requireGitRepository: checked, ...next });
              }}
            />
          </SettingRow>
          <SettingRow
            description={
              requireGitRepository
                ? "Turn off the Git requirement first: the default folder is not a repository."
                : "Lets a Code thread start with no Project chosen, in the Code subfolder of the default folder."
            }
            label="Threads without a Project"
            scope="mode"
            settingId="code-default-folder-threads"
          >
            <OctantSwitch
              checked={allowDefaultFolderThreads}
              disabled={requireGitRepository}
              label="Threads without a Project"
              onCheckedChange={(checked) => {
                setAllowDefaultFolderThreads(checked);
                void commit({ allowDefaultFolderThreads: checked });
              }}
            />
          </SettingRow>
        </div>
      </div>
      <div className="settings-card-section settings-card-section--open">
        <h2>External editor</h2>
        <div className="setgroup">
          <SettingRow
            description="An absolute path to the editor Octant opens files in."
            label="External editor executable"
            scope="app"
            settingId="code-editor-executable"
          >
            <OctantInput
              aria-label="External editor executable"
              className="settings-view__text-input"
              id="code-editor-executable"
              onBlur={() => void commit({})}
              onChange={(event) => setExecutable(event.currentTarget.value)}
              placeholder="/usr/local/bin/code"
              type="text"
              value={executable}
            />
          </SettingRow>
          <SettingRow
            description={
              <>
                One argument per line. Available placeholders: {"{file}"}, {"{line}"}, {"{column}"}.
              </>
            }
            label="External editor arguments"
            scope="app"
            settingId="code-editor-arguments"
          >
            <OctantTextarea
              aria-label="External editor arguments"
              className="settings-view__text-input"
              id="code-editor-arguments"
              onBlur={() => void commit({})}
              onChange={(event) => setArgumentsText(event.currentTarget.value)}
              placeholder={"--goto\n{file}:{line}:{column}"}
              value={argumentsText}
            />
          </SettingRow>
        </div>
        <div className="settings-feedback-slot" aria-live="polite">
          {message === undefined ? null : (
            <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
          )}
        </div>
      </div>
    </section>
  );
}
