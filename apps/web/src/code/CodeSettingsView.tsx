import type { CodeSettings } from "@octant/contracts/code";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantField,
  OctantFieldDescription,
  OctantFieldError,
  OctantFieldGroup,
  OctantFieldLabel,
} from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

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
    <section aria-label="Code defaults" className="code-settings">
      <h2 className="sr-only">Code defaults</h2>
      <p className="code-settings__note">
        These defaults apply only to new Code threads. Existing threads keep their access.
      </p>
      <section className="code-settings__section">
        <h2>Thread defaults</h2>
        <OctantFieldGroup className="code-settings__group">
          <OctantField className="code-settings__field code-settings__field--choice">
            <OctantFieldLabel>Default Code access</OctantFieldLabel>
            <OctantFieldDescription>
              Choose the authority new Code threads request at creation.
            </OctantFieldDescription>
            <OctantToggleGroup<CodeSettings["defaultExecutionPolicy"]>
              className="max-w-full flex-wrap"
              aria-label="Default Code access"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) setExecutionPolicy(selected);
              }}
              value={[executionPolicy]}
            >
              <OctantToggleGroupItem value="approval-gated">Approval</OctantToggleGroupItem>
              <OctantToggleGroupItem value="auto-accept-edits">
                Auto-accept edits
              </OctantToggleGroupItem>
              <OctantToggleGroupItem value="plan">Plan</OctantToggleGroupItem>
              <OctantToggleGroupItem value="full-access">Full access</OctantToggleGroupItem>
            </OctantToggleGroup>
          </OctantField>
          <OctantField className="code-settings__field code-settings__field--choice">
            <OctantFieldLabel>Default approval persistence</OctantFieldLabel>
            <OctantFieldDescription>
              Decide whether approvals end with the session or follow the Project default.
            </OctantFieldDescription>
            <OctantToggleGroup<CodeSettings["defaultPermissionPersistence"]>
              aria-label="Default approval persistence"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) setPermissionPersistence(selected);
              }}
              value={[permissionPersistence]}
            >
              <OctantToggleGroupItem value="current-session">Session</OctantToggleGroupItem>
              <OctantToggleGroupItem value="project-default">Project</OctantToggleGroupItem>
            </OctantToggleGroup>
          </OctantField>
        </OctantFieldGroup>
      </section>
      <section className="code-settings__section">
        <h2>External editor</h2>
        <OctantFieldGroup className="code-settings__group">
          <OctantField className="code-settings__field code-settings__field--editor">
            <OctantFieldLabel htmlFor="code-editor-executable">
              External editor executable
            </OctantFieldLabel>
            <OctantInput
              aria-label="External editor executable"
              id="code-editor-executable"
              onChange={(event) => setExecutable(event.currentTarget.value)}
              placeholder="/usr/local/bin/code"
              type="text"
              value={executable}
            />
          </OctantField>
          <OctantField className="code-settings__field code-settings__field--editor">
            <OctantFieldLabel htmlFor="code-editor-arguments">
              External editor arguments
            </OctantFieldLabel>
            <OctantTextarea
              aria-label="External editor arguments"
              id="code-editor-arguments"
              onChange={(event) => setArgumentsText(event.currentTarget.value)}
              placeholder={"--goto\n{file}:{line}:{column}"}
              value={argumentsText}
            />
            <OctantFieldDescription>
              One argument per line. Available placeholders: {"{file}"}, {"{line}"}, {"{column}"}.
            </OctantFieldDescription>
          </OctantField>
          <div className="code-settings__actions">
            <OctantButton onClick={() => void save()} type="button" variant="secondary">
              Save Code defaults
            </OctantButton>
            {message === undefined ? null : message === "Code defaults saved." ? (
              <p className="m-0 text-sm text-muted-foreground" role="status">
                {message}
              </p>
            ) : (
              <OctantFieldError>{message}</OctantFieldError>
            )}
          </div>
        </OctantFieldGroup>
      </section>
    </section>
  );
}
