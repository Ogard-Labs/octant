import type { CodeDiffLayout, CodeSettings } from "@octant/contracts/code";
import type { SettingsSettingId } from "@octant/contracts";
import { useRef, useState } from "react";
import { SettingRow, SettingsSection } from "../settings/primitives";
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
  readonly defaultDiffLayout?: CodeDiffLayout;
  readonly bundledLanguageServer?: boolean;
}

interface CodeSettingsDraft {
  readonly executionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly permissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly requireGitRepository: boolean;
  readonly defaultDiffLayout: CodeDiffLayout;
  readonly executable: string;
  readonly argumentsText: string;
}

export interface CodeSettingsViewProps {
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
  readonly settings: CodeSettings;
}

/** The section holding the control a change came from. */
type CodeSettingsSectionId = "thread-defaults" | "editor" | "external-editor";

/**
 * Why the last change was not kept, said in the section whose control made
 * it: one message under External editor answered a Language services switch
 * two sections up, out of sight (observed in rendered QA). A later change
 * replaces it wherever it is.
 */
interface CodeSettingsFeedback {
  readonly section: CodeSettingsSectionId;
  readonly message: string;
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
  const [defaultDiffLayout, setDefaultDiffLayout] = useState(
    props.settings.defaultDiffLayout ?? "unified",
  );
  const [bundledLanguageServer, setBundledLanguageServer] = useState(
    props.settings.bundledLanguageServer !== false,
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
    setDefaultDiffLayout((current) =>
      current === (previousSettings.defaultDiffLayout ?? "unified")
        ? (props.settings.defaultDiffLayout ?? "unified")
        : current,
    );
    setBundledLanguageServer((current) =>
      current === (previousSettings.bundledLanguageServer !== false)
        ? props.settings.bundledLanguageServer !== false
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
  const [feedback, setFeedback] = useState<CodeSettingsFeedback>();
  // A save can resolve after later renders: when the host refuses a change as
  // stale, its reloaded settings arrive first, so a refused pick returns to
  // what the host holds now, not what it held when the pick was made.
  const hostSettings = useRef(props.settings);
  hostSettings.current = props.settings;

  /**
   * A switch or pick that was not saved goes back to what the host kept: left
   * as chosen, the Language services switch read off while the host still ran
   * the server, and no later change carried it. Typed text stays so the person
   * can correct it.
   */
  function restoreUnsavedPicks(
    change: Partial<CodeSettingsDraft> & { readonly bundledLanguageServer?: boolean },
  ) {
    const host = hostSettings.current;
    if (change.executionPolicy !== undefined) {
      setExecutionPolicy(host.defaultExecutionPolicy);
    }
    if (change.permissionPersistence !== undefined) {
      setPermissionPersistence(host.defaultPermissionPersistence);
    }
    if (change.requireGitRepository !== undefined) {
      setRequireGitRepository(host.requireGitRepository);
    }
    if (change.defaultDiffLayout !== undefined) {
      setDefaultDiffLayout(host.defaultDiffLayout ?? "unified");
    }
    if (change.bundledLanguageServer !== undefined) {
      setBundledLanguageServer(host.bundledLanguageServer !== false);
    }
  }

  /**
   * Every page in Settings keeps what you change; a Save button here meant a
   * choice could look made and not be. A pick commits as it is made, and free
   * text commits when it is finished, because a path is not valid halfway
   * through typing it.
   */
  async function commit(
    section: CodeSettingsSectionId,
    change: Partial<CodeSettingsDraft> & { readonly bundledLanguageServer?: boolean },
  ) {
    const draft: CodeSettingsDraft = {
      executionPolicy,
      permissionPersistence,
      requireGitRepository,
      defaultDiffLayout,
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
      restoreUnsavedPicks(change);
      setFeedback({ section, message: "External editor executable must be an absolute path." });
      return;
    }
    if (arguments_.length > 32) {
      restoreUnsavedPicks(change);
      setFeedback({ section, message: "External editor arguments are limited to 32 entries." });
      return;
    }
    let updated = false;
    try {
      updated = await props.onUpdate({
        defaultExecutionPolicy: draft.executionPolicy,
        defaultPermissionPersistence: draft.permissionPersistence,
        requireGitRepository: draft.requireGitRepository,
        defaultDiffLayout: draft.defaultDiffLayout,
        // The host keeps the stored switch when a change leaves it out, so
        // only the change that flips it carries it.
        ...(change.bundledLanguageServer === undefined
          ? {}
          : { bundledLanguageServer: change.bundledLanguageServer }),
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
    if (!updated) restoreUnsavedPicks(change);
    setFeedback(updated ? undefined : { section, message: "Code defaults could not be saved." });
  }

  return (
    <section aria-label="Code defaults" className="code-settings">
      <h2 className="sr-only">Code defaults</h2>
      <SettingsSection
        description="Access defaults apply only to new Code threads. Existing threads keep their access. The diff layout default is used until a thread has its own choice."
        title="Thread defaults"
      >
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
                void commit("thread-defaults", { executionPolicy: option.id });
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
                void commit("thread-defaults", { permissionPersistence: selected });
              }}
              value={[permissionPersistence]}
            >
              <OctantToggleGroupItem value="current-session">Session</OctantToggleGroupItem>
              <OctantToggleGroupItem value="project-default">Project</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
          <SettingRow
            description="Off lets a Code thread start in a plain folder, the default folder included; branches, diffs, and pull requests stay unavailable there."
            label="Code needs a Git repository"
            focused={props.focusedSetting === "code-require-git"}
            scope="mode"
            settingId="code-require-git"
          >
            <OctantSwitch
              checked={requireGitRepository}
              label="Code needs a Git repository"
              onCheckedChange={(checked) => {
                setRequireGitRepository(checked);
                void commit("thread-defaults", { requireGitRepository: checked });
              }}
            />
          </SettingRow>
          <SettingRow
            description="Used when a Code thread has no stored layout of its own."
            label="Default diff layout"
            focused={props.focusedSetting === "code-default-diff-layout"}
            scope="mode"
            settingId="code-default-diff-layout"
          >
            <OctantToggleGroup<CodeDiffLayout>
              aria-label="Default diff layout"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected === undefined) return;
                setDefaultDiffLayout(selected);
                void commit("thread-defaults", { defaultDiffLayout: selected });
              }}
              value={[defaultDiffLayout]}
            >
              <OctantToggleGroupItem value="unified">Unified</OctantToggleGroupItem>
              <OctantToggleGroupItem value="side-by-side">Side by side</OctantToggleGroupItem>
            </OctantToggleGroup>
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="thread-defaults" />
      </SettingsSection>
      <SettingsSection title="Editor">
        <div className="setgroup">
          <SettingRow
            description="Type errors and go to definition across the checkout, from the TypeScript server bundled with Octant. It reads the checkout and cannot write, run other programs, or reach the network."
            label="Language services"
            focused={props.focusedSetting === "code-language-services"}
            scope="mode"
            settingId="code-language-services"
          >
            <OctantSwitch
              checked={bundledLanguageServer}
              label="Language services"
              onCheckedChange={(checked) => {
                setBundledLanguageServer(checked);
                void commit("editor", { bundledLanguageServer: checked });
              }}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="editor" />
      </SettingsSection>
      <SettingsSection title="External editor">
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
              onBlur={() => void commit("external-editor", {})}
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
              onBlur={() => void commit("external-editor", {})}
              onChange={(event) => setArgumentsText(event.currentTarget.value)}
              placeholder={"--goto\n{file}:{line}:{column}"}
              value={argumentsText}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="external-editor" />
      </SettingsSection>
    </section>
  );
}

function CodeSettingsFeedbackSlot(props: {
  readonly feedback: CodeSettingsFeedback | undefined;
  readonly section: CodeSettingsSectionId;
}) {
  const message = props.feedback?.section === props.section ? props.feedback.message : undefined;
  return (
    <div className="settings-feedback-slot" aria-live="polite">
      {message === undefined ? null : (
        <OctantFieldError className="settings-section-line">{message}</OctantFieldError>
      )}
    </div>
  );
}
