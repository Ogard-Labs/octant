import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import type { CodeCheckoutIdentity, CodeThread } from "@octant/contracts/code";
import { decodeHostAnswer, type RunningService } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { HostResourceSnapshot } from "@octant/contracts/host-resources";
import type { OctantMode } from "@octant/contracts/modes";
import type { PaneId } from "@octant/contracts/shell";
import { localHostDisplayName, type createLocalServerClient } from "@octant/client-runtime";
import { useMemo } from "react";
import { useRetainedRecord } from "../polling/useRetainedRecord";
import type { useContinueCards } from "../code/useContinueCards";
import { createCiFailuresCard } from "../home/CiFailuresCard";
import { currentCodeProjectBranches } from "../home/ciFailures";
import { createComputersCard } from "../home/ComputersCard";
import { computerConnection, sameHostOrigin } from "../home/computers";
import { createNeedsYouCard } from "../home/NeedsYouCard";
import { isChildPendingRequest } from "../pendingRequests/pendingRequests";
import {
  pullRequestCardAvailable,
  sharePullRequestRead,
  type PullRequestCardCapability,
  type PullRequestCardRow,
} from "../home/pullRequests";
import { createPullRequestsCard } from "../home/PullRequestsCard";
import { RunningTab } from "../home/RunningTab";
import type { RemoteOpenMode, RemoteOpenOutcome } from "../home/runningServices";
import { createRunningServicesCard } from "../home/RunningServicesCard";
import { stopRunningRow } from "../home/stopRunningRow";
import { createWorkingNowCard, type WorkingNowCardSource } from "../home/WorkingNowCard";
import type { WorkingNowThread } from "../home/workingNow";
import type { useHostFederationLifecycle } from "../host/useHostFederationLifecycle";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { FIRST_PARTY_PLUGINS_EFFECTIVE } from "../shell/contributionRegistry";
import type { DraftThreadWorkspaceProps } from "../shell/DraftThreadWorkspace";
import { reviewWaitingCount, runningThreadCount } from "../shell/runningNow";
import type { useShellController } from "../shell/useShellController";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";
import type { ShellNavigationModel } from "./shellNavigationModel";

type ShellController = ReturnType<typeof useShellController>;
type HostFederation = NonNullable<ReturnType<typeof useHostFederationLifecycle>>;
type LaunchedShellClients = ReturnType<typeof createLaunchedShellClients>;

export interface HomeStartInput {
  readonly actions: Pick<
    ShellActions,
    | "closeWorkspaceReaders"
    | "openDraftThread"
    | "openHomeTerminal"
    | "openInbox"
    | "openReview"
    | "openRunningService"
    | "openSidebarList"
    | "openSubagentRequest"
    | "openThreadBoard"
    | "resetNewTaskDraft"
    | "selectChatThread"
    | "selectCodeThread"
    | "selectProjectPullRequestIdentity"
    | "selectWorkThread"
    | "setCodePullRequestsOpen"
    | "setDraftError"
    | "setDraftPendingMessage"
    | "setDraftProjectSelection"
    | "setEnvironmentSelection"
    | "setPendingDraftBranch"
    | "setPendingDraftPrompt"
    | "updateSettings"
  >;
  readonly activeMode: OctantMode;
  readonly activePaneId: PaneId | undefined;
  readonly agentRunClient: AgentRunClient;
  readonly browserAutomationClient: BrowserAutomationClient | undefined;
  readonly chatClient: ChatClient;
  readonly codeCheckouts: ReadonlyArray<CodeCheckoutIdentity>;
  readonly codeClient: CodeClient;
  readonly codeThreads: ReadonlyArray<CodeThread>;
  readonly continueCards: ReturnType<typeof useContinueCards>;
  /** The sum of every mode's navigation revision: when a turn starts or ends. */
  readonly feedRevision: number;
  readonly githubPullRequestCapability: PullRequestCardCapability;
  readonly hostFederationLifecycle: HostFederation["lifecycle"] | undefined;
  readonly hostFederationTransports: HostFederation["transports"] | undefined;
  readonly hostResourceClient: LaunchedShellClients["hostResourceClient"];
  /** A desktop window reads this computer; a browser window names its host. */
  readonly isDesktop: boolean;
  readonly loadHomePullRequests: ReturnType<typeof sharePullRequestRead>;
  readonly navigation: ShellNavigationModel;
  readonly needsYouThreadProviders: ReadonlyMap<string, ThreadProviderIdentity>;
  readonly now: number;
  readonly openRunningServiceLive:
    | ((service: RunningService, mode: RemoteOpenMode) => Promise<RemoteOpenOutcome>)
    | undefined;
  readonly pendingRequestClient: LaunchedShellClients["pendingRequestClient"];
  readonly remoteRunningServicesClient: ReturnType<typeof createLocalServerClient> | undefined;
  readonly runningServicesClient: ReturnType<typeof createLocalServerClient> | undefined;
  readonly runningServicesRemoteHost:
    | { readonly status: "disconnected"; readonly hostName: string }
    | { readonly status: "ready"; readonly hostName: string }
    | undefined;
  readonly serverUrl: string;
  readonly settings: ShellController["settings"];
  readonly sidebarRunningCount: number;
  readonly workingNowBoardFacts: WorkingNowCardSource["boardFacts"];
  readonly workingNowHost: string | undefined;
  readonly workingNowModes: WorkingNowCardSource["modes"];
  readonly workingNowProjectNames: ReadonlyMap<string, string>;
  readonly workingNowProviders: ReadonlyMap<string, ThreadProviderIdentity>;
  readonly workingNowThreads: ReadonlyArray<WorkingNowThread>;
  readonly workRequestClient: LaunchedShellClients["workRequestClient"];
  readonly workTurnClient: WorkTurnClient;
  readonly workspace: ShellController["workspace"];
}

/**
 * The start screen model for the active mode, rebuilt only when one of its
 * inputs changes. The thread pane takes it as a prop and bails out of a shell
 * render that changed none of them, so a list rebuilt per render would undo
 * that for every pane.
 */
export function useHomeStart(input: HomeStartInput): DraftThreadWorkspaceProps["homeStart"] {
  const retained = useRetainedRecord(input);
  return useMemo(() => buildHomeStart(retained), [retained]);
}

/**
 * The start screen's cards and tabs for the active mode: Needs you, Working
 * now, Running services, Pull requests, CI failures and Computers, with the
 * Running tab above the composer. Work and Code share one shape, tiles then
 * the card area; Chat has no folder tiles. The card list is rebuilt on each
 * call and is cheap: each card's own rows are memoized from the inputs, which
 * keep their identity between renders.
 */
function buildHomeStart(input: HomeStartInput): DraftThreadWorkspaceProps["homeStart"] {
  const {
    actions,
    activeMode,
    activePaneId,
    agentRunClient,
    browserAutomationClient,
    chatClient,
    codeCheckouts,
    codeClient,
    codeThreads,
    continueCards,
    feedRevision,
    githubPullRequestCapability,
    hostFederationLifecycle,
    hostFederationTransports,
    hostResourceClient,
    isDesktop,
    loadHomePullRequests,
    navigation,
    needsYouThreadProviders,
    now,
    openRunningServiceLive,
    pendingRequestClient,
    remoteRunningServicesClient,
    runningServicesClient,
    runningServicesRemoteHost,
    serverUrl,
    settings,
    sidebarRunningCount,
    workingNowBoardFacts,
    workingNowHost,
    workingNowModes,
    workingNowProjectNames,
    workingNowProviders,
    workingNowThreads,
    workRequestClient,
    workTurnClient,
    workspace,
  } = input;
  // Before the shell has its settings and workspace there is no start screen to draw.
  if (settings === undefined || workspace === undefined) return undefined;
  const { codeProjectThreads, workProjectThreads } = navigation;
  const computerSnapshots = hostFederationLifecycle?.list() ?? [];
  const computerLaunchHostId = isDesktop
    ? String(LOCAL_HOST_ID)
    : String(
        computerSnapshots.find(
          (snapshot) => snapshot.origin !== undefined && sameHostOrigin(snapshot.origin, serverUrl),
        )?.hostId ?? LOCAL_HOST_ID,
      );
  const computerHosts =
    computerSnapshots.length === 0
      ? [
          {
            hostId: String(LOCAL_HOST_ID),
            name: localHostDisplayName(),
            connection: "connected" as const,
            figuresAllowed: isDesktop,
          },
        ]
      : computerSnapshots.map((snapshot) => {
          const connection = computerConnection(snapshot.state);
          return {
            hostId: String(snapshot.hostId),
            name: snapshot.displayName,
            connection: connection.connection,
            figuresAllowed: connection.figuresAllowed,
            ...(snapshot.lastReadyAt === undefined ? {} : { lastSeenAt: snapshot.lastReadyAt }),
          };
        });
  const readComputerResources = async (hostId: string, signal: AbortSignal) => {
    if (hostId === computerLaunchHostId) return hostResourceClient.read(signal);
    const transport = hostFederationTransports?.remoteTransportFor(hostId);
    if (transport === undefined) return { status: "refused" as const };
    try {
      const response = await transport.authenticatedFetch({
        method: "GET",
        path: "/api/host/resources",
        signal,
      });
      if (response.status === 401 || response.status === 403) return { status: "refused" as const };
      if (!response.ok) return { status: "unavailable" as const };
      return {
        status: "ready" as const,
        snapshot: decodeHostAnswer(HostResourceSnapshot)(await response.json()),
      };
    } catch {
      return { status: "unavailable" as const };
    }
  };
  // The card list is rebuilt each render and is cheap: each card's own rows are
  // memoized from the inputs above, which keep their identity between renders.
  const workingNowSource: WorkingNowCardSource = {
    agentRunClient,
    boardFacts: workingNowBoardFacts,
    ...(workingNowHost === undefined ? {} : { host: workingNowHost }),
    modes: workingNowModes,
    now: now,
    onOpenRow: (row) => {
      actions.closeWorkspaceReaders();
      if (row.mode === "chat") actions.selectChatThread(row.threadId);
      else if (row.mode === "work") actions.selectWorkThread(row.threadId);
      else actions.selectCodeThread(row.threadId);
    },
    // The same place the sidebar's Running tile goes: Chat has no board, so
    // its running threads lead the Activity feed instead.
    onOpenRunning: () => {
      if (activeMode === "chat") {
        actions.openSidebarList("activity");
        return;
      }
      actions.closeWorkspaceReaders();
      actions.openThreadBoard();
    },
    projectNames: workingNowProjectNames,
    providers: workingNowProviders,
    runRevision: feedRevision,
    threads: workingNowThreads,
  };
  const homeCards = [
    createNeedsYouCard({
      answerClients: { chatClient, codeClient, workRequestClient, workTurnClient },
      feedRevision,
      modes: workingNowModes,
      now: now,
      onOpenInbox: actions.openInbox,
      onOpenThread: (request) => {
        actions.closeWorkspaceReaders();
        if (isChildPendingRequest(request)) actions.openSubagentRequest(request);
        else if (request.mode === "chat") actions.selectChatThread(String(request.threadId));
        else if (request.mode === "work") actions.selectWorkThread(String(request.threadId));
        else actions.selectCodeThread(String(request.threadId));
      },
      pendingRequestClient,
      projectNames: workingNowProjectNames,
      settings: settings,
      threadProviders: needsYouThreadProviders,
      workspace: workspace,
    }),
    createWorkingNowCard(workingNowSource),
    runningServicesRemoteHost === undefined || remoteRunningServicesClient === undefined
      ? createRunningServicesCard({
          client: runningServicesClient,
          ...(workingNowHost === undefined ? {} : { host: workingNowHost }),
          // A service on another computer opens only as that thread's Browser tab,
          // which the host itself shows; this window's own browser cannot reach it.
          canOpen: (service) =>
            workingNowHost === undefined ||
            (service.thread !== undefined &&
              browserAutomationClient !== undefined &&
              activePaneId !== undefined),
          onOpenTarget: actions.openRunningService,
        })
      : createRunningServicesCard({
          client: remoteRunningServicesClient,
          host: runningServicesRemoteHost.hostName,
          // This window's Browser tabs belong to its own host, so the other
          // computer's servers open only live, through the desktop's forwarder.
          canOpen: () => false,
          onOpenTarget: actions.openRunningService,
          ...(openRunningServiceLive === undefined ? {} : { openLive: openRunningServiceLive }),
        }),
    createPullRequestsCard({
      available: pullRequestCardAvailable({
        mode: activeMode,
        pluginEffective: FIRST_PARTY_PLUGINS_EFFECTIVE.get("github-integration") === true,
        capability: githubPullRequestCapability,
      }),
      viewerLogin: githubPullRequestCapability.login ?? "",
      load: loadHomePullRequests,
      now: now,
      onOpenRow: (row: PullRequestCardRow) => {
        actions.closeWorkspaceReaders();
        actions.selectProjectPullRequestIdentity({
          projectId: row.projectId,
          repositoryOwner: row.repositoryOwner,
          repositoryName: row.repositoryName,
          number: row.number,
        });
      },
      onOpenAll: () => {
        actions.closeWorkspaceReaders();
        actions.setCodePullRequestsOpen(true);
      },
    }),
    createCiFailuresCard({
      available: pullRequestCardAvailable({
        mode: activeMode,
        pluginEffective: FIRST_PARTY_PLUGINS_EFFECTIVE.get("github-integration") === true,
        capability: githubPullRequestCapability,
      }),
      viewerLogin: githubPullRequestCapability.login ?? "",
      currentBranches: currentCodeProjectBranches({
        threads: codeThreads,
        checkouts: codeCheckouts,
      }),
      load: loadHomePullRequests,
      now: now,
      onStartFix: (fix) => {
        // A draft only. The person sends it; this never starts a turn.
        actions.closeWorkspaceReaders();
        actions.setDraftError(undefined);
        actions.setDraftPendingMessage(undefined);
        actions.resetNewTaskDraft("code");
        actions.setPendingDraftPrompt(fix.prompt);
        actions.setPendingDraftBranch(fix.branch);
        actions.setDraftProjectSelection((current) => ({ ...current, code: fix.projectId }));
        void actions.openDraftThread("code", fix.projectId);
      },
    }),
    createComputersCard({
      hosts: computerHosts,
      launchHostId: computerLaunchHostId,
      agentRunClient,
      runRevision: feedRevision,
      now: now,
      readResources: readComputerResources,
      onOpenRunning: (hostId) => {
        actions.setEnvironmentSelection({ kind: "some", hostIds: new Set([hostId]) });
        if (activeMode === "chat") {
          actions.openSidebarList("activity");
          return;
        }
        actions.closeWorkspaceReaders();
        actions.openThreadBoard();
      },
    }),
  ];
  // The Running tab lists the card's own rows and shows the sidebar's own
  // Running count, so the three never disagree.
  const composerTabs = {
    runningCount: sidebarRunningCount,
    running: (
      <RunningTab
        onStop={(row) =>
          stopRunningRow({ agentRunClient, chatClient, codeClient, workTurnClient }, row)
        }
        source={workingNowSource}
      />
    ),
  };
  const homeStart: DraftThreadWorkspaceProps["homeStart"] =
    activeMode === "chat"
      ? {
          reviewCount: 0,
          runningCount: 0,
          cards: homeCards,
          composerTabs,
          cardCustomization: settings.homeCards,
          onCardCustomizationChange: (homeCardChoice) =>
            void actions.updateSettings({ homeCards: homeCardChoice }),
        }
      : activeMode === "code" || activeMode === "work"
        ? {
            reviewCount: reviewWaitingCount(
              activeMode === "code" ? codeProjectThreads : workProjectThreads,
            ),
            runningCount:
              activeMode === "code"
                ? continueCards.kind === "ready"
                  ? continueCards.runningTotal
                  : 0
                : runningThreadCount(workProjectThreads),
            onReview: actions.openReview,
            cards: homeCards,
            composerTabs,
            cardCustomization: settings.homeCards,
            onCardCustomizationChange: (homeCardChoice) =>
              void actions.updateSettings({ homeCards: homeCardChoice }),
            ...(activeMode === "code" ? { onOpenTerminal: actions.openHomeTerminal } : {}),
          }
        : undefined;
  return homeStart;
}
