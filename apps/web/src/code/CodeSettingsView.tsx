import type { CodeDiffLayout, CodeSettings } from "@octant/contracts/code";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { AutoReviewer, ShieldModelChoice } from "@octant/contracts/shield";
import type { PermissionMode, SettingsSettingId } from "@octant/contracts";
import { permissionModeOf, threadAccessOf } from "@octant/domain/guardrail-policy";
import { useRef, useState } from "react";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { useFullAccessWarning } from "./FullAccessWarning";
import { PERMISSION_MODE_OPTIONS } from "./PermissionModePicker";

export interface CodeSettingsUpdate {
  readonly defaultExecutionPolicy: CodeSettings["defaultExecutionPolicy"];
  readonly defaultPermissionPersistence: CodeSettings["defaultPermissionPersistence"];
  readonly defaultAutoApprove?: boolean;
  readonly autoReviewer?: AutoReviewer;
  /** Null returns Octant Shield to each thread's own provider. */
  readonly shieldModel?: ShieldModelChoice | null;
  readonly externalEditor?: NonNullable<CodeSettings["externalEditor"]>;
  readonly requireGitRepository?: boolean;
  readonly defaultDiffLayout?: CodeDiffLayout;
  readonly bundledLanguageServer?: boolean;
}

interface CodeSettingsDraft {
  readonly permissionMode: PermissionMode;
  readonly requireGitRepository: boolean;
  readonly defaultDiffLayout: CodeDiffLayout;
  readonly executable: string;
  readonly argumentsText: string;
}

export interface CodeSettingsViewProps {
  readonly focusedSetting?: SettingsSettingId | undefined;
  readonly onUpdate: (input: CodeSettingsUpdate) => Promise<boolean>;
  readonly settings: CodeSettings;
  /** The configured providers Octant Shield may judge with. */
  readonly providerSnapshot?: ProviderRegistrySnapshot | undefined;
}

const AUTO_REVIEWER_OPTIONS: ReadonlyArray<{ readonly id: AutoReviewer; readonly label: string }> =
  [
    { id: "provider", label: "Provider's own" },
    { id: "octant-shield", label: "Octant Shield" },
  ];

/** The Shield model choice as one select value; empty is each thread's own provider. */
const THREAD_PROVIDER_MODEL = "thread-provider";
const modelValue = (choice: ShieldModelChoice | undefined) =>
  choice === undefined
    ? THREAD_PROVIDER_MODEL
    : `${String(choice.providerInstanceId)}/${String(choice.modelId)}`;

/**
 * The endpoints Octant Shield may judge with: each enabled provider's
 * catalogued models, local ones included. The default is each thread's own
 * provider account with that provider's smallest model.
 */
function shieldModelOptions(
  snapshot: ProviderRegistrySnapshot | undefined,
  current: ShieldModelChoice | undefined,
): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly choice?: ShieldModelChoice;
}> {
  const options: Array<{ id: string; label: string; choice?: ShieldModelChoice }> = [
    { id: THREAD_PROVIDER_MODEL, label: "Each thread's provider, smallest model" },
  ];
  for (const instance of snapshot?.instances ?? []) {
    if (!instance.enabled) continue;
    const catalog = snapshot?.catalogs?.find(
      (candidate) => String(candidate.instanceId) === String(instance.id),
    );
    for (const model of catalog?.models ?? []) {
      const choice = { providerInstanceId: instance.id, modelId: model.id };
      options.push({
        id: modelValue(choice),
        label: `${instance.displayName} · ${model.displayName}`,
        choice,
      });
    }
  }
  // A stored choice whose provider is gone is still shown, so the select
  // never claims a choice the host does not hold.
  if (current !== undefined && !options.some((option) => option.id === modelValue(current))) {
    options.push({ id: modelValue(current), label: String(current.modelId), choice: current });
  }
  return options;
}

/** The section holding the control a change came from. */
type CodeSettingsSectionId = "access" | "thread-defaults" | "editor" | "external-editor";

/**
 * Why the last change was not kept. A refusal is said in the section whose
 * control made the change: one message under External editor answered a
 * Language services switch two sections up, out of sight (observed in
 * rendered QA). An unfinished external editor field is said at that field,
 * whichever control sent the change, because that is what needs fixing. A
 * later change replaces it wherever it is.
 */
interface CodeSettingsFeedback {
  readonly section: CodeSettingsSectionId;
  readonly message: string;
}

const MODE_OPTIONS = PERMISSION_MODE_OPTIONS.map((option) => ({
  id: option.id,
  label: option.id === "auto" ? "Auto · Recommended" : option.label,
}));

function permissionModeOfSettings(settings: CodeSettings): PermissionMode {
  return permissionModeOf({
    executionPolicy: settings.defaultExecutionPolicy,
    autoApprove: settings.defaultAutoApprove,
  });
}

export function CodeSettingsView(props: CodeSettingsViewProps) {
  const [permissionMode, setPermissionMode] = useState(permissionModeOfSettings(props.settings));
  const [autoReviewer, setAutoReviewer] = useState<AutoReviewer>(
    props.settings.autoReviewer ?? "provider",
  );
  const [shieldModel, setShieldModel] = useState(modelValue(props.settings.shieldModel));
  const shieldModels = shieldModelOptions(props.providerSnapshot, props.settings.shieldModel);
  const fullAccessWarning = useFullAccessWarning("machine");
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
    setPermissionMode((current) =>
      current === permissionModeOfSettings(previousSettings)
        ? permissionModeOfSettings(props.settings)
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
    change: Partial<CodeSettingsDraft> & {
      readonly bundledLanguageServer?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly shieldModel?: ShieldModelChoice | null;
    },
  ) {
    const host = hostSettings.current;
    if (change.autoReviewer !== undefined) {
      setAutoReviewer(host.autoReviewer ?? "provider");
    }
    if (change.shieldModel !== undefined) {
      setShieldModel(modelValue(host.shieldModel));
    }
    if (change.permissionMode !== undefined) {
      setPermissionMode(permissionModeOfSettings(host));
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
    change: Partial<CodeSettingsDraft> & {
      readonly bundledLanguageServer?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly shieldModel?: ShieldModelChoice | null;
    },
  ) {
    const draft: CodeSettingsDraft = {
      permissionMode,
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
      setFeedback({
        section: "external-editor",
        message: "External editor executable must be an absolute path.",
      });
      return;
    }
    if (arguments_.length > 32) {
      restoreUnsavedPicks(change);
      setFeedback({
        section: "external-editor",
        message: "External editor arguments are limited to 32 entries.",
      });
      return;
    }
    let updated = false;
    try {
      const access = threadAccessOf(draft.permissionMode);
      updated = await props.onUpdate({
        defaultExecutionPolicy: access.executionPolicy,
        defaultPermissionPersistence: hostSettings.current.defaultPermissionPersistence,
        // The host keeps what it stored when a change leaves these out, so
        // only an Access change carries them.
        ...(change.permissionMode === undefined ? {} : { defaultAutoApprove: access.autoApprove }),
        ...(change.autoReviewer === undefined ? {} : { autoReviewer: change.autoReviewer }),
        ...(change.shieldModel === undefined ? {} : { shieldModel: change.shieldModel }),
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
        description="The mode new threads start in. A Project can choose its own, and any thread can switch from its composer. Existing threads keep their mode."
        title="Access"
      >
        <div className="setgroup">
          <SettingRow
            description="Auto lets a reviewer approve each action: the provider's own or Octant Shield. Where none can run, threads ask first."
            label="Default mode"
            scope="mode"
            settingId="code-default-access"
          >
            <OctantSelectField
              aria-label="Default mode"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const option = MODE_OPTIONS.find((candidate) => candidate.id === value);
                if (option === undefined) return;
                fullAccessWarning.guard(option.id, () => {
                  setPermissionMode(option.id);
                  void commit("access", { permissionMode: option.id });
                });
              }}
              options={MODE_OPTIONS}
              value={permissionMode}
            />
          </SettingRow>
          <SettingRow
            description="Who approves actions at Auto. Provider's own uses the provider's reviewer where it has one and Octant Shield elsewhere. A Project can choose its own."
            focused={props.focusedSetting === "code-auto-reviewer"}
            label="Auto reviewer"
            scope="mode"
            settingId="code-auto-reviewer"
          >
            <OctantSelectField
              aria-label="Auto reviewer"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const option = AUTO_REVIEWER_OPTIONS.find((candidate) => candidate.id === value);
                if (option === undefined || option.id === autoReviewer) return;
                setAutoReviewer(option.id);
                void commit("access", { autoReviewer: option.id });
              }}
              options={AUTO_REVIEWER_OPTIONS}
              value={autoReviewer}
            />
          </SettingRow>
          <SettingRow
            description="The model Octant Shield asks about actions no rule decides. It sees only your messages and the pending action, never files, tool output, or web pages, and its use counts against your spend limits."
            focused={props.focusedSetting === "code-shield-model"}
            label="Shield model"
            scope="mode"
            settingId="code-shield-model"
          >
            <OctantSelectField
              aria-label="Shield model"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const option = shieldModels.find((candidate) => candidate.id === value);
                if (option === undefined || option.id === shieldModel) return;
                setShieldModel(option.id);
                void commit("access", { shieldModel: option.choice ?? null });
              }}
              options={shieldModels.map(({ id, label }) => ({ id, label }))}
              value={shieldModel}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="access" />
      </SettingsSection>
      {fullAccessWarning.dialog}
      <SettingsSection
        description="The diff layout default is used until a thread has its own choice."
        title="Thread defaults"
      >
        <div className="setgroup">
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
