import { ThreadActivityEnvironment } from "../threadActivity/ThreadActivityEnvironment";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type {
  AutomationClient,
  LocalServerClient,
  UsageDashboardClient,
  UsageQueryFilter,
} from "@octant/client-runtime";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutIdentity,
  CodeCommand,
  CodeCommandResult,
  CodeDeliveryOutcomeKind,
  CodeOperationId,
  CodeProjectPullRequestRow,
  CodeWorktreeRef,
  LocalServerOpenTarget,
  ProjectSummary,
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummaries,
  WorkspaceTab,
} from "@octant/contracts";
import type { OpenInApplicationId } from "@octant/contracts/shell";
import { deriveCodeEnvironmentProjection } from "@octant/domain/shell-policy";
import { decideThreadMove, folderContains } from "@octant/domain/thread-project-move-policy";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  MoreHorizontal,
  Paperclip,
  Plus,
  Server,
  Target,
} from "../ui/icons";
import { CodeAttachmentGallery, type CodeAttachmentReader } from "../code/CodeAttachmentGallery";
import type { CodeAttachmentReference } from "@octant/contracts";
import { CodeCheckoutProvider } from "./CodeCheckoutContext";
import { EnvironmentGitGroup } from "./EnvironmentGitGroup";
import {
  EnvironmentCard,
  EnvironmentGroup,
  EnvironmentRow,
  EnvironmentTile,
} from "./EnvironmentGroup";
import { EnvironmentRunningReport } from "./environmentSections";
import { EnvironmentExtraFolders } from "./EnvironmentExtraFolders";
import { EnvironmentPullRequests } from "./EnvironmentPullRequests";
import {
  EnvironmentThreadPullRequests,
  threadPullRequestCount,
} from "./EnvironmentThreadPullRequests";
import { countGroupedLocalServerListenersByScope } from "./localServerGroups";
import { LocalServersGroup } from "./LocalServersGroup";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import {
  ThreadMoveComputerCard,
  type ThreadMoveEnvironment,
} from "./threadMove/ThreadMoveComputerCard";
import { useCodeEnvironmentController } from "./useCodeEnvironmentController";
import { useLocalServersController } from "./useLocalServersController";
import { ChangeWorkingFolder, workingFolderLabel } from "./WorkingDirectoryControl";
import { OpenInMenu } from "./OpenInMenu";
import type { OctantHostBridge } from "../shell/hostBridge";
import { EnvironmentGoal } from "./EnvironmentGoal";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { EnvironmentRoutines } from "./EnvironmentRoutines";
import { ThreadUsagePanel } from "../usage/ThreadUsagePanel";
import { OctantMenu } from "../ui/base/OctantMenu";
import { SwitchBranchDialog } from "./SwitchBranchDialog";
import type { CodeBranchPreviewOutcome, SwitchCodeBranchOutcome } from "../code/switchCodeBranch";
import { CODE_DELIVERY_OUTCOME_OPTIONS } from "../code/composer/CodeDeliveryOutcomeSelector";

type CodeThreadWorkspaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;

export interface CodeThreadEnvironmentProps {
  /** Where the thread runs and how it moves to another computer; absent, no Computer card. */
  readonly threadMove?: ThreadMoveEnvironment;
  readonly tab: CodeThreadWorkspaceTab;
  readonly active?: boolean;
  /** Defers filesystem and Git observation until the primary transcript is ready. */
  readonly observe?: boolean;
  /**
   * Whether the host has reconnected this thread's checkout. The host starts
   * every checkout Waiting after a launch and refuses to observe one until it
   * is back, so a read sent earlier fails and is never repeated.
   */
  readonly checkoutAvailability?: CodeCheckoutIdentity["availability"] | undefined;
  /**
   * The checkout's recorded kind. A remote root or a plain folder has no local
   * branch to move HEAD to, so Switch branch stays off the row's menu; absent,
   * the host is still the one that would refuse.
   */
  readonly checkoutKind?: CodeCheckoutIdentity["kind"] | undefined;
  readonly project?: ProjectSummary | undefined;
  /**
   * Every Project the window knows, for the Project row's move affordance:
   * the row opens the shared Move dialog only while another same-folder Code
   * Project could take this thread.
   */
  readonly projects?: ReadonlyArray<ProjectSummary> | undefined;
  readonly projectClient?: ProjectClient | undefined;
  /**
   * The thread's most recent turn to have settled. The checkout is read again
   * each time this changes, so what the header and the bar under the composer
   * report includes that turn's edits.
   */
  readonly latestSettledTurn?: CodeOperationId | undefined;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly children: ReactNode;
  /** Opens Review beside this thread. Absent hides the control. */
  readonly onOpenChanges?: () => void;
  /**
   * Starts a fresh thread in this Project. Offered only when the checkout is
   * unusable: a thread created against an older binding revision can never
   * observe its own checkout again, so a new thread is the way forward.
   */
  readonly onNewThreadInProject?: (projectId: ProjectSummary["id"]) => void;
  /**
   * Opens a fresh task draft in this Project with its branch choice shown —
   * the normal "Where > Start from" flow, not worktree setup. Absent hides
   * the menu entry.
   */
  readonly onNewTaskOnBranch?: () => void;
  /**
   * The working-tree reading the switch dialog shows before a stash consent:
   * its state token is the one the switch sends, so consent is always to what
   * was last observed. Absent hides "Switch branch…".
   */
  readonly onObserveBranchState?: () => Promise<CodeBranchPreviewOutcome>;
  /**
   * Sends the person's approved branch switch for this thread's checkout
   * against the preview's own state token. Absent hides "Switch branch…".
   */
  readonly onSwitchBranch?: (request: {
    readonly branch: string;
    readonly dirty: "refuse" | "stash";
    readonly expectedStateToken: string;
  }) => Promise<SwitchCodeBranchOutcome>;
  /** Opens the existing Move to Project dialog for this thread. */
  readonly onMoveToProject?: () => void;
  /**
   * True while a turn occupies the thread: branch switching waits for idle
   * (the host also refuses mid-turn) and the busy move choice is offered.
   */
  readonly threadBusy?: boolean;
  readonly onExecute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  /**
   * Creates a new host-owned Browser tab for exactly one local origin.
   * Absent means the shell has nowhere to put the tab, so the Open control is
   * hidden entirely rather than rendered dead.
   */
  readonly onOpenLocalServer?: (target: LocalServerOpenTarget) => void | Promise<void>;
  /** Writes a local URL to the host clipboard. Absent hides the Copy control. */
  readonly onCopyLocalServerUrl?: (url: string) => void | Promise<void>;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly localServerClient?: LocalServerClient;
  /**
   * The journaled pull-request inventory: one manually refreshed snapshot per
   * Project, so the Environment group never sends a GitHub read of its own.
   */
  readonly pullRequestClient?: Pick<
    CodeClient,
    "queryProjectPullRequests" | "refreshProjectPullRequests"
  >;
  /** Routes to the complete Pull requests overview across Projects. */
  readonly onOpenPullRequests?: () => void;
  /** Opens a pull request's Review surface; absent leaves rows inert. */
  readonly onSelectPullRequest?: (row: CodeProjectPullRequestRow) => void;
  /**
   * This thread's own pull requests, from the host's cached snapshot. Absent
   * when it has none; the renderer never reads GitHub to fill it.
   */
  readonly threadPullRequests?: ThreadBoardPullRequestSummaries;
  /** Opens one of this thread's pull requests in the app. Absent leaves its rows inert. */
  readonly onOpenThreadPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  /** Opens one of this thread's pull requests on GitHub. Absent hides that menu entry. */
  readonly onOpenThreadPullRequestOnGithub?: (identity: ThreadBoardPullRequestIdentity) => void;
  readonly hostBridge?: OctantHostBridge;
  readonly openInApplications?: ReadonlyArray<OpenInApplicationId>;
  readonly agentRunClient?: AgentRunClient;
  /** Reads the thread's goal; absent leaves the Goal row out. */
  readonly goalClient?: GoalClient;
  /**
   * What this thread has to produce before it may be called Done. Absent when
   * the caller has no thread record to read it from.
   */
  readonly deliveryOutcome?: CodeDeliveryOutcomeKind;
  /** Opens the Agents tool; with a run id, on that subagent. */
  readonly onOpenAgents?: (runId?: string) => void;
  readonly automationClient?: AutomationClient;
  /** Opens the Automation Center on this routine. */
  readonly onOpenRoutine?: (automationId: string) => void;
  readonly environmentOpen?: boolean;
  readonly onOpenGit?: () => void;
  /** Opens worktree setup for this thread's checkout. */
  readonly onOpenWorktrees?: () => void;
  readonly onCreatePullRequest?: () => void;
  readonly sources?: ReadonlyArray<CodeAttachmentReference>;
  readonly sourceClient?: CodeAttachmentReader;
  readonly usageDashboardClient?: UsageDashboardClient;
  readonly spendCeilingClient?: import("@octant/client-runtime").SpendCeilingClient;
  /** Whether the Usage group shows its spend ceiling row when no ceiling is set. */
  readonly spendCeilingShown?: boolean;
  readonly onOpenUsageDashboard?: (filter: UsageQueryFilter) => void;
}

/**
 * Compact Code Environment: a truthful header summary and a transient
 * disclosure for checkout facts, local servers, and the working folder.
 */
export function CodeThreadEnvironment(props: CodeThreadEnvironmentProps) {
  const environmentOpen = props.environmentOpen === true;
  const controller = useCodeEnvironmentController({
    ...(props.projectClient === undefined ? {} : { client: props.projectClient }),
    enabled:
      props.project !== undefined &&
      props.observe !== false &&
      props.checkoutAvailability !== "waiting",
    project: props.project,
    threadId: props.tab.threadId,
    latestSettledTurn: props.latestSettledTurn,
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const projectName = props.project?.name ?? "Code";
  const pullRequestClient = props.pullRequestClient;
  const projection = deriveCodeEnvironmentProjection({
    observation: controller.observation,
    projectName,
    controllerStatus: controller.status,
  });
  const localServersSection = projection.sections.find((section) => section.id === "local-servers");
  const project = props.project;
  const onNewThreadInProject = props.onNewThreadInProject;
  const checkoutUnusable =
    controller.status === "error" ||
    controller.observation?.status === "unavailable" ||
    controller.observation?.status === "failed";
  const freshThreadAction =
    !checkoutUnusable || project === undefined || onNewThreadInProject === undefined
      ? undefined
      : { label: "New task in this Project", onClick: () => onNewThreadInProject(project.id) };
  const observed = controller.observation;
  const readyObservation = observed?.status === "ready" ? observed : undefined;
  // The section holds the working tree's state and the branch, not how far the
  // branch is ahead of its remote or whether a pull request exists, so it
  // cannot rule out a push on a named branch. It hides the rows only where
  // they could do nothing: an unreadable checkout (the status row says why)
  // and a detached HEAD with a clean tree.
  const offersCommitOrPush =
    props.onOpenGit !== undefined &&
    readyObservation !== undefined &&
    (readyObservation.changes === "dirty" || readyObservation.branch.kind === "named");
  const offersPullRequest =
    props.onCreatePullRequest !== undefined &&
    readyObservation !== undefined &&
    readyObservation.branch.kind === "named";
  const [switchBranchOpen, setSwitchBranchOpen] = useState(false);
  const onExecute = props.onExecute;
  const fetchLocalRefs = useCallback(async (): Promise<ReadonlyArray<CodeWorktreeRef>> => {
    if (onExecute === undefined || project === undefined) return [];
    const result = await onExecute({ kind: "list-code-worktree-refs", projectId: project.id });
    return result !== undefined && result.kind === "worktree-refs-listed" ? result.refs : [];
  }, [onExecute, project]);
  const onSwitchBranch = props.onSwitchBranch;
  const switchBranchRequest = useCallback(
    async (request: {
      readonly branch: string;
      readonly dirty: "refuse" | "stash";
      readonly expectedStateToken: string;
    }) => {
      if (onSwitchBranch === undefined) {
        return { status: "refused" as const, message: "Branch switching is unavailable." };
      }
      const outcome = await onSwitchBranch(request);
      // A completed switch moved the head this panel reports; the host already
      // journaled it and this read only follows what was recorded.
      if (outcome.status === "ok") void controller.refresh();
      return outcome;
    },
    [onSwitchBranch, controller],
  );
  const onObserveBranchState = props.onObserveBranchState;
  const fetchBranchPreview = useCallback(async (): Promise<CodeBranchPreviewOutcome> => {
    if (onObserveBranchState === undefined) {
      return { status: "refused", message: "The checkout could not be read." };
    }
    return onObserveBranchState();
  }, [onObserveBranchState]);
  // Only a local checkout has a HEAD the switch can move: a remote root and a
  // plain folder are reported as themselves, and "New task in this Project" is
  // the way out of a checkout that cannot be read at all.
  const localCheckout =
    props.checkoutKind !== "remote-root" && props.checkoutKind !== "plain-folder";
  const switchBranchOffered =
    project !== undefined &&
    props.onSwitchBranch !== undefined &&
    props.onObserveBranchState !== undefined &&
    readyObservation !== undefined &&
    localCheckout;
  // The branch row's own menu: everything that moves this checkout's work or
  // starts work beside it lives on the row that names the branch.
  const branchMenu: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly icon: ReactNode;
    readonly disabled?: boolean;
    readonly description?: string;
    readonly run: () => void;
  }> = [
    ...(switchBranchOffered
      ? [
          {
            value: "switch-branch",
            label: "Switch branch…",
            icon: <GitFork aria-hidden="true" size={16} />,
            // A switch while a turn runs would move the ground under the
            // provider; the host refuses too, and the greyed row says why.
            ...(props.threadBusy === true
              ? { disabled: true, description: "Available when the current turn finishes." }
              : {}),
            run: () => setSwitchBranchOpen(true),
          },
        ]
      : []),
    ...(project === undefined || props.onNewTaskOnBranch === undefined || checkoutUnusable
      ? []
      : [
          {
            value: "new-task-branch",
            label: "New task on another branch…",
            icon: <Plus aria-hidden="true" size={16} />,
            run: props.onNewTaskOnBranch,
          },
        ]),
    ...(props.onOpenWorktrees === undefined || !localCheckout
      ? []
      : [
          {
            value: "worktrees",
            label: "Worktrees",
            icon: <GitFork aria-hidden="true" size={16} />,
            run: props.onOpenWorktrees,
          },
        ]),
  ];
  // The Project row is itself the move control — but only while the shared
  // dialog could actually take the thread: another active Code Project bound
  // to the same repository folder. Otherwise the row stays a fact.
  const currentFolder = project?.type === "code" ? project.binding.canonicalRoot : undefined;
  const moveToProjectAvailable =
    project !== undefined &&
    props.onMoveToProject !== undefined &&
    currentFolder !== undefined &&
    (props.projects ?? []).some((candidate) => {
      if (
        candidate.type !== "code" ||
        candidate.lifecycle !== "active" ||
        String(candidate.id) === String(project.id)
      ) {
        return false;
      }
      const folder = candidate.binding.canonicalRoot;
      const decision = decideThreadMove({
        thread: { lifecycle: "active", executing: false, awaitingInput: false },
        source: { id: String(project.id), mode: "code", folder: currentFolder },
        destination: {
          id: String(candidate.id),
          mode: "code",
          lifecycle: candidate.lifecycle,
          folder,
        },
      });
      return decision.status === "allowed" && folderContains(currentFolder, folder);
    });
  // A checkout that cannot be read already shows "New task in this Project" as
  // its way out, so the menu offers it for every other state.
  const changesMenu: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly icon: ReactNode;
    readonly run: () => void;
  }> =
    project === undefined || onNewThreadInProject === undefined || checkoutUnusable
      ? []
      : [
          {
            value: "new-task",
            label: "New task in this Project",
            icon: <Plus aria-hidden="true" size={16} />,
            run: () => onNewThreadInProject(project.id),
          },
        ];
  const localServersAvailable = localServersSection?.available === true;
  const localServers = useLocalServersController({
    enabled: localServersAvailable,
    poll: localServersAvailable && environmentOpen,
    ...(props.localServerClient === undefined ? {} : { client: props.localServerClient }),
    threadId: props.tab.threadId,
    ...(props.project === undefined ? {} : { projectId: props.project.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const runningServerCounts =
    localServers.snapshot === undefined
      ? undefined
      : countGroupedLocalServerListenersByScope(localServers.snapshot);
  // A server elsewhere on the computer keeps the row, so it stays reachable;
  // before the first read there is nothing to say yet. A failed read keeps it
  // too, open, because the error and its way to try again live in the row.
  const serversFailed = localServersAvailable && localServers.status === "error";
  const serversShown =
    serversFailed ||
    (localServersAvailable &&
      runningServerCounts !== undefined &&
      runningServerCounts.currentCheckout + runningServerCounts.other > 0);
  // Open by default only when this checkout is serving something; a list of
  // servers elsewhere on the computer is a count until asked for.
  const [serversOpen, setServersOpen] = useState<boolean>();
  const workingDirectory = readyObservation?.workingDirectory;
  const threadVersion = readyObservation?.threadVersion;
  // Applying a working folder re-reads the checkout without the old facts, so
  // the field, its group, and the button that held focus are all unmounted
  // before the new reading lands. The Working folder row is what comes back,
  // and takes the keyboard.
  const workingFolderRow = useRef<HTMLButtonElement>(null);
  const returnToWorkingFolder = useRef(false);
  const failure = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!returnToWorkingFolder.current) return;
    if (controller.status === "error") {
      // The re-read failed, so the row never comes back: the failure that
      // replaced it is what the keyboard needs next.
      returnToWorkingFolder.current = false;
      failure.current?.focus();
      return;
    }
    if (workingDirectory === undefined) return;
    returnToWorkingFolder.current = false;
    workingFolderRow.current?.focus();
  }, [controller.status, workingDirectory]);

  return (
    <div className="code-thread-environment">
      <OpenInMenu
        {...(props.active === undefined ? {} : { active: props.active })}
        applications={props.openInApplications ?? []}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        threadId={String(props.tab.threadId)}
      />
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        {...(props.threadMove === undefined
          ? {}
          : {
              computer: (
                <ThreadMoveComputerCard
                  {...props.threadMove}
                  thread={{ mode: "code", threadId: String(props.tab.threadId) }}
                  threadTitle={props.tab.title}
                />
              ),
            })}
        {...(moveToProjectAvailable && props.onMoveToProject !== undefined
          ? { projectAction: props.onMoveToProject }
          : {})}
        {...(branchMenu.length === 0 || readyObservation === undefined
          ? {}
          : {
              branchRow: (
                <OctantMenu
                  items={branchMenu.map(({ value, label, icon, disabled, description }) => ({
                    value,
                    label,
                    icon,
                    ...(disabled === true ? { disabled } : {}),
                    ...(description === undefined ? {} : { description }),
                  }))}
                  onValueChange={(value) =>
                    branchMenu.find((entry) => entry.value === value)?.run()
                  }
                  selectionMode="action"
                  trigger={
                    <>
                      <EnvironmentTile icon={GitBranch} />
                      <span className="environment-row__title">
                        {readyObservation.branch.kind === "named"
                          ? readyObservation.branch.name
                          : `Detached ${readyObservation.branch.oid.slice(0, 7)}`}
                      </span>
                      {readyObservation.workingFolder?.kind === "extra" ? (
                        <span className="environment-row__detail">Shared folder</span>
                      ) : (
                        <span className="environment-row__detail">
                          {readyObservation.worktreeRoot === readyObservation.repositoryRoot
                            ? "Main folder"
                            : "Worktree"}
                        </span>
                      )}
                      <ChevronRight
                        aria-hidden="true"
                        className="environment-row__trailing"
                        size={14}
                      />
                    </>
                  }
                  triggerClassName="environment-row environment-link"
                  triggerLabel={
                    readyObservation.branch.kind === "named"
                      ? `Branch ${readyObservation.branch.name}`
                      : "Detached head"
                  }
                  value=""
                />
              ),
            })}
        open={environmentOpen}
        headerContent={
          <EnvironmentCard
            caption="Changes"
            className="environment-checkout"
            foldId="changes"
            summary={changesSummary(
              controller.status,
              controller.observation,
              threadPullRequestCount(props.threadPullRequests),
            )}
            {...(changesMenu.length === 0
              ? {}
              : {
                  titleAction: (
                    <OctantMenu
                      items={changesMenu.map(({ value, label, icon }) => ({ value, label, icon }))}
                      onValueChange={(value) =>
                        changesMenu.find((entry) => entry.value === value)?.run()
                      }
                      selectionMode="action"
                      trigger={<MoreHorizontal aria-hidden="true" size={16} />}
                      triggerClassName="environment-menu-trigger"
                      triggerLabel="More for changes"
                      value=""
                    />
                  ),
                })}
          >
            <EnvironmentGitGroup
              {...(freshThreadAction === undefined ? {} : { action: freshThreadAction })}
              {...(controller.errorMessage === undefined
                ? {}
                : { errorMessage: controller.errorMessage })}
              {...(controller.observation === undefined
                ? {}
                : { observation: controller.observation })}
              {...(props.onOpenChanges === undefined ? {} : { onOpenChanges: props.onOpenChanges })}
              failureRef={failure}
              status={controller.status}
            />
            {/* The connected repository is a credential-free owner/name the
                host already sanitized; it routes to this Project's pull
                requests, never to a remote URL the renderer would compose. */}
            {project?.type === "code" &&
            project.connectedRepository !== undefined &&
            props.onOpenPullRequests !== undefined ? (
              <EnvironmentRow
                icon={GitPullRequest}
                label={`${project.connectedRepository.owner}/${project.connectedRepository.repository}`}
                onClick={props.onOpenPullRequests}
              />
            ) : null}
            {offersCommitOrPush ? (
              <EnvironmentRow
                icon={GitCommitHorizontal}
                label="Commit or push"
                onClick={props.onOpenGit}
              />
            ) : null}
            {offersPullRequest ? (
              <EnvironmentRow
                icon={GitPullRequest}
                label="Create pull request"
                onClick={props.onCreatePullRequest}
              />
            ) : null}
            {/* Last in the card: the thread's pull requests arrive with the
                host's snapshot, and a row that appears there pushes nothing the
                pointer may be on. */}
            <EnvironmentThreadPullRequests
              onOpen={props.onOpenThreadPullRequest}
              onOpenOnGithub={props.onOpenThreadPullRequestOnGithub}
              summaries={props.threadPullRequests}
            />
          </EnvironmentCard>
        }
        mode="code"
        projectName={props.project?.name}
        summary={{
          identity: projection.identity,
          ...(readyObservation === undefined
            ? {}
            : {
                branch:
                  readyObservation.branch.kind === "named"
                    ? readyObservation.branch.name
                    : `Detached ${readyObservation.branch.oid.slice(0, 7)}`,
                changes: readyObservation.changes,
                // The folder the thread works in: a separate worktree's own
                // path, not the repository it was cut from.
                path: readyObservation.worktreeRoot,
                checkout:
                  readyObservation.workingFolder?.kind === "extra"
                    ? "Shared folder"
                    : readyObservation.worktreeRoot === readyObservation.repositoryRoot
                      ? "Main folder"
                      : "Worktree",
              }),
          ...(workingDirectory === undefined ? {} : { workingLocation: String(workingDirectory) }),
          ...(runningServerCounts === undefined ? {} : { runningServerCounts }),
        }}
      >
        {/* Two captioned cards, one row grammar: what is live on this checkout
            first, then what the thread delivers and what it has cost. */}
        <div className="environment-list">
          <EnvironmentCard caption="Running" foldId="running">
            {/* Servers serving this checkout count as running; the section's
                folded line adds the subagents and a live computer-use session. */}
            <EnvironmentRunningReport
              count={
                !localServersAvailable
                  ? 0
                  : runningServerCounts === undefined
                    ? undefined
                    : runningServerCounts.currentCheckout
              }
            />
            {props.agentRunClient === undefined ? null : (
              <EnvironmentSubagents
                client={props.agentRunClient}
                {...(props.onOpenAgents === undefined ? {} : { onOpenAgents: props.onOpenAgents })}
                threadId={String(props.tab.threadId)}
              />
            )}
            {props.automationClient === undefined || props.project === undefined ? null : (
              <EnvironmentRoutines
                client={props.automationClient}
                mode="code"
                {...(props.onOpenRoutine === undefined
                  ? {}
                  : { onOpenRoutine: props.onOpenRoutine })}
                projectId={String(props.project.id)}
                threadId={String(props.tab.threadId)}
              />
            )}
            <ThreadActivityEnvironment />
            {/* Last in its section: a server that starts while the strip is open
                adds a row at the end, never above one the pointer may be on. It
                is absent when nothing runs on this computer, which the
                section's summary says. */}
            {serversShown ? (
              <EnvironmentGroup
                icon={Server}
                onOpenChange={setServersOpen}
                open={
                  serversOpen ?? (serversFailed || (runningServerCounts?.currentCheckout ?? 0) > 0)
                }
                {...(localServers.snapshot === undefined
                  ? {}
                  : {
                      summary: serverSummary(runningServerCounts),
                    })}
                title="Local servers"
              >
                <LocalServersGroup
                  controller={localServers}
                  {...(props.onOpenLocalServer === undefined
                    ? {}
                    : { onOpenTarget: props.onOpenLocalServer })}
                  {...(props.onCopyLocalServerUrl === undefined
                    ? {}
                    : { onCopyUrl: props.onCopyLocalServerUrl })}
                />
              </EnvironmentGroup>
            ) : null}
          </EnvironmentCard>
          <EnvironmentCard caption="Delivery" foldId="delivery">
            {pullRequestClient === undefined || props.project === undefined ? null : (
              <EnvironmentPullRequests
                enabled={environmentOpen}
                load={(query) => pullRequestClient.queryProjectPullRequests(query)}
                projectId={props.project.id}
                refresh={(command) => pullRequestClient.refreshProjectPullRequests(command)}
                {...(props.onOpenPullRequests === undefined
                  ? {}
                  : { onOpenAll: props.onOpenPullRequests })}
                {...(props.onSelectPullRequest === undefined
                  ? {}
                  : { onSelectRow: props.onSelectPullRequest })}
                threadId={String(props.tab.threadId)}
              />
            )}
            {props.goalClient === undefined ? null : (
              <EnvironmentGoal
                client={props.goalClient}
                refreshKey={
                  props.latestSettledTurn === undefined
                    ? undefined
                    : String(props.latestSettledTurn)
                }
                threadId={String(props.tab.threadId)}
              />
            )}
            {(props.sources?.length ?? 0) === 0 ? null : (
              <EnvironmentGroup
                icon={Paperclip}
                title="Sources"
                summary={String(props.sources?.length ?? 0)}
                defaultOpen
              >
                <CodeAttachmentGallery
                  attachments={props.sources ?? []}
                  threadId={props.tab.threadId}
                  {...(props.sourceClient === undefined ? {} : { client: props.sourceClient })}
                />
              </EnvironmentGroup>
            )}
            {props.deliveryOutcome === undefined ||
            threadVersion === undefined ||
            props.onExecute === undefined ? null : (
              /* One row, "Delivers" and the current outcome, that opens the same
                 four choices as a menu: a whole group had stood here for one
                 decision. The outcome is the reader's to confirm, and the host
                 has accepted a confirmation all along; picking one sends it
                 (maintainer request 2026-11-17: quieter Environment panel). */
              <OctantMenu
                items={CODE_DELIVERY_OUTCOME_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.label,
                  description: option.detail,
                  icon: <option.icon aria-hidden="true" size={14} />,
                }))}
                onValueChange={(value) => {
                  const outcomeKind = CODE_DELIVERY_OUTCOME_OPTIONS.find(
                    (option) => option.id === value,
                  )?.id;
                  if (outcomeKind === undefined) return;
                  void props.onExecute?.({
                    kind: "confirm-code-delivery-outcome",
                    threadId: props.tab.threadId,
                    expectedVersion: threadVersion,
                    outcomeKind,
                  });
                }}
                trigger={
                  <>
                    <EnvironmentTile icon={Target} />
                    <span className="environment-row__title">Delivers</span>
                    <span className="environment-row__detail">
                      {deliveryOutcomeLabel(props.deliveryOutcome)}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="environment-row__trailing"
                      size={14}
                    />
                  </>
                }
                triggerClassName="environment-row environment-link"
                triggerLabel={`Delivers, ${deliveryOutcomeLabel(props.deliveryOutcome)}`}
                value={props.deliveryOutcome}
              />
            )}
            {workingDirectory === undefined ||
            threadVersion === undefined ||
            props.onExecute === undefined ? null : (
              <EnvironmentGroup
                headerRef={workingFolderRow}
                icon={FolderOpen}
                summary={
                  readyObservation?.workingFolderUnavailable === true
                    ? "Working folder unavailable"
                    : `${readyObservation?.workingFolder?.label ?? workingFolderLabel(workingDirectory)}${String(workingDirectory) === "." || readyObservation?.workingFolder === undefined ? "" : ` / ${workingDirectory}`}`
                }
                title="Working folder"
                {...(readyObservation?.workingFolder?.kind === "extra"
                  ? {
                      // The caveat that used to open the body; the body is now one
                      // line, so the tooltip keeps what it said (maintainer
                      // request 2026-11-17).
                      hint: "Shared folder, outside this task's worktree. Git, changed files, Review and pull requests cover the Code checkout only.",
                    }
                  : {})}
              >
                {readyObservation?.workingFolderUnavailable === true ? (
                  <p>
                    The recorded working folder is unavailable. Restore its original binding or
                    start a new task in a current approved folder; output is never redirected.
                  </p>
                ) : readyObservation?.workingFolder === undefined ? (
                  <ChangeWorkingFolder
                    row={workingFolderRow}
                    value={workingDirectory}
                    onApply={async (nextWorkingDirectory) => {
                      const result = await props.onExecute?.({
                        kind: "change-code-thread-working-directory",
                        threadId: props.tab.threadId,
                        expectedVersion: threadVersion,
                        workingDirectory: nextWorkingDirectory,
                      });
                      if (
                        result === undefined ||
                        !("kind" in result) ||
                        result.kind !== "thread-updated"
                      ) {
                        throw new Error("Code working directory was not updated.");
                      }
                      returnToWorkingFolder.current = true;
                      await controller.refresh();
                    }}
                  />
                ) : (
                  <p>Fixed for this task. Start a new task to change it.</p>
                )}
              </EnvironmentGroup>
            )}
            <EnvironmentExtraFolders
              folders={props.project?.type === "code" ? props.project.extraFolders : undefined}
            />
            {props.usageDashboardClient === undefined &&
            props.spendCeilingClient === undefined ? null : (
              <ThreadUsagePanel
                client={props.usageDashboardClient}
                subjectType="code-thread"
                subjectId={String(props.tab.threadId)}
                {...(props.project === undefined ? {} : { projectId: String(props.project.id) })}
                {...(props.spendCeilingClient === undefined
                  ? {}
                  : { spendCeilingClient: props.spendCeilingClient })}
                {...(props.spendCeilingShown === true ? { spendCeilingShown: true } : {})}
                {...(props.onOpenUsageDashboard === undefined
                  ? {}
                  : { onOpenUsageDashboard: props.onOpenUsageDashboard })}
              />
            )}
          </EnvironmentCard>
        </div>
      </ThreadEnvironmentPanel>
      <div className="code-thread-environment__content">
        <CodeCheckoutProvider
          {...(readyObservation === undefined ? {} : { observation: readyObservation })}
        >
          {props.children}
        </CodeCheckoutProvider>
      </div>
      {switchBranchOpen && readyObservation !== undefined && project !== undefined ? (
        <SwitchBranchDialog
          currentBranch={
            readyObservation.branch.kind === "named"
              ? readyObservation.branch.name
              : `Detached ${readyObservation.branch.oid.slice(0, 7)}`
          }
          fetchPreview={fetchBranchPreview}
          fetchRefs={fetchLocalRefs}
          {...(props.onOpenGit === undefined ? {} : { onOpenGit: props.onOpenGit })}
          onClose={() => setSwitchBranchOpen(false)}
          onSwitch={switchBranchRequest}
        />
      ) : null}
    </div>
  );
}

/** The product name for an outcome, for a header that states it without opening. */
function deliveryOutcomeLabel(outcome: CodeDeliveryOutcomeKind): string {
  return (
    CODE_DELIVERY_OUTCOME_OPTIONS.find((option) => option.id === outcome)?.label ?? String(outcome)
  );
}

/**
 * What the Changes section says when folded: the counts its head already
 * shows, "Clean", or a word for a repository that cannot be read. Nothing
 * while the first read is out.
 */
function changesSummary(
  status: ReturnType<typeof useCodeEnvironmentController>["status"],
  observation: ReturnType<typeof useCodeEnvironmentController>["observation"],
  pullRequests: number,
): string | undefined {
  const changes = changesFigure(status, observation);
  if (changes === undefined || pullRequests === 0) return changes;
  return `${changes} \u00b7 ${String(pullRequests)} ${pullRequests === 1 ? "PR" : "PRs"}`;
}

function changesFigure(
  status: ReturnType<typeof useCodeEnvironmentController>["status"],
  observation: ReturnType<typeof useCodeEnvironmentController>["observation"],
): string | undefined {
  if (status === "error") return "Unavailable";
  if (observation === undefined) return undefined;
  if (observation.status !== "ready") return "Unavailable";
  if (observation.changes === "clean") return "Clean";
  if (observation.insertions === undefined || observation.deletions === undefined) {
    return "Uncommitted";
  }
  return `+${observation.insertions.toLocaleString("en")} \u2212${observation.deletions.toLocaleString("en")}`;
}

function serverSummary(
  counts: { readonly currentCheckout: number; readonly other: number } | undefined,
): string {
  if (counts === undefined) return "";
  if (counts.currentCheckout === 0 && counts.other === 0) return "None";
  if (counts.other === 0) return `${String(counts.currentCheckout)} here`;
  return `${String(counts.currentCheckout)} here · ${String(counts.other)} elsewhere`;
}
