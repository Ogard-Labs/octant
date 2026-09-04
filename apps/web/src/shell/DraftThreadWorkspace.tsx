import type { OctantMode } from "@octant/contracts/modes";
import {
  decodeProjectId,
  type ProjectAvailability,
  type ProjectId,
  type ProjectSummary,
} from "@octant/contracts/projects";
import { localHostDisplayName } from "@octant/client-runtime";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts/providers";
import { LOCAL_HOST_ID, type HostId, type HostIdentity } from "@octant/contracts/host";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type {
  CodeCommand,
  CodeCommandResult,
  CodeDeliveryOutcomeKind,
} from "@octant/contracts/code";
import type {
  GithubIssueContextRequest,
  LinearIssueContextRequest,
  MentionableThreadId,
} from "@octant/contracts";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import {
  CreateFromIssuePicker,
  useGithubIssuesCreateAvailable,
} from "../github/CreateFromIssuePicker";
import {
  CreateFromLinearIssuePicker,
  useLinearIssuesCreateAvailable,
} from "../linear/CreateFromLinearIssuePicker";
import {
  draftThreadModePresentation,
  resolveCodeNewThreadWorkspace,
  type CreateHostViewScope,
  type DraftIntentCard,
  type PickerGroup,
} from "@octant/domain";
import { FolderOpen, GitBranch, ShieldCheck } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { CodeHomeUpNext } from "../code/CodeHomeUpNext";
import {
  CodeComposerAdapter,
  type CodeComposerSuggestion,
  type CodeComposerSubmitInput,
} from "../code/composer/CodeComposerAdapter";
import { useWorktreeRemoteFacts } from "../code/composer/useWorktreeRemoteFacts";
import { WorkComposerAdapter } from "../work/composer/WorkComposerAdapter";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import {
  ComposerProjectSelector,
  type ComposerProjectEntry,
} from "../projects/ComposerProjectSelector";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { RecentThreadList, type RecentThreadListItem } from "./RecentThreadList";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { HostSelector } from "./HostSelector";
import type { OctantHostBridge } from "./hostBridge";

// Cloning a repository from GitHub is a first-time step, not a start-screen
// staple; its onboarding stays out of the first bundle.
const GitHubRepositoryOnboarding = lazy(() =>
  import("../code/GitHubRepositoryOnboarding").then((module) => ({
    default: module.GitHubRepositoryOnboarding,
  })),
);

/** One row of the start screen's recent-work list. */
export type DraftRecentThread = RecentThreadListItem;

export interface DraftThreadWorkspaceProps {
  readonly mode: OctantMode;
  /**
   * What this mode already has open, shown under the composer. A start screen
   * with nothing below the prompt left most of the pane empty and gave the
   * user no way back into recent work without crossing to the sidebar.
   */
  readonly recentThreads?: ReadonlyArray<DraftRecentThread>;
  readonly projectId?: ProjectId;
  readonly projectName?: string;
  readonly projectRoot?: string;
  readonly branchName?: string;
  readonly approvalLabel?: string;
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
  /** False when the GitHub first-party plugin is not effective. */
  readonly githubPluginEnabled?: boolean;
  readonly linearClient?: IntegrationClient;
  /** False when the Linear first-party plugin is not effective. */
  readonly linearPluginEnabled?: boolean;
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
    threadMentionIds?: ReadonlyArray<MentionableThreadId>,
    issueContext?: GithubIssueContextRequest,
    linearIssueContext?: LinearIssueContextRequest,
  ) => boolean | void | Promise<boolean | void>;
  readonly onCreateCodeThread?: (
    input: CodeComposerSubmitInput,
    projectId?: ProjectId,
  ) => boolean | void | Promise<boolean | void>;
  readonly codeExecute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  readonly defaultExecutionPolicy?: ProviderExecutionPolicy;
  readonly defaultPermissionPersistence?: PermissionPersistence;
  readonly onExecutionPolicyChange?: (executionPolicy: ProviderExecutionPolicy) => void;
  readonly onAttachFolder?: () => void;
  /**
   * Reports the Project the composer now targets. The draft is unmounted
   * while Settings covers the workspace, so the shell keeps this choice and
   * hands it back through `projectId` when the draft remounts.
   */
  readonly onSelectProject?: (projectId: ProjectId) => void;
  readonly onCreateProject?: (
    mode: OctantMode,
    name: string,
    receiptId?: string,
    initializeGit?: boolean,
  ) => Promise<ProjectId | undefined>;
  readonly onCancel: () => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
}

/**
 * Ready-made first prompts for a Code thread. Each is a complete instruction
 * the agent can act on in any repository, so choosing one is a real start
 * rather than a label to finish.
 */
const CODE_SUGGESTIONS: ReadonlyArray<CodeComposerSuggestion> = [
  {
    id: "fix-failing-test",
    label: "Fix a failing test",
    prompt:
      "Run the test suite, find the failing test, and fix the root cause without weakening the test.",
  },
  {
    id: "add-tests",
    label: "Add missing tests",
    prompt:
      "Find the least-tested module that matters most and add focused tests for its observable behavior.",
  },
  {
    id: "explain-codebase",
    label: "Explain this codebase",
    prompt:
      "Explain how this repository is organised: entry points, main modules, how data flows, and how to run it.",
  },
  {
    id: "review-changes",
    label: "Review my changes",
    prompt:
      "Review the uncommitted changes on this branch for bugs, missing tests, and unclear code, and list what to fix.",
  },
  {
    id: "update-dependencies",
    label: "Update dependencies",
    prompt:
      "Find outdated dependencies, update the ones that are safe, run the checks, and summarise anything that needs a decision.",
  },
];

export function DraftThreadWorkspace(props: DraftThreadWorkspaceProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | undefined>(
    props.projectId,
  );
  const selectProject = (projectId: ProjectId) => {
    setSelectedProjectId(projectId);
    props.onSelectProject?.(projectId);
  };
  type CreateFromSelection =
    | {
        readonly kind: "github";
        readonly request: GithubIssueContextRequest;
        readonly label: string;
      }
    | {
        readonly kind: "linear";
        readonly request: LinearIssueContextRequest;
        readonly label: string;
      };
  const [createFromSelection, setCreateFromSelection] = useState<CreateFromSelection>();
  const [promptRequest, setPromptRequest] = useState<{
    readonly text: string;
    readonly revision: number;
  }>();
  const [createFromOpen, setCreateFromOpen] = useState(false);
  const [createFromTab, setCreateFromTab] = useState<"github" | "linear">("github");
  const issuesCreateAvailable = useGithubIssuesCreateAvailable(
    props.githubClient,
    props.githubPluginEnabled !== false,
  );
  const linearCreateAvailable = useLinearIssuesCreateAvailable(
    props.linearClient,
    props.linearPluginEnabled === true,
  );
  useEffect(() => {
    if (!issuesCreateAvailable && linearCreateAvailable) setCreateFromTab("linear");
    if (issuesCreateAvailable && !linearCreateAvailable) setCreateFromTab("github");
  }, [issuesCreateAvailable, linearCreateAvailable]);
  const createFromControl =
    (issuesCreateAvailable && props.githubClient !== undefined) ||
    (linearCreateAvailable && props.linearClient !== undefined) ? (
      <CreateFromIssueControl
        {...(props.githubClient === undefined || !issuesCreateAvailable
          ? {}
          : { githubClient: props.githubClient })}
        {...(props.linearClient === undefined || !linearCreateAvailable
          ? {}
          : { linearClient: props.linearClient })}
        creating={props.creating === true}
        onClear={() => setCreateFromSelection(undefined)}
        onSelectGithub={(selected) => {
          setCreateFromSelection({
            kind: "github",
            request: selected,
            label: `${selected.owner}/${selected.name}#${String(selected.number)}`,
          });
          setCreateFromOpen(false);
        }}
        onSelectLinear={(selected) => {
          setCreateFromSelection({
            kind: "linear",
            request: { id: selected.id },
            label: selected.identifier,
          });
          setCreateFromOpen(false);
        }}
        open={createFromOpen}
        onToggle={() => setCreateFromOpen((open) => !open)}
        tab={createFromTab}
        onTabChange={setCreateFromTab}
        {...(createFromSelection === undefined
          ? {}
          : {
              selectedLabel: createFromSelection.label,
              ...(createFromSelection.kind === "github"
                ? { selectedGithub: createFromSelection.request }
                : { selectedLinear: createFromSelection.request }),
            })}
      />
    ) : null;
  const issueContext =
    createFromSelection?.kind === "github" ? createFromSelection.request : undefined;
  const linearIssueContext =
    createFromSelection?.kind === "linear" ? createFromSelection.request : undefined;
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
            selectProject(entry.projectId);
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
  const connectedBaseRepository =
    selectedProject?.type === "code" && selectedProject.connectedRepository !== undefined
      ? `${selectedProject.connectedRepository.owner}/${selectedProject.connectedRepository.repository}`
      : undefined;

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
      ?.displayName ?? localHostDisplayName();
  const onCreateProjectForGithub = props.onCreateProject;
  const githubControl =
    props.mode === "code" &&
    props.githubClient !== undefined &&
    props.githubCloneClient !== undefined &&
    onCreateProjectForGithub !== undefined ? (
      <Suspense fallback={null}>
        <GitHubRepositoryOnboarding
          client={props.githubClient}
          cloneClient={props.githubCloneClient}
          createProject={(name, receiptId) => onCreateProjectForGithub("code", name, receiptId)}
          {...(props.creating === undefined ? {} : { disabled: props.creating })}
          {...(selectedProjectName === undefined ? {} : { fixedProjectName: selectedProjectName })}
          hostName={githubHostName}
          onProjectCreated={(projectId, name) => {
            selectProject(decodeProjectId(projectId));
            setSelectedProjectLabel(name);
          }}
        />
      </Suspense>
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
          selectProject(projectId);
          setSelectedProjectLabel(name);
        }}
      />
    ) : null;

  if (props.mode === "code") {
    const upNext =
      props.githubClient !== undefined && props.githubPluginEnabled !== false ? (
        <CodeHomeUpNext
          client={props.githubClient}
          onPick={(item) => {
            const reference = `${item.owner}/${item.name}#${String(item.number)}`;
            // Only an issue can be attached to the new thread, so picking a
            // pull request has to take the previous issue back off: leaving it
            // sent a "Review pull request …" draft away carrying an unrelated
            // issue as its context.
            setCreateFromSelection(
              item.category === "issue"
                ? {
                    kind: "github",
                    request: { owner: item.owner, name: item.name, number: item.number },
                    label: reference,
                  }
                : undefined,
            );
            setPromptRequest((current) => ({
              text:
                item.category === "issue"
                  ? `Work on ${reference}: ${item.title}`
                  : `Review pull request ${reference}: ${item.title}`,
              revision: (current?.revision ?? 0) + 1,
            }));
          }}
        />
      ) : null;
    const beneath =
      upNext === null && (props.recentThreads?.length ?? 0) === 0 ? undefined : (
        <div className="code-home">
          {upNext}
          <RecentThreadList threads={props.recentThreads ?? []} />
        </div>
      );
    return (
      <>
        <CodeComposerAdapter
          suggestions={CODE_SUGGESTIONS}
          {...(beneath === undefined ? {} : { beneath })}
          {...(promptRequest === undefined ? {} : { promptRequest })}
          {...hostSelectorBinding}
          {...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId })}
          projectAvailable={selectedProject !== undefined}
          {...(selectedProjectName === undefined ? {} : { projectName: selectedProjectName })}
          {...(selectedProjectRoot === undefined ? {} : { projectRoot: selectedProjectRoot })}
          {...(connectedBaseRepository === undefined
            ? {}
            : { baseRepository: connectedBaseRepository })}
          {...(props.branchName === undefined ? {} : { branchName: props.branchName })}
          newThreadWorkspace={newThreadWorkspace}
          {...(worktreeRemoteFacts === undefined ? {} : { worktreeRemoteFacts })}
          defaultExecutionPolicy={props.defaultExecutionPolicy ?? "approval-gated"}
          defaultPermissionPersistence={props.defaultPermissionPersistence ?? "current-session"}
          {...(props.onExecutionPolicyChange === undefined
            ? {}
            : { onExecutionPolicyChange: props.onExecutionPolicyChange })}
          folderControl={folderControl}
          {...(githubControl === null ? {} : { githubControl })}
          {...(createFromControl === null ? {} : { createFromControl })}
          {...(props.codeExecute === undefined ? {} : { execute: props.codeExecute })}
          providerGroups={props.providerGroups}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          onSelectProvider={props.onSelectProvider}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
          onCreateThread={(input) => {
            const submitted = {
              ...input,
              ...(issueContext === undefined ? {} : { issueContext }),
              ...(linearIssueContext === undefined ? {} : { linearIssueContext }),
            };
            if (props.onCreateCodeThread !== undefined && selectedProjectId !== undefined) {
              return props.onCreateCodeThread(submitted, selectedProjectId);
            }
            // Carry the outcome the user confirmed in the composer so the
            // fallback path never re-derives or auto-confirms a suggestion.
            return issueContext === undefined && linearIssueContext === undefined
              ? props.onCreateThread(
                  submitted.prompt,
                  selectedProjectId,
                  submitted.deliveryTarget.outcomeKind,
                )
              : props.onCreateThread(
                  submitted.prompt,
                  selectedProjectId,
                  submitted.deliveryTarget.outcomeKind,
                  submitted.images,
                  submitted.threadMentionIds,
                  issueContext,
                  linearIssueContext,
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
          {...(createFromControl === null ? {} : { createFromControl })}
          providerGroups={props.providerGroups}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          onSelectProvider={props.onSelectProvider}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
          onCreateThread={(prompt, images, threadMentionIds) =>
            issueContext === undefined && linearIssueContext === undefined
              ? props.onCreateThread(prompt, selectedProjectId, undefined, images, threadMentionIds)
              : props.onCreateThread(
                  prompt,
                  selectedProjectId,
                  undefined,
                  images,
                  threadMentionIds,
                  issueContext,
                  linearIssueContext,
                )
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
    if (issueContext === undefined && linearIssueContext === undefined) {
      void props.onCreateThread(trimmed);
      return;
    }
    void props.onCreateThread(
      trimmed,
      undefined,
      undefined,
      undefined,
      undefined,
      issueContext,
      linearIssueContext,
    );
  }, [canSubmit, issueContext, linearIssueContext, props, trimmed]);

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
          <h1 className="draft-thread__heading">{presentation.heading}</h1>
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
          {createFromControl}
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

        {(props.recentThreads?.length ?? 0) === 0 ? (
          <div className="draft-thread__intent-cards" role="group" aria-label="Suggested actions">
            {presentation.intentCards.map((card) => (
              <OctantButton
                className="draft-thread__intent-card"
                key={card.id}
                onClick={() => applyIntentCard(card)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <span className="draft-thread__intent-label">{card.label}</span>
                <span className="draft-thread__intent-description">{card.description}</span>
              </OctantButton>
            ))}
          </div>
        ) : null}

        <RecentThreadList threads={props.recentThreads ?? []} />
      </div>
    </section>
  );
}

function CreateFromIssueControl(props: {
  readonly githubClient?: GithubClient;
  readonly linearClient?: IntegrationClient;
  readonly creating: boolean;
  readonly open: boolean;
  readonly tab: "github" | "linear";
  readonly onTabChange: (tab: "github" | "linear") => void;
  readonly selectedGithub?: GithubIssueContextRequest;
  readonly selectedLinear?: LinearIssueContextRequest;
  readonly selectedLabel?: string;
  readonly onSelectGithub: (issue: GithubIssueContextRequest) => void;
  readonly onSelectLinear: (
    issue: LinearIssueContextRequest & { readonly identifier: string },
  ) => void;
  readonly onClear: () => void;
  readonly onToggle: () => void;
}) {
  const showGithub = props.githubClient !== undefined;
  const showLinear = props.linearClient !== undefined;
  const activeTab =
    props.tab === "linear" && showLinear
      ? "linear"
      : props.tab === "github" && showGithub
        ? "github"
        : showGithub
          ? "github"
          : "linear";
  const panel = (
    <div className="create-from-issue-control__panel">
      <div role="tablist" aria-label="Create from">
        {showGithub ? (
          <OctantButton
            aria-selected={activeTab === "github"}
            onClick={() => props.onTabChange("github")}
            role="tab"
            size="sm"
            type="button"
            variant="ghost"
          >
            Issues
          </OctantButton>
        ) : null}
        {showLinear ? (
          <OctantButton
            aria-selected={activeTab === "linear"}
            onClick={() => props.onTabChange("linear")}
            role="tab"
            size="sm"
            type="button"
            variant="ghost"
          >
            Linear
          </OctantButton>
        ) : null}
      </div>
      {activeTab === "github" && props.githubClient !== undefined ? (
        <div role="tabpanel">
          <CreateFromIssuePicker
            client={props.githubClient}
            disabled={props.creating}
            onSelect={props.onSelectGithub}
            {...(props.selectedGithub === undefined ? {} : { selected: props.selectedGithub })}
          />
        </div>
      ) : null}
      {activeTab === "linear" && props.linearClient !== undefined ? (
        <div role="tabpanel">
          <CreateFromLinearIssuePicker
            client={props.linearClient}
            disabled={props.creating}
            onSelect={props.onSelectLinear}
            {...(props.selectedLinear === undefined ? {} : { selected: props.selectedLinear })}
          />
        </div>
      ) : null}
    </div>
  );
  // The picker floats over the page. Opened in place it grew the context
  // strip by a repository list and pushed the prompt down with it.
  return (
    <div className="create-from-issue-control">
      <div className="create-from-issue-control__bar">
        <OctantPopover
          align="end"
          className="create-from-issue-control__popup"
          onOpenChange={(open) => {
            if (open !== props.open) props.onToggle();
          }}
          open={props.open}
          side="bottom"
          sideOffset={8}
          title="Create from an issue"
          trigger={<>Create from…</>}
          triggerDisabled={props.creating}
          triggerLabel="Create from…"
          triggerVariant="ghost"
        >
          {panel}
        </OctantPopover>
        {props.selectedLabel === undefined ? null : (
          <span className="create-from-issue-control__selection">
            <span>{props.selectedLabel}</span>
            <OctantButton
              aria-label="Remove selected issue"
              disabled={props.creating}
              onClick={props.onClear}
              size="sm"
              type="button"
              variant="ghost"
            >
              Remove
            </OctantButton>
          </span>
        )}
      </div>
    </div>
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
        presentation="environment"
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
