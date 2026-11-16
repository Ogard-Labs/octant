import type { CodeDiffLayout, CodeSettings, WindowsTerminalShell } from "@octant/contracts/code";
import type { AutoReviewer, ShieldModelChoice } from "@octant/contracts/shield";
import { Schema } from "effect";
import {
  DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  MAX_COORDINATOR_OPEN_WORKER_LIMIT,
  CoordinatorOpenWorkerLimit,
  type CoordinatorStartingByProject,
  type CoordinatorStartingChoice,
  type CoordinatorWorkerListing,
  type CoordinatorWorkerListingByProject,
  type PermissionMode,
  type SettingsSettingId,
} from "@octant/contracts";
import { permissionModeOf, threadAccessOf } from "@octant/domain/guardrail-policy";
import { useRef, useState } from "react";
import { useHostPlatform } from "../platform";
import { SettingRow, SettingsSection } from "../settings/primitives";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { useFullAccessWarning } from "./FullAccessWarning";
import { PERMISSION_MODE_OPTIONS } from "./PermissionModePicker";
import { WORKERS_UNLISTED } from "./coordinatorWorkerListing";

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
  readonly androidEmulatorSnapshotBoot?: boolean;
  /** Absent keeps the stored choice. */
  readonly coordinatorStarting?: CoordinatorStartingChoice;
  /** Absent keeps the stored overrides; a present map replaces them. */
  readonly coordinatorStartingByProject?: CoordinatorStartingByProject;
  /** Absent keeps the stored choice. */
  readonly coordinatorWorkerListing?: CoordinatorWorkerListing;
  /** Absent keeps the stored overrides; a present map replaces them. */
  readonly coordinatorWorkerListingByProject?: CoordinatorWorkerListingByProject;
  /** Absent keeps the stored limit. */
  readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
  /** Absent keeps the stored choice. */
  readonly restartContinuation?: boolean;
  /** Absent keeps the stored choice. */
  readonly windowsTerminalShell?: WindowsTerminalShell;
}

/** Settings › Code › Coordinators › Starting workers (docs/design/coordinator-threads.md). */
export const COORDINATOR_STARTING_OPTIONS: ReadonlyArray<{
  readonly id: CoordinatorStartingChoice;
  readonly label: string;
}> = [
  { id: "start-without-asking", label: "Start without asking" },
  { id: "propose-for-approval", label: "Propose for approval" },
];

/** Settings › Code › Terminal shell, offered on a Windows host only. */
export const WINDOWS_TERMINAL_SHELL_OPTIONS: ReadonlyArray<{
  readonly id: WindowsTerminalShell;
  readonly label: string;
}> = [
  { id: "powershell", label: "Windows PowerShell" },
  { id: "pwsh", label: "PowerShell 7" },
  { id: "cmd", label: "Command Prompt" },
];

const isOpenWorkerLimit = Schema.is(CoordinatorOpenWorkerLimit);

function sameWorkerListing(a: CoordinatorWorkerListing, b: CoordinatorWorkerListing): boolean {
  return a.sidebar === b.sidebar && a.board === b.board;
}

/**
 * The two Show workers checkboxes, shared by Settings and a Project's
 * overview so both say the same words (docs/design/workspace.md#coordinators).
 */
export function CoordinatorWorkerListingChecks(props: {
  readonly label: string;
  readonly value: CoordinatorWorkerListing;
  readonly disabled: boolean;
  readonly onChange: (next: CoordinatorWorkerListing) => void;
}) {
  return (
    <div aria-label={props.label} className="coordinator-worker-listing" role="group">
      <label className="coordinator-worker-listing__choice">
        <OctantCheckbox
          checked={props.value.sidebar}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange({ ...props.value, sidebar: event.currentTarget.checked })
          }
        />
        <span>In the sidebar</span>
      </label>
      <label className="coordinator-worker-listing__choice">
        <OctantCheckbox
          checked={props.value.board}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange({ ...props.value, board: event.currentTarget.checked })
          }
        />
        <span>On the board</span>
      </label>
    </div>
  );
}

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
  | "devices"
  | "terminal"
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
  const [androidSnapshotBoot, setAndroidSnapshotBoot] = useState(
    props.settings.androidEmulatorSnapshotBoot === true,
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
  const [workerListing, setWorkerListing] = useState<CoordinatorWorkerListing>(
    props.settings.coordinatorWorkerListing ?? WORKERS_UNLISTED,
  );
  const [openWorkerLimit, setOpenWorkerLimit] = useState<number>(
    props.settings.coordinatorOpenWorkerLimit ?? DEFAULT_COORDINATOR_OPEN_WORKER_LIMIT,
  );
  const hostPlatform = useHostPlatform();
  const [windowsShell, setWindowsShell] = useState<WindowsTerminalShell>(
    props.settings.windowsTerminalShell ?? "powershell",
  );
  const [previousSettings, setPreviousSettings] = useState(props.settings);
  if (previousSettings !== props.settings) {
    setPreviousSettings(props.settings);
    setWindowsShell((current) =>
      current === (previousSettings.windowsTerminalShell ?? "powershell")
        ? (props.settings.windowsTerminalShell ?? "powershell")
        : current,
    );
    setCoordinatorStarting((current) =>
      current === (previousSettings.coordinatorStarting ?? "start-without-asking")
        ? (props.settings.coordinatorStarting ?? "start-without-asking")
        : current,
    );
    setWorkerListing((current) =>
      sameWorkerListing(current, previousSettings.coordinatorWorkerListing ?? WORKERS_UNLISTED)
        ? (props.settings.coordinatorWorkerListing ?? WORKERS_UNLISTED)
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
    setAndroidSnapshotBoot((current) =>
      current === (previousSettings.androidEmulatorSnapshotBoot === true)
        ? props.settings.androidEmulatorSnapshotBoot === true
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
      readonly androidEmulatorSnapshotBoot?: boolean;
      readonly restartContinuation?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly fullAccessSandbox?: boolean;
      readonly coordinatorStarting?: CoordinatorStartingChoice;
      readonly coordinatorWorkerListing?: CoordinatorWorkerListing;
      readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
      readonly windowsTerminalShell?: WindowsTerminalShell;
    },
  ) {
    const host = hostSettings.current;
    if (change.coordinatorStarting !== undefined) {
      setCoordinatorStarting(host.coordinatorStarting ?? "start-without-asking");
    }
    if (change.coordinatorWorkerListing !== undefined) {
      setWorkerListing(host.coordinatorWorkerListing ?? WORKERS_UNLISTED);
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
    if (change.androidEmulatorSnapshotBoot !== undefined) {
      setAndroidSnapshotBoot(host.androidEmulatorSnapshotBoot === true);
    }
    if (change.restartContinuation !== undefined) {
      setRestartContinuation(host.restartContinuation !== false);
    }
    if (change.windowsTerminalShell !== undefined) {
      setWindowsShell(host.windowsTerminalShell ?? "powershell");
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
      readonly androidEmulatorSnapshotBoot?: boolean;
      readonly restartContinuation?: boolean;
      readonly autoReviewer?: AutoReviewer;
      readonly fullAccessSandbox?: boolean;
      readonly coordinatorStarting?: CoordinatorStartingChoice;
      readonly coordinatorWorkerListing?: CoordinatorWorkerListing;
      readonly coordinatorOpenWorkerLimit?: CoordinatorOpenWorkerLimit;
      readonly windowsTerminalShell?: WindowsTerminalShell;
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
        ...(change.androidEmulatorSnapshotBoot === undefined
          ? {}
          : { androidEmulatorSnapshotBoot: change.androidEmulatorSnapshotBoot }),
        ...(change.restartContinuation === undefined
          ? {}
          : { restartContinuation: change.restartContinuation }),
        ...(change.coordinatorStarting === undefined
          ? {}
          : { coordinatorStarting: change.coordinatorStarting }),
        ...(change.coordinatorWorkerListing === undefined
          ? {}
          : { coordinatorWorkerListing: change.coordinatorWorkerListing }),
        ...(change.coordinatorOpenWorkerLimit === undefined
          ? {}
          : { coordinatorOpenWorkerLimit: change.coordinatorOpenWorkerLimit }),
        ...(change.windowsTerminalShell === undefined
          ? {}
          : { windowsTerminalShell: change.windowsTerminalShell }),
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
            description="Workers live inside their coordinator's thread. Choose where else they are listed. Requests from workers always reach Needs you. A Project can choose its own in its overview."
            focused={props.focusedSetting === "code-coordinator-show-workers"}
            label="Show workers"
            scope="mode"
            settingId="code-coordinator-show-workers"
          >
            <CoordinatorWorkerListingChecks
              disabled={false}
              label="Show workers"
              onChange={(next) => {
                setWorkerListing(next);
                void commit("coordinators", { coordinatorWorkerListing: next });
              }}
              value={workerListing}
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
      <SettingsSection title="Devices">
        <div className="setgroup">
          <SettingRow
            description="Let an Android emulator Octant boots start from its saved quickboot snapshot. Off, every boot is cold and takes about a minute; a saved snapshot can leave the emulator offline for minutes after it loads, so the boot times out."
            label="Android snapshot boot"
            focused={props.focusedSetting === "code-android-snapshot-boot"}
            scope="mode"
            settingId="code-android-snapshot-boot"
          >
            <OctantSwitch
              checked={androidSnapshotBoot}
              label="Android snapshot boot"
              onCheckedChange={(checked) => {
                setAndroidSnapshotBoot(checked);
                void commit("devices", { androidEmulatorSnapshotBoot: checked });
              }}
            />
          </SettingRow>
        </div>
        <CodeSettingsFeedbackSlot feedback={feedback} section="devices" />
      </SettingsSection>
      {hostPlatform === "win32" ? (
        <SettingsSection title="Terminal">
          <div className="setgroup">
            <SettingRow
              description="The shell a Code or Project terminal opens on this computer. Terminals run only at Full access on Windows."
              focused={props.focusedSetting === "code-terminal-shell"}
              label="Terminal shell"
              scope="mode"
              settingId="code-terminal-shell"
            >
              <OctantSelectField
                aria-label="Terminal shell"
                className="settings-view__select window-no-drag"
                onValueChange={(value) => {
                  const option = WINDOWS_TERMINAL_SHELL_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option === undefined || option.id === windowsShell) return;
                  setWindowsShell(option.id);
                  void commit("terminal", { windowsTerminalShell: option.id });
                }}
                options={WINDOWS_TERMINAL_SHELL_OPTIONS}
                value={windowsShell}
              />
            </SettingRow>
          </div>
          <CodeSettingsFeedbackSlot feedback={feedback} section="terminal" />
        </SettingsSection>
      ) : null}
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
