import type { CodeSettings } from "@octant/contracts/code";
import { useState } from "react";
import { SettingRow } from "../settings/primitives";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

export interface CodeSettingsUpdate {
  readonly defaultExecutionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly defaultPermissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly externalEditor?: NonNullable<CodeSettings["externalEditor"]>;
}

interface CodeSettingsDraft {
  readonly executionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly permissionPersistence: CodeSettings["defaultPermissionPersistence"];
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
  { id: "approval-gated", label: "Approval" },
  { id: "auto-accept-edits", label: "Auto-accept edits" },
  { id: "plan", label: "Plan" },
  { id: "full-access", label: "Full access" },
];

export function CodeSettingsView(props: CodeSettingsViewProps) {
  const [executionPolicy, setExecutionPolicy] = useState(props.settings.defaultExecutionPolicy);
  const [permissionPersistence, setPermissionPersistence] = useState(
    props.settings.defaultPermissionPersistence,
  );
  const [executable, setExecutable] = useState(props.settings.externalEditor?.executable ?? "");
  const [argumentsText, setArgumentsText] = useState(
    props.settings.externalEditor?.arguments.join("\n") ?? "",
  );
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
    const updated = await props.onUpdate({
      defaultExecutionPolicy: draft.executionPolicy,
      defaultPermissionPersistence: draft.permissionPersistence,
      ...(trimmedExecutable === ""
        ? {}
        : {
            externalEditor: {
              executable: trimmedExecutable,
              arguments: arguments_,
            },
          }),
    });
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
        {message === undefined ? null : (
          <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
        )}
      </div>
    </section>
  );
}
