import type { OctantMode } from "@octant/contracts/modes";
import {
  decodeProjectId,
  type ProjectAvailability,
  type ProjectId,
  type ProjectSummary,
} from "@octant/contracts/projects";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts/providers";
import {
  LOCAL_HOST_DISPLAY_NAME,
  LOCAL_HOST_ID,
  type HostId,
  type HostIdentity,
} from "@octant/contracts/host";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type {
  CodeCommand,
  CodeCommandResult,
  CodeDeliveryOutcomeKind,
} from "@octant/contracts/code";
import { draftThreadModePresentation, type DraftIntentCard } from "@octant/contracts/thread-draft";
import {
  resolveCodeNewThreadWorkspace,
  type CreateHostViewScope,
  type PickerGroup,
} from "@octant/domain";
import { FolderOpen, GitBranch, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CodeComposerAdapter,
  type CodeComposerSubmitInput,
} from "../code/composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "../code/composer/useWorktreeRemoteFacts";
import { GitHubRepositoryOnboarding } from "../code/GitHubRepositoryOnboarding";
import { WorkComposerAdapter } from "../work/composer/WorkComposerAdapter";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import {
  ComposerProjectSelector,
  type ComposerProjectEntry,
} from "../projects/ComposerProjectSelector";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { HostSelector } from "./HostSelector";
import type { OctantHostBridge } from "./hostBridge";

export interface DraftThreadWorkspaceProps {
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly branchName?: string;
  readonly approvalLabel?: string;
  /**
   * The execution-profile control. Only Code binds a thread to a profile today,
   * so only the Code composer mounts it; showing it where it decides nothing was
   * the reason it read as an unexplained dropdown.
   */
  readonly executionProfile?: ReactNode;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly projects?: ReadonlyArray<ProjectSummary>;
  readonly availabilityByProject?: ReadonlyMap<ProjectId, ProjectAvailability>;
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostBridge?: OctantHostBridge;
  readonly hostId?: string;
  /** GitHub onboarding clients. Both are required for the GitHub
   *  repository selection to appear in the Code composer. */
  readonly githubClient?: GithubClient;
  readonly githubCloneClient?: GithubCloneClient;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly onCreateThread: (
    prompt: string,
    draftProjectId?: ProjectId,
    deliveryOutcome?: CodeDeliveryOutcomeKind,
    images?: ReadonlyArray<File>,
  ) => void | Promise<void>;
  readonly onCreateCodeThread?: (
    input: CodeComposerSubmitInput,
    projectId?: ProjectId,
  ) => void | Promise<void>;
  readonly codeExecute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  readonly defaultExecutionPolicy?: ProviderExecutionPolicy;
  readonly defaultPermissionPersistence?: PermissionPersistence;
  readonly onAttachFolder?: () => void;
  readonly onCreateProject?: (
    mode: OctantMode,
    name: string,
    receiptId?: string,
  ) => Promise<ProjectId | undefined>;
  readonly onCancel: () => void;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
}

export function DraftThreadWorkspace(props: DraftThreadWorkspaceProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | undefined>(
    props.projectId,
  );
  const [selectedProjectLabel, setSelectedProjectLabel] = useState(
    props.projectId === undefined ? undefined : props.projectName,
  );
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const projectFixedHostId =
    props.fixedHostId ??
    (props.projectId !== undefined
      ? ((props.selectedHostId ??
          (props.hostId === undefined ? LOCAL_HOST_ID : (props.hostId as HostId))) as HostId)
      : undefined);
  const hostSelectorBinding = {
    ...(props.hosts === undefined ? {} : { hosts: props.hosts }),
    ...(props.selectedHostId === undefined ? {} : { selectedHostId: props.selectedHostId }),
    ...(projectFixedHostId === undefined ? {} : { fixedHostId: projectFixedHostId }),
    ...(props.lastSelectedHealthyHostId === undefined
      ? {}
      : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId }),
    ...(props.viewScope === undefined ? {} : { viewScope: props.viewScope }),
    ...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost }),
  } as const;
  const compatibleProjects = useMemo(
    () =>
      (props.projects ?? []).filter(
        (project) =>
          (props.mode === "code" || props.mode === "work") &&
          project.type === props.mode &&
          project.lifecycle === "active" &&
          props.availabilityByProject?.get(project.id)?.status !== "unavailable",
      ),
    [props.availabilityByProject, props.mode, props.projects],
  );
  const selectedProject = compatibleProjects.find(
    (project) => String(project.id) === String(selectedProjectId),
  );
  const projectSelection =
    selectedProjectId === undefined
      ? undefined
      : {
          projectId: selectedProjectId,
          displayName: selectedProject?.name ?? selectedProjectLabel ?? "Selected Project",
        };
  const projectEntries: ReadonlyArray<ComposerProjectEntry> = [
    ...compatibleProjects.map(
      (project): ComposerProjectEntry => ({
        kind: "saved-project",
        projectId: project.id,
        displayName: project.name,
        rootPath: project.type === "chat" ? "" : project.binding.canonicalRoot,
      }),
    ),
    { kind: "add-folder" },
  ];
  const folderControl =
    props.mode === "code" || props.mode === "work" ? (
      <ComposerProjectSelector
        {...(props.creating === undefined ? {} : { disabled: props.creating })}
        entries={projectEntries}
        onAddFolder={() => {
          if (props.onCreateProject !== undefined) {
            setAddFolderOpen(true);
          } else {
            props.onAttachFolder?.();
          }
        }}
        onSelect={(entry) => {
          if (entry.kind === "saved-project") {
            setSelectedProjectId(entry.projectId);
            setSelectedProjectLabel(entry.displayName);
          }
        }}
        {...(projectSelection === undefined ? {} : { selection: projectSelection })}
      />
    ) : null;
  const selectedProjectName =
    selectedProjectId === undefined ? undefined : (selectedProject?.name ?? selectedProjectLabel);
  const selectedProjectRoot =
    selectedProjectId === undefined
      ? undefined
      : selectedProject === undefined || selectedProject.type === "chat"
        ? props.projectRoot
        : selectedProject.binding.canonicalRoot;

  // The selected Code Project's remembered habit preselects the
  // composer's Workspace control. A Project with no stored habit resolves to
  // the current checkout, which creates no worktree the user did not ask for.
  const newThreadWorkspace = resolveCodeNewThreadWorkspace(selectedProject);

  // D3: fetch server-authoritative remote facts for the selected Code Project
  // so the composer can decide whether "Start from origin" is available.
  const { remoteFacts: worktreeRemoteFacts } = useWorktreeRemoteFacts({
    ...(props.codeExecute === undefined ? {} : { execute: props.codeExecute }),
    ...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId }),
    enabled:
      props.mode === "code" && selectedProjectId !== undefined && props.codeExecute !== undefined,
  });

  // The GitHub repository stays a distinct visible selection next to
  // Host and Project. A successful onboarding creates one ordinary Code
  // Project from the server-issued binding receipt and selects it here; an
  // already-selected Project fixes its repository so the flow fails closed.
  const githubHostName =
    props.hosts?.find((host) => host.hostId === (props.selectedHostId ?? LOCAL_HOST_ID))
      ?.displayName ?? LOCAL_HOST_DISPLAY_NAME;
  const onCreateProjectForGithub = props.onCreateProject;
  const githubControl =
    props.mode === "code" &&
    props.githubClient !== undefined &&
    props.githubCloneClient !== undefined &&
    onCreateProjectForGithub !== undefined ? (
      <GitHubRepositoryOnboarding
        client={props.githubClient}
        cloneClient={props.githubCloneClient}
        createProject={(name, receiptId) => onCreateProjectForGithub("code", name, receiptId)}
        {...(props.creating === undefined ? {} : { disabled: props.creating })}
        {...(selectedProjectName === undefined ? {} : { fixedProjectName: selectedProjectName })}
        hostName={githubHostName}
        onProjectCreated={(projectId, name) => {
          setSelectedProjectId(decodeProjectId(projectId));
          setSelectedProjectLabel(name);
        }}
      />
    ) : null;

  const addFolderDialog =
    addFolderOpen && props.onCreateProject !== undefined ? (
      <ProjectCreateDialog
        {...(props.folderBrowseClient === undefined
          ? {}
          : { folderBrowseClient: props.folderBrowseClient })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        mode={props.mode}
        onClose={() => setAddFolderOpen(false)}
        onCreate={props.onCreateProject}
        onCreated={(projectId, _mode, name) => {
          setSelectedProjectId(projectId);
          setSelectedProjectLabel(name);
        }}
      />
    ) : null;

  if (props.mode === "code") {
    return (
      <>
        <CodeComposerAdapter
          {...hostSelectorBinding}
          {...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId })}
          {...(selectedProjectName === undefined ? {} : { projectName: selectedProjectName })}
          {...(selectedProjectRoot === undefined ? {} : { projectRoot: selectedProjectRoot })}
          {...(props.branchName === undefined ? {} : { branchName: props.branchName })}
          newThreadWorkspace={newThreadWorkspace}
          {...(worktreeRemoteFacts === undefined ? {} : { worktreeRemoteFacts })}
          defaultExecutionPolicy={props.defaultExecutionPolicy ?? "approval-gated"}
          defaultPermissionPersistence={props.defaultPermissionPersistence ?? "current-session"}
          folderControl={folderControl}
          {...(githubControl === null ? {} : { githubControl })}
          {...(props.codeExecute === undefined ? {} : { execute: props.codeExecute })}
          providerGroups={props.providerGroups}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          onSelectProvider={props.onSelectProvider}
          {...(props.executionProfile === undefined
            ? {}
            : { profileControl: props.executionProfile })}
          onCreateThread={(input) => {
            if (props.onCreateCodeThread !== undefined && selectedProjectId !== undefined) {
              void props.onCreateCodeThread(input, selectedProjectId);
              return;
            }
            // Carry the outcome the user confirmed in the composer so the
            // fallback path never re-derives or auto-confirms a suggestion.
            void props.onCreateThread(
              input.prompt,
              selectedProjectId,
              input.deliveryTarget.outcomeKind,
            );
          }}
          onCancel={props.onCancel}
          {...(props.onCancelFirstTurn === undefined
            ? {}
            : { onCancelFirstTurn: props.onCancelFirstTurn })}
          {...(props.creating === undefined ? {} : { creating: props.creating })}
          {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
          {...(props.pendingMessage === undefined ? {} : { pendingMessage: props.pendingMessage })}
        />
        {addFolderDialog}
      </>
    );
  }

  if (props.mode === "work") {
    return (
      <>
        <WorkComposerAdapter
          {...hostSelectorBinding}
          {...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId })}
          {...(selectedProjectName === undefined ? {} : { projectName: selectedProjectName })}
          {...(selectedProjectRoot === undefined ? {} : { projectRoot: selectedProjectRoot })}
          folderControl={folderControl}
          providerGroups={props.providerGroups}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          onSelectProvider={props.onSelectProvider}
          onCreateThread={(prompt, images) =>
            images === undefined
              ? props.onCreateThread(prompt, selectedProjectId)
              : props.onCreateThread(prompt, selectedProjectId, undefined, images)
          }
          onCancel={props.onCancel}
          {...(props.onCancelFirstTurn === undefined
            ? {}
            : { onCancelFirstTurn: props.onCancelFirstTurn })}
          {...(props.creating === undefined ? {} : { creating: props.creating })}
          {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
          {...(props.pendingMessage === undefined ? {} : { pendingMessage: props.pendingMessage })}
        />
        {addFolderDialog}
      </>
    );
  }

  const presentation = draftThreadModePresentation(props.mode);
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !props.creating;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    void props.onCreateThread(trimmed);
  }, [canSubmit, props, trimmed]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  }

  function applyIntentCard(card: DraftIntentCard) {
    setPrompt((current) => (current.trim() === "" ? `${card.label}: ` : current));
    textareaRef.current?.focus();
  }

  return (
    <section aria-label={`New ${presentation.eyebrow} thread`} className="draft-thread">
      <div className="draft-thread__canvas">
        <div className="draft-thread__welcome">
          <p className="draft-thread__eyebrow">{presentation.eyebrow}</p>
          <h1 className="draft-thread__heading">{presentation.heading}</h1>
          <p className="draft-thread__description">{presentation.description}</p>
        </div>

        <div className="draft-thread__intent-cards" role="list" aria-label="Suggested actions">
          {presentation.intentCards.map((card) => (
            <OctantButton
              className="draft-thread__intent-card"
              key={card.id}
              onClick={() => applyIntentCard(card)}
              role="listitem"
              type="button"
              variant="outline"
            >
              <span className="draft-thread__intent-label">{card.label}</span>
              <span className="draft-thread__intent-description">{card.description}</span>
            </OctantButton>
          ))}
        </div>

        <div className="draft-thread__composer">
          <DraftContextStrip
            mode={props.mode}
            {...hostSelectorBinding}
            providerGroups={props.providerGroups}
            onSelectProvider={props.onSelectProvider}
            {...(props.approvalLabel === undefined ? {} : { approvalLabel: props.approvalLabel })}
            {...(props.branchName === undefined ? {} : { branchName: props.branchName })}
            {...(props.projectName === undefined ? {} : { projectName: props.projectName })}
            {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
            {...(props.selectedModelId === undefined
              ? {}
              : { selectedModelId: props.selectedModelId })}
            {...(props.selectedProviderInstanceId === undefined
              ? {}
              : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          />
          <ThreadComposer
            input={
              <OctantTextarea
                aria-label="First message"
                autoFocus
                className="composer-input"
                disabled={props.creating}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={presentation.composerPlaceholder}
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            row={{
              actions: {
                kind: "send",
                send: { ariaLabel: "Create thread", disabled: !canSubmit, onSend: submit },
              },
            }}
          />
          {props.errorMessage === undefined ? null : (
            <p className="draft-thread__error" role="alert">
              {props.errorMessage}
            </p>
          )}
          <p className="draft-thread__hint">
            Press Enter to start · Shift+Enter for a new line · Escape to close
          </p>
        </div>
      </div>
    </section>
  );
}

/** Compact context strip showing Project, environment, provider/model, and permission state. */
function DraftContextStrip(props: {
  readonly approvalLabel?: string;
  readonly branchName?: string;
  readonly mode: OctantMode;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: HostId;
  readonly fixedHostId?: HostId;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly viewScope?: CreateHostViewScope;
  readonly onSelectHost?: (hostId: HostId) => void;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedModelId?: ProviderModelId;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
}) {
  return (
    <div className="draft-thread__context-strip" aria-label="Thread context">
      <HostSelector
        {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
        {...(props.selectedHostId === undefined ? {} : { selectedHostId: props.selectedHostId })}
        {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
        {...(props.lastSelectedHealthyHostId === undefined
          ? {}
          : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
        {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
        {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
        requiredCapability={props.mode}
      />
      {props.projectName !== undefined ? (
        <span className="draft-thread__context-item" title={props.projectRoot}>
          <FolderOpen aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{props.projectName}</span>
        </span>
      ) : null}
      {props.mode === "code" && props.branchName !== undefined ? (
        <span className="draft-thread__context-item">
          <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{props.branchName}</span>
        </span>
      ) : null}
      {props.approvalLabel !== undefined ? (
        <span className="draft-thread__context-item">
          <ShieldCheck aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{props.approvalLabel}</span>
        </span>
      ) : null}
      <span className="draft-thread__context-picker">
        <ComposerModelPicker
          ariaLabel="Provider and model"
          groups={props.providerGroups}
          onSelect={props.onSelectProvider}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
        />
      </span>
    </div>
  );
}
