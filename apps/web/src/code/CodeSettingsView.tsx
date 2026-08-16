import type { CodeSettings } from "@octant/contracts/code";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface CodeSettingsUpdate {
  readonly defaultExecutionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly defaultPermissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly externalEditor?: NonNullable<CodeSettings["externalEditor"]>;
}

export interface CodeSettingsViewProps {
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
  readonly settings: CodeSettings;
}

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

  async function save() {
    const arguments_ = argumentsText
      .split("\n")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    const trimmedExecutable = executable.trim();
    if (trimmedExecutable !== "" && !trimmedExecutable.startsWith("/")) {
      setMessage("External editor executable must be an absolute path.");
      return;
    }
    if (arguments_.length > 32) {
      setMessage("External editor arguments are limited to 32 entries.");
      return;
    }
    const updated = await props.onUpdate({
      defaultExecutionPolicy: executionPolicy,
      defaultPermissionPersistence: permissionPersistence,
      ...(trimmedExecutable === ""
        ? {}
        : {
            externalEditor: {
              executable: trimmedExecutable,
              arguments: arguments_,
            },
          }),
    });
    setMessage(updated ? "Code defaults saved." : "Code defaults could not be saved.");
  }

  return (
    <section aria-labelledby="settings-code-heading">
      <h2 id="settings-code-heading">Code defaults</h2>
      <p>These defaults apply only to new Code threads. Existing threads keep their access.</p>
      <label className="settings-view__field">
        <span>Default Code access</span>
        <OctantNativeSelect
          aria-label="Default Code access"
          className="settings-view__select"
          onChange={(event) =>
            setExecutionPolicy(event.currentTarget.value as CodeSettings["defaultExecutionPolicy"])
          }
          value={executionPolicy}
        >
          <option value="approval-gated">Ask for approvals</option>
          <option value="plan">Plan mode (read-only)</option>
          <option value="full-access">Full access</option>
        </OctantNativeSelect>
      </label>
      <label className="settings-view__field">
        <span>Default approval persistence</span>
        <OctantNativeSelect
          aria-label="Default approval persistence"
          className="settings-view__select"
          onChange={(event) =>
            setPermissionPersistence(
              event.currentTarget.value as CodeSettings["defaultPermissionPersistence"],
            )
          }
          value={permissionPersistence}
        >
          <option value="current-session">Current session only</option>
          <option value="project-default">Project default</option>
        </OctantNativeSelect>
      </label>
      <label className="settings-view__field">
        <span>External editor executable</span>
        <OctantInput
          aria-label="External editor executable"
          className="settings-view__text-input"
          onChange={(event) => setExecutable(event.currentTarget.value)}
          placeholder="/usr/local/bin/code"
          type="text"
          value={executable}
        />
      </label>
      <label className="settings-view__field">
        <span>External editor arguments</span>
        <OctantTextarea
          aria-label="External editor arguments"
          className="settings-view__text-input"
          onChange={(event) => setArgumentsText(event.currentTarget.value)}
          placeholder={"--goto\n{file}:{line}:{column}"}
          value={argumentsText}
        />
      </label>
      <p>
        Use one argument per line. Available placeholders: {"{file}"}, {"{line}"}, {"{column}"}.
      </p>
      <OctantButton
        className="settings-view__action"
        onClick={() => void save()}
        type="button"
        variant="secondary"
      >
        Save Code defaults
      </OctantButton>
      {message === undefined ? null : <p role="status">{message}</p>}
    </section>
  );
}
