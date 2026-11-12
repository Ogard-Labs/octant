import type { CodeDiffLayout, CodeSettings } from "@octant/contracts/code";
import type { AutoReviewer, ShieldModelChoice } from "@octant/contracts/shield";
import { Schema } from "effect";
import {
  DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  MAX_COORDINATOR_OPEN_WORKER_LIMIT,
  CoordinatorOpenWorkerLimit,
  type CoordinatorStartingByProject,
  type CoordinatorStartingChoice,
  type PermissionMode,
  type SettingsSettingId,
} from "@octant/contracts";
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
  /** Absent keeps the stored choice. */
  readonly defaultFullAccessSandbox?: boolean;
  readonly autoReviewer?: AutoReviewer;
  /** Null returns Octant Shield to each thread's own provider. */
  readonly shieldModel?: ShieldModelChoice | null;
  readonly externalEditor?: NonNullable<CodeSettings["externalEditor"]>;
  readonly requireGitRepository?: boolean;
  readonly defaultDiffLayout?: CodeDiffLayout;
  readonly bundledLanguageServer?: boolean;
  /** Absent keeps the stored choice. */
  readonly coordinatorStarting?: CoordinatorStartingChoice;
  /** Absent keeps the stored overrides; a present map replaces them. */
  readonly coordinatorStartingByProject?: CoordinatorStartingByProject;
  /** Absent keeps the stored limit. */
  readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
  /** Absent keeps the stored choice. */
  readonly restartContinuation?: boolean;
}

/** Settings › Code › Coordinators › Starting workers (docs/design/coordinator-threads.md). */
export const COORDINATOR_STARTING_OPTIONS: ReadonlyArray<{
  readonly id: CoordinatorStartingChoice;
  readonly label: string;
}> = [
  { id: "start-without-asking", label: "Start without asking" },
  { id: "propose-for-approval", label: "Propose for approval" },
];

const isOpenWorkerLimit = Schema.is(CoordinatorOpenWorkerLimit);

const OPEN_WORKER_LIMIT_OPTIONS = Array.from(
  { length: MAX_COORDINATOR_OPEN_WORKER_LIMIT },
  (_, index) => ({ id: String(index + 1), label: String(index + 1) }),
);

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
}

const AUTO_REVIEWER_OPTIONS: ReadonlyArray<{ readonly id: AutoReviewer; readonly label: string }> =
  [
    { id: "provider", label: "Provider's own" },
    { id: "octant-shield", label: "Octant Shield" },
  ];

/** The section holding the control a change came from. */
type CodeSettingsSectionId =
  | "access"
  | "thread-defaults"
  | "coordinators"
  | "editor"
  | "external-editor";

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
  const [fullAccessSandbox, setFullAccessSandbox] = useState(
    props.settings.defaultFullAccessSandbox === true,
  );
  const [autoReviewer, setAutoReviewer] = useState<AutoReviewer>(
    props.settings.autoReviewer ?? "provider",
  );
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
  const [restartContinuation, setRestartContinuation] = useState(
    props.settings.restartContinuation !== false,
  );
  const [executable, setExecutable] = useState(props.settings.externalEditor?.executable ?? "");
  const [argumentsText, setArgumentsText] = useState(
    props.settings.externalEditor?.arguments.join("\n") ?? "",
  );
  const [coordinatorStarting, setCoordinatorStarting] = useState<CoordinatorStartingChoice>(
    props.settings.coordinatorStarting ?? "start-without-asking",
  );
  const [openWorkerLimit, setOpenWorkerLimit] = useState<number>(
    props.settings.coordinatorOpenWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  );
  const [previousSettings, setPreviousSettings] = useState(props.settings);
  if (previousSettings !== props.settings) {
    setPreviousSettings(props.settings);
    setCoordinatorStarting((current) =>
      current === (previousSettings.coordinatorStarting ?? "start-without-asking")
        ? (props.settings.coordinatorStarting ?? "start-without-asking")
        : current,
    );
    setOpenWorkerLimit((current) =>
      current ===
      (previousSettings.coordinatorOpenWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT)
        ? (props.settings.coordinatorOpenWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT)
        : current,
    );
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
    setRestartContinuation((current) =>
      current === (previousSettings.restartContinuation !== false)
        ? props.settings.restartContinuation !== false
        : current,
    );
    setFullAccessSandbox((current) =>
      current === (previousSettings.defaultFullAccessSandbox === true)
        ? props.settings.defaultFullAccessSandbox === true
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
      readonly restartContinuation?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly fullAccessSandbox?: boolean;
      readonly coordinatorStarting?: CoordinatorStartingChoice;
      readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
    },
  ) {
    const host = hostSettings.current;
    if (change.coordinatorStarting !== undefined) {
      setCoordinatorStarting(host.coordinatorStarting ?? "start-without-asking");
    }
    if (change.coordinatorOpenWorkerLimit !== undefined) {
      setOpenWorkerLimit(host.coordinatorOpenWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT);
    }
    if (change.fullAccessSandbox !== undefined) {
      setFullAccessSandbox(host.defaultFullAccessSandbox === true);
    }
    if (change.autoReviewer !== undefined) {
      setAutoReviewer(host.autoReviewer ?? "provider");
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
    if (change.restartContinuation !== undefined) {
      setRestartContinuation(host.restartContinuation !== false);
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
      readonly restartContinuation?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly fullAccessSandbox?: boolean;
      readonly coordinatorStarting?: CoordinatorStartingChoice;
      readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
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
        ...(change.fullAccessSandbox === undefined
          ? {}
          : { defaultFullAccessSandbox: change.fullAccessSandbox }),
        requireGitRepository: draft.requireGitRepository,
        defaultDiffLayout: draft.defaultDiffLayout,
        // The host keeps the stored switch when a change leaves it out, so
        // only the change that flips it carries it.
        ...(change.bundledLanguageServer === undefined
          ? {}
          : { bundledLanguageServer: change.bundledLanguageServer }),
        ...(change.restartContinuation === undefined
          ? {}
          : { restartContinuation: change.restartContinuation }),
        ...(change.coordinatorStarting === undefined
          ? {}
          : { coordinatorStarting: change.coordinatorStarting }),
        ...(change.coordinatorOpenWorkerLimit === undefined
          ? {}
          : { coordinatorOpenWorkerLimit: change.coordinatorOpenWorkerLimit }),
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
            description="New threads at Full access run without prompts but keep writes in the Project folder and secret files closed. Works with Codex and Octant Harness models; a thread can turn it off from its mode picker."
            focused={props.focusedSetting === "code-full-access-sandbox"}
            label="Keep the sandbox at Full access"
            scope="mode"
            settingId="code-full-access-sandbox"
          >
            <OctantSwitch
              checked={fullAccessSandbox}
              label="Keep the sandbox at Full access"
              onCheckedChange={(checked) => {
                setFullAccessSandbox(checked);
                void commit("access", { fullAccessSandbox: checked });
              }}
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
          <SettingRow
            description="When Octant stops in the middle of a turn, from a crash, a quit, or a restart of this computer, the thread picks the turn up by itself when Octant opens again. A thread whose push or pull request may have gone out waits for you. A thread can turn this off from its menu."
            focused={props.focusedSetting === "code-restart-continuation"}
            label="Continue after restart"
            scope="mode"
            settingId="code-restart-continuation"
          >
            <OctantSwitch
              checked={restartContinuation}
              label="Continue after restart"
              onCheckedChange={(checked) => {
                setRestartContinuation(checked);
                void commit("thread-defaults", { restartContinuation: checked });
              }}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="thread-defaults" />
      </SettingsSection>
      <SettingsSection
        description="A coordinator splits a Project's work into worker threads, starts them, and brings their questions back to you."
        title="Coordinators"
      >
        <div className="setgroup">
          <SettingRow
            description="Whether a coordinator starts each worker itself or proposes it for you to approve. A Project can choose its own in its overview."
            focused={props.focusedSetting === "code-coordinator-starting"}
            label="Starting workers"
            scope="mode"
            settingId="code-coordinator-starting"
          >
            <OctantSelectField
              aria-label="Starting workers"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const option = COORDINATOR_STARTING_OPTIONS.find(
                  (candidate) => candidate.id === value,
                );
                if (option === undefined || option.id === coordinatorStarting) return;
                setCoordinatorStarting(option.id);
                void commit("coordinators", { coordinatorStarting: option.id });
              }}
              options={COORDINATOR_STARTING_OPTIONS}
              value={coordinatorStarting}
            />
          </SettingRow>
          <SettingRow
            description="How many workers one coordinator may have open at once. A worker that is Done, put away, or archived no longer counts."
            focused={props.focusedSetting === "code-coordinator-open-workers"}
            label="Open workers per coordinator"
            scope="mode"
            settingId="code-coordinator-open-workers"
          >
            <OctantSelectField
              aria-label="Open workers per coordinator"
              className="settings-view__select window-no-drag"
              onValueChange={(value) => {
                const limit = Number(value);
                if (!isOpenWorkerLimit(limit) || limit === openWorkerLimit) return;
                setOpenWorkerLimit(limit);
                void commit("coordinators", { coordinatorOpenWorkerLimit: limit });
              }}
              options={OPEN_WORKER_LIMIT_OPTIONS}
              value={String(openWorkerLimit)}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="coordinators" />
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
