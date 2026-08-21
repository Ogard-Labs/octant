import type {
  EnvironmentPresentationState,
  LayoutNodeId,
  PaneId,
  WindowWorkspace,
  WorkspaceLayoutNode,
  WorkspacePane,
  WorkspaceSurfaceCatalog,
  WorkspaceSurfaceDescriptor,
  WorkspaceTab,
} from "@octant/contracts/shell";
import { decodeWorkMutationRequestId } from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts/browser-automation";
import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { PreviewClient } from "@octant/client-runtime/preview-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasInventoryEntry } from "@octant/contracts";
import type { CanvasId } from "@octant/contracts/canvas";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type {
  CanvasContextSelection,
  CanvasContextSelectionId,
} from "@octant/contracts/canvasContext";
import { OctantButton } from "../ui/base/OctantButton";
import { SplitWorkspace } from "./SplitWorkspace";
import { ProjectOverview } from "../projects/ProjectOverview";
import type { OctantHostBridge } from "./hostBridge";
import type { ProviderController } from "../providers/useProviderController";
import { ShellState } from "./ShellState";
import { TabActivationProvider, type TabActivationRegistry } from "./TabActivation";
import type { WorkspaceSurfaceDragHandle } from "./useWorkspaceTabDrag";
import { CodeThreadEnvironment } from "../environment/CodeThreadEnvironment";
import { Component, lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { buildModelPickerGroups } from "@octant/domain";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { ChatThread, ChatThreadId } from "@octant/contracts/chat";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useChatController } from "../chat/useChatController";
import type { ChatController, ChatReadCursorStore } from "../chat/useChatController";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { ChatWelcome } from "../chat/ChatWelcome";
import { ChatProjectOverview } from "../chat/ChatProjectOverview";
import type { CodeController } from "../code/useCodeController";
import { useCodeThreadController, type CodeThreadControllers } from "../code/codeThreadControllers";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { CodeOverview } from "../code/CodeOverview";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import type { WorkThreadId } from "@octant/contracts/work-threads";
import type { CodeOverviewSurfaceKind } from "../code/CodeOverview";
import { codeSurfaceTitle } from "../code/codeSurfaces";
import { WorkOverview } from "../work/WorkOverview";
import { buildWorkOverviewModel } from "../work/buildWorkOverviewModel";
import type { WorkOverviewModel } from "../work/WorkOverview";
import { useWorkOverviewController } from "../work/useWorkOverviewController";
import type { WorkOverviewClient } from "@octant/client-runtime/work-overview-client";
import type { WorkResearchClient } from "@octant/client-runtime/work-research-client";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import type { UsageDashboardClient } from "@octant/client-runtime";
import type { UsageQueryFilter } from "@octant/contracts/usage-rpc";
import { WorkResearchPanel } from "../work/WorkResearchPanel";
import { ThreadGoalPanel } from "../goal/ThreadGoalPanel";
import { ShipPanel } from "../ship/ShipPanel";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { ThreadPlanPanel } from "../plan/ThreadPlanPanel";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import { SideChatWorkspaceTab } from "../chat/SideChatWorkspaceTab";
import { ThreadUsagePanel } from "../usage/ThreadUsagePanel";
import { ThreadChildRunStatusSlot } from "../agents/ThreadChildRunStatusSlot";
import { CodeFileExplorerPanel } from "../code/CodeFileExplorerPanel";
import { useWorkResearchController } from "../work/useWorkResearchController";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkThread, SideChatSidecar } from "@octant/contracts";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { LocalServerClient } from "@octant/client-runtime";
import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { BrowserContextId, BrowserThreadId } from "@octant/contracts/browser-automation";
import type { LocalServerOpenTarget } from "@octant/contracts";
import { BrowserWorkspace, makeBrowserToolAction } from "../browser/BrowserWorkspace";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import { WorkPromotionFlow } from "../work/WorkPromotionFlow";
import type { WorkPromotionController } from "../work/useWorkPromotionController";
import type { CodeThreadProviderChoice } from "../code/codeThreadCreate";
import { PreviewWorkspaceTab } from "../preview/PreviewWorkspaceTab";
import { CanvasWorkspaceTab } from "../canvas/CanvasWorkspaceTab";
import { ProjectCanvasInventory } from "../projects/ProjectCanvasInventory";
import { DraftThreadWorkspace } from "./DraftThreadWorkspace";
import { AgentModeWelcome } from "./AgentModeWelcome";
import { WorkThreadWorkspace } from "../work/WorkThreadWorkspace";
import { WorkThreadEnvironment } from "../environment/WorkThreadEnvironment";
import { ChatThreadEnvironment } from "../environment/ChatThreadEnvironment";
import { ThreadActivityPictureInPicture } from "../threadActivity/ThreadActivityPictureInPicture";

const CodeWorkspaceTab = lazy(() => import("../code/CodeWorkspaceTab"));
type CodeWorkspaceProps = import("../code/CodeWorkspace").CodeWorkspaceProps;

export interface WorkspaceViewProps {
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly chatClient: ChatClient;
  readonly chatController: ChatController;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly codeController: CodeController;
  /**
   * One controller per open Code thread. Every Code surface reads the one for
   * the thread its tab is bound to, so two Code threads in one window run and
   * render at the same time. `codeController` stays the window's own reader for
   * the thread list, settings, and thread creation.
   */
  readonly codeControllers: CodeThreadControllers;
  readonly extensionClient?: ExtensionClient;
  readonly workPromotionController: WorkPromotionController;
  readonly workMutationClient?: WorkMutationClient;
  readonly workThreadClient?: WorkThreadClient;
  readonly workTurnClient?: WorkTurnClient;
  readonly workRequestClient?: WorkRequestClient;
  readonly onWorkThreadUpdated?: (thread: WorkThread) => void;
  readonly codeProviderChoices: ReadonlyArray<CodeThreadProviderChoice>;
  /**
   * The shared surface-drag pipeline, owned by the shell so sidebar rows and
   * pane grips feed the same drag. Its root ref lands on the split workspace.
   */
  readonly drag: WorkspaceSurfaceDragHandle;
  readonly focusedPaneId?: PaneId;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedCreateHostId?: import("@octant/contracts/host").HostId;
  readonly fixedCreateHostId?: import("@octant/contracts/host").HostId;
  readonly lastSelectedHealthyHostId?: import("@octant/contracts/host").HostId;
  readonly createHostViewScope?: import("@octant/domain").CreateHostViewScope;
  readonly onSelectCreateHost?: (hostId: import("@octant/contracts/host").HostId) => void;
  readonly hidden?: boolean;
  readonly layout: WorkspaceLayoutNode;
  readonly memoryRevision?: number;
  readonly mode: "chat" | "work" | "code";
  /** A pointer landing in a pane makes it the window's active pane. */
  readonly onActivatePane: (paneId: PaneId) => void;
  readonly onClearFocus: () => void;
  readonly onClosePane: (paneId: PaneId) => Promise<boolean | void> | boolean | void;
  readonly onCreateChat: (prompt?: string) => void;
  readonly onCreateChatProjectThread?: (
    projectId: ProjectId,
    draft: string,
  ) => boolean | Promise<boolean>;
  readonly onOpenChatThread?: (
    threadId: ChatThreadId,
    title: string,
    projectId?: ProjectId,
  ) => void;
  readonly onViewAllChatProjectThreads?: (projectId: ProjectId) => void;
  /** Opens the Side Chat tab for a sidecar the host has already resolved. */
  readonly onOpenSideChat?: (sidecar: SideChatSidecar) => void;
  readonly onCreateWorkThread?: (
    projectId: ProjectId,
    draft: string,
    images?: ReadonlyArray<File>,
  ) => boolean | Promise<boolean>;
  readonly workOverviewClient?: WorkOverviewClient;
  readonly workResearchClient?: WorkResearchClient;
  readonly goalClient?: GoalClient;
  readonly goalLoopClient?: GoalLoopClient;
  readonly planClient?: PlanClient;
  readonly shipClient?: ShipClient;
  readonly usageDashboardClient?: UsageDashboardClient;
  readonly onOpenUsageDashboard?: (filter: UsageQueryFilter) => void;
  readonly workOverviewModel?: WorkOverviewModel;
  readonly workCreateThreadAvailable?: boolean;
  readonly onCommitResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly onFocus: (paneId: PaneId) => void;
  readonly onOpenCodeThread: (threadId: CodeThreadId, title: string, projectId?: ProjectId) => void;
  readonly onOpenWorkThread?: (threadId: WorkThreadId, projectId: ProjectId) => void;
  /** Opens one repository file as a Code file tab, from the file explorer. */
  readonly onOpenCodeFile?: (input: {
    readonly threadId: import("@octant/contracts/code").CodeThreadId;
    readonly relativePath: import("@octant/contracts/code").CodeRelativePath;
  }) => void;
  readonly onOpenCodeSurface: (
    kind: CodeOverviewSurfaceKind,
    threadId: CodeThreadId,
    title: string,
    /**
     * The terminal process a `code-terminal` surface must show, when the caller
     * is opening a second shell rather than returning to the thread's first.
     */
    terminalId?: import("@octant/contracts/code").CodeTerminalId,
  ) => void;
  /**
   * Open one workspace surface, resolving to whether a tab bound to
   * `browserContextId` was committed. The shell recovers a rejected tab
   * mutation instead of throwing, so a caller that minted a context for this
   * Open must read that answer rather than assume the tab exists. An Open
   * naming no context has nothing to confirm and resolves `true`.
   */
  /** Pins a Code thread's terminal to the focus zone. */
  readonly onPinTerminal?: CodeWorkspaceProps["onPinTerminal"];
  readonly onPinCanvasInFocusZone?: (request: {
    readonly canvasId: CanvasId;
    readonly title: string;
  }) => void;
  readonly onDockResearch?: (request: {
    readonly threadId: string;
    readonly mode: "work" | "code";
  }) => void;
  readonly onOpenSurface?: (
    surface: WorkspaceSurfaceDescriptor["kind"],
    paneId: PaneId,
    /**
     * The Browser context this surface must attach to, when the caller created
     * one for it. Omitted for the ordinary Browser surface, which
     * stays one shared view per thread.
     */
    browserContextId?: BrowserContextId,
  ) => Promise<boolean>;
  readonly onPreviewResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  /** A keyboard path to the edge-drop gesture: split a pane onto a welcome. */
  readonly onSplitPane: (
    paneId: PaneId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after",
  ) => void;
  readonly workspace: WindowWorkspace;
  readonly availableSurfaces?: WorkspaceSurfaceCatalog;
  readonly crossContextOffer?: {
    readonly message: string;
    readonly canOpenInNewWindow: boolean;
  };
  readonly onDismissCrossContextOffer?: () => void;
  readonly onOpenCrossContextInNewWindow?: () => void;
  readonly hostBridge?: OctantHostBridge;
  readonly folderBrowseClient?: import("@octant/client-runtime/folder-browse-client").FolderBrowseClient;
  readonly hostId?: string;
  /** GitHub onboarding clients for the Code draft composer. */
  readonly githubClient?: import("@octant/client-runtime/github-client").GithubClient;
  readonly githubCloneClient?: import("@octant/client-runtime/github-clone-client").GithubCloneClient;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly providerController: ProviderController;
  readonly browserAutomationClient?: BrowserAutomationClient;
  /** Injected in tests; otherwise the Environment builds one from the server URL. */
  readonly localServerClient?: LocalServerClient;
  readonly computerUseClient?: ComputerUseClient;
  readonly onComputerUseSessionChange?: (
    threadId: string,
    sessionId: string,
    represented: boolean,
  ) => void;
  readonly isNarrow?: boolean;
  readonly availabilityByProject: ReadonlyMap<ProjectId, ProjectAvailability>;
  readonly onArchiveProject: (projectId: ProjectId) => void;
  readonly onRelinkProject: (projectId: ProjectId, receiptId: string) => Promise<boolean>;
  readonly onRenameProject: (projectId: ProjectId, name: string) => Promise<boolean>;
  readonly statusBar?: ReactNode;
  /** Session record of which tabs the person activated, opened, or created. */
  readonly tabActivation?: TabActivationRegistry;
  readonly environmentPresentation: EnvironmentPresentationState;
  readonly onSetEnvironmentPresentation: (next: EnvironmentPresentationState) => void;
  /** Starts a fresh thread in a Project, offered when a checkout is unusable. */
  readonly onNewThreadInProject?: (projectId: ProjectSummary["id"]) => void;
  readonly projectClient?: ProjectClient;
  readonly projectServerUrl?: string;
  readonly projectWindowCapability?: string;
  readonly previewClient?: PreviewClient;
  readonly canvasClient?: CanvasClient;
  readonly onOpenCanvas?: (entry: CanvasInventoryEntry) => void;
  readonly onOpenCanvasReference?: (card: CanvasThreadReferenceCard) => void;
  readonly draftProviderGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly codeProviderGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly workProviderGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly draftProjectName?: string;
  readonly draftProjectRoot?: string;
  readonly draftBranchName?: string;
  readonly draftApprovalLabel?: string;
  readonly draftSelectedProviderInstanceId?: import("@octant/contracts/providers").ProviderInstanceId;
  readonly draftSelectedModelId?: import("@octant/contracts/providers").ProviderModelId;
  readonly onDraftSelectProvider?: (selection: {
    readonly providerInstanceId: import("@octant/contracts/providers").ProviderInstanceId;
    readonly modelId: import("@octant/contracts/providers").ProviderModelId;
  }) => void;
  readonly onDraftCreateThread?: (
    mode: string,
    prompt: string,
    draftProjectId?: ProjectId,
    deliveryOutcome?: import("@octant/contracts/code").CodeDeliveryOutcomeKind,
    images?: ReadonlyArray<File>,
    threadMentionIds?: ReadonlyArray<import("@octant/contracts").MentionableThreadId>,
  ) => boolean | void | Promise<boolean | void>;
  readonly draftCodeExecute?: (
    command: import("@octant/contracts/code").CodeCommand,
    signal?: AbortSignal,
  ) => Promise<import("@octant/contracts/code").CodeCommandResult | undefined>;
  readonly onDraftCreateCodeThread?: (
    input: import("../code/composer/CodeComposerAdapter").CodeComposerSubmitInput,
    projectId?: ProjectId,
  ) => boolean | void | Promise<boolean | void>;
  /**
   * Records a Code Project's remembered new-thread workspace habit
   * through the journaled Project command path.
   */
  readonly onChangeCodeNewThreadWorkspace?: (
    projectId: ProjectId,
    newThreadWorkspace: import("@octant/contracts/projects").CodeNewThreadWorkspace,
  ) => Promise<boolean>;
  readonly onCreateProject?: (
    mode: "chat" | "work" | "code",
    name: string,
    receiptId?: string,
  ) => Promise<ProjectId | undefined>;
  readonly onDraftCreating?: boolean;
  readonly onDraftError?: string;
  readonly onDraftPendingMessage?: string;
  readonly onDraftCancelFirstTurn?: () => void;
  readonly onAttachFolder?: () => void;
  readonly onOpenDraftThread?: (mode: "work" | "code") => void;
  readonly onOpenProviderSettings?: () => void;
  readonly onOpenSettings?: () => void;
  readonly providerReady?: boolean;
  readonly providerBootstrapMessage?: string;
  readonly chatWelcomeCreating?: boolean;
  readonly chatWelcomeError?: string;
  readonly draftExecutionProfile?: ReactNode;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const [pendingCanvasSelections, setPendingCanvasSelections] = useState<
    ReadonlyArray<CanvasContextSelection>
  >([]);
  const pinCanvasContext = useCallback((selection: CanvasContextSelection) => {
    setPendingCanvasSelections((current) => [...current, selection]);
  }, []);
  const removeCanvasSelection = useCallback((selectionId: CanvasContextSelectionId) => {
    setPendingCanvasSelections((current) =>
      current.filter((selection) => selection.id !== selectionId),
    );
  }, []);
  const clearCanvasSelections = useCallback(() => {
    setPendingCanvasSelections([]);
  }, []);
  const canvasContext = {
    clearCanvasSelections,
    pendingCanvasSelections,
    onAttachCanvasContext: pinCanvasContext,
    onRemoveCanvasSelection: removeCanvasSelection,
  };
  const closePane = useCallback(
    async (paneId: PaneId) => {
      const surface = findWorkspacePane(props.workspace, paneId)?.surface;
      // A terminal surface that carries an identity of its own is the only
      // thing that knows it: the identity was minted for that view and is
      // recorded nowhere else, so closing the pane would leave the shell
      // running with nothing able to reach, watch, or stop it for the rest of
      // the session. The shutdown therefore has to be confirmed before the
      // pane goes, not after — a transient failure, a refused operation, or a
      // checkout that will not resolve all mean the pane is what has to stay.
      // A surface with no identity of its own only views the thread's original
      // terminal, which the thread's own Terminal surface still reaches, so it
      // is left running.
      if (surface?.kind === "code-terminal" && surface.terminalId !== undefined) {
        const checkoutId = resolveCodeTabCheckoutId(surface, props.codeController);
        if (checkoutId === undefined) return;
        const stopped = await props.codeController.client
          .executeOperation({
            kind: "stop-terminal",
            operationId: globalThis.crypto.randomUUID() as never,
            terminalId: surface.terminalId,
            threadId: surface.threadId,
            checkoutId,
          })
          .catch(() => undefined);
        // A terminal the host no longer owns has already stopped — the user
        // pressed Stop inside it, or its shell exited on its own — so there is
        // nothing left to strand and the pane may go. Every other answer keeps
        // the pane, because the pane is the only thing that can retry.
        const cleaned =
          stopped?.kind === "terminal-state" ||
          (stopped?.kind === "operation-failed" && stopped.failure.category === "unavailable");
        if (!cleaned) return;
      }
      const closed = await props.onClosePane(paneId);
      if (closed === false) return;
      if (
        surface?.kind === "browser" &&
        surface.threadId !== undefined &&
        props.browserAutomationClient !== undefined
      ) {
        // A surface that owns one context takes only that context with it; the
        // thread's other Local servers sessions are none of its business.
        // Only the thread's shared Browser surface releases the thread.
        const threadId = surface.threadId;
        const contextId = surface.contextId;
        await (
          contextId === undefined
            ? props.browserAutomationClient.releaseThread({ threadId })
            : props.browserAutomationClient.stop({ contextId, threadId })
        ).catch(() => undefined);
      }
    },
    [props.browserAutomationClient, props.codeController, props.onClosePane, props.workspace],
  );

  return (
    <TabActivationProvider
      {...(props.tabActivation === undefined ? {} : { registry: props.tabActivation })}
    >
      <main className="workspace" hidden={props.hidden}>
        {props.crossContextOffer === undefined ? null : (
          <CrossContextBanner
            message={props.crossContextOffer.message}
            {...(props.onDismissCrossContextOffer === undefined
              ? {}
              : { onDismiss: props.onDismissCrossContextOffer })}
            {...(props.onOpenCrossContextInNewWindow === undefined ||
            !props.crossContextOffer.canOpenInNewWindow
              ? {}
              : { onOpenInNewWindow: props.onOpenCrossContextInNewWindow })}
          />
        )}
        <SplitWorkspace
          drag={props.drag}
          layout={props.layout}
          mode={props.mode}
          onActivatePane={props.onActivatePane}
          onClearFocus={props.onClearFocus}
          onClosePane={(paneId) => void closePane(paneId)}
          onCommitResize={props.onCommitResize}
          onFocus={props.onFocus}
          onPreviewResize={props.onPreviewResize}
          onSplitPane={props.onSplitPane}
          {...(props.focusedPaneId === undefined ? {} : { focusedPaneId: props.focusedPaneId })}
          {...(props.availableSurfaces === undefined
            ? {}
            : { availableSurfaces: props.availableSurfaces })}
          {...(props.onOpenSurface === undefined ? {} : { onOpenSurface: props.onOpenSurface })}
          onOpenCodeSurface={props.onOpenCodeSurface}
          renderSurface={(surface, paneId) => renderTab(surface, props, paneId, canvasContext)}
          totalWorkspacePaneCount={Object.values(props.workspace.layouts).reduce(
            (count, layout) => count + countPanes(layout),
            0,
          )}
        />
        {props.statusBar}
      </main>
    </TabActivationProvider>
  );
}

function CrossContextBanner(props: {
  readonly message: string;
  readonly onDismiss?: () => void;
  readonly onOpenInNewWindow?: () => void;
}) {
  return (
    <div className="workspace-cross-context-banner" role="alert">
      <span className="workspace-cross-context-banner__message">{props.message}</span>
      <span className="workspace-cross-context-banner__actions">
        {props.onOpenInNewWindow === undefined ? (
          <span className="workspace-cross-context-banner__hint">
            Open it in a new window to keep its authority.
          </span>
        ) : (
          <OctantButton
            className="workspace-cross-context-banner__new-window"
            onClick={props.onOpenInNewWindow}
            type="button"
            variant="secondary"
          >
            Open in new window
          </OctantButton>
        )}
        {props.onDismiss === undefined ? null : (
          <OctantButton
            className="workspace-cross-context-banner__dismiss"
            onClick={props.onDismiss}
            type="button"
            variant="ghost"
          >
            Dismiss
          </OctantButton>
        )}
      </span>
    </div>
  );
}

function countPanes(layout: WorkspaceLayoutNode): number {
  return layout.kind === "pane" ? 1 : countPanes(layout.first) + countPanes(layout.second);
}

function renderTab(
  tab: WorkspaceTab,
  props: WorkspaceViewProps,
  paneId: PaneId,
  canvasContext: {
    readonly clearCanvasSelections: () => void;
    readonly pendingCanvasSelections: ReadonlyArray<CanvasContextSelection>;
    readonly onAttachCanvasContext: (selection: CanvasContextSelection) => void;
    readonly onRemoveCanvasSelection: (selectionId: CanvasContextSelectionId) => void;
  },
): React.ReactNode {
  const openProviderSettings = props.onOpenProviderSettings ?? props.onOpenSettings;
  if (isCodeWorkspaceTab(tab)) {
    return (
      <CodeThreadTabSurface controllers={props.codeControllers} key={tab.id} tab={tab}>
        {(controller) => renderCodeTab(tab, props, paneId, controller)}
      </CodeThreadTabSurface>
    );
  }
  return renderNonCodeTab(tab, props, paneId, canvasContext, openProviderSettings);
}

/**
 * One Code surface, rendered under its own thread's controller.
 *
 * A tab whose thread has no controller yet says so. Rendering it against
 * another thread's controller is what let one window show a second Code
 * thread the first thread's transcript, checkout, and runtime.
 */
function CodeThreadTabSurface(props: {
  readonly controllers: CodeThreadControllers;
  readonly tab: Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }>;
  readonly children: (controller: CodeController) => React.ReactNode;
}) {
  const controller = useCodeThreadController(props.controllers, props.tab.threadId as CodeThreadId);
  if (controller === undefined) {
    return (
      <ShellState
        eyebrow="Code workspace"
        message="Opening this thread's own Code state."
        state="loading"
        title="Preparing this Code thread"
      />
    );
  }
  return <>{props.children(controller)}</>;
}

function renderCodeTab(
  tab: Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }>,
  props: WorkspaceViewProps,
  paneId: PaneId,
  codeController: CodeController,
): React.ReactNode {
  const project = resolveCodeTabProject(tab, props);
  const browserAutomationClient = props.browserAutomationClient;
  const onOpenSurface = props.onOpenSurface;
  const checkoutId = resolveCodeTabCheckoutId(tab, codeController);
  const content = (
    <Suspense
      fallback={
        <ShellState
          eyebrow="Code workspace"
          message="Loading the selected Code surface."
          state="loading"
          title={tab.title}
        />
      }
    >
      <CodeWorkspaceTab
        {...(props.agentRunClient === undefined ? {} : { agentRunClient: props.agentRunClient })}
        {...(props.agentRunSettingsClient === undefined
          ? {}
          : { agentRunSettingsClient: props.agentRunSettingsClient })}
        {...(props.appleToolchainClient === undefined
          ? {}
          : { appleToolchainClient: props.appleToolchainClient })}
        controller={codeController}
        onOpenCodeThread={props.onOpenCodeThread}
        {...(props.onPinTerminal === undefined ? {} : { onPinTerminal: props.onPinTerminal })}
        {...(props.onOpenSurface === undefined
          ? {}
          : { onOpenBrowser: () => props.onOpenSurface?.("browser", paneId) })}
        onOpenSurface={(kind, options) =>
          options?.terminalId === undefined
            ? props.onOpenCodeSurface(kind, tab.threadId, codeSurfaceTitle(kind))
            : props.onOpenCodeSurface(
                kind,
                tab.threadId,
                codeSurfaceTitle(kind),
                options.terminalId,
              )
        }
        {...(props.onOpenCodeFile === undefined
          ? {}
          : {
              onOpenFile: (relativePath: string) =>
                props.onOpenCodeFile?.({
                  threadId: tab.threadId,
                  relativePath: relativePath as never,
                }),
            })}
        tab={tab}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.codeProviderGroups === undefined && props.draftProviderGroups === undefined
          ? {}
          : { providerGroups: props.codeProviderGroups ?? props.draftProviderGroups })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId as HostId })}
        {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { windowCapability: props.projectWindowCapability })}
        {...(props.onOpenCanvasReference === undefined
          ? {}
          : { onOpenCanvas: props.onOpenCanvasReference })}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
      />
    </Suspense>
  );
  // Auxiliary Code surfaces (terminal, file, diff, tests, …) share the
  // thread rail and Browser/Computer Use preview with the thread tab;
  // mounting them per split pane just repeats the same rail and
  // "Browser is active" card beside every surface of one thread.
  if (tab.kind !== "code-overview") {
    return (
      <CodeWorkspaceErrorBoundary key={tab.id}>
        <div className="code-thread-environment code-thread-environment--surface">
          <div className="code-thread-environment__content">{content}</div>
        </div>
      </CodeWorkspaceErrorBoundary>
    );
  }
  const surface = (
    <ThreadActivityPictureInPicture
      {...(props.browserAutomationClient === undefined
        ? {}
        : { browserClient: props.browserAutomationClient })}
      {...(props.computerUseClient === undefined
        ? {}
        : { computerUseClient: props.computerUseClient })}
      {...(props.onComputerUseSessionChange === undefined
        ? {}
        : { onComputerUseSessionChange: props.onComputerUseSessionChange })}
      {...(props.onOpenSurface === undefined
        ? {}
        : { onOpenBrowser: () => props.onOpenSurface?.("browser", paneId) })}
      threadId={tab.threadId as never}
    >
      {content}
    </ThreadActivityPictureInPicture>
  );
  const shipClient = props.shipClient;
  const files = (
    <CodeFileExplorerPanel
      threadId={tab.threadId}
      {...(checkoutId === undefined ? {} : { checkoutId })}
      {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
      {...(props.projectWindowCapability === undefined
        ? {}
        : { windowCapability: props.projectWindowCapability })}
      onOpenFile={(entry) =>
        props.onOpenCodeFile?.({ threadId: tab.threadId, relativePath: entry.path })
      }
    />
  );
  return (
    <CodeWorkspaceErrorBoundary key={tab.id}>
      <ThreadPlanProvider
        {...(props.planClient === undefined ? {} : { client: props.planClient })}
        threadId={String(tab.threadId)}
      >
        <CodeThreadEnvironment
          presentation={props.environmentPresentation}
          onChangePresentation={props.onSetEnvironmentPresentation}
          {...(project === undefined ? {} : { project })}
          {...(props.onNewThreadInProject === undefined
            ? {}
            : { onNewThreadInProject: props.onNewThreadInProject })}
          {...(props.projectClient === undefined ? {} : { projectClient: props.projectClient })}
          {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
          {...(props.projectWindowCapability === undefined
            ? {}
            : { windowCapability: props.projectWindowCapability })}
          {...(props.localServerClient === undefined
            ? {}
            : { localServerClient: props.localServerClient })}
          {...(browserAutomationClient === undefined || onOpenSurface === undefined
            ? {}
            : {
                onOpenLocalServer: async (target: LocalServerOpenTarget) => {
                  const browserThreadId = tab.threadId as unknown as BrowserThreadId;
                  const contextId = await openLocalServerBrowserContext(
                    browserAutomationClient,
                    browserThreadId,
                    target,
                  );
                  // Named by the context it just created, so this Open gets its
                  // own tab instead of taking over the thread's Browser tab.
                  // The shell recovers a rejected tab mutation rather than
                  // throwing, so only its adoption answer proves the context
                  // gained a close path; without one it is released here and
                  // the Open is reported as the failure it was.
                  const adopted = await onOpenSurface("browser", paneId, contextId);
                  if (adopted) return;
                  await releaseBrowserContext(browserAutomationClient, browserThreadId, contextId);
                  throw new Error("No Browser tab adopted the context opened for this server.");
                },
              })}
          {...(globalThis.navigator?.clipboard === undefined
            ? {}
            : {
                onCopyLocalServerUrl: (url: string) => navigator.clipboard.writeText(url),
              })}
          tab={tab}
          onExecute={codeController.execute}
          files={files}
          plan={<ThreadPlanPanel />}
          {...(shipClient === undefined
            ? {}
            : { publish: <ShipPanel client={shipClient} threadId={String(tab.threadId)} /> })}
          onOpenChanges={() =>
            props.onOpenCodeSurface("code-diff", tab.threadId, codeSurfaceTitle("code-diff"))
          }
        >
          {surface}
        </CodeThreadEnvironment>
      </ThreadPlanProvider>
    </CodeWorkspaceErrorBoundary>
  );
}

function renderNonCodeTab(
  tab: WorkspaceTab,
  props: WorkspaceViewProps,
  paneId: PaneId,
  canvasContext: {
    readonly clearCanvasSelections: () => void;
    readonly pendingCanvasSelections: ReadonlyArray<CanvasContextSelection>;
    readonly onAttachCanvasContext: (selection: CanvasContextSelection) => void;
    readonly onRemoveCanvasSelection: (selectionId: CanvasContextSelectionId) => void;
  },
  openProviderSettings: (() => void) | undefined,
): React.ReactNode {
  if (tab.kind === "draft-thread") {
    return (
      <DraftThreadWorkspace
        key={tab.id}
        mode={tab.mode}
        {...(tab.mode === "code" && props.draftExecutionProfile !== undefined
          ? { executionProfile: props.draftExecutionProfile }
          : {})}
        {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
        {...(props.selectedCreateHostId === undefined
          ? {}
          : { selectedHostId: props.selectedCreateHostId })}
        {...(props.fixedCreateHostId === undefined
          ? tab.projectId !== undefined && props.selectedCreateHostId !== undefined
            ? { fixedHostId: props.selectedCreateHostId }
            : {}
          : { fixedHostId: props.fixedCreateHostId })}
        {...(props.lastSelectedHealthyHostId === undefined
          ? {}
          : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
        {...(props.createHostViewScope === undefined
          ? {}
          : { viewScope: props.createHostViewScope })}
        {...(props.onSelectCreateHost === undefined
          ? {}
          : { onSelectHost: props.onSelectCreateHost })}
        projects={props.projects}
        availabilityByProject={props.availabilityByProject}
        {...(props.folderBrowseClient === undefined
          ? {}
          : { folderBrowseClient: props.folderBrowseClient })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        {...(props.githubClient === undefined ? {} : { githubClient: props.githubClient })}
        {...(props.githubCloneClient === undefined
          ? {}
          : { githubCloneClient: props.githubCloneClient })}
        {...(tab.projectId === undefined ? {} : { projectId: tab.projectId })}
        {...(props.draftProjectName === undefined ? {} : { projectName: props.draftProjectName })}
        {...(props.draftProjectRoot === undefined ? {} : { projectRoot: props.draftProjectRoot })}
        {...(props.draftBranchName === undefined ? {} : { branchName: props.draftBranchName })}
        {...(props.draftApprovalLabel === undefined
          ? {}
          : { approvalLabel: props.draftApprovalLabel })}
        providerGroups={props.draftProviderGroups ?? []}
        {...(props.draftSelectedProviderInstanceId === undefined
          ? {}
          : { selectedProviderInstanceId: props.draftSelectedProviderInstanceId })}
        {...(props.draftSelectedModelId === undefined
          ? {}
          : { selectedModelId: props.draftSelectedModelId })}
        onSelectProvider={props.onDraftSelectProvider ?? (() => {})}
        {...(props.draftCodeExecute === undefined ? {} : { codeExecute: props.draftCodeExecute })}
        {...(props.onDraftCreateCodeThread === undefined
          ? {}
          : { onCreateCodeThread: props.onDraftCreateCodeThread })}
        {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { windowCapability: props.projectWindowCapability })}
        onCreateThread={(prompt, folderSelection, deliveryOutcome, images, threadMentionIds) => {
          if (props.onDraftCreateThread === undefined) return;
          return props.onDraftCreateThread(
            tab.mode,
            prompt,
            folderSelection,
            deliveryOutcome,
            images,
            threadMentionIds,
          );
        }}
        {...(props.onCreateProject === undefined ? {} : { onCreateProject: props.onCreateProject })}
        onCancel={() => {
          void props.onClosePane(paneId);
        }}
        {...(props.onDraftCreating === undefined ? {} : { creating: props.onDraftCreating })}
        {...(props.onDraftError === undefined ? {} : { errorMessage: props.onDraftError })}
        {...(props.onDraftPendingMessage === undefined
          ? {}
          : { pendingMessage: props.onDraftPendingMessage })}
        {...(props.onDraftCancelFirstTurn === undefined
          ? {}
          : { onCancelFirstTurn: props.onDraftCancelFirstTurn })}
        {...(props.onAttachFolder === undefined ? {} : { onAttachFolder: props.onAttachFolder })}
      />
    );
  }
  if (tab.kind === "chat-thread") {
    return (
      <ChatThreadWorkspace
        chatClient={props.chatClient}
        chatReadCursorStore={props.chatReadCursorStore}
        {...(props.extensionClient === undefined ? {} : { extensionClient: props.extensionClient })}
        {...(openProviderSettings === undefined ? {} : { onOpenSettings: openProviderSettings })}
        environmentPresentation={props.environmentPresentation}
        key={tab.threadId}
        onClearCanvasSelections={canvasContext.clearCanvasSelections}
        onRemoveCanvasSelection={canvasContext.onRemoveCanvasSelection}
        onSetEnvironmentPresentation={props.onSetEnvironmentPresentation}
        pendingCanvasSelections={canvasContext.pendingCanvasSelections}
        projects={props.projects}
        tab={tab}
        providerController={props.providerController}
        {...(props.projectServerUrl === undefined
          ? {}
          : { projectServerUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { projectWindowCapability: props.projectWindowCapability })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        {...(props.onOpenCanvasReference === undefined
          ? {}
          : { onOpenCanvasReference: props.onOpenCanvasReference })}
        {...(props.onOpenChatThread === undefined ? {} : { onOpenThread: props.onOpenChatThread })}
        {...(props.onOpenSideChat === undefined ? {} : { onOpenSideChat: props.onOpenSideChat })}
        threadId={tab.threadId}
        childRunStatus={
          <ThreadChildRunStatusSlot
            {...(props.agentRunClient === undefined ? {} : { client: props.agentRunClient })}
            threadId={String(tab.threadId)}
          />
        }
      />
    );
  }
  if (tab.kind === "work-thread") {
    if (props.workThreadClient === undefined) {
      return (
        <ShellState
          eyebrow="Work thread"
          message="Work thread service is unavailable in this window."
          state="warning"
          title={tab.title}
        />
      );
    }
    return (
      <WorkThreadEnvironment
        key={tab.id}
        onChangePresentation={props.onSetEnvironmentPresentation}
        presentation={props.environmentPresentation}
        projects={props.projects}
        tab={tab}
        threadClient={props.workThreadClient}
      >
        <ThreadActivityPictureInPicture
          {...(props.browserAutomationClient === undefined
            ? {}
            : { browserClient: props.browserAutomationClient })}
          {...(props.computerUseClient === undefined
            ? {}
            : { computerUseClient: props.computerUseClient })}
          {...(props.onComputerUseSessionChange === undefined
            ? {}
            : { onComputerUseSessionChange: props.onComputerUseSessionChange })}
          {...(props.onOpenSurface === undefined
            ? {}
            : { onOpenBrowser: () => props.onOpenSurface?.("browser", paneId) })}
          threadId={tab.threadId as never}
        >
          <WorkThreadWorkspace
            {...(props.workMutationClient === undefined
              ? {}
              : { mutationClient: props.workMutationClient })}
            {...(props.workTurnClient === undefined ? {} : { turnClient: props.workTurnClient })}
            {...(props.workRequestClient === undefined
              ? {}
              : { requestClient: props.workRequestClient })}
            threadClient={props.workThreadClient}
            {...(props.onOpenSurface === undefined
              ? {}
              : { onOpenBrowser: () => props.onOpenSurface?.("browser", paneId) })}
            threadId={tab.threadId}
            title={tab.title}
            providerGroups={props.workProviderGroups ?? []}
            {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
            {...(props.hostId === undefined ? {} : { hostId: props.hostId as HostId })}
            {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
            {...(props.projectWindowCapability === undefined
              ? {}
              : { windowCapability: props.projectWindowCapability })}
            {...(props.onOpenCanvasReference === undefined
              ? {}
              : { onOpenCanvas: props.onOpenCanvasReference })}
            {...(props.onWorkThreadUpdated === undefined
              ? {}
              : { onThreadUpdated: props.onWorkThreadUpdated })}
            childRunStatus={
              <ThreadChildRunStatusSlot
                {...(props.agentRunClient === undefined ? {} : { client: props.agentRunClient })}
                threadId={String(tab.threadId)}
              />
            }
          />
          <ThreadGoalPanel
            {...(props.goalClient === undefined ? {} : { client: props.goalClient })}
            {...(props.goalLoopClient === undefined ? {} : { loopClient: props.goalLoopClient })}
            threadId={String(tab.threadId)}
          />
          <ThreadUsagePanel
            client={props.usageDashboardClient}
            subjectType="work-thread"
            subjectId={String(tab.threadId)}
            {...(props.onOpenUsageDashboard === undefined
              ? {}
              : { onOpenUsageDashboard: props.onOpenUsageDashboard })}
          />
        </ThreadActivityPictureInPicture>
      </WorkThreadEnvironment>
    );
  }
  if (tab.kind === "settings") {
    return (
      <ShellState
        {...(props.onOpenSettings === undefined
          ? {}
          : { action: { label: "Open Settings", onClick: props.onOpenSettings } })}
        eyebrow="Settings moved"
        message="Settings now opens from the app sidebar without changing this workspace."
        state="neutral"
        title="Open the dedicated Settings view"
      />
    );
  }
  if (tab.kind === "preview") {
    return <PreviewWorkspaceTab key={tab.id} tab={tab} client={props.previewClient} />;
  }
  if (tab.kind === "canvas") {
    return (
      <CanvasWorkspaceTab
        key={tab.id}
        client={props.canvasClient}
        tab={tab}
        onAttachContext={canvasContext.onAttachCanvasContext}
        {...(props.onPinCanvasInFocusZone === undefined
          ? {}
          : { onPinCanvasInFocusZone: props.onPinCanvasInFocusZone })}
      />
    );
  }
  if (tab.kind === "browser") {
    return props.browserAutomationClient === undefined ? (
      <ShellState
        eyebrow="Browser unavailable"
        message="The host browser automation client is unavailable."
        state="warning"
        title={tab.title}
      />
    ) : (
      <BrowserWorkspace
        key={tab.id}
        client={props.browserAutomationClient}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { windowCapability: props.projectWindowCapability })}
        {...(props.onDockResearch === undefined ? {} : { onDockResearch: props.onDockResearch })}
        tab={tab}
      />
    );
  }
  if (tab.kind === "files") {
    return (
      <ShellState
        eyebrow="Files surface"
        message="Files surfaces open inside the bound Project context."
        state="neutral"
        title={tab.title}
      />
    );
  }
  if (tab.kind === "side-chat") {
    return (
      <SideChatWorkspaceTab
        key={tab.id}
        chatClient={props.chatClient}
        chatReadCursorStore={props.chatReadCursorStore}
        providerController={props.providerController}
        tab={tab}
        {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { windowCapability: props.projectWindowCapability })}
        {...(props.onOpenSideChat === undefined ? {} : { onSidecarOpened: props.onOpenSideChat })}
      />
    );
  }
  if (tab.kind === "project") {
    const project = props.projects.find((candidate) => candidate.id === tab.projectId);
    if (project === undefined || project.type !== tab.mode) {
      return (
        <ShellState
          eyebrow="Project unavailable"
          message="Refresh Project state or close this tab."
          state="warning"
          title={tab.title}
        />
      );
    }
    const availability = props.availabilityByProject.get(project.id);
    return (
      <ProjectOverview
        {...(project.type === "chat"
          ? {
              chatOverview: (
                <ChatProjectOverview
                  client={props.chatClient}
                  controller={props.chatController}
                  {...(project.lifecycle === "active" &&
                  props.chatController.status === "ready" &&
                  props.onCreateChatProjectThread !== undefined
                    ? {
                        onCreateThread: (draft: string) =>
                          props.onCreateChatProjectThread?.(project.id, draft) ?? false,
                      }
                    : {})}
                  {...(props.onOpenChatThread === undefined
                    ? {}
                    : {
                        onOpenThread: (threadId: string) => {
                          const thread = props.chatController.bootstrap?.threads.find(
                            (candidate) => String(candidate.id) === threadId,
                          );
                          if (thread !== undefined) {
                            props.onOpenChatThread?.(thread.id, thread.title, project.id);
                          }
                        },
                      })}
                  {...(project.lifecycle !== "active" ||
                  props.onViewAllChatProjectThreads === undefined
                    ? {}
                    : {
                        onViewAllProjectThreads: () =>
                          props.onViewAllChatProjectThreads?.(project.id),
                      })}
                  {...(props.projectClient === undefined
                    ? {}
                    : { projectClient: props.projectClient })}
                  {...(props.memoryRevision === undefined
                    ? {}
                    : { memoryRevision: props.memoryRevision })}
                  {...(props.draftProviderGroups === undefined
                    ? {}
                    : { providerGroups: props.draftProviderGroups })}
                  {...(props.draftSelectedProviderInstanceId === undefined
                    ? {}
                    : { selectedProviderInstanceId: props.draftSelectedProviderInstanceId })}
                  {...(props.draftSelectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.draftSelectedModelId })}
                  {...(props.onDraftSelectProvider === undefined
                    ? {}
                    : { onSelectProvider: props.onDraftSelectProvider })}
                  {...(props.onOpenSettings === undefined
                    ? {}
                    : { onOpenSettings: props.onOpenSettings })}
                  projectId={project.id}
                />
              ),
            }
          : {})}
        {...(project.type === "code" && availability?.status !== "unavailable"
          ? {
              codeOverview: (
                <CodeOverview
                  controller={props.codeController}
                  {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
                  onOpenThread={(threadId) => {
                    const thread = props.codeController.bootstrap?.threads.find(
                      (candidate) => candidate.id === threadId,
                    );
                    if (thread !== undefined) {
                      props.onOpenCodeThread(thread.id, thread.title, thread.projectId);
                    }
                  }}
                  projectId={project.id}
                  projectName={project.name}
                  projectRoot={project.binding.canonicalRoot}
                  providerGroups={props.codeProviderGroups ?? props.draftProviderGroups ?? []}
                  {...(props.draftSelectedProviderInstanceId === undefined
                    ? {}
                    : { selectedProviderInstanceId: props.draftSelectedProviderInstanceId })}
                  {...(props.draftSelectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.draftSelectedModelId })}
                  {...(props.onDraftSelectProvider === undefined
                    ? {}
                    : { onSelectProvider: props.onDraftSelectProvider })}
                  {...(props.onDraftCreateCodeThread === undefined
                    ? {}
                    : { onCreateThread: props.onDraftCreateCodeThread })}
                  {...(props.onChangeCodeNewThreadWorkspace === undefined
                    ? {}
                    : { onChangeNewThreadWorkspace: props.onChangeCodeNewThreadWorkspace })}
                  {...(project.type !== "code" || project.newThreadWorkspace === undefined
                    ? {}
                    : { newThreadWorkspace: project.newThreadWorkspace })}
                  {...(props.onDraftCreating === undefined
                    ? {}
                    : { creating: props.onDraftCreating })}
                  {...(props.onDraftError === undefined
                    ? {}
                    : { errorMessage: props.onDraftError })}
                  {...(props.onDraftPendingMessage === undefined
                    ? {}
                    : { pendingMessage: props.onDraftPendingMessage })}
                />
              ),
            }
          : {})}
        {...(project.type === "work"
          ? {
              workOverview: (
                <WorkProjectOverviewSlot
                  {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
                  {...(props.selectedCreateHostId === undefined
                    ? {}
                    : { selectedHostId: props.selectedCreateHostId })}
                  {...(props.selectedCreateHostId === undefined
                    ? {}
                    : { fixedHostId: props.selectedCreateHostId })}
                  {...(props.lastSelectedHealthyHostId === undefined
                    ? {}
                    : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
                  {...(props.createHostViewScope === undefined
                    ? {}
                    : { viewScope: props.createHostViewScope })}
                  {...(availability === undefined ? {} : { availability })}
                  {...(props.workOverviewClient === undefined
                    ? {}
                    : { client: props.workOverviewClient })}
                  {...(props.workResearchClient === undefined
                    ? {}
                    : { researchClient: props.workResearchClient })}
                  {...(props.workMutationClient === undefined
                    ? {}
                    : { mutationClient: props.workMutationClient })}
                  createStarterArtifactAvailable={
                    availability?.status === "available" && project.lifecycle === "active"
                  }
                  createThreadAvailable={
                    props.workCreateThreadAvailable === true &&
                    props.onCreateWorkThread !== undefined &&
                    availability?.status === "available" &&
                    project.lifecycle === "active"
                  }
                  onReloadPromotion={props.workPromotionController.reload}
                  onCreateThread={(draft, images) =>
                    images === undefined
                      ? (props.onCreateWorkThread?.(project.id, draft) ?? false)
                      : (props.onCreateWorkThread?.(project.id, draft, images) ?? false)
                  }
                  {...(openProviderSettings === undefined
                    ? {}
                    : { onOpenSettings: openProviderSettings })}
                  onOpenThread={(threadId) => {
                    props.onOpenWorkThread?.(threadId as WorkThreadId, project.id);
                  }}
                  {...(props.onDraftSelectProvider === undefined
                    ? {}
                    : { onSelectProvider: props.onDraftSelectProvider })}
                  {...(props.workOverviewModel === undefined
                    ? {}
                    : { overviewModel: props.workOverviewModel })}
                  projectId={project.id}
                  projectName={project.name}
                  providerGroups={props.workProviderGroups ?? props.draftProviderGroups ?? []}
                  {...(props.draftSelectedModelId === undefined
                    ? {}
                    : { selectedModelId: props.draftSelectedModelId })}
                  {...(props.draftSelectedProviderInstanceId === undefined
                    ? {}
                    : { selectedProviderInstanceId: props.draftSelectedProviderInstanceId })}
                />
              ),
            }
          : {})}
        {...(project.type === "work" && availability?.status !== "unavailable"
          ? {
              workPromotion: (
                <WorkPromotionFlow
                  controller={props.workPromotionController}
                  originProjectName={project.name}
                  targetCodeProjectLabels={props.projects
                    .filter(
                      (candidate) => candidate.type === "code" && candidate.lifecycle === "active",
                    )
                    .map((candidate) => ({ id: candidate.id, name: candidate.name }))}
                  providerChoices={props.codeProviderChoices}
                  onOpenLinkedCodeThread={props.onOpenCodeThread}
                />
              ),
            }
          : {})}
        key={project.id}
        {...(availability === undefined ? {} : { availability })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.folderBrowseClient === undefined
          ? {}
          : { folderBrowseClient: props.folderBrowseClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        onArchive={props.onArchiveProject}
        onRelink={props.onRelinkProject}
        onRename={props.onRenameProject}
        project={project}
        canvasInventory={
          props.canvasClient !== undefined && props.onOpenCanvas !== undefined ? (
            <ProjectCanvasInventory
              client={props.canvasClient}
              onOpenCanvas={props.onOpenCanvas}
              projectId={project.id}
            />
          ) : undefined
        }
      />
    );
  }
  if (tab.mode === "chat") {
    return (
      <ChatWelcome
        {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
        {...(props.selectedCreateHostId === undefined
          ? {}
          : { selectedHostId: props.selectedCreateHostId })}
        {...(props.fixedCreateHostId === undefined ? {} : { fixedHostId: props.fixedCreateHostId })}
        {...(props.lastSelectedHealthyHostId === undefined
          ? {}
          : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
        {...(props.createHostViewScope === undefined
          ? {}
          : { viewScope: props.createHostViewScope })}
        {...(props.onSelectCreateHost === undefined
          ? {}
          : { onSelectHost: props.onSelectCreateHost })}
        {...(props.chatWelcomeError === undefined
          ? props.chatController.errorMessage === undefined
            ? {}
            : { errorMessage: props.chatController.errorMessage }
          : { errorMessage: props.chatWelcomeError })}
        {...(props.chatWelcomeCreating === undefined
          ? {}
          : { creating: props.chatWelcomeCreating })}
        onCreateChat={(prompt) => props.onCreateChat(prompt)}
        providerGroups={props.draftProviderGroups ?? []}
        {...(props.draftSelectedProviderInstanceId === undefined
          ? {}
          : { selectedProviderInstanceId: props.draftSelectedProviderInstanceId })}
        {...(props.draftSelectedModelId === undefined
          ? {}
          : { selectedModelId: props.draftSelectedModelId })}
        {...(props.onDraftSelectProvider === undefined
          ? {}
          : { onSelectProvider: props.onDraftSelectProvider })}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
        onRetry={props.chatController.retry}
        status={props.chatController.status}
      />
    );
  }
  return (
    <AgentModeWelcome
      mode={tab.mode === "code" ? "code" : "work"}
      onAddFolder={props.onAttachFolder ?? (() => {})}
      {...(props.onOpenDraftThread === undefined
        ? {}
        : {
            onOpenDraft: () => props.onOpenDraftThread?.(tab.mode === "code" ? "code" : "work"),
          })}
      providerReady={props.providerReady ?? true}
      {...(props.providerBootstrapMessage === undefined
        ? {}
        : { providerMessage: props.providerBootstrapMessage })}
    />
  );
}

function isHostQualifiedThreadTab(
  tab: WorkspaceTab,
): tab is
  | Extract<WorkspaceTab, { readonly kind: "work-thread" }>
  | Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }> {
  return (tab.kind === "work-thread" || isCodeWorkspaceTab(tab)) && tab.hostId !== undefined;
}

class CodeWorkspaceErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ShellState
        action={{ label: "Reload Octant", onClick: () => globalThis.location.reload() }}
        eyebrow="Code workspace"
        message="Reload Octant to retry this Code surface."
        state="warning"
        title="Code surface unavailable"
      />
    );
  }
}

function isCodeWorkspaceTab(
  tab: WorkspaceTab,
): tab is Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }> {
  return (
    tab.kind === "code-overview" ||
    tab.kind === "code-file" ||
    tab.kind === "code-diff" ||
    tab.kind === "code-terminal" ||
    tab.kind === "code-test" ||
    tab.kind === "code-git" ||
    tab.kind === "code-pr" ||
    tab.kind === "code-local-review" ||
    tab.kind === "apple-workbench"
  );
}

/**
 * Realize a prepared Local servers Open target as a host-owned Browser context
 * of its own.
 *
 * Every Open mints a fresh context confined to exactly the one prepared origin
 * and returns its identity, so the caller can open a tab bound to *that*
 * context. Nothing is reconciled against the thread's existing context: a
 * second classified server neither inherits the first server's origin nor stops
 * its session to take the slot.
 */
async function openLocalServerBrowserContext(
  client: BrowserAutomationClient,
  threadId: BrowserThreadId,
  target: LocalServerOpenTarget,
): Promise<BrowserContextId> {
  const scope = await client.resolve({ threadId, mode: "code" });
  const snapshot = await client.create({
    threadId,
    action: makeBrowserToolAction(
      scope,
      "Open one classified local server in a host-owned isolated browser context.",
    ),
    policy: {
      profileMode: "isolated",
      allowedOrigins: [target.allowedOrigin],
      credentialFieldProtection: true,
      maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
      sessionTimeoutMs: 300_000,
      // The host already decided this, and only for a loopback HTTPS origin: an
      // HTTPS dev server's self-signed localhost certificate is accepted by this
      // one context and nowhere else.
      ...(target.acceptsLocalCertificate ? { acceptsLocalCertificate: true } : {}),
    },
    dedicated: true,
  });
  const context = snapshot.context;
  if (context === undefined || context.state !== "active") {
    throw new Error(snapshot.failure?.message ?? "The host Browser context is unavailable.");
  }
  // Only the returned identity is adopted: the caller names a Browser tab after
  // it, and closing that tab is what stops the context. A context this Open
  // created but never returned is reachable from no tab, so it would hold a host
  // Browser session until the session timeout with no user close path. Release
  // it here and let the honest Open failure reach the user either way.
  try {
    await client.act({
      actionId: context.actionId,
      contextId: context.contextId,
      correlationId: context.correlationId,
      authority: scope.authority,
      kind: "navigate",
      target: String(target.url),
    });
  } catch (error) {
    await releaseBrowserContext(client, threadId, context.contextId);
    throw error;
  }
  return context.contextId;
}

/**
 * Stop a dedicated Browser context that no tab owns, so it cannot hold a host
 * Browser session no user control can reach.
 *
 * Best-effort by design: a failed release must not replace or swallow the
 * honest Open failure the caller is about to report.
 */
async function releaseBrowserContext(
  client: BrowserAutomationClient,
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
): Promise<void> {
  await client.stop({ contextId, threadId }).catch(() => undefined);
}

function resolveCodeTabProject(
  tab: Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }>,
  props: WorkspaceViewProps,
): ProjectSummary | undefined {
  const projectId = props.codeController.navigation?.find(
    (item) => String(item.threadId) === String(tab.threadId),
  )?.projectId;
  if (projectId === undefined) return undefined;
  return props.projects.find((project) => String(project.id) === String(projectId));
}

/**
 * The checkout bound to this tab's own thread. In a split, panes render
 * threads other than the controller's focused view, so the focused view's
 * checkout applies only when it belongs to this thread; otherwise the
 * bootstrap thread record supplies the thread–checkout pair the server's
 * checkout authorization will actually accept.
 */
function resolveCodeTabCheckoutId(
  tab: Extract<WorkspaceTab, { readonly mode: "code"; readonly threadId: unknown }>,
  controller: CodeController,
): CodeCheckoutId | undefined {
  const view = controller.activeView;
  if (view !== undefined && String(view.thread.id) === String(tab.threadId)) {
    return view.checkout.id;
  }
  return controller.bootstrap?.threads.find((thread) => String(thread.id) === String(tab.threadId))
    ?.checkoutId;
}

function ChatThreadWorkspace(props: {
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly environmentPresentation: EnvironmentPresentationState;
  readonly extensionClient?: ExtensionClient;
  readonly onOpenSettings?: () => void;
  readonly onClearCanvasSelections: () => void;
  readonly onRemoveCanvasSelection: (selectionId: CanvasContextSelectionId) => void;
  readonly onSetEnvironmentPresentation: (next: EnvironmentPresentationState) => void;
  readonly pendingCanvasSelections: ReadonlyArray<CanvasContextSelection>;
  readonly projectServerUrl?: string;
  readonly projectWindowCapability?: string;
  readonly canvasClient?: CanvasClient;
  readonly hostId?: string;
  readonly onOpenCanvasReference?: (card: CanvasThreadReferenceCard) => void;
  /** Opens another Chat thread as a workspace tab — e.g. a branch just minted. */
  readonly onOpenThread?: (threadId: ChatThreadId, title: string, projectId?: ProjectId) => void;
  /** Opens the Side Chat tab for a sidecar the host has already resolved. */
  readonly onOpenSideChat?: (sidecar: SideChatSidecar) => void;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly providerController: ProviderController;
  readonly tab: Extract<WorkspaceTab, { kind: "chat-thread" }>;
  readonly threadId: Extract<WorkspaceTab, { kind: "chat-thread" }>["threadId"];
  readonly childRunStatus?: ReactNode;
}) {
  const controller = useChatController({
    activeThreadId: props.threadId,
    client: props.chatClient,
    readCursorStore: props.chatReadCursorStore,
  });
  const providerOrder = props.providerController.defaults?.providerOrder ?? [];
  const providerGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: props.providerController.instances ?? [],
        observedByInstance: props.providerController.observedByInstance ?? new Map(),
        providerOrder,
        mode: "chat",
      }),
    [
      props.providerController.instances,
      props.providerController.observedByInstance,
      providerOrder,
    ],
  );
  return (
    <ChatThreadEnvironment
      controller={controller}
      onChangePresentation={props.onSetEnvironmentPresentation}
      presentation={props.environmentPresentation}
      projects={props.projects}
      tab={props.tab}
    >
      <ChatWorkspace
        controller={controller}
        providerGroups={providerGroups}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
        onClearCanvasSelections={props.onClearCanvasSelections}
        onRemoveCanvasSelection={props.onRemoveCanvasSelection}
        pendingCanvasSelections={props.pendingCanvasSelections}
        {...(props.extensionClient === undefined ? {} : { extensionClient: props.extensionClient })}
        {...(props.projectServerUrl === undefined ? {} : { serverUrl: props.projectServerUrl })}
        {...(props.projectWindowCapability === undefined
          ? {}
          : { windowCapability: props.projectWindowCapability })}
        {...(props.providerController.snapshot === undefined
          ? {}
          : { providerSnapshot: props.providerController.snapshot })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId as HostId })}
        {...(props.onOpenCanvasReference === undefined
          ? {}
          : { onOpenCanvas: props.onOpenCanvasReference })}
        {...(props.onOpenThread === undefined
          ? {}
          : {
              onThreadBranched: (thread: ChatThread) =>
                props.onOpenThread?.(thread.id, thread.title, thread.projectId),
            })}
        {...(props.onOpenSideChat === undefined ? {} : { onOpenSideChat: props.onOpenSideChat })}
        {...(props.childRunStatus === undefined ? {} : { childRunStatus: props.childRunStatus })}
      />
    </ChatThreadEnvironment>
  );
}

function findWorkspacePane(
  workspace: WorkspaceViewProps["workspace"],
  paneId: PaneId,
): WorkspacePane | undefined {
  for (const mode of ["chat", "work", "code"] as const) {
    const found = findPaneInLayout(workspace.layouts[mode], paneId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findPaneInLayout(layout: WorkspaceLayoutNode, paneId: PaneId): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId) ? layout : undefined;
  }
  return findPaneInLayout(layout.first, paneId) ?? findPaneInLayout(layout.second, paneId);
}

function WorkProjectOverviewSlot(props: {
  readonly availability?: ProjectAvailability;
  readonly client?: WorkOverviewClient;
  readonly researchClient?: WorkResearchClient;
  readonly createStarterArtifactAvailable: boolean;
  readonly createThreadAvailable: boolean;
  readonly hosts?: ReadonlyArray<HostIdentity>;
  readonly selectedHostId?: import("@octant/contracts/host").HostId;
  readonly fixedHostId?: import("@octant/contracts/host").HostId;
  readonly lastSelectedHealthyHostId?: import("@octant/contracts/host").HostId;
  readonly viewScope?: import("@octant/domain").CreateHostViewScope;
  readonly onSelectHost?: (hostId: import("@octant/contracts/host").HostId) => void;
  readonly mutationClient?: WorkMutationClient;
  readonly onReloadPromotion: () => Promise<void>;
  readonly onCreateThread: (
    draft: string,
    images?: ReadonlyArray<File>,
  ) => boolean | Promise<boolean>;
  readonly onOpenSettings?: () => void;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onSelectProvider?: (selection: {
    readonly providerInstanceId: import("@octant/contracts/providers").ProviderInstanceId;
    readonly modelId: import("@octant/contracts/providers").ProviderModelId;
  }) => void;
  readonly overviewModel?: WorkOverviewModel;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly providerGroups: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly selectedModelId?: import("@octant/contracts/providers").ProviderModelId;
  readonly selectedProviderInstanceId?: import("@octant/contracts/providers").ProviderInstanceId;
}) {
  const researchController = useWorkResearchController({
    client: props.researchClient,
    enabled: props.researchClient !== undefined,
    projectId: props.projectId,
    // Finalizing a report writes the deliverable through the ordinary Work
    // artifact workflow; without that authority the panel omits the affordance
    // instead of offering a control the host would refuse.
    ...(props.mutationClient === undefined ? {} : { mutationClient: props.mutationClient }),
  });
  const controller = useWorkOverviewController({
    ...(props.availability === undefined ? {} : { availability: props.availability }),
    client: props.client,
    enabled: props.client !== undefined && props.overviewModel === undefined,
    projectId: props.projectId,
  });
  const model =
    props.overviewModel ??
    (props.client !== undefined
      ? controller.model
      : buildWorkOverviewModel(
          props.availability === undefined ? {} : { availability: props.availability },
        ));
  const createStarterArtifactAvailable =
    props.createStarterArtifactAvailable && props.mutationClient !== undefined;
  const handleCreateStarterArtifact = useCallback(
    async (draft: {
      readonly content: string;
      readonly displayName: string;
      readonly format: "markdown";
    }) => {
      if (!createStarterArtifactAvailable || props.mutationClient === undefined) return false;
      try {
        const reply = await props.mutationClient.mutate({
          kind: "create-artifact",
          requestId: decodeWorkMutationRequestId(globalThis.crypto.randomUUID()),
          projectId: props.projectId,
          format: draft.format,
          displayName: draft.displayName,
          content: draft.content,
        });
        if (reply.outcome.kind !== "created") return false;
        controller.retry();
        await props.onReloadPromotion();
        return true;
      } catch {
        return false;
      }
    },
    [
      controller,
      createStarterArtifactAvailable,
      props.mutationClient,
      props.onReloadPromotion,
      props.projectId,
    ],
  );
  return (
    <WorkOverview
      {...(props.researchClient === undefined
        ? {}
        : {
            research: (
              <WorkResearchPanel
                briefs={researchController.briefs}
                status={researchController.status}
                onRetry={researchController.reload}
                onCreateBrief={researchController.createBrief}
                onAddSource={researchController.addSource}
                onRevokeSource={researchController.revokeSource}
                onRecordEvidence={researchController.recordEvidence}
                onRecordClaim={researchController.recordClaim}
                {...(props.mutationClient === undefined
                  ? {}
                  : { onFinalizeReport: researchController.finalizeReport })}
              />
            ),
          })}
      createStarterArtifactAvailable={createStarterArtifactAvailable}
      createThreadAvailable={props.createThreadAvailable}
      {...(props.hosts === undefined ? {} : { hosts: props.hosts })}
      {...(props.selectedHostId === undefined ? {} : { selectedHostId: props.selectedHostId })}
      {...(props.fixedHostId === undefined ? {} : { fixedHostId: props.fixedHostId })}
      {...(props.lastSelectedHealthyHostId === undefined
        ? {}
        : { lastSelectedHealthyHostId: props.lastSelectedHealthyHostId })}
      {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
      {...(props.onSelectHost === undefined ? {} : { onSelectHost: props.onSelectHost })}
      model={model}
      onCreateStarterArtifact={handleCreateStarterArtifact}
      onCreateThread={props.onCreateThread}
      {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
      {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
      {...(props.onSelectProvider === undefined
        ? {}
        : { onSelectProvider: props.onSelectProvider })}
      projectName={props.projectName}
      providerGroups={props.providerGroups}
      {...(props.selectedModelId === undefined ? {} : { selectedModelId: props.selectedModelId })}
      {...(props.selectedProviderInstanceId === undefined
        ? {}
        : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
    />
  );
}
