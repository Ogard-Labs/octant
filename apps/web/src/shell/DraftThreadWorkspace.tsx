import { useDraftModelOptions } from "../providers/useDraftModelOptions";
import type { AutoReview } from "../code/autoReview";
import {
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
  useNewTaskPrompt,
  type NewTaskCreateFromSelection,
} from "../composer/useNewTaskPrompt";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
} from "../composer/useComposerSlashCommands";
import { ComposerAtTypeahead, useComposerAtMenu } from "../composer/useComposerAtMenu";
import { useExtensionDraftSelections } from "../chat/useExtensionDraftSelections";
import { providerFamilyForThread } from "../providers/providerFamily";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import { decodeGithubIssueContextRequest } from "@octant/contracts";
import type { RepositoryIssueRow } from "../github/readIssuesAcrossRepositories";
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
  PermissionMode,
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
} from "@octant/contracts/providers";
import { LOCAL_HOST_ID, type HostId, type HostIdentity } from "@octant/contracts/host";
import type { HomeCardCustomization } from "@octant/contracts/shell";
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
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
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
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { joinDefaultFolderDisplayPath } from "../settings/defaultFolderDisplay";
import { CodeHome, type CodeHomeProps } from "../code/CodeHome";
import {
  CodeComposerAdapter,
  type CodeComposerSuggestion,
  type CodeComposerSubmitInput,
} from "../code/composer/CodeComposerAdapter";
import { StartQuickToolsPlacementContext } from "./StartQuickTools";
import { useWorktreeRemoteFacts } from "../code/composer/useWorktreeRemoteFacts";
import { WorkComposerAdapter } from "../work/composer/WorkComposerAdapter";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { ComposerModelPicker } from "../providers/ComposerModelPicker";
import {
  ComposerProjectSelector,
  type ComposerProjectGithubSource,
  type ComposerProjectEntry,
} from "../projects/ComposerProjectSelector";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { RecentThreadList, type RecentThreadListItem } from "./RecentThreadList";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ThreadComposer } from "../composer/ThreadComposer";
import { ComposerVoiceButton } from "../voice/ComposerVoiceButton";
import { appendTranscript } from "../voice/appendTranscript";
import { HostSelector } from "./HostSelector";
import { HomeStart } from "./HomeStart";
import { WelcomeHeading } from "../composer/WelcomeHeading";
import { HomeDashboard } from "../home/HomeDashboard";
import type { HomeCardDefinition } from "../home/homeCards";
import type { OctantHostBridge } from "./hostBridge";
import { WorkKindSwitch } from "./WorkKindSwitch";
import { OctantAlert } from "../ui/base/OctantAlert";

// Cloning a repository from GitHub is a first-time step, not a start-screen
// staple; its onboarding stays out of the first bundle.
/** One row of the start screen's recent-work list. */
export type DraftRecentThread = RecentThreadListItem;

/**
 * Which start screen a draft is. **Home** is where Code lands with nothing
 * chosen: the composer with what is next, what to continue, prompt
 * suggestions, and the cards. **New task** is the question and the composer
 * alone, in every mode.
 */
export type DraftStartPresentation = "home" | "new-task";

export interface DraftThreadWorkspaceProps {
  readonly mode: OctantMode;
  readonly startPresentation?: DraftStartPresentation;
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
  readonly onSelectUnfiled?: () => void;
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
    computerUseSelection?: ExtensionSelection,
    extensionSelections?: ReadonlyArray<ExtensionSelection>,
    /** The access posture the composer submitted with, not a project default. */
    executionPolicy?: ProviderExecutionPolicy,
    permissionPersistence?: PermissionPersistence,
    modelOptionValues?: ProviderModelOptionValues,
  ) => boolean | void | Promise<boolean | void>;
  readonly onCreateCodeThread?: (
    input: CodeComposerSubmitInput,
    projectId?: ProjectId,
  ) => boolean | void | Promise<boolean | void>;
  readonly codeExecute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  readonly defaultPermissionMode?: PermissionMode;
  readonly defaultPermissionPersistence?: PermissionPersistence;
  readonly onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Whether the selected provider has a reviewer of its own, so Auto applies. */
  readonly autoSupported?: boolean;
  /** Who would answer the new thread's prompts at Auto, or why nobody can. */
  readonly autoReview?: AutoReview;
  readonly onAttachFolder?: () => void;
  readonly onOpenCodeSettings?: () => void;
  /** Opens Providers & Models from the start composer while none is ready. */
  readonly onOpenSettings?: () => void;
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
  /**
   * The default folder in effect and the way to get the Project the host keeps
   * under it. Both present is what puts the "No Project" row in the menu.
   */
  readonly defaultFolder?: string;
  /**
   * Whether Code may start a thread without a Project. Work always may; Code
   * has its own switch beside the Git requirement, because the default folder
   * is not a repository.
   */
  readonly codeDefaultFolderThreads?: boolean;
  readonly onEnsureDefaultProject?: (
    mode: "work" | "code",
  ) => Promise<{ readonly projectId: ProjectId; readonly name: string } | undefined>;
  readonly onCancel: () => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly extensionClient?: ExtensionClient;
  readonly creating?: boolean;
  readonly errorMessage?: string;
  readonly pendingMessage?: string;
  readonly onCancelFirstTurn?: () => void;
  /**
   * What a start screen offers under the composer besides its own sections:
   * the card area.
   */
  readonly homeStart?: {
    /** The card registry for this screen; absent leaves the card area out. */
    readonly cards?: ReadonlyArray<HomeCardDefinition>;
    readonly cardCustomization: HomeCardCustomization;
    readonly onCardCustomizationChange: (next: HomeCardCustomization) => void;
  };
  /**
   * What the Code start screen shows under the composer: the threads to
   * continue, the Linear loader for Up next, names for cards, and the openers
   * the sections hand off to. Absent on hosts that have none of it.
   */
  /**
   * Text handed over from elsewhere, such as a Canvas plan task, to start the
   * composer with. Nothing is created until the person sends it.
   */
  readonly pendingPrompt?: string;
  readonly onPendingPromptConsumed?: () => void;
  readonly codeHome?: Pick<
    CodeHomeProps,
    | "loadAssignedLinearIssues"
    | "loadOpenLinearIssues"
    | "continueCards"
    | "projectNames"
    | "providerLabels"
    | "onOpenThread"
    | "onOpenInbox"
    | "onOpenIssues"
  > & {
    /**
     * An issue the Issues surface handed over: it fills the prompt and the
     * create-from context once, then the owner clears it.
     */
    readonly pendingIssue?: RepositoryIssueRow;
    readonly onPendingIssueConsumed?: () => void;
  };
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
  const [localProjectId, setLocalProjectId] = useState<ProjectId | undefined>(props.projectId);
  // The shell owns a persisted selection when supplied; refused transitions
  // must keep its former Project without replacing the composer's draft.
  const selectedProjectId = props.onSelectProject === undefined ? localProjectId : props.projectId;
  const selectProject = (projectId: ProjectId) => {
    if (props.onSelectProject === undefined) setLocalProjectId(projectId);
    else props.onSelectProject(projectId);
  };
  const selectUnfiled = () => {
    if (props.onSelectUnfiled === undefined) {
      setLocalProjectId(undefined);
      setSelectedProjectLabel(undefined);
    } else {
      props.onSelectUnfiled();
    }
  };
  useEffect(() => setLocalProjectId(props.projectId), [props.projectId]);
  const drafts = useContext(NewTaskDraftsContext);
  const draftScope = useContext(NewTaskDraftScopeContext);
  // A Code start screen hands its Project to the dock, under its own draft
  // scope, so the dock holds the active pane's quick tools while that task
  // waits for its thread.
  const chooseQuickToolsProject = useContext(StartQuickToolsPlacementContext)?.chooseProject;
  const codeStart = props.mode === "code";
  useEffect(() => {
    if (chooseQuickToolsProject === undefined || !codeStart || draftScope === undefined) return;
    chooseQuickToolsProject(draftScope, selectedProjectId);
    return () => chooseQuickToolsProject(draftScope, undefined);
  }, [chooseQuickToolsProject, codeStart, draftScope, selectedProjectId]);
  const [createFromSelection, setCreateFromSelectionState] = useState<
    NewTaskCreateFromSelection | undefined
  >(() => (draftScope === undefined ? undefined : drafts?.readCreateFrom(draftScope)));
  useLayoutEffect(() => {
    setCreateFromSelectionState(
      draftScope === undefined ? undefined : drafts?.readCreateFrom(draftScope),
    );
  }, [drafts, draftScope]);
  const setCreateFromSelection = (selection: NewTaskCreateFromSelection | undefined) => {
    setCreateFromSelectionState(selection);
    if (draftScope !== undefined) drafts?.writeCreateFrom(draftScope, selection);
  };
  const [promptRequest, setPromptRequest] = useState<{
    readonly text: string;
    readonly revision: number;
  }>();
  const [createFromOpen, setCreateFromOpen] = useState(false);
  const [createFromTab, setCreateFromTab] = useState<"github" | "linear">("github");
  const fillPromptRequest = (text: string) =>
    setPromptRequest((current) => ({ text, revision: (current?.revision ?? 0) + 1 }));
  const adoptIssue = (row: RepositoryIssueRow) => {
    const reference = `${row.owner}/${row.name}#${String(row.number)}`;
    let request: GithubIssueContextRequest | undefined;
    try {
      request = decodeGithubIssueContextRequest({
        owner: row.owner,
        name: row.name,
        number: row.number,
      });
    } catch {
      request = undefined;
    }
    setCreateFromSelection(
      request === undefined ? undefined : { kind: "github", request, label: reference },
    );
    fillPromptRequest(`Work on ${reference}: ${row.title}`);
  };
  const pendingPrompt = props.pendingPrompt;
  const onPendingPromptConsumed = props.onPendingPromptConsumed;
  useEffect(() => {
    if (pendingPrompt === undefined) return;
    setPromptRequest((current) => ({
      text: pendingPrompt,
      revision: (current?.revision ?? 0) + 1,
    }));
    onPendingPromptConsumed?.();
  }, [pendingPrompt]);
  const pendingIssue = props.codeHome?.pendingIssue;
  const onPendingIssueConsumed = props.codeHome?.onPendingIssueConsumed;
  useEffect(() => {
    if (pendingIssue === undefined) return;
    adoptIssue(pendingIssue);
    onPendingIssueConsumed?.();
  }, [pendingIssue]);
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
        onSelectGithub={(selected, title) => {
          const reference = `${selected.owner}/${selected.name}#${String(selected.number)}`;
          setCreateFromSelection({ kind: "github", request: selected, label: reference });
          fillPromptRequest(`Work on ${reference}: ${title}`);
          setCreateFromOpen(false);
        }}
        onSelectLinear={(selected, title) => {
          setCreateFromSelection({
            kind: "linear",
            request: { id: selected.id },
            label: selected.identifier,
          });
          fillPromptRequest(`Work on ${selected.identifier}: ${title}`);
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
          (props.mode === "chat" || props.mode === "code" || props.mode === "work") &&
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
  const defaultFolderEntry =
    props.defaultFolder !== undefined && props.onEnsureDefaultProject !== undefined
      ? ({
          kind: "default-folder" as const,
          rootPath: joinDefaultFolderDisplayPath(
            props.defaultFolder,
            props.mode === "work" ? "Work" : "Code",
          ),
          ...(props.mode === "code" && props.codeDefaultFolderThreads !== true
            ? {
                disabled: true,
                disabledReason: "Code needs a Git repository. Change it in Code settings",
              }
            : {}),
        } satisfies ComposerProjectEntry)
      : undefined;
  const projectEntries: ReadonlyArray<ComposerProjectEntry> = [
    ...compatibleProjects.map(
      (project): ComposerProjectEntry => ({
        kind: "saved-project",
        projectId: project.id,
        displayName: project.name,
        rootPath: project.type === "chat" ? "" : project.binding.canonicalRoot,
      }),
    ),
    ...(props.mode === "chat"
      ? [{ kind: "unfiled" as const }]
      : [
          ...(defaultFolderEntry === undefined ? [] : [defaultFolderEntry]),
          { kind: "add-folder" as const },
        ]),
  ];
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

  // A GitHub repository becomes a Project through the Project menu's "New
  // Project from GitHub repository": a successful onboarding creates one
  // ordinary Code Project from the server-issued binding receipt and selects
  // it here, the same as a folder would.
  const githubHostName =
    props.hosts?.find((host) => host.hostId === (props.selectedHostId ?? LOCAL_HOST_ID))
      ?.displayName ?? localHostDisplayName();
  const onCreateProjectForGithub = props.onCreateProject;
  const githubProjectSource: ComposerProjectGithubSource | undefined =
    props.mode === "code" &&
    props.githubClient !== undefined &&
    props.githubCloneClient !== undefined &&
    props.githubPluginEnabled !== false &&
    onCreateProjectForGithub !== undefined
      ? {
          client: props.githubClient,
          cloneClient: props.githubCloneClient,
          createProject: (name, receiptId) => onCreateProjectForGithub("code", name, receiptId),
          hostName: githubHostName,
          onProjectCreated: (projectId, name) => {
            selectProject(decodeProjectId(projectId));
            setSelectedProjectLabel(name);
          },
        }
      : undefined;

  function addFolder() {
    if (props.onCreateProject !== undefined) setAddFolderOpen(true);
    else props.onAttachFolder?.();
  }

  const home = props.startPresentation === "home";
  const homeStartNode =
    !home || props.homeStart?.cards === undefined ? undefined : (
      <HomeStart
        dashboard={
          <HomeDashboard
            cards={props.homeStart.cards}
            customization={props.homeStart.cardCustomization}
            onCustomizationChange={props.homeStart.onCardCustomizationChange}
          />
        }
      />
    );

  const folderControl =
    props.mode === "chat" || props.mode === "code" || props.mode === "work" ? (
      <ComposerProjectSelector
        {...(props.creating === undefined ? {} : { disabled: props.creating })}
        entries={projectEntries}
        onAddFolder={addFolder}
        onSelect={(entry) => {
          if (entry.kind === "saved-project") {
            selectProject(entry.projectId);
            setSelectedProjectLabel(entry.displayName);
          } else if (entry.kind === "unfiled") {
            selectUnfiled();
          } else if (
            entry.kind === "default-folder" &&
            props.onEnsureDefaultProject !== undefined &&
            (props.mode === "work" || props.mode === "code")
          ) {
            void props.onEnsureDefaultProject(props.mode).then((ensured) => {
              if (ensured === undefined) return;
              selectProject(ensured.projectId);
              setSelectedProjectLabel(ensured.name);
            });
          }
        }}
        {...(projectSelection === undefined ? {} : { selection: projectSelection })}
        {...(githubProjectSource === undefined ? {} : { github: githubProjectSource })}
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
        {...(props.mode === "code" &&
        props.githubClient !== undefined &&
        props.githubCloneClient !== undefined &&
        props.githubPluginEnabled !== false
          ? {
              github: {
                client: props.githubClient,
                cloneClient: props.githubCloneClient,
                hostName: githubHostName,
              },
            }
          : {})}
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
    const githubHomeClient =
      props.githubClient !== undefined && props.githubPluginEnabled !== false
        ? props.githubClient
        : undefined;
    const linearHome =
      props.linearPluginEnabled === true ? props.codeHome?.loadAssignedLinearIssues : undefined;
    const linearFresh =
      props.linearPluginEnabled === true ? props.codeHome?.loadOpenLinearIssues : undefined;
    const beneath = !home ? undefined : githubHomeClient === undefined &&
      linearHome === undefined &&
      props.codeHome === undefined ? (
      (props.recentThreads?.length ?? 0) === 0 ? undefined : (
        <div className="code-home">
          <RecentThreadList threads={props.recentThreads ?? []} />
        </div>
      )
    ) : (
      <CodeHome
        {...(githubHomeClient === undefined ? {} : { githubClient: githubHomeClient })}
        {...(linearHome === undefined ? {} : { loadAssignedLinearIssues: linearHome })}
        {...(linearFresh === undefined ? {} : { loadOpenLinearIssues: linearFresh })}
        {...(props.codeHome?.continueCards === undefined
          ? {}
          : { continueCards: props.codeHome.continueCards })}
        {...(props.codeHome?.projectNames === undefined
          ? {}
          : { projectNames: props.codeHome.projectNames })}
        {...(props.codeHome?.providerLabels === undefined
          ? {}
          : { providerLabels: props.codeHome.providerLabels })}
        {...(props.codeHome?.onOpenThread === undefined
          ? {}
          : { onOpenThread: props.codeHome.onOpenThread })}
        {...(props.codeHome?.onOpenInbox === undefined
          ? {}
          : { onOpenInbox: props.codeHome.onOpenInbox })}
        {...(props.codeHome?.onOpenIssues === undefined
          ? {}
          : { onOpenIssues: props.codeHome.onOpenIssues })}
        onPickGithub={(item) => {
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
          fillPromptRequest(
            item.category === "issue"
              ? `Work on ${reference}: ${item.title}`
              : `Review pull request ${reference}: ${item.title}`,
          );
        }}
        onPickIssue={adoptIssue}
        onPickLinear={(row) => {
          setCreateFromSelection({
            kind: "linear",
            request: { id: row.id },
            label: row.identifier,
          });
          fillPromptRequest(`Work on ${row.identifier}: ${row.title}`);
        }}
      />
    );
    const composer = (
      <CodeComposerAdapter
        {...(home ? { suggestions: CODE_SUGGESTIONS } : {})}
        {...(homeStartNode === undefined ? {} : { homeStart: homeStartNode })}
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
        defaultPermissionMode={props.defaultPermissionMode ?? "ask-first"}
        defaultPermissionPersistence={props.defaultPermissionPersistence ?? "current-session"}
        {...(props.onPermissionModeChange === undefined
          ? {}
          : { onPermissionModeChange: props.onPermissionModeChange })}
        {...(props.autoSupported === true ? { autoSupported: true } : {})}
        {...(props.autoReview === undefined ? {} : { autoReview: props.autoReview })}
        projectSetup={
          selectedProjectId === undefined && compatibleProjects.length === 0 ? (
            <div aria-label="Set up a Code project" className="code-home__project-setup">
              <p>Add a folder to choose where this task will work.</p>
              {props.onCreateProject === undefined && props.onAttachFolder === undefined ? null : (
                <OctantButton
                  onClick={addFolder}
                  disabled={props.creating}
                  size="sm"
                  variant="secondary"
                >
                  <FolderOpen aria-hidden="true" size={16} />
                  Add a folder
                </OctantButton>
              )}
              {defaultFolderEntry?.disabled === true ? (
                <>
                  <p>
                    Code needs a Git repository, so it cannot start in the default folder. You can
                    change this in Code settings.
                  </p>
                  {props.onOpenCodeSettings === undefined ? null : (
                    <OctantButton onClick={props.onOpenCodeSettings} size="sm" variant="link">
                      Open Code settings
                    </OctantButton>
                  )}
                </>
              ) : null}
            </div>
          ) : undefined
        }
        folderControl={folderControl}
        {...(createFromControl === null ? {} : { createFromControl })}
        {...(props.codeExecute === undefined ? {} : { execute: props.codeExecute })}
        providerGroups={props.providerGroups}
        {...(props.selectedProviderInstanceId === undefined
          ? {}
          : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
        {...(props.selectedModelId === undefined ? {} : { selectedModelId: props.selectedModelId })}
        onSelectProvider={props.onSelectProvider}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.extensionClient === undefined ? {} : { extensionClient: props.extensionClient })}
        onCreateThread={(input) => {
          const submitted = {
            ...input,
            ...(issueContext === undefined ? {} : { issueContext }),
            ...(linearIssueContext === undefined ? {} : { linearIssueContext }),
          };
          if (props.onCreateCodeThread !== undefined && selectedProjectId !== undefined) {
            return props.onCreateCodeThread(submitted, selectedProjectId);
          }
          // Carry the outcome the user confirmed in the composer, and the
          // access posture they submitted with, so the fallback path never
          // re-derives a suggestion or falls back to a Project default.
          return props.onCreateThread(
            submitted.prompt,
            selectedProjectId,
            submitted.deliveryTarget.outcomeKind,
            submitted.images,
            submitted.threadMentionIds,
            issueContext,
            linearIssueContext,
            submitted.computerUseSelection,
            submitted.extensionSelections,
            submitted.executionPolicy,
            submitted.permissionPersistence,
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
    );
    return (
      <>
        {composer}
        {addFolderDialog}
      </>
    );
  }

  if (props.mode === "work") {
    return (
      <>
        <WorkComposerAdapter
          {...(promptRequest === undefined ? {} : { promptRequest })}
          {...(homeStartNode === undefined ? {} : { homeStart: homeStartNode })}
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
          {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
          {...(props.extensionClient === undefined
            ? {}
            : { extensionClient: props.extensionClient })}
          onCreateThread={(
            prompt,
            images,
            threadMentionIds,
            computerUseSelection,
            extensionSelections,
            modelOptionValues,
          ) =>
            modelOptionValues !== undefined
              ? props.onCreateThread(
                  prompt,
                  selectedProjectId,
                  undefined,
                  images,
                  threadMentionIds,
                  issueContext,
                  linearIssueContext,
                  computerUseSelection,
                  extensionSelections,
                  undefined,
                  undefined,
                  modelOptionValues,
                )
              : computerUseSelection !== undefined
                ? props.onCreateThread(
                    prompt,
                    selectedProjectId,
                    undefined,
                    images,
                    threadMentionIds,
                    issueContext,
                    linearIssueContext,
                    computerUseSelection,
                    extensionSelections,
                  )
                : extensionSelections !== undefined && extensionSelections.length > 0
                  ? props.onCreateThread(
                      prompt,
                      selectedProjectId,
                      undefined,
                      images,
                      threadMentionIds,
                      issueContext,
                      linearIssueContext,
                      undefined,
                      extensionSelections,
                    )
                  : issueContext === undefined && linearIssueContext === undefined
                    ? props.onCreateThread(
                        prompt,
                        selectedProjectId,
                        undefined,
                        images,
                        threadMentionIds,
                      )
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

  const { modelKey, modelOptionValues, setModelChoice } = useDraftModelOptions(
    props.providerGroups ?? [],
    props.selectedProviderInstanceId,
    props.selectedModelId,
  );

  const presentation = draftThreadModePresentation(props.mode);
  const [prompt, setPrompt] = useNewTaskPrompt();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A Chat draft is a first-message composer like Work's and Code's, so it
  // offers the same host command list.
  const slash = useComposerSlashCommands({
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
  });
  const draftProviderFamily = providerFamilyForThread(
    props.providerGroups,
    props.selectedProviderInstanceId,
  );
  const extensionDraft = useExtensionDraftSelections({
    ...(props.extensionClient === undefined ? {} : { client: props.extensionClient }),
    mode: "chat",
    projectId: null,
    ...(draftProviderFamily === undefined ? {} : { providerFamily: draftProviderFamily }),
  });
  const atMenu = useComposerAtMenu({
    draft: prompt,
    onDraftChange: setPrompt,
    textarea: () => textareaRef.current,
    onResolveExtensionReference: extensionDraft.resolveReference,
  });
  useEffect(() => {
    if (props.pendingMessage === undefined) return;
    setPrompt(props.pendingMessage);
  }, [props.pendingMessage]);
  const appliedPromptRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (promptRequest === undefined || appliedPromptRevision.current === promptRequest.revision) {
      return;
    }
    appliedPromptRevision.current = promptRequest.revision;
    setPrompt(promptRequest.text);
    textareaRef.current?.focus();
  }, [promptRequest]);
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && !props.creating && !atMenu.resolving;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const extensionSelections = extensionDraft.receipts.flatMap((receipt) =>
      receipt.selection === undefined ? [] : [receipt.selection],
    );
    const afterCreate = (created: boolean | void | Promise<boolean | void>) => {
      if (extensionSelections.length === 0) return;
      void Promise.resolve(created).then((accepted) => {
        if (accepted !== false) extensionDraft.clear();
      });
    };
    if (Object.keys(modelOptionValues).length > 0) {
      afterCreate(
        props.onCreateThread(
          trimmed,
          undefined,
          undefined,
          undefined,
          undefined,
          issueContext,
          linearIssueContext,
          undefined,
          extensionSelections.length === 0 ? undefined : extensionSelections,
          undefined,
          undefined,
          modelOptionValues,
        ),
      );
      return;
    }
    if (extensionSelections.length > 0) {
      afterCreate(
        props.onCreateThread(
          trimmed,
          undefined,
          undefined,
          undefined,
          undefined,
          issueContext,
          linearIssueContext,
          undefined,
          extensionSelections,
        ),
      );
      return;
    }
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
  }, [
    canSubmit,
    extensionDraft,
    issueContext,
    linearIssueContext,
    modelOptionValues,
    props,
    trimmed,
  ]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (atMenu.handleKeyDown(event)) return;
    if (slash.handleKeyDown(event)) return;
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
          <WelcomeHeading />
        </div>
        <div className="draft-thread__composer composer-stack">
          {createFromControl}
          <ThreadComposer
            planUsage={{
              providerInstanceId:
                props.selectedProviderInstanceId === undefined
                  ? undefined
                  : String(props.selectedProviderInstanceId),
              alternatives: {
                groups: props.providerGroups,
                onSelect: props.onSelectProvider,
                selectedModelId:
                  props.selectedModelId === undefined ? undefined : String(props.selectedModelId),
              },
            }}
            startContext={
              <div className="composer-tray composer-tray--inside" aria-label="Thread context">
                {props.mode === "chat" ? <WorkKindSwitch /> : null}
                <DraftContextStrip
                  mode={props.mode}
                  {...hostSelectorBinding}
                  {...(props.approvalLabel === undefined
                    ? {}
                    : { approvalLabel: props.approvalLabel })}
                  {...(props.branchName === undefined ? {} : { branchName: props.branchName })}
                  {...(props.mode === "chat" || props.projectName === undefined
                    ? {}
                    : { projectName: props.projectName })}
                  {...(props.projectRoot === undefined ? {} : { projectRoot: props.projectRoot })}
                />
              </div>
            }
            chips={
              <>
                {extensionDraft.receipts.length > 0 ? (
                  <ul aria-label="Selected extensions" className="composer-chips">
                    {extensionDraft.receipts.map((receipt) => (
                      <li className="chip" key={receipt.reference}>
                        <span>{receipt.label}</span>
                        {receipt.status.kind === "blocked" ? (
                          <span>{`Blocked: ${receipt.status.reason}`}</span>
                        ) : null}
                        <OctantButton
                          aria-label={`Remove ${receipt.label} extension`}
                          className="chip-x window-no-drag"
                          onClick={() => extensionDraft.remove(receipt.reference)}
                          type="button"
                          variant="bare"
                        >
                          ×
                        </OctantButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            }
            typeahead={
              atMenu.open ? (
                <ComposerAtTypeahead controller={atMenu} />
              ) : slash.open ? (
                <ComposerSlashTypeahead controller={slash} />
              ) : null
            }
            input={
              <OctantTextarea
                aria-label="First message"
                aria-autocomplete="list"
                aria-expanded={atMenu.open || slash.open}
                aria-controls={atMenu.open ? atMenu.listId : slash.open ? slash.listId : undefined}
                aria-activedescendant={
                  atMenu.active !== undefined
                    ? `${atMenu.listId}-${atMenu.active.id}`
                    : slash.active === undefined
                      ? undefined
                      : `${slash.listId}-${slash.active.id}`
                }
                autoFocus
                className="composer-input"
                disabled={props.creating}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  slash.sync(event.target.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.target.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => {
                  slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onSelect={(event) => {
                  slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                  atMenu.sync(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onKeyDown={handleKeyDown}
                placeholder={presentation.composerPlaceholder}
                ref={textareaRef}
                rows={3}
                value={prompt}
              />
            }
            row={{
              leading: <>{folderControl}</>,
              trailing: (
                <>
                  <ComposerModelPicker
                    ariaLabel="Provider and model"
                    disabled={props.creating === true}
                    menuSide="bottom"
                    groups={props.providerGroups}
                    modelOptionValues={modelOptionValues}
                    onModelOptionChange={(id, value) => {
                      const rest = Object.fromEntries(
                        Object.entries(modelOptionValues).filter(([key]) => key !== id),
                      );
                      setModelChoice({
                        key: modelKey,
                        values: value === undefined ? rest : { ...rest, [id]: value },
                      });
                    }}
                    onSelect={props.onSelectProvider}
                    {...(props.onOpenSettings === undefined
                      ? {}
                      : { onOpenSettings: props.onOpenSettings })}
                    {...(props.selectedModelId === undefined
                      ? {}
                      : { selectedModelId: props.selectedModelId })}
                    {...(props.selectedProviderInstanceId === undefined
                      ? {}
                      : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
                  />
                  <ComposerVoiceButton
                    disabled={props.creating}
                    onTranscript={(transcript) =>
                      setPrompt((current) => appendTranscript(current, transcript))
                    }
                  />
                </>
              ),
              actions: {
                kind: "send",
                send: { ariaLabel: "Create thread", disabled: !canSubmit, onSend: submit },
              },
            }}
          />
          {props.errorMessage === undefined ? null : (
            <OctantAlert className="draft-thread__error" tone="danger">
              {props.errorMessage}
            </OctantAlert>
          )}
          <p className="draft-thread__hint">
            Press Enter to start · Shift+Enter for a new line · Escape to close
          </p>
        </div>

        {homeStartNode}

        {home && (props.recentThreads?.length ?? 0) === 0 ? (
          <div className="draft-thread__intent-cards" role="group" aria-label="Suggested actions">
            {presentation.intentCards.map((card) => (
              <OctantButton
                className="draft-thread__intent-card"
                key={card.id}
                onClick={() => applyIntentCard(card)}
                type="button"
                variant="ghost"
              >
                <span className="draft-thread__intent-label">{card.label}</span>
                <span className="draft-thread__intent-description">{card.description}</span>
              </OctantButton>
            ))}
          </div>
        ) : null}

        {home ? <RecentThreadList threads={props.recentThreads ?? []} /> : null}
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
  readonly onSelectGithub: (issue: GithubIssueContextRequest, title: string) => void;
  readonly onSelectLinear: (
    issue: LinearIssueContextRequest & { readonly identifier: string },
    title: string,
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
      {props.mode !== "chat" && props.projectName !== undefined ? (
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
    </div>
  );
}
