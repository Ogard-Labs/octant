import { createContextClient, type ContextClient } from "@octant/client-runtime/context-client";
import { createChatClient, type ChatClient } from "@octant/client-runtime/chat-client";
import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import { ArtifactLibrarySurface } from "./artifacts/ArtifactLibrarySurface";
import { AutomationCenter } from "./automation/AutomationCenter";
import type { AutomationEditorCatalog } from "./automation/automationCenterModel";
import { buildAutomationEditorCatalog } from "./automation/automationEditorCatalog";
import {
  createComputerUseClient,
  type ComputerUseClient,
} from "@octant/client-runtime/computer-use-client";
import {
  createWorkThreadClient,
  type WorkThreadClient,
} from "@octant/client-runtime/work-thread-client";
import { createWorkTurnClient, type WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { createPreviewClient } from "@octant/client-runtime/preview-client";
import { createCanvasClient } from "@octant/client-runtime/canvas-client";
import { createWorkOverviewClient } from "@octant/client-runtime/work-overview-client";
import { createWorkResearchClient } from "@octant/client-runtime/work-research-client";
import { createGoalClient } from "@octant/client-runtime/goal-client";
import { createGoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import { createShipClient } from "@octant/client-runtime/ship-client";
import { createPlanClient } from "@octant/client-runtime/plan-client";
import { createUsageDashboardClient } from "@octant/client-runtime";
import type { UsageQueryFilter } from "@octant/contracts/usage-rpc";
import { UsageWorkspace } from "./usage/UsageWorkspace";
import { createWorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import { createWorkRequestClient } from "@octant/client-runtime/work-request-client";
import { createFolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import { createUsageClient } from "@octant/client-runtime/usage-client";
import { createDiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import { createHostControlClient } from "@octant/client-runtime/host-control-client";
import { createGithubClient } from "@octant/client-runtime/github-client";
import { createGithubCloneClient } from "@octant/client-runtime/github-clone-client";
import { createAgentProfileClient, type AgentProfileClient } from "@octant/client-runtime";
import { createAgentRunClient, type AgentRunClient } from "@octant/client-runtime/agent-run-client";
import {
  createAgentRunSettingsClient,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { createAutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import {
  createExtensionClient,
  type ExtensionClient,
} from "@octant/client-runtime/extension-client";
import {
  createBrowserAutomationClient,
  type BrowserAutomationClient,
} from "@octant/client-runtime/browser-automation-client";
import { createHostClient, type HostClient } from "@octant/client-runtime/host-client";
import {
  createNavigatorAssistantClient,
  type NavigatorAssistantClient,
} from "@octant/client-runtime/navigator-assistant-client";
import {
  createAutomationClient,
  isRemotePairingOrigin,
  readPairingFragment,
  type AutomationClient,
} from "@octant/client-runtime";
import {
  createAppleToolchainClient,
  type AppleToolchainClient,
} from "@octant/client-runtime/apple-toolchain-client";
import { decodeChatThreadId, type ChatThreadId } from "@octant/contracts/chat";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import {
  decodeCodeThread,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  type CodeDeliveryOutcomeKind,
  type CodeThreadId,
} from "@octant/contracts/code";
import type { CodeComposerSubmitInput } from "./code/composer/CodeComposerAdapter";
import { decodeContextSubjectRef } from "@octant/contracts/context";
import { decodeWorkThreadId, decodeWorkTurnId, decodeWorkTurnRequestId } from "@octant/contracts";
import type { CodeOperationId } from "@octant/contracts";
import { decodeWindowId, type WindowId } from "@octant/contracts/shell";
import type { ProductSurfaceSettings } from "@octant/contracts/modes";
import type { OctantMode } from "@octant/contracts/modes";
import type { ThemeTypography } from "@octant/contracts/theme";
import type { ShellClient } from "@octant/client-runtime/shell-client";
import type { ThemeClient } from "@octant/client-runtime/theme-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import { decodeProjectId, type ProjectId, type ProjectSummary } from "@octant/contracts/projects";
import { enabledModes } from "@octant/domain/mode-policy";
import {
  defaultEnvironmentPresentationState,
  defaultShellSettings,
} from "@octant/domain/shell-policy";
import type { UserProfile } from "@octant/contracts/user-profile";
import {
  enforceAccessibilitySettings,
  enforceSidebarBackgroundAccessibility,
  resolveEffectiveSidebarBackground,
} from "@octant/domain/theme-policy";
import {
  buildModelPickerGroups,
  preselectCreateHost,
  resolveDraftProviderSelection,
} from "@octant/domain";
import type { CreateHostViewScope, ModelPickerSelection } from "@octant/domain";
import { resolveSidebarBackground } from "@octant/theme/backgrounds";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./styles.css";
import "./styles/shell.css";
import "./styles/dock.css";
// The shared component/material layer loads last so its assignments win.
import "./styles/components.css";
import { ShellSidebar } from "./shell/ShellSidebar";
import { WindowChrome } from "./shell/WindowChrome";
import type { CodeDeepLink, OctantHostBridge, ResolvedSidebarMaterial } from "./shell/hostBridge";
import { collectThreadAttentionSignals } from "./notifications/collectThreadAttention";
import { useThreadAttentionNotifications } from "./notifications/useThreadAttentionNotifications";
import { useShellController, type NativeShellHost } from "./shell/useShellController";
import { useHostObservation } from "./shell/useHostObservation";
import {
  defaultCreateHostId,
  readLastSelectedHealthyHostId,
  rememberHealthyCreateHost,
} from "./shell/createHostPreference";
import { useLaunchSession } from "./shell/useLaunchSession";
import { WorkspaceView } from "./shell/WorkspaceView";
import { useWorkPromotionController } from "./work/useWorkPromotionController";
import { ShellState } from "./shell/ShellState";
import { ProjectCreateDialog } from "./projects/ProjectCreateDialog";
import { ThreadSearchOverlay, type ThreadSearchListingStatus } from "./shell/ThreadSearchOverlay";
import { FirstRunOnboarding } from "./onboarding/FirstRunOnboarding";
import type { WorkspaceChoices } from "./onboarding/firstRunStepModel";
import {
  describeDiscoveryNotice,
  summarizeFirstRunReadiness,
} from "./onboarding/firstRunReadinessModel";
import {
  useFirstRunOnboardingController,
  type FirstRunOnboardingOutcome,
} from "./onboarding/useFirstRunOnboardingController";
import type { ThreadSearchThread } from "./shell/threadSearchViewModel";
import { ProjectSidebarSection } from "./projects/ProjectSidebarSection";
import { OctantButton } from "./ui/base/OctantButton";
import { useProjectController } from "./projects/useProjectController";
import {
  ProjectMemoryInspector,
  ProjectMemoryInspectorProvider,
} from "./projects/ProjectMemoryInspector";
import {
  ProjectThreadsProvider,
  type ProjectThreadsAccess,
} from "./projects/ProjectThreadsSection";
import { useProviderController } from "./providers/useProviderController";
import { useDiscoveryController } from "./providers/useDiscoveryController";
import { useProviderBootstrap } from "./providers/useProviderBootstrap";
import { hasSelectableProviderModels } from "./providers/providerBootstrapPolicy";
import { useArchivedChatThreadSearch } from "./chat/useArchivedChatThreadSearch";
import { createChatReadCursorStore, useChatController } from "./chat/useChatController";
import {
  autoConfigureChatDefaults,
  chatDefaultModelCommand,
} from "./chat/autoConfigureChatDefaults";
import { ShellFrame, ShellThemeRoot } from "./shell/ShellFrame";
import { SettingsSurfaceErrorBoundary } from "./shell/SettingsSurfaceErrorBoundary";
import { RemotePairingView } from "./remote/RemotePairingView";
import { RightUtilityDock } from "./shell/RightUtilityDock";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  resolveRightUtilityDockSurface,
  type RightUtilityDockResolution,
  type RightUtilityDockSurfaceAvailability,
  type RightUtilityDockSurfaceId,
} from "./shell/rightUtilityDockModel";
import { ContextInspector } from "./context/ContextInspector";
import { NavigatorPanel } from "./navigator/NavigatorPanel";
import { useNavigatorAssistant } from "./navigator/useNavigatorAssistant";
import { ContextStatusBar } from "./context/ContextStatusBar";
import { ContextTabWarning } from "./context/ContextTabWarning";
import { useContextController } from "./context/useContextController";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { createCodeReadCursorStore, useCodeController } from "./code/useCodeController";
import {
  CodeThreadControllerSlots,
  createCodeThreadControllers,
  useCodeThreadController,
} from "./code/codeThreadControllers";
import { CodeSearchDialog } from "./code/CodeSearchDialog";
import { planCodeThreadCreate, type CodeThreadProviderChoice } from "./code/codeThreadCreate";
import { CodeThreadBoard } from "./code/CodeThreadBoard";
import type { ZenClient } from "@octant/client-runtime/zen-client";
import { ZenRoot } from "./zen/ZenRoot";
import { ZenSurface } from "./zen/ZenSurface";
import { ZenCanvasCard } from "./zen/ZenCanvasCard";
import { ZenResearchDock } from "./zen/ZenResearchDock";
import { ZenTerminalCard } from "./zen/ZenTerminalCard";
import { useZenController } from "./zen/useZenController";
import { resolveZenLiveThreadCard, type ZenLiveThreadClients } from "./zen/ZenLiveThreadCards";
import { useAppleProjects } from "./apple/useAppleProjects";
import { useThemeController } from "./theme/useThemeController";
import { ExecutionProfileWorkflow } from "./agentProfile/ExecutionProfileWorkflow";
import { useExecutionProfileController } from "./agentProfile/useExecutionProfileController";
import { useWorkThreadNavigation } from "./work/useWorkThreadNavigation";
import type { ThreadRowActions } from "./projects/ThreadRowMenu";
import type {
  ChatThreadNavigationItem,
  ThreadProviderIdentity,
  ThreadRowActivity,
} from "./shell/navigationModel";
import { ComputerUseActivitySurface } from "./computerUse/ComputerUseActivitySurface";
import { useHostFederationLifecycle } from "./host/useHostFederationLifecycle";
import { FederatedHostsLifecycleStrip } from "./host/FederatedHostsLifecyclePanel";
import { CommandPalette } from "./palette/CommandPalette";
import { OctantCommandProvider } from "./palette/CommandRegistry";
import { buildOctantCommands, type CommandProject } from "./palette/buildOctantCommands";
import { useCommandSkills } from "./palette/useCommandSkills";

const LazySettingsView = lazy(async () => {
  const module = await import("./shell/SettingsView");
  return { default: module.SettingsView };
});

interface InspectorOpener {
  readonly element: HTMLElement;
  readonly logicalTarget: "dock";
}

/** Words for an agent profile's default policy, so a row never relies on colour. */
const EXECUTION_POLICY_LABEL: Record<
  import("@octant/contracts/providers").ProviderExecutionPolicy,
  string
> = {
  "full-access": "Full access",
  "approval-gated": "Approval gated",
  "auto-accept-edits": "Auto-accept edits",
  plan: "Plan",
};

const visuallyHiddenStyle = {
  border: 0,
  clip: "rect(0, 0, 0, 0)",
  clipPath: "inset(50%)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute" as const,
  whiteSpace: "nowrap" as const,
  width: 1,
};

export interface ShellLaunch {
  readonly serverUrl: string;
  readonly windowId?: WindowId;
  readonly developmentWebBootstrap?: true;
}

export interface AppProps {
  readonly agentProfileClient?: AgentProfileClient;
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly automationClient?: AutomationClient;
  readonly chatClient?: ChatClient;
  readonly codeClient?: CodeClient;
  readonly computerUseClient?: ComputerUseClient;
  readonly contextClient?: ContextClient;
  readonly workThreadClient?: WorkThreadClient;
  readonly workTurnClient?: WorkTurnClient;
  readonly hostBridge?: OctantHostBridge;
  readonly hostClient?: HostClient;
  readonly isNarrow?: boolean;
  readonly launch?: ShellLaunch;
  readonly nativeHost?: NativeShellHost;
  readonly projectClient?: ProjectClient;
  readonly projectWindowCapability?: string;
  readonly providerClient?: ProviderClient;
  /** Optional injected settings; the shell otherwise derives them from its bootstrap. */
  readonly settings?: ProductSurfaceSettings;
  readonly typography?: ThemeTypography;
  readonly availableFonts?: ReadonlyArray<string>;
  readonly developmentAuthentication?: boolean;
  readonly extensionClient?: ExtensionClient;
  readonly navigatorAssistantClient?: NavigatorAssistantClient;
  readonly shellClient?: ShellClient;
  readonly themeClient?: ThemeClient;
  readonly zenClient?: ZenClient;
}

/**
 * What a draft that named a Project resolves to. `unresolved-selection` is its
 * own answer because an explicitly chosen Project that no longer exists is not
 * the same question as a draft that never named one.
 */
export type DraftProjectResolution<TProject> =
  | { readonly kind: "project"; readonly project: TProject | undefined }
  | { readonly kind: "unresolved-selection" };

/**
 * Resolve the Project a draft submits into.
 *
 * An explicitly chosen Project id is authoritative. When it no longer resolves
 * — archived or deleted while the draft stayed open — the draft is refused, not
 * retargeted: substituting whatever Project happens to be active would create
 * the thread, and start its first provider turn, in a repository or folder the
 * user never chose. Only a draft that named no Project at all falls back to the
 * active one.
 */
export function resolveDraftProject<TProject extends { readonly id: ProjectId }>(input: {
  readonly draftProjectId: ProjectId | undefined;
  readonly candidates: ReadonlyArray<TProject>;
  readonly activeProject: TProject | undefined;
}): DraftProjectResolution<TProject> {
  if (input.draftProjectId === undefined) {
    return { kind: "project", project: input.activeProject };
  }
  const chosen = input.candidates.find(
    (candidate) => String(candidate.id) === String(input.draftProjectId),
  );
  return chosen === undefined
    ? { kind: "unresolved-selection" }
    : { kind: "project", project: chosen };
}

/** Shown when a draft's explicitly chosen Project no longer resolves. */
const UNRESOLVED_DRAFT_PROJECT_MESSAGE =
  "The folder this draft was started in is no longer available. Choose another folder before starting the thread.";

/**
 * Any directory can be bound as a Code Project, but a Code thread still needs a
 * repository checkout. Say what to do instead of a generic preparation error.
 */
function checkoutNotPreparedMessage(projectName: string): string {
  return `Code threads need a Git repository, and "${projectName}" could not be opened as one. Run git init in that folder and retry, or add the same folder as a Work Project to work there without Git.`;
}

export function resolveWorkProviderChoice(
  choices: ReadonlyArray<CodeThreadProviderChoice>,
  selectedProviderInstanceId?: CodeThreadProviderChoice["instanceId"],
  selectedModelId?: CodeThreadProviderChoice["modelId"],
): CodeThreadProviderChoice | undefined {
  return (
    choices.find(
      (choice) =>
        choice.instanceId === selectedProviderInstanceId && choice.modelId === selectedModelId,
    ) ?? choices[0]
  );
}

export function App(props: AppProps) {
  const [locationLaunch] = useState(() => launchFromLocation(window.location.href));
  const launch = props.launch ?? locationLaunch;
  const injectedCapability =
    props.projectWindowCapability ?? props.hostBridge?.projectWindowCapability;
  const launchSession = useLaunchSession({
    ...(injectedCapability === undefined && launch !== undefined
      ? { serverUrl: launch.serverUrl }
      : {}),
    onExchanged: clearLaunchTokenFragment,
    allowDevelopmentBootstrap: launch?.developmentWebBootstrap === true,
  });

  // Remote browser entry: without a desktop launch token, a
  // non-loopback origin is the pairing surface (typed code or fragment ticket).
  // Localhost without launch still falls through to the desktop-session warning.
  if (injectedCapability === undefined && launch === undefined && typeof window !== "undefined") {
    const pairingTicket = readPairingFragment(window.location.href);
    const isRemote = isRemotePairingOrigin(window.location.href);
    if (pairingTicket !== undefined || isRemote) {
      const baseUrl = new URL(window.location.href).origin;
      return (
        <main className="shell-boundary">
          <RemotePairingView baseUrl={baseUrl} ticket={pairingTicket} />
        </main>
      );
    }
  }

  if (launch === undefined) {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Desktop session"
          message="Open this renderer from the Octant desktop application."
          state="warning"
          title="Octant launch configuration is unavailable"
        />
      </main>
    );
  }

  if (injectedCapability === undefined) {
    if (launchSession.status === "loading") {
      return (
        <main className="shell-boundary">
          <ShellState
            eyebrow="Browser session"
            message="Establishing the authenticated Octant browser session."
            state="loading"
            title="Opening Octant"
          />
        </main>
      );
    }
    if (launchSession.status === "ready" && isProjectWindowCapability(launchSession.capability)) {
      const resolvedWindowId = launchSession.windowId ?? launch.windowId;
      if (resolvedWindowId === undefined) {
        return (
          <main className="shell-boundary">
            <ShellState
              eyebrow="Project authority"
              message="Octant could not establish the window identity for this browser session."
              state="warning"
              title="Project authority is unavailable"
            />
          </main>
        );
      }
      const resolvedLaunch: ShellLaunch & { windowId: WindowId } = {
        serverUrl: launch.serverUrl,
        windowId: resolvedWindowId,
      };
      return (
        <LaunchedShell
          {...props}
          launch={resolvedLaunch}
          projectWindowCapability={launchSession.capability}
          developmentAuthentication={launchSession.authentication === "development-bypass"}
        />
      );
    }
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Project authority"
          message={
            launchSession.failureMessage ??
            "Retry from `octant web` or the Octant desktop application to establish this window session."
          }
          state="warning"
          title="Project authority is unavailable"
        />
      </main>
    );
  }

  if (!isProjectWindowCapability(injectedCapability)) {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Project authority"
          message="Retry from the Octant desktop application to establish this window session."
          state="warning"
          title="Project authority is unavailable"
        />
      </main>
    );
  }
  if (launch.windowId === undefined) {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Desktop session"
          message="Open this renderer from the Octant desktop application."
          state="warning"
          title="Octant launch configuration is unavailable"
        />
      </main>
    );
  }
  const desktopLaunch: ShellLaunch & { windowId: WindowId } = {
    serverUrl: launch.serverUrl,
    windowId: launch.windowId,
  };
  return (
    <LaunchedShell {...props} launch={desktopLaunch} projectWindowCapability={injectedCapability} />
  );
}

function clearLaunchTokenFragment(): void {
  if (window.location.hash === "") return;
  const url = new URL(window.location.href);
  if (url.hash === "" || !url.hash.startsWith("#launchToken=")) return;
  url.hash = "";
  window.history.replaceState(null, "", url.toString());
}

function LaunchedShell(
  props: AppProps & {
    readonly launch: ShellLaunch & { readonly windowId: WindowId };
    readonly projectWindowCapability: string;
  },
) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (props.hostBridge === undefined) {
      delete root.dataset.octantNativeHost;
      return;
    }
    root.dataset.octantNativeHost = "true";
    return () => {
      delete root.dataset.octantNativeHost;
    };
  }, [props.hostBridge]);
  const viewportIsNarrow = useNarrowViewport();
  const isNarrow = props.isNarrow ?? viewportIsNarrow;
  const nativeHost = props.nativeHost ?? props.hostBridge;
  const controller = useShellController({
    ...(props.shellClient === undefined ? {} : { client: props.shellClient }),
    isNarrow,
    ...(nativeHost === undefined ? {} : { nativeHost }),
    serverUrl: props.launch.serverUrl,
    windowId: props.launch.windowId,
  });
  const themeController = useThemeController({
    ...(props.themeClient === undefined ? {} : { client: props.themeClient }),
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  const accessibleThemeDraft = useMemo(
    () =>
      themeController.draft === undefined
        ? undefined
        : enforceSidebarBackgroundAccessibility(
            enforceAccessibilitySettings(themeController.draft),
          ),
    [themeController.draft],
  );
  const presentedShellSettings = useMemo(
    () =>
      controller.settings === undefined
        ? undefined
        : {
            ...controller.settings,
            ...(accessibleThemeDraft === undefined
              ? {}
              : { sidebarBackground: accessibleThemeDraft.sidebarBackground }),
          },
    [accessibleThemeDraft, controller.settings],
  );
  const material = useResolvedMaterial(
    controller.settings?.sidebarMaterial ?? "opaque",
    props.hostBridge,
  );
  const sidebarVibrancySupported = useSidebarVibrancySupported(props.hostBridge);
  useAutomaticUpdateCheckSync(props.hostBridge, controller.settings?.automaticUpdateChecks);
  const sidebarBackgroundFetcher = useSidebarBackgroundFetcher(
    props.launch.serverUrl,
    props.projectWindowCapability,
  );
  const resolvedSidebarBackground = useMemo(
    () =>
      accessibleThemeDraft !== undefined
        ? resolveEffectiveSidebarBackground(accessibleThemeDraft, true)
        : controller.settings === undefined
          ? undefined
          : resolveSidebarBackground(
              {
                sidebarBackground:
                  presentedShellSettings?.sidebarBackground ??
                  controller.settings.sidebarBackground,
              } as never,
              "dark",
            ),
    [accessibleThemeDraft, controller.settings, presentedShellSettings],
  );
  useSidebarVibrancyModeSync(
    props.hostBridge,
    presentedShellSettings?.sidebarBackground.vibrancyMode ?? "off",
    sidebarVibrancySupported,
  );
  const zen = useZenController({
    ...(props.zenClient === undefined ? {} : { client: props.zenClient }),
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
    windowId: props.launch.windowId,
  });
  useEffect(() => {
    if (!zen.active) return;
    void zen.refreshThreads();
  }, [zen.active, zen.refreshThreads]);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftCreating, setDraftCreating] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [draftPendingMessage, setDraftPendingMessage] = useState<string>();
  const [railPlaceholder, setRailPlaceholder] = useState<{
    readonly title: string;
    readonly message: string;
  }>();
  const [codeBoardOpen, setCodeBoardOpen] = useState(false);
  const [automationCenterOpen, setAutomationCenterOpen] = useState(false);
  const [artifactLibraryOpen, setArtifactLibraryOpen] = useState(false);
  const [draftProviderInstanceId, setDraftProviderInstanceId] =
    useState<import("@octant/contracts/providers").ProviderInstanceId>();
  const [draftModelId, setDraftModelId] =
    useState<import("@octant/contracts/providers").ProviderModelId>();
  const [searchOpen, setSearchOpen] = useState(false);
  // The Thread Search query lives here as well as in the overlay, because the
  // archived half of the Chat listing is fetched from the host per query.
  const [searchQuery, setSearchQuery] = useState("");
  const openThreadSearch = useCallback(() => {
    setSearchQuery("");
    setSearchOpen(true);
  }, []);
  const closeThreadSearch = useCallback(() => {
    setSearchQuery("");
    setSearchOpen(false);
  }, []);
  // The Usage destination opens filtered when a thread hands over its own
  // filter, so the compact panel and the full surface cannot disagree about
  // which subject they describe.
  const [usageOpen, setUsageOpen] = useState(false);
  const [pendingUsageFilter, setPendingUsageFilter] = useState<UsageQueryFilter | undefined>(
    undefined,
  );
  const [chatProjectThreadListRequest, setChatProjectThreadListRequest] = useState<
    { readonly projectId: ProjectId; readonly sequence: number } | undefined
  >(undefined);
  const [dockSurface, setDockSurface] = useState<RightUtilityDockSurfaceId>();
  const [dockProjectId, setDockProjectId] = useState<ProjectId>();
  const [previewSidebarWidth, setPreviewSidebarWidth] = useState<number>();
  // Presentation-only: whether the person hid the navigation sidebar. Kept in
  // local storage so a reload does not surprise them with it back.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed(globalThis));
  // Toggling unmounts the button that was activated, so a keyboard user would
  // otherwise be dropped on the document body. Remember which control replaces
  // it and focus that one once the new layout has rendered.
  const sidebarToggleFocusRef = useRef<"Hide sidebar" | "Show sidebar" | undefined>(undefined);
  const setSidebarCollapsedPersistent = useCallback((collapsed: boolean) => {
    sidebarToggleFocusRef.current = collapsed ? "Show sidebar" : "Hide sidebar";
    setSidebarCollapsed(collapsed);
    writeSidebarCollapsed(globalThis, collapsed);
  }, []);
  useLayoutEffect(() => {
    const label = sidebarToggleFocusRef.current;
    if (label === undefined) return;
    sidebarToggleFocusRef.current = undefined;
    document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)?.focus();
  }, [sidebarCollapsed]);
  const [previewContextWidth, setPreviewContextWidth] = useState<number>();
  const [pendingCodeDeepLink, setPendingCodeDeepLink] = useState<CodeDeepLink>();
  const [computerUseSessionRepresentationCounts, setComputerUseSessionRepresentationCounts] =
    useState<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map());
  const onComputerUseSessionChange = useCallback(
    (threadId: string, sessionId: string, represented: boolean) => {
      setComputerUseSessionRepresentationCounts((current) => {
        const next = new Map(current);
        const threadSessions = new Map(current.get(threadId) ?? []);
        const count = threadSessions.get(sessionId) ?? 0;
        if (represented) {
          threadSessions.set(sessionId, count + 1);
        } else if (count <= 1) {
          threadSessions.delete(sessionId);
        } else {
          threadSessions.set(sessionId, count - 1);
        }
        if (threadSessions.size === 0) {
          next.delete(threadId);
        } else {
          next.set(threadId, threadSessions);
        }
        return next;
      });
    },
    [],
  );
  const representedComputerUseSessions = useMemo(() => {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [threadId, sessionCounts] of computerUseSessionRepresentationCounts) {
      next.set(threadId, new Set(sessionCounts.keys()));
    }
    return next;
  }, [computerUseSessionRepresentationCounts]);
  const initialProjectTargetConsumed = useRef(false);
  const autoChatDefaultsAttempt = useRef<string | undefined>(undefined);
  const [contextSnapshotsByProject, setContextSnapshotsByProject] = useState<
    ReadonlyMap<ProjectId, ContextInspectorSnapshot>
  >(new Map());
  const dockOpener = useRef<InspectorOpener | undefined>(undefined);
  const pendingDockFocus = useRef<InspectorOpener | undefined>(undefined);
  const initialDockRestoreAttempted = useRef(false);
  const previousActiveDraftKey = useRef<string | undefined>(undefined);
  const previousProjectLifecycle = useRef<
    | {
        readonly id: ProjectId;
        readonly lifecycle: ProjectSummary["lifecycle"];
      }
    | undefined
  >(undefined);
  const activeMode = controller.workspace?.activeMode ?? "chat";
  const activeGroupId = controller.workspace?.activeGroupIds[activeMode];
  const selectedProjectTabId =
    controller.workspace === undefined || activeGroupId === undefined
      ? undefined
      : activeProjectTabId(controller.workspace.layouts[activeMode], activeGroupId);
  const activeChatThreadId =
    controller.workspace === undefined || activeGroupId === undefined || activeMode !== "chat"
      ? undefined
      : activeChatThreadTabId(controller.workspace.layouts.chat, activeGroupId);
  const activeCodeThreadId =
    controller.workspace === undefined || activeGroupId === undefined || activeMode !== "code"
      ? undefined
      : activeCodeThreadTabId(controller.workspace.layouts.code, activeGroupId);
  const activeWorkThreadId =
    controller.workspace === undefined || activeGroupId === undefined || activeMode !== "work"
      ? undefined
      : activeWorkThreadTabId(controller.workspace.layouts.work, activeGroupId);
  const activeDraftKey =
    controller.workspace === undefined || activeGroupId === undefined
      ? undefined
      : activeDraftTabKey(controller.workspace.layouts[activeMode], activeGroupId);
  useEffect(() => {
    if (activeDraftKey === undefined) return;
    const previous = previousActiveDraftKey.current;
    previousActiveDraftKey.current = activeDraftKey;
    if (previous === undefined || previous === activeDraftKey) return;
    setDraftCreating(false);
    setDraftError(undefined);
    setDraftPendingMessage(undefined);
  }, [activeDraftKey]);
  const chatClient = useMemo(
    () =>
      props.chatClient ??
      createChatClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.chatClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  // Navigator is host-owned and loopback-only. A base URL the client refuses
  // leaves the surface without one, which the panel reports as "not available
  // on this host" rather than pretending to a conversation it cannot reach.
  const navigatorAssistantClient = useMemo(() => {
    if (props.navigatorAssistantClient !== undefined) return props.navigatorAssistantClient;
    try {
      return createNavigatorAssistantClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      });
    } catch {
      return undefined;
    }
  }, [props.navigatorAssistantClient, props.launch.serverUrl, props.projectWindowCapability]);
  // One Navigator reader for the whole window: the dock panel and Zen's
  // assistant are two fronts on it, so a turn sent from either is immediately
  // on screen in both.
  const navigatorAssistant = useNavigatorAssistant(navigatorAssistantClient);
  const chatReadCursorStore = useMemo(() => createChatReadCursorStore(), []);
  const extensionClient = useMemo(
    () =>
      props.extensionClient ??
      createExtensionClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.extensionClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  // Skills this host reports as installed and effective. They become the
  // Skills group of the `/` composer affordance; an unreachable extension
  // service simply contributes nothing.
  const commandSkills = useCommandSkills(extensionClient);
  // The Chat bootstrap lists only active threads because it feeds the sidebar,
  // so the Thread Search overlay's Archived group is filled from the host's own
  // lifecycle-spanning Chat thread search instead.
  const archivedChatSearch = useArchivedChatThreadSearch({
    client: chatClient,
    query: searchQuery,
    enabled: searchOpen && activeMode === "chat",
  });
  const chatController = useChatController({
    client: chatClient,
    readCursorStore: chatReadCursorStore,
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  const codeClient = useMemo(
    () =>
      props.codeClient ??
      createCodeClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.codeClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const createCodeOperationId = useCallback(
    () => globalThis.crypto.randomUUID() as CodeOperationId,
    [],
  );
  const automationClient = useMemo(
    () =>
      props.automationClient ??
      createAutomationClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.automationClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const appleToolchainClient = useMemo(
    () =>
      props.appleToolchainClient ??
      createAppleToolchainClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.appleToolchainClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const computerUseClient = useMemo(
    () =>
      props.computerUseClient ??
      createComputerUseClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.computerUseClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const workOverviewClient = useMemo(
    () =>
      createWorkOverviewClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const workResearchClient = useMemo(
    () =>
      createWorkResearchClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const usageDashboardClient = useMemo(
    () =>
      createUsageDashboardClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const goalClient = useMemo(
    () =>
      createGoalClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const goalLoopClient = useMemo(
    () =>
      createGoalLoopClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const shipClient = useMemo(
    () =>
      createShipClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const planClient = useMemo(
    () =>
      createPlanClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const workMutationClient = useMemo(
    () =>
      createWorkMutationClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const workRequestClient = useMemo(
    () =>
      createWorkRequestClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const folderBrowseClient = useMemo(
    () =>
      createFolderBrowseClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const workThreadClient = useMemo(
    () =>
      props.workThreadClient ??
      createWorkThreadClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.workThreadClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const workTurnClient = useMemo(
    () =>
      props.workTurnClient ??
      createWorkTurnClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.workTurnClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const workNavigation = useWorkThreadNavigation(workThreadClient);
  const usageClient = useMemo(
    () =>
      createUsageClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const diagnosticsExportClient = useMemo(
    () =>
      createDiagnosticsExportClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const hostControlClient = useMemo(
    () =>
      createHostControlClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const githubClient = useMemo(
    () =>
      createGithubClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const githubCloneClient = useMemo(
    () =>
      createGithubCloneClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const agentProfileClient = useMemo(
    () =>
      props.agentProfileClient ??
      createAgentProfileClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.agentProfileClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const agentRunClient = useMemo(
    () =>
      props.agentRunClient ??
      createAgentRunClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.agentRunClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const agentRunSettingsClient = useMemo(
    () =>
      props.agentRunSettingsClient ??
      createAgentRunSettingsClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.agentRunSettingsClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const automationNotificationClient = useMemo(
    () =>
      createAutomationNotificationClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const browserAutomationClient = useMemo(
    () =>
      props.browserAutomationClient ??
      createBrowserAutomationClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.browserAutomationClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const hostClient = useMemo(
    () =>
      props.hostClient ??
      createHostClient({ baseUrl: props.launch.serverUrl, fetch: globalThis.fetch }),
    [props.hostClient, props.launch.serverUrl],
  );
  const hosts = useHostObservation(hostClient);
  const hostFederationLifecycle = useHostFederationLifecycle();
  const [lastSelectedHealthyHostId, setLastSelectedHealthyHostId] = useState<HostId | undefined>(
    () => readLastSelectedHealthyHostId(),
  );
  const [createHostId, setCreateHostId] = useState<HostId>(() => defaultCreateHostId());
  // Until B3 ships host-filtered shell views, create uses All Hosts preselect
  // (last healthy → first healthy). The selector still accepts multi-host input.
  const createHostViewScope = useMemo<CreateHostViewScope>(() => ({ kind: "all-hosts" }), []);
  useEffect(() => {
    if (hosts.length === 0) return;
    const result = preselectCreateHost({
      hosts,
      viewScope: createHostViewScope,
      ...(lastSelectedHealthyHostId === undefined ? {} : { lastSelectedHealthyHostId }),
    });
    if (result.kind === "selected") {
      setCreateHostId(result.host.hostId);
    }
  }, [createHostViewScope, hosts, lastSelectedHealthyHostId]);
  function handleSelectCreateHost(hostId: HostId) {
    setCreateHostId(hostId);
    const host = hosts.find((candidate) => candidate.hostId === hostId);
    if (host === undefined) return;
    const remembered = rememberHealthyCreateHost(host);
    if (remembered !== undefined) setLastSelectedHealthyHostId(remembered);
  }
  // Read cursors are the window's, not a thread's: the sidebar's unread marks
  // have to agree no matter which thread's controller cleared them.
  const codeReadCursorStore = useMemo(() => createCodeReadCursorStore(), []);
  const codeThreadControllers = useMemo(() => createCodeThreadControllers(), []);
  // The window's own Code reader: the thread list, settings, and the commands
  // that create a thread. It deliberately binds to no thread, so no thread's
  // transcript or stream depends on which tab happens to be in front.
  const codeController = useCodeController({
    client: codeClient,
    readCursorStore: codeReadCursorStore,
  });
  const openCodeThreadIds = useMemo(
    () =>
      controller.workspace === undefined
        ? []
        : openLocalCodeThreadIds(controller.workspace.layouts.code),
    [controller.workspace],
  );
  const activeCodeThreadController = useCodeThreadController(
    codeThreadControllers,
    activeCodeThreadId,
  );
  const activeCodeThreadView = activeCodeThreadController?.activeView;
  // The Apple projects the host lists at the root of the Code thread in view.
  // The window's own Code reader binds to no thread, so the root comes from
  // that thread's own controller. Nothing is inferred from the Project name: a
  // checkout with no Xcode project simply offers no workbench entry point.
  const appleProjects = useAppleProjects({
    ...(activeCodeThreadView === undefined
      ? {}
      : {
          threadId: activeCodeThreadView.thread.id,
          checkoutId: activeCodeThreadView.checkout.id,
        }),
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  const watchedThreadId =
    activeMode === "code"
      ? activeCodeThreadId === undefined
        ? undefined
        : String(activeCodeThreadId)
      : activeMode === "work"
        ? activeWorkThreadId === undefined
          ? undefined
          : String(activeWorkThreadId)
        : activeChatThreadId === undefined
          ? undefined
          : String(activeChatThreadId);
  const attentionSignals = useMemo(
    () =>
      collectThreadAttentionSignals({
        ...(activeCodeThreadId === undefined
          ? {}
          : { activeCodeThreadId: String(activeCodeThreadId) }),
        chatThreads: chatController.navigation,
        codeProviderRequests: activeCodeThreadController?.providerRequests ?? [],
        codeThreads: codeController.navigation,
      }),
    [
      activeCodeThreadId,
      chatController.navigation,
      activeCodeThreadController?.providerRequests,
      codeController.navigation,
    ],
  );
  useThreadAttentionNotifications({
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
    signals: attentionSignals,
    ...(watchedThreadId === undefined ? {} : { watchedThreadId }),
  });
  const activeProjectId =
    selectedProjectTabId ??
    (activeMode === "code"
      ? (activeCodeThreadController?.activeView?.thread.projectId ??
        codeController.bootstrap?.threads.find((thread) => thread.id === activeCodeThreadId)
          ?.projectId)
      : undefined) ??
    // Preserve Project context when a utility tab (browser/files/side-chat) is
    // active: the mode context remains bound even without an active Project tab.
    controller.workspace?.contextByMode[activeMode].projectId ??
    undefined;
  const contextClient = useMemo(
    () =>
      props.contextClient ??
      createContextClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.contextClient, props.launch.serverUrl, props.projectWindowCapability],
  );
  const previewClient = useMemo(
    () =>
      createPreviewClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const canvasClient = useMemo(
    () =>
      createCanvasClient({
        baseUrl: props.launch.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.projectWindowCapability,
      }),
    [props.launch.serverUrl, props.projectWindowCapability],
  );
  const contextSubject = useMemo(
    () =>
      activeProjectId === undefined
        ? undefined
        : decodeContextSubjectRef({ aggregateType: "project", aggregateId: activeProjectId }),
    [activeProjectId],
  );
  const contextController = useContextController({
    client: contextClient,
    subject: contextSubject,
  });
  const projectController = useProjectController({
    activeMode: controller.workspace?.activeMode ?? "chat",
    ...(activeProjectId === undefined ? {} : { activeProjectId }),
    ...(props.projectClient === undefined ? {} : { client: props.projectClient }),
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  useEffect(() => {
    const target = props.hostBridge?.initialProjectTarget;
    if (
      target === undefined ||
      initialProjectTargetConsumed.current ||
      controller.status !== "ready"
    ) {
      return;
    }
    const project = projectController.allProjects.find(
      (candidate) => String(candidate.id) === target.projectId,
    );
    if (project === undefined) return;
    if (target.kind === "project-thread" && project.type !== target.mode) return;
    const codeTargetThread =
      target.kind === "project-thread" && target.mode === "code"
        ? codeController.bootstrap?.threads.find(
            (candidate) =>
              String(candidate.id) === target.threadId &&
              String(candidate.projectId) === target.projectId,
          )
        : undefined;
    const workTargetThread =
      target.kind === "project-thread" && target.mode === "work"
        ? workNavigation.bootstrap?.threads.find(
            (candidate) =>
              String(candidate.id) === target.threadId &&
              String(candidate.projectId) === target.projectId,
          )
        : undefined;
    if (
      target.kind === "project-thread" &&
      ((target.mode === "code" && codeTargetThread === undefined) ||
        (target.mode === "work" && workTargetThread === undefined))
    ) {
      return;
    }
    initialProjectTargetConsumed.current = true;
    void (async () => {
      await controller.openProject(project.id, project.type, project.name);
      if (target.kind !== "project-thread") return;
      if (target.mode === "code" && codeTargetThread !== undefined) {
        await controller.openCodeThread(
          codeTargetThread.id,
          codeTargetThread.title,
          undefined,
          codeTargetThread.projectId,
        );
      } else if (target.mode === "work" && workTargetThread !== undefined) {
        await controller.openWorkThread(
          workTargetThread.id,
          workTargetThread.title,
          undefined,
          workTargetThread.projectId,
        );
      }
    })();
  }, [
    codeController.bootstrap?.threads,
    controller,
    workNavigation.bootstrap?.threads,
    projectController.allProjects,
    props.hostBridge,
  ]);
  const workOriginProjectId =
    activeProjectId !== undefined &&
    projectController.allProjects.some(
      (project) => project.id === activeProjectId && project.type === "work",
    )
      ? activeProjectId
      : undefined;
  const workPromotionController = useWorkPromotionController({
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
    ...(workOriginProjectId === undefined ? {} : { originProjectId: workOriginProjectId }),
    targetCodeProjects: projectController.allProjects
      .filter((project) => project.type === "code" && project.lifecycle === "active")
      .map((project) => project.id),
  });
  useEffect(() => {
    const subscribe = props.hostBridge?.subscribeCodeDeepLinks;
    if (subscribe === undefined) return;
    return subscribe((target) => setPendingCodeDeepLink(target));
  }, [props.hostBridge]);
  useEffect(() => {
    const subscribe = props.hostBridge?.subscribeStartNewAgent;
    if (subscribe === undefined) return;
    return subscribe(() => {
      if (controller.status !== "ready") return;
      void controller.openDraftThread(controller.workspace?.activeMode ?? "chat");
    });
  }, [controller, props.hostBridge]);
  useEffect(() => {
    const target = pendingCodeDeepLink;
    if (target === undefined || controller.status !== "ready") return;
    if (target.kind === "project" || target.kind === "new-thread") {
      const project = projectController.allProjects.find(
        (candidate) => String(candidate.id) === target.projectId && candidate.type === "code",
      );
      if (project === undefined) return;
      setPendingCodeDeepLink(undefined);
      void controller.openProject(project.id, "code", project.name);
      return;
    }
    const thread = codeController.bootstrap?.threads.find(
      (candidate) => String(candidate.id) === target.threadId,
    );
    if (thread === undefined) return;
    if (target.kind === "thread") {
      setPendingCodeDeepLink(undefined);
      void controller.openCodeThread(thread.id, thread.title, undefined, thread.projectId);
      return;
    }
    if ("checkoutId" in target && String(thread.checkoutId) !== target.checkoutId) {
      setPendingCodeDeepLink(undefined);
      return;
    }
    setPendingCodeDeepLink(undefined);
    if (target.kind === "file") {
      void controller.openCodeSurface({
        kind: "code-file",
        threadId: thread.id,
        title: target.relativePath,
        relativePath: decodeCodeRelativePath(target.relativePath),
      });
    } else if (target.kind === "diff") {
      void controller.openCodeSurface({
        kind: "code-diff",
        threadId: thread.id,
        title: `${thread.title} changes`,
      });
    } else {
      void controller.openCodeSurface({
        kind: "code-test",
        threadId: thread.id,
        title: `${thread.title} tests`,
        testRunId: target.testRunId as never,
      });
    }
  }, [codeController.bootstrap, controller, pendingCodeDeepLink, projectController.allProjects]);
  useEffect(() => {
    const snapshot = contextController.snapshot;
    if (snapshot === undefined || snapshot.subject.aggregateType !== "project") return;
    const project = projectController.allProjects.find(
      (candidate) => String(candidate.id) === String(snapshot.subject.aggregateId),
    );
    if (project === undefined) return;
    setContextSnapshotsByProject((current) => {
      if (current.get(project.id) === snapshot) return current;
      const next = new Map(current);
      next.set(project.id, snapshot);
      return next;
    });
  }, [contextController.snapshot, projectController.allProjects]);
  const dockProject =
    dockProjectId === undefined
      ? undefined
      : projectController.allProjects.find((project) => project.id === dockProjectId);
  const dockResolution = resolveDockSurface(dockSurface, dockProjectId);
  const availableDockSurfaces = RIGHT_UTILITY_DOCK_SURFACES.filter(
    (surface) =>
      resolveDockSurface(surface.id, activeProjectId, surfaceAvailability(surface.id)).kind ===
      "surface",
  );
  const preferredDockSurface =
    availableDockSurfaces.find(
      (surface) => surface.id === controller.settings?.lastContextSurface,
    ) ?? availableDockSurfaces[0];
  const dockOpen = dockResolution.kind === "surface";
  const providerController = useProviderController({
    ...(props.providerClient === undefined ? {} : { client: props.providerClient }),
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  const discoveryController = useDiscoveryController({
    afterScan: providerController.retry,
    serverUrl: props.launch.serverUrl,
    windowCapability: props.projectWindowCapability,
  });
  // The surfaces a Zen card may open. Each card builds its own controller from
  // its own source context; these are only the connections it does that over.
  const zenLiveThreadClients = useMemo<ZenLiveThreadClients>(
    () => ({
      chatClient,
      chatReadCursorStore,
      providerController,
      workMutationClient,
      workRequestClient,
      workThreadClient,
      workTurnClient,
    }),
    [
      chatClient,
      chatReadCursorStore,
      providerController,
      workMutationClient,
      workRequestClient,
      workThreadClient,
      workTurnClient,
    ],
  );

  // First run is derived from projected host settings, never renderer storage,
  // so a clean store is the only thing that can produce it.
  const firstRunReadiness = useMemo(
    () =>
      summarizeFirstRunReadiness({
        providerStatus: providerController.status,
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        ...(discoveryController.snapshot === undefined
          ? {}
          : { discoverySnapshot: discoveryController.snapshot }),
      }),
    [
      providerController.status,
      providerController.instances,
      providerController.observedByInstance,
      discoveryController.snapshot,
    ],
  );
  const firstRunDiscoveryNotice = describeDiscoveryNotice({
    scanning: discoveryController.scanning,
    ...(discoveryController.snapshot === undefined
      ? {}
      : { snapshot: discoveryController.snapshot }),
    ...(discoveryController.message === undefined ? {} : { message: discoveryController.message }),
  });
  const recordFirstRunOutcome = useCallback(
    async (outcome: FirstRunOnboardingOutcome) => {
      await controller.updateSettings({ firstRunOnboarding: outcome });
    },
    [controller],
  );
  const saveUserProfile = useCallback(
    (profile: UserProfile) => controller.updateSettings({ userProfile: profile }),
    [controller],
  );
  const selectNavigatorDefault = useCallback(
    (selection: ModelPickerSelection) =>
      controller.updateSettings({
        navigatorAssistant: {
          ...(controller.settings?.navigatorAssistant ?? {}),
          defaultProvider: selection,
        },
      }),
    [controller],
  );
  const clearNavigatorDefault = useCallback(() => {
    const { defaultProvider: _cleared, ...rest } = controller.settings?.navigatorAssistant ?? {};
    return controller.updateSettings({ navigatorAssistant: rest });
  }, [controller]);
  // The workspace step writes through to the same settings Settings owns:
  // appearance lives in theme settings, the modes and switcher in shell
  // settings. First run keeps no copy of either.
  const firstRunWorkspace = useMemo<WorkspaceChoices>(
    () => ({
      // `undefined` while theme settings load, which the step reports as an
      // unknown rather than drawing "system" as though it had been chosen.
      colorScheme: themeController.settings?.mode,
      chatEnabled: controller.settings?.chatEnabled ?? true,
      workEnabled: controller.settings?.workEnabled ?? true,
      modeSwitcher: controller.settings?.modeSwitcherPresentation ?? "buttons",
    }),
    [
      themeController.settings?.mode,
      controller.settings?.chatEnabled,
      controller.settings?.workEnabled,
      controller.settings?.modeSwitcherPresentation,
    ],
  );
  const selectColorScheme = useCallback(
    (scheme: "system" | "light" | "dark") => themeController.applyPatch({ mode: scheme }),
    [themeController],
  );
  const selectChatDefaultModel = useCallback(
    async (selection: ModelPickerSelection) => {
      const settings = chatController.bootstrap?.settings;
      // Without Chat's own settings there is no version to write against, so
      // the choice has not been taken rather than merely deferred.
      if (settings === undefined) return false;
      return await chatController.updateSettings(chatDefaultModelCommand(settings, selection));
    },
    [chatController],
  );
  // Chat stores the pair as two independent optional fields, and the contract
  // only allows them together. Reading it as one value keeps a half-configured
  // default from ever reaching a picker as a selection.
  const chatSettings = chatController.bootstrap?.settings;
  const firstRunChatDefault = useMemo(() => {
    if (chatSettings?.defaultProviderInstanceId === undefined) return undefined;
    if (chatSettings.defaultModelId === undefined) return undefined;
    return {
      providerInstanceId: chatSettings.defaultProviderInstanceId,
      modelId: chatSettings.defaultModelId,
    };
  }, [chatSettings?.defaultProviderInstanceId, chatSettings?.defaultModelId]);
  const firstRunController = useFirstRunOnboardingController({
    onboarding: controller.settings?.firstRunOnboarding,
    shellStatus: controller.status,
    resolve: recordFirstRunOutcome,
  });

  const codeProviderGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        providerOrder: providerController.defaults.providerOrder,
        mode: "code",
      }),
    [
      providerController.instances,
      providerController.observedByInstance,
      providerController.defaults.providerOrder,
    ],
  );
  const workProviderGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        providerOrder: providerController.defaults.providerOrder,
        mode: "work",
      }),
    [
      providerController.instances,
      providerController.observedByInstance,
      providerController.defaults.providerOrder,
    ],
  );
  const chatProviderGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        providerOrder: providerController.defaults.providerOrder,
        mode: "chat",
      }),
    [
      providerController.instances,
      providerController.observedByInstance,
      providerController.defaults.providerOrder,
    ],
  );
  useEffect(() => {
    const settings = chatController.bootstrap?.settings;
    if (settings === undefined) return;
    const command = autoConfigureChatDefaults(settings, chatProviderGroups);
    if (command === undefined) {
      autoChatDefaultsAttempt.current = undefined;
      return;
    }
    const attemptKey = `${String(command.expectedVersion)}:${String(command.defaultProviderInstanceId)}:${String(command.defaultModelId)}`;
    if (autoChatDefaultsAttempt.current === attemptKey) return;
    autoChatDefaultsAttempt.current = attemptKey;
    void chatController.updateSettings(command).then((configured) => {
      if (!configured && autoChatDefaultsAttempt.current === attemptKey) {
        autoChatDefaultsAttempt.current = undefined;
      }
    });
  }, [chatController, chatProviderGroups]);
  const bootstrapProviderGroups = useMemo(
    () => [...chatProviderGroups, ...codeProviderGroups, ...workProviderGroups],
    [chatProviderGroups, codeProviderGroups, workProviderGroups],
  );
  useProviderBootstrap({
    discoveryController,
    enabled: true,
    providerController,
    providerGroups: bootstrapProviderGroups,
  });
  const providerReady = hasSelectableProviderModels(bootstrapProviderGroups);
  // A ready or degraded provider still lists chat-only and unverified-tool
  // models in the Code picker, each carrying the reason it cannot be used.
  // Those entries are not choices: offering them here would let create,
  // promotion, and automation flows select a model the picker itself marks
  // unusable and fail only after the work exists.
  const codeProviderChoices = useMemo<ReadonlyArray<CodeThreadProviderChoice>>(
    () =>
      codeProviderGroups.flatMap((group) =>
        group.sections.flatMap((section) =>
          section.models.flatMap((picker) =>
            picker.unavailableReason === undefined
              ? [
                  {
                    instanceId: group.instance.id,
                    modelId: picker.model.id,
                    label: `${group.instance.displayName} — ${picker.model.displayName}`,
                  },
                ]
              : [],
          ),
        ),
      ),
    [codeProviderGroups],
  );
  const codeBoardProjects = useMemo(
    () =>
      projectController.allProjects
        .filter((project) => project.type === "code" && project.lifecycle === "active")
        .map((project) => ({ id: project.id, name: project.name })),
    [projectController.allProjects],
  );
  const workProviderChoices = useMemo<ReadonlyArray<CodeThreadProviderChoice>>(
    () =>
      workProviderGroups.flatMap((group) =>
        group.sections.flatMap((section) =>
          section.models.flatMap((picker) =>
            picker.unavailableReason === undefined
              ? [
                  {
                    instanceId: group.instance.id,
                    modelId: picker.model.id,
                    label: `${group.instance.displayName} — ${picker.model.displayName}`,
                  },
                ]
              : [],
          ),
        ),
      ),
    [workProviderGroups],
  );
  const workProviderChoice = resolveWorkProviderChoice(
    workProviderChoices,
    draftProviderInstanceId,
    draftModelId,
  );
  const effectiveDraftProviderInstanceId =
    activeMode === "work" ? workProviderChoice?.instanceId : draftProviderInstanceId;
  const effectiveDraftModelId = activeMode === "work" ? workProviderChoice?.modelId : draftModelId;
  const draftProviderGroups =
    activeMode === "chat"
      ? chatProviderGroups
      : activeMode === "work"
        ? workProviderGroups
        : codeProviderGroups;
  const executionProfileScope = useMemo(
    () =>
      activeProjectId === undefined
        ? ({ scopeKind: "mode", scopeRef: activeMode } as const)
        : ({
            scopeKind: "project",
            scopeRef: String(activeProjectId),
          } as const),
    [activeMode, activeProjectId],
  );
  const localHost = hosts.find((host) => String(host.hostId) === String(LOCAL_HOST_ID));
  const executionProfileController = useExecutionProfileController({
    client: agentProfileClient,
    ...(localHost === undefined ? {} : { hostHealth: localHost.health }),
    hostId: LOCAL_HOST_ID,
    hostLabel: localHost?.displayName ?? "This Mac",
    mode: activeMode,
    onSelectProvider: (selection) => {
      setDraftProviderInstanceId(selection.providerInstanceId);
      setDraftModelId(selection.modelId);
    },
    profileSelectionStorageKey: `octant.execution-profile.${activeMode}.${activeProjectId ?? "unfiled"}`,
    projectExecutionPolicy:
      activeMode === "code"
        ? (codeController.bootstrap?.settings.defaultExecutionPolicy ?? "approval-gated")
        : "approval-gated",
    providerGroups: draftProviderGroups,
    ...(effectiveDraftProviderInstanceId === undefined
      ? {}
      : { selectedProviderInstanceId: effectiveDraftProviderInstanceId }),
    ...(effectiveDraftModelId === undefined ? {} : { selectedModelId: effectiveDraftModelId }),
    scope: executionProfileScope,
  });
  // Editor catalog from Projects already loaded in App, approval-gated agent
  // profiles, and Code bootstrap / prepared checkout receipts when present.
  // Work Projects with a binding revision always qualify; Code Projects
  // require complete managed or prepared checkout facts. Durable receipts are
  // binding-revision-backed; incomplete Code binding facts stay omitted.
  //
  // Build synchronously from content fingerprints. `allProjects` and provider
  // choice arrays allocate new wrappers every render; depending on those
  // references in an effect/setState path would loop forever and hang App tests.
  const automationCatalogProjects = projectController.allProjects;
  const automationCatalogProfiles = executionProfileController.profiles;
  const automationCatalogProjectKey = automationCatalogProjects
    .map((project) => {
      const bindingRevision =
        "bindingRevisionId" in project ? String(project.bindingRevisionId) : "";
      return `${String(project.id)}:${project.type}:${project.lifecycle}:${String(project.version)}:${project.name}:${bindingRevision}`;
    })
    .join("\0");
  const automationCatalogProfileKey = automationCatalogProfiles
    .map(
      (profile) =>
        `${String(profile.id)}:${String(profile.version)}:${profile.defaultExecutionPolicy}:${profile.compatibleModes.join(",")}:${profile.displayName}`,
    )
    .join("\0");
  const automationCatalogProviderKey = [
    "work",
    ...workProviderChoices.map(
      (choice) => `${String(choice.instanceId)}:${String(choice.modelId)}`,
    ),
    "code",
    ...codeProviderChoices.map(
      (choice) => `${String(choice.instanceId)}:${String(choice.modelId)}`,
    ),
  ].join("\0");
  const automationCatalogCodeBootstrapKey =
    codeController.bootstrap === undefined
      ? ""
      : [
          String(codeController.bootstrap.settings.version),
          ...codeController.bootstrap.threads.map(
            (thread) =>
              `${String(thread.id)}:${String(thread.projectId)}:${String(thread.checkoutId)}:${String(thread.bindingRevisionId)}:${String(thread.repositoryId)}`,
          ),
          ...codeController.bootstrap.checkouts.map((checkout) => {
            const ownership =
              checkout.kind === "managed-worktree" ? String(checkout.ownershipReceiptId) : "";
            return `${String(checkout.id)}:${checkout.kind}:${checkout.availability}:${ownership}`;
          }),
        ].join("\0");
  const automationEditorCatalog = useMemo(
    () =>
      buildAutomationEditorCatalog({
        hostId: String(LOCAL_HOST_ID),
        hostLabel: localHost?.displayName ?? "This computer",
        actorId: String(props.launch.windowId),
        projects: automationCatalogProjects,
        profiles: automationCatalogProfiles,
        providerChoicesByMode: {
          work: workProviderChoices.map((choice) => ({
            providerInstanceId: String(choice.instanceId),
            modelId: String(choice.modelId),
          })),
          code: codeProviderChoices.map((choice) => ({
            providerInstanceId: String(choice.instanceId),
            modelId: String(choice.modelId),
          })),
        },
        ...(codeController.bootstrap === undefined
          ? {}
          : { codeBootstrap: codeController.bootstrap }),
      }),
    // Content keys keep the memo referentially stable across renders that only
    // allocate new Project/profile/provider array wrappers with identical facts.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
    [
      automationCatalogCodeBootstrapKey,
      automationCatalogProfileKey,
      automationCatalogProjectKey,
      automationCatalogProviderKey,
      localHost?.displayName,
      props.launch.windowId,
    ],
  );
  const activeWorkProject =
    projectController.activeProject?.type === "work" &&
    projectController.activeProject.lifecycle === "active"
      ? projectController.activeProject
      : undefined;
  const workCreateThreadAvailable = workProviderChoice !== undefined;
  const enabledProjectTypes = new Set(
    enabledModes(controller.settings ?? { chatEnabled: true, workEnabled: true }),
  );
  const memoryTransferProjects = projectController.allProjects.filter((project) =>
    enabledProjectTypes.has(project.type),
  );

  function openDockSurface(
    surface: RightUtilityDockSurfaceId,
    opener: HTMLElement,
    projectId = activeProjectId,
  ) {
    const resolution = resolveDockSurface(
      surface,
      projectId,
      surfaceAvailability(surface, projectId),
    );
    if (resolution.kind !== "surface") return;
    dockOpener.current = { element: opener, logicalTarget: "dock" };
    if (surface !== "project-memory" || String(dockProjectId) !== String(projectId)) {
      projectController.clearMemory();
    }
    setDockProjectId(projectId);
    setDockSurface(surface);
    if (controller.settings?.lastContextSurface !== surface) {
      void controller.updateSettings({ lastContextSurface: surface });
    }
  }
  function openMemoryInspector(projectId: ProjectId | undefined, opener: HTMLElement) {
    openDockSurface("project-memory", opener, projectId);
  }
  function closeDock() {
    pendingDockFocus.current = dockOpener.current;
    setDockProjectId(undefined);
    setDockSurface(undefined);
    projectController.clearMemory();
    if (controller.settings?.lastContextSurface !== null) {
      void controller.updateSettings({ lastContextSurface: null });
    }
  }
  function toggleDock() {
    const opener = document.activeElement;
    if (!(opener instanceof HTMLElement)) return;
    if (dockOpen) {
      dockOpener.current = { element: opener, logicalTarget: "dock" };
      closeDock();
      return;
    }
    if (preferredDockSurface !== undefined) openDockSurface(preferredDockSurface.id, opener);
  }
  useEffect(() => {
    if (initialDockRestoreAttempted.current) return;
    const savedSurface = controller.settings?.lastContextSurface;
    if (savedSurface === null) {
      initialDockRestoreAttempted.current = true;
      return;
    }
    if (
      savedSurface === undefined ||
      activeProjectId === undefined ||
      projectController.activeProject === undefined
    ) {
      return;
    }
    const restored = resolveDockSurface(savedSurface, activeProjectId);
    if (restored.kind !== "surface") {
      if (restored.reason === "unknown") return;
      initialDockRestoreAttempted.current = true;
      return;
    }
    initialDockRestoreAttempted.current = true;
    setDockProjectId(activeProjectId);
    setDockSurface(restored.surface.id);
  }, [
    activeProjectId,
    controller.settings?.lastContextSurface,
    projectController.activeProject,
    projectController.status,
  ]);
  useEffect(() => {
    if (dockSurface === undefined && dockProjectId === undefined) return;
    if (
      dockSurface !== undefined &&
      (dockProjectId === activeProjectId ||
        (dockSurface === "project-memory" &&
          dockProject !== undefined &&
          dockProject.lifecycle === "active" &&
          dockProject.type === activeMode))
    ) {
      return;
    }
    dockOpener.current = undefined;
    pendingDockFocus.current = undefined;
    setDockProjectId(undefined);
    setDockSurface(undefined);
    projectController.clearMemory();
  }, [
    activeMode,
    activeProjectId,
    dockProject,
    dockProjectId,
    dockSurface,
    projectController.clearMemory,
  ]);
  useEffect(() => {
    if (dockSurface === undefined || dockResolution.kind === "surface") return;
    dockOpener.current = undefined;
    pendingDockFocus.current = undefined;
    setDockProjectId(undefined);
    setDockSurface(undefined);
    projectController.clearMemory();
  }, [dockResolution.kind, dockSurface, projectController.clearMemory]);
  useEffect(() => {
    const current = projectController.activeProject;
    const previous = previousProjectLifecycle.current;
    previousProjectLifecycle.current =
      current === undefined ? undefined : { id: current.id, lifecycle: current.lifecycle };
    if (
      previous === undefined ||
      current === undefined ||
      previous.id !== current.id ||
      previous.lifecycle !== "active" ||
      current.lifecycle !== "archived"
    ) {
      return;
    }
    queueMicrotask(() => {
      const target = dockOpen
        ? document.querySelector<HTMLElement>(".right-utility-dock__actions button:last-child")
        : document.querySelector<HTMLElement>(".project-overview__memory-action");
      target?.focus();
    });
  }, [dockOpen, projectController.activeProject]);
  useEffect(() => {
    if (dockSurface !== undefined) return;
    const pending = pendingDockFocus.current;
    if (pending === undefined) return;
    pendingDockFocus.current = undefined;
    focusLogicalOpener(pending);
  }, [dockSurface]);
  useEffect(() => {
    setPreviewContextWidth(undefined);
  }, [controller.settings?.contextSidebarWidth]);
  useEffect(() => {
    setPreviewSidebarWidth((preview) =>
      preview === controller.settings?.sidebarWidth ? undefined : preview,
    );
  }, [controller.settings?.sidebarWidth]);
  useEffect(() => {
    if (isNarrow) setPreviewSidebarWidth(undefined);
  }, [isNarrow]);

  function surfaceAvailability(
    surface: RightUtilityDockSurfaceId,
    projectId = activeProjectId,
  ): RightUtilityDockSurfaceAvailability {
    if (projectController.status === "loading" || projectController.status === "conflict-reload") {
      return "unknown";
    }
    if (projectController.status === "disconnected") return "unavailable";
    // Navigator is host-owned, so no Project decides whether it can be shown.
    // Its own readiness — unconfigured, unavailable — is the panel's to report
    // from the host snapshot, not something to pre-empt by hiding the surface.
    if (surface === "navigator") return "available";
    if (surface === "project-memory" || surface === "context") {
      return projectId === undefined ? "unavailable" : "available";
    }
    const availability =
      projectId === undefined ? undefined : projectController.availabilityByProject.get(projectId);
    if (availability?.status === "available") return "available";
    if (availability?.status === "unavailable") return "unavailable";
    return "unknown";
  }

  function resolveDockSurface(
    surface: unknown,
    surfaceProjectId: ProjectId | undefined,
    availability = surfaceAvailability(
      surface === "context" || surface === "navigator" ? surface : "project-memory",
    ),
  ): RightUtilityDockResolution {
    const project =
      surfaceProjectId === undefined
        ? undefined
        : projectController.allProjects.find((candidate) => candidate.id === surfaceProjectId);
    return resolveRightUtilityDockSurface({
      activeMode,
      ...(project === undefined ? {} : { activeProject: project }),
      connectionState: projectController.status === "disconnected" ? "disconnected" : "connected",
      presentationAvailability: availability,
      savedSurface: surface,
      ...(surfaceProjectId === undefined ? {} : { surfaceProjectId }),
    });
  }

  if (controller.status === "loading") {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Workspace"
          message="Loading authoritative shell state."
          state="loading"
          title="Loading Octant workspace"
        />
      </main>
    );
  }
  if (controller.status === "conflict-reload") {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Workspace"
          message="A command outcome may have changed this workspace. Loading authoritative state."
          state="loading"
          title="Reloading shell state"
        />
      </main>
    );
  }
  if (controller.status === "recovery-required") {
    return (
      <main className="shell-boundary">
        <ShellState
          action={{ label: "Retry after recovery", onClick: controller.retry }}
          eyebrow="Local storage"
          message={controller.errorMessage ?? "Octant storage needs recovery before continuing."}
          role="alert"
          state="warning"
          title="Storage recovery required"
        />
      </main>
    );
  }
  if (controller.status === "disconnected") {
    return (
      <main className="shell-boundary">
        <ShellState
          action={{ label: "Retry connection", onClick: controller.retry }}
          eyebrow="Connection"
          message={controller.errorMessage ?? "The local Octant server is unavailable."}
          role="alert"
          state="disconnected"
          title="Octant is disconnected"
        />
      </main>
    );
  }
  if (
    controller.settings === undefined ||
    controller.workspace === undefined ||
    controller.presentedLayout === undefined
  ) {
    return (
      <main className="shell-boundary">
        <ShellState
          eyebrow="Workspace"
          message="Loading authoritative shell state."
          state="loading"
          title="Loading Octant workspace"
        />
      </main>
    );
  }
  // Search is scoped to the current mode and reads the host bootstrap rather
  // than the navigation lists, because navigation drops archived threads and the
  // overlay must still surface them in their own labelled group. Work and Code
  // bootstrap their archived threads too; Chat's bootstrap is active-only, so its
  // archived rows come from the host's own lifecycle-spanning thread search and
  // are merged in here — the search answer wins for a thread listed by both,
  // because it is the later reading of that thread's lifecycle.
  const threadSearchThreads: ReadonlyArray<ThreadSearchThread> =
    activeMode === "chat"
      ? [
          ...new Map(
            [...(chatController.bootstrap?.threads ?? []), ...archivedChatSearch.threads].map(
              (thread) => [
                String(thread.id),
                {
                  mode: "chat" as const,
                  threadId: String(thread.id),
                  title: thread.title,
                  ...(thread.projectId === undefined
                    ? {}
                    : { projectId: String(thread.projectId) }),
                  lifecycle: thread.lifecycle,
                  updatedAt: thread.updatedAt,
                },
              ],
            ),
          ).values(),
        ]
      : activeMode === "work"
        ? (workNavigation.bootstrap?.threads ?? []).map((thread) => ({
            mode: "work" as const,
            threadId: String(thread.id),
            title: thread.title,
            ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
            lifecycle: thread.lifecycle,
            updatedAt: thread.updatedAt,
          }))
        : (codeController.bootstrap?.threads ?? []).map((thread) => ({
            mode: "code" as const,
            threadId: String(thread.id),
            title: thread.title,
            ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
            // A Code thread also reports run states (`interrupted`, `waiting`).
            // Search only distinguishes live from archived, so a running thread
            // stays listed as active rather than being hidden or mislabelled.
            lifecycle:
              thread.lifecycle === "archived" ? ("archived" as const) : ("active" as const),
            updatedAt: thread.updatedAt,
          }));
  const threadSearchStatus =
    activeMode === "chat"
      ? chatController.status
      : activeMode === "work"
        ? workNavigation.status
        : codeController.status;
  const threadSearchListing =
    threadSearchStatus === "ready"
      ? "ready"
      : threadSearchStatus === "loading"
        ? "loading"
        : "unavailable";
  // `idle` means nothing was asked for yet, which is not an incomplete answer.
  const threadSearchArchivedListing: ThreadSearchListingStatus =
    archivedChatSearch.status === "loading"
      ? "loading"
      : archivedChatSearch.status === "unavailable"
        ? "unavailable"
        : "ready";
  const threadSearchProjects = [
    ...projectController.projects,
    ...projectController.archivedProjects,
  ].map((project) => ({ id: String(project.id), name: project.name }));

  const activeSurface = searchOpen
    ? "Search threads"
    : activeSurfaceTitle(
        controller.workspace.layouts[activeMode],
        controller.workspace.activeGroupIds[activeMode],
      );
  const automationCenterVisible =
    automationCenterOpen && (activeMode === "code" || activeMode === "work");
  const visibleComputerUseSessions =
    controller.settingsOpen ||
    zen.active ||
    railPlaceholder !== undefined ||
    codeBoardOpen ||
    automationCenterVisible
      ? new Map<string, ReadonlySet<string>>()
      : representedComputerUseSessions;
  const contextSidebarWidth = previewContextWidth ?? controller.settings.contextSidebarWidth;
  const sidebarWidth = previewSidebarWidth ?? controller.settings.sidebarWidth;
  const codeProjectThreads: ReadonlyArray<ChatThreadNavigationItem> =
    codeController.status === "ready"
      ? codeController.navigation.map((thread) => ({
          threadId: String(thread.threadId),
          title: thread.title,
          projectId: String(thread.projectId),
          providerInstanceId: String(thread.providerInstanceId),
          // The lifecycle used to ride along as a badge on every row, which
          // said "active" beside almost every thread and told the reader
          // nothing. The status dot carries it instead.
          activity: codeThreadActivity(thread),
          ...(thread.followUp === undefined ? {} : { followUp: thread.followUp }),
          ...(thread.unread === undefined ? {} : { unread: thread.unread }),
          ...(thread.pinned === undefined ? {} : { pinned: thread.pinned }),
          ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
        }))
      : [];
  const workProjectThreads = workNavigation.navigation;
  const sidebarThreadGroups =
    activeMode === "code"
      ? { recents: codeProjectThreads, all: codeProjectThreads, unfiled: [] }
      : activeMode === "work"
        ? { recents: workProjectThreads, all: workProjectThreads, unfiled: [] }
        : undefined;

  // A row names its provider by mark, not by model, so the instance id every
  // thread already carries is resolved once here rather than by each list that
  // renders a row. A thread whose instance is gone keeps no mark rather than
  // borrowing another provider's.
  const providerIdentityById = new Map<string, ThreadProviderIdentity>(
    providerController.instances.map((instance) => [
      String(instance.id),
      { displayName: instance.displayName, driverKind: instance.driverKind },
    ]),
  );
  const withProviderMark = (thread: ChatThreadNavigationItem): ChatThreadNavigationItem => {
    const provider =
      thread.providerInstanceId === undefined
        ? undefined
        : providerIdentityById.get(thread.providerInstanceId);
    return provider === undefined ? thread : { ...thread, provider };
  };
  const markedThreadGroups =
    sidebarThreadGroups === undefined
      ? undefined
      : {
          recents: sidebarThreadGroups.recents.map(withProviderMark),
          all: sidebarThreadGroups.all.map(withProviderMark),
          unfiled: sidebarThreadGroups.unfiled.map(withProviderMark),
        };

  // What a Code thread row offers on right-click. Each one carries the row's
  // navigation id, which for a Project-backed thread is its Code thread id;
  // the controller refuses anything its bootstrap does not hold rather than
  // guessing at a thread it cannot see.
  const codeThreadRowActions: ThreadRowActions = {
    onArchiveThread: (threadId) => void codeController.archiveThread(decodeCodeThreadId(threadId)),
    onMarkThreadUnread: (threadId) => codeReadCursorStore.unmark(decodeCodeThreadId(threadId)),
    onPinThread: (threadId, pinned) =>
      void codeController.pinThread(decodeCodeThreadId(threadId), pinned),
  };
  const renameCodeThreadFromRow = (threadId: string, title: string): void => {
    void codeController.renameThread(decodeCodeThreadId(threadId), title);
  };

  // One thread-selection handler per mode. The sidebar and every Project
  // Overview call the same one, so a row opens the same thread wherever it is
  // rendered.
  function selectChatThread(threadId: string) {
    if (chatController.status !== "ready") return;
    const thread = chatController.navigation.find((candidate) => candidate.threadId === threadId);
    if (thread === undefined) return;
    void controller.openChatThread(
      decodeChatThreadId(threadId),
      thread.title,
      thread.projectId === undefined ? undefined : decodeProjectId(thread.projectId),
    );
  }

  function selectCodeThread(navigationId: string) {
    const thread = codeController.navigation.find(
      (candidate) => String(candidate.threadId) === navigationId,
    );
    if (thread === undefined) return;
    void controller.openCodeThread(
      decodeCodeThreadId(navigationId),
      thread.title,
      undefined,
      thread.projectId,
    );
  }

  function selectWorkThread(navigationId: string) {
    const thread = workNavigation.navigation.find(
      (candidate) => String(candidate.threadId) === navigationId,
    );
    if (thread === undefined) return;
    void controller.openWorkThread(
      decodeWorkThreadId(navigationId),
      thread.title,
      undefined,
      thread.projectId === undefined ? undefined : decodeProjectId(thread.projectId),
    );
  }

  // The Project Overview sits below surfaces this file does not own, so the
  // active mode's thread navigation reaches it through a provider rather than
  // through props. It carries the same list the sidebar nests, so neither can
  // claim a Project has threads the other cannot see. `errorMessage` is read
  // only from a disconnected bootstrap, never from a failed command.
  const projectThreadsAccess: ProjectThreadsAccess =
    activeMode === "chat"
      ? {
          ...(chatController.status === "disconnected" && chatController.errorMessage !== undefined
            ? { errorMessage: chatController.errorMessage }
            : {}),
          onRetry: () => void chatController.retry(),
          onSelectThread: selectChatThread,
          status:
            chatController.status === "ready"
              ? "ready"
              : chatController.status === "disconnected"
                ? "unavailable"
                : "loading",
          threads: chatController.navigation,
        }
      : activeMode === "code"
        ? {
            ...(codeController.status === "disconnected" &&
            codeController.errorMessage !== undefined
              ? { errorMessage: codeController.errorMessage }
              : {}),
            onRetry: () => void codeController.retry(),
            onSelectThread: selectCodeThread,
            status:
              codeController.status === "disconnected"
                ? "unavailable"
                : codeController.status === "ready"
                  ? "ready"
                  : "loading",
            threads: codeProjectThreads,
          }
        : {
            ...(workNavigation.status === "unavailable" && workNavigation.errorMessage !== undefined
              ? { errorMessage: workNavigation.errorMessage }
              : {}),
            onRetry: () => void workNavigation.refresh(),
            onSelectThread: selectWorkThread,
            status:
              workNavigation.status === "unavailable"
                ? "unavailable"
                : workNavigation.status === "ready"
                  ? "ready"
                  : "loading",
            threads: workProjectThreads,
          };

  async function openSelectedProject(project: ProjectSummary) {
    closeThreadSearch();
    if (project.lifecycle !== "active") return;
    await controller.openProject(project.id, project.type, project.name);
  }

  function viewAllChatProjectThreads(projectId: ProjectId) {
    setChatProjectThreadListRequest((current) => ({
      projectId,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }

  async function openDraftInProject(projectId: ProjectId) {
    const project = projectController.allProjects.find((candidate) => candidate.id === projectId);
    if (project === undefined || project.lifecycle !== "active") return;
    await openDraftInKnownProject(project.id, project.type, project.name);
  }

  // Used right after creation, when the Project is not yet in this render's
  // snapshot; the dialog already knows the mode and name.
  async function openDraftInKnownProject(projectId: ProjectId, mode: OctantMode, name: string) {
    await controller.openProject(projectId, mode, name);
    await controller.openDraftThread(mode, projectId);
  }

  // The sidebar's "New thread" starts in the highlighted Project when there
  // is one; the composer still lets the user switch to no folder.
  function openDraftInActiveProject(mode: "work" | "code") {
    const project = projectController.activeProject;
    void controller.openDraftThread(
      mode,
      project?.type === mode && project.lifecycle === "active" ? project.id : undefined,
    );
  }

  function createChat(prompt?: string) {
    if (prompt === undefined || prompt.trim() === "") {
      void controller.openDraftThread("chat");
      return;
    }
    void handleDraftCreateThread("chat", prompt);
  }

  // Skills and plugins have a real Settings destination; the sidebar entry goes
  // there rather than to a placeholder that says the surface exists elsewhere.
  function openSkillsSettings() {
    void controller.openSettings({ section: "skills" });
  }

  function openRailPlaceholder(title: string, message: string) {
    setCodeBoardOpen(false);
    setAutomationCenterOpen(false);
    setRailPlaceholder({ title, message });
  }

  function openAutomationCenter() {
    setRailPlaceholder(undefined);
    setCodeBoardOpen(false);
    setArtifactLibraryOpen(false);
    setAutomationCenterOpen(true);
  }

  // The library gathers artifacts from every mode, so unlike the Automation
  // Center it is not dismissed when the mode changes: a person who opened it
  // in Work is looking for the same artifacts in Code.
  function openArtifactLibrary() {
    setRailPlaceholder(undefined);
    setCodeBoardOpen(false);
    setAutomationCenterOpen(false);
    setArtifactLibraryOpen(true);
  }

  function handleSelectMode(mode: OctantMode) {
    setRailPlaceholder(undefined);
    controller.setMode(mode);
    if (mode !== "code") setCodeBoardOpen(false);
    // The Automation Center is one shared Work/Code surface; leaving both
    // work modes dismisses it.
    if (mode === "chat") setAutomationCenterOpen(false);
    if (mode === "chat") return;
    const hasProject = projectController.projects.some(
      (project) => project.type === mode && project.lifecycle === "active",
    );
    if (!hasProject) {
      void controller.openDraftThread(mode);
    }
  }

  async function handleCreateWorkThread(projectId: ProjectId, prompt: string): Promise<boolean> {
    const project = projectController.allProjects.find(
      (
        candidate,
      ): candidate is Extract<(typeof projectController.allProjects)[number], { type: "work" }> =>
        candidate.type === "work" &&
        candidate.lifecycle === "active" &&
        String(candidate.id) === String(projectId),
    );
    if (
      project === undefined ||
      projectController.availabilityByProject.get(project.id)?.status !== "available"
    ) {
      return false;
    }
    const bindingRevisionId = project.bindingRevisionId;
    const providerInstanceId = workProviderChoice?.instanceId;
    const modelId = workProviderChoice?.modelId;
    if (providerInstanceId === undefined || modelId === undefined) return false;
    try {
      const created = await workThreadClient.execute({
        kind: "create-work-thread",
        threadId: decodeWorkThreadId(globalThis.crypto.randomUUID()),
        projectId: project.id,
        title: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
        providerInstanceId,
        modelId,
        hostId: createHostId,
        bindingRevisionId,
        workingDirectory: "." as never,
      });
      if (!("kind" in created) || created.kind !== "thread-created") return false;
      // A successful create is durable even if the first turn fails. Open the
      // exact thread before starting the turn so the user can see recovery UI.
      await controller.openWorkThread(
        created.thread.id,
        created.thread.title,
        undefined,
        created.thread.projectId,
      );
      await workNavigation.refresh();
      const started = await workTurnClient.startFirstTurn({
        kind: "start-work-thread-turn",
        requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
        threadId: created.thread.id,
        turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
        prompt,
        authority: {
          hostId: createHostId,
          projectId: project.id,
          bindingRevisionId,
          workingDirectory: created.thread.workingDirectory ?? ("." as never),
          confinementPosture: "project-root-confined",
          providerInstanceId,
          modelId,
        },
      });
      if (started.kind !== "accepted") return false;
      return true;
    } catch {
      return false;
    }
  }

  async function handleCreateChatProjectThread(
    projectId: ProjectId,
    prompt: string,
  ): Promise<boolean> {
    const project = projectController.allProjects.find(
      (candidate) =>
        candidate.type === "chat" &&
        candidate.lifecycle === "active" &&
        String(candidate.id) === String(projectId),
    );
    if (project === undefined) return false;
    const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
    const created = await chatController.execute({
      kind: "create-chat-thread",
      title,
      projectId: project.id,
    });
    if (created?.kind !== "thread-created") return false;
    let thread = created.thread;
    // A successful create is durable even if provider selection or the first
    // turn fails. Open its exact thread before either follow-up command so the
    // user can see the failure and retry instead of creating a duplicate.
    if (!(await controller.openChatThread(thread.id, thread.title, project.id))) return false;
    const selection = resolveDraftProviderSelection(
      draftProviderGroups,
      draftProviderInstanceId !== undefined && draftModelId !== undefined
        ? { providerInstanceId: draftProviderInstanceId, modelId: draftModelId }
        : undefined,
    );
    if (
      selection !== undefined &&
      (thread.providerInstanceId !== selection.providerInstanceId ||
        thread.modelId !== selection.modelId)
    ) {
      const changed = await chatController.execute({
        kind: "change-chat-provider",
        threadId: thread.id,
        expectedVersion: thread.version,
        providerInstanceId: selection.providerInstanceId,
        modelId: selection.modelId,
      });
      if (changed?.kind !== "thread-updated") return false;
      thread = changed.thread;
    }
    const sent = await chatController.execute({
      kind: "send-chat-turn",
      threadId: thread.id,
      expectedVersion: thread.version,
      prompt,
    });
    if (sent === undefined) {
      chatController.reportError(
        "The first message could not be sent. Retry from the open thread.",
      );
      return false;
    }
    return true;
  }

  async function handleDraftCreateCodeThread(
    input: CodeComposerSubmitInput,
    draftProjectId?: ProjectId,
  ): Promise<void> {
    setDraftCreating(true);
    setDraftError(undefined);
    setDraftPendingMessage(undefined);
    setRailPlaceholder(undefined);
    try {
      const resolution = resolveDraftProject({
        draftProjectId,
        candidates: projectController.projects,
        activeProject: projectController.activeProject,
      });
      if (resolution.kind === "unresolved-selection") {
        setDraftError(UNRESOLVED_DRAFT_PROJECT_MESSAGE);
        return;
      }
      const project = resolution.project;
      if (project?.type !== "code" || codeController.bootstrap === undefined) {
        setDraftError("No active Code Project is available.");
        return;
      }
      const prepared = await codeController.execute({
        kind: "prepare-code-project-checkout",
        projectId: project.id,
      });
      if (prepared?.kind !== "checkout-prepared") {
        setDraftError(checkoutNotPreparedMessage(project.name));
        return;
      }
      const codeSelection = resolveDraftProviderSelection(
        draftProviderGroups,
        draftProviderInstanceId !== undefined && draftModelId !== undefined
          ? { providerInstanceId: draftProviderInstanceId, modelId: draftModelId }
          : undefined,
      );
      const providerInstanceId =
        codeSelection?.providerInstanceId ?? codeProviderChoices[0]?.instanceId;
      const modelId = codeSelection?.modelId ?? codeProviderChoices[0]?.modelId;
      if (providerInstanceId === undefined || modelId === undefined) {
        setDraftError(
          "No provider is available. Configure a provider before starting a Code thread.",
        );
        return;
      }
      const timestamp = new Date().toISOString();
      const title = input.prompt.length > 60 ? `${input.prompt.slice(0, 57)}…` : input.prompt;
      // The Project's remembered habit — overridable for this one thread
      // in the composer — decides which journaled create command runs. Both
      // still go through the same server checkout and approval path.
      const plan = planCodeThreadCreate({
        composer: input,
        modelId,
        prepared,
        projectId: project.id,
        providerInstanceId,
        threadId: globalThis.crypto.randomUUID(),
        timestamp,
        title,
      });
      if (plan.kind === "rejected") {
        setDraftError(plan.message);
        return;
      }
      const created = await codeController.execute(plan.command);
      if (created?.kind !== "managed-thread-created" && created?.kind !== "thread-created") {
        setDraftError(
          codeController.lastExecuteError.current?.message ??
            "The Code thread could not be created.",
        );
        return;
      }
      const firstTurnStarted = await codeController.startThreadTurn({
        threadId: created.thread.id,
        checkoutId:
          created.kind === "managed-thread-created"
            ? created.checkout.id
            : created.thread.checkoutId,
        prompt: input.prompt,
      });
      if (!firstTurnStarted) {
        setDraftError("The thread was created, but its first provider turn could not be started.");
      }
      await controller.openCodeThread(
        created.thread.id,
        created.thread.title,
        undefined,
        created.thread.projectId,
      );
    } catch (error) {
      setDraftError(
        error instanceof Error && error.message !== ""
          ? error.message
          : "The Code thread could not be created.",
      );
    } finally {
      setDraftCreating(false);
    }
  }

  async function handleDraftCreateThread(
    mode: string,
    prompt: string,
    draftProjectId?: ProjectId,
    // The confirmed delivery outcome from the composer. It is only ever set by
    // explicit user confirmation in the composer UI; this handler never derives
    // or auto-confirms a heuristic suggestion of its own.
    deliveryOutcome?: CodeDeliveryOutcomeKind,
  ): Promise<void> {
    setDraftCreating(true);
    setDraftError(undefined);
    setDraftPendingMessage(undefined);
    setRailPlaceholder(undefined);
    try {
      if (mode === "chat") {
        const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
        const chatDraftProjectId =
          draftProjectId ??
          (controller.workspace === undefined || activeGroupId === undefined
            ? undefined
            : activeDraftProjectId(controller.workspace.layouts.chat, activeGroupId));
        const result = await chatController.execute({
          kind: "create-chat-thread",
          title,
          ...(chatDraftProjectId === undefined ? {} : { projectId: chatDraftProjectId }),
        });
        if (result?.kind !== "thread-created") {
          setDraftError("The chat thread could not be created.");
          return;
        }
        let thread = result.thread;
        const draftSelection = resolveDraftProviderSelection(
          draftProviderGroups,
          draftProviderInstanceId !== undefined && draftModelId !== undefined
            ? { providerInstanceId: draftProviderInstanceId, modelId: draftModelId }
            : undefined,
        );
        if (
          draftSelection !== undefined &&
          (thread.providerInstanceId !== draftSelection.providerInstanceId ||
            thread.modelId !== draftSelection.modelId)
        ) {
          const changed = await chatController.execute({
            kind: "change-chat-provider",
            threadId: thread.id,
            expectedVersion: thread.version,
            providerInstanceId: draftSelection.providerInstanceId,
            modelId: draftSelection.modelId,
          });
          if (changed?.kind !== "thread-updated") {
            setDraftError("The selected Chat provider and model could not be applied.");
            return;
          }
          thread = changed.thread;
        }
        const sendOutcome = chatController
          .execute({
            kind: "send-chat-turn",
            threadId: thread.id,
            expectedVersion: thread.version,
            prompt,
          })
          .then(
            (sent) => ({ sent }),
            (error: unknown) => ({ error }),
          );
        await controller.openChatThread(thread.id, thread.title);
        const outcome = await sendOutcome;
        if ("error" in outcome) {
          throw outcome.error;
        }
        if (outcome.sent === undefined) {
          setDraftError("The first message could not be sent. Retry from the open thread.");
        }
      } else if (mode === "code") {
        const resolution = resolveDraftProject({
          draftProjectId,
          candidates: projectController.projects,
          activeProject: projectController.activeProject,
        });
        if (resolution.kind === "unresolved-selection") {
          setDraftError(UNRESOLVED_DRAFT_PROJECT_MESSAGE);
          return;
        }
        const project = resolution.project;
        if (project?.type !== "code" || codeController.bootstrap === undefined) {
          setDraftError("No active Code Project is available.");
          return;
        }
        const prepared = await codeController.execute({
          kind: "prepare-code-project-checkout",
          projectId: project.id,
        });
        if (prepared?.kind !== "checkout-prepared") {
          setDraftError(checkoutNotPreparedMessage(project.name));
          return;
        }
        if (prepared.checkout.head.kind !== "branch") {
          setDraftError("Create or select a branch before starting a Code thread.");
          return;
        }
        const codeDraftSelection = resolveDraftProviderSelection(
          draftProviderGroups,
          draftProviderInstanceId !== undefined && draftModelId !== undefined
            ? { providerInstanceId: draftProviderInstanceId, modelId: draftModelId }
            : undefined,
        );
        const providerInstanceId =
          codeDraftSelection?.providerInstanceId ?? codeProviderChoices[0]?.instanceId;
        const modelId = codeDraftSelection?.modelId ?? codeProviderChoices[0]?.modelId;
        if (providerInstanceId === undefined || modelId === undefined) {
          setDraftError(
            "No provider is available. Configure a provider before starting a Code thread.",
          );
          return;
        }
        // The delivery outcome must be confirmed by the user in the composer;
        // never stamp a heuristic suggestion here without that confirmation.
        if (deliveryOutcome === undefined) {
          setDraftError("Confirm a delivery outcome before starting a Code thread.");
          return;
        }
        const timestamp = new Date().toISOString();
        const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
        const thread = decodeCodeThread({
          id: globalThis.crypto.randomUUID(),
          projectId: project.id,
          bindingRevisionId: prepared.bindingRevisionId,
          repositoryId: prepared.checkout.repositoryId,
          checkoutId: prepared.checkout.id,
          title,
          lifecycle: "active",
          providerInstanceId,
          modelId,
          executionPolicy: codeController.bootstrap.settings.defaultExecutionPolicy,
          permissionPersistence: codeController.bootstrap.settings.defaultPermissionPersistence,
          deliveryTarget: {
            branchIntent: prepared.checkout.head.name,
            remoteName: "origin",
            proposedBaseRepository: `local/${project.name}`,
            proposedBaseBranch: "development",
            outcomeKind: deliveryOutcome,
            confirmedAt: timestamp,
          },
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const created = await codeController.execute({
          kind: "create-code-thread",
          thread,
        });
        if (created?.kind !== "thread-created") {
          setDraftError("The Code thread could not be created.");
          return;
        }
        const firstTurnStarted = await codeController.startThreadTurn({
          threadId: created.thread.id,
          checkoutId: created.thread.checkoutId,
          prompt,
        });
        if (!firstTurnStarted) {
          setDraftError(
            "The thread was created, but its first provider turn could not be started.",
          );
        }
        await controller.openCodeThread(
          created.thread.id,
          created.thread.title,
          undefined,
          created.thread.projectId,
        );
      } else if (mode === "work") {
        const resolution = resolveDraftProject({
          draftProjectId,
          candidates: projectController.projects.filter(
            (
              candidate,
            ): candidate is Extract<
              (typeof projectController.projects)[number],
              { type: "work" }
            > => candidate.type === "work",
          ),
          activeProject: activeWorkProject,
        });
        if (resolution.kind === "unresolved-selection") {
          setDraftError(UNRESOLVED_DRAFT_PROJECT_MESSAGE);
          return;
        }
        const project = resolution.project;
        if (project === undefined || project.type !== "work") {
          setDraftError("No active Work Project is available.");
          return;
        }
        const providerInstanceId = workProviderChoice?.instanceId;
        const modelId = workProviderChoice?.modelId;
        if (providerInstanceId === undefined || modelId === undefined) {
          setDraftError(
            "No provider is available. Configure a provider before starting a Work thread.",
          );
          return;
        }
        const bindingRevisionId = project.bindingRevisionId;
        const created = await workThreadClient.execute({
          kind: "create-work-thread",
          threadId: decodeWorkThreadId(globalThis.crypto.randomUUID()),
          projectId: project.id,
          title: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
          providerInstanceId,
          modelId,
          hostId: createHostId,
          bindingRevisionId,
          workingDirectory: "." as never,
        });
        if (!("kind" in created) || created.kind !== "thread-created") {
          setDraftError("The Work thread could not be created.");
          return;
        }
        await controller.openWorkThread(
          created.thread.id,
          created.thread.title,
          undefined,
          created.thread.projectId,
        );
        await workNavigation.refresh();
        const started = await workTurnClient.startFirstTurn({
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
          threadId: created.thread.id,
          turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
          prompt,
          authority: {
            hostId: createHostId,
            projectId: project.id,
            bindingRevisionId,
            workingDirectory: created.thread.workingDirectory ?? ("." as never),
            confinementPosture: "project-root-confined",
            providerInstanceId,
            modelId,
          },
        });
        if (started.kind !== "accepted") {
          setDraftError(
            "The thread was created, but its first provider turn could not be started.",
          );
        }
      }
    } catch (error) {
      const detail =
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Review the provider and project status.";
      setDraftError(`The thread could not be created. ${detail}`);
    } finally {
      setDraftCreating(false);
      setDraftPendingMessage(undefined);
    }
  }

  async function continueZenThread(catalogRef: import("@octant/contracts").ZenThreadCatalogRef) {
    const target = await zen.continueThread(catalogRef);
    if (target === undefined) return;
    const { entry } = target;
    zen.exitZen();
    if (entry.projectId !== null) {
      await controller.openProject(entry.projectId, entry.mode, entry.projectLabel);
    }
    if (entry.mode === "chat") {
      await controller.openChatThread(decodeChatThreadId(entry.threadId), entry.title);
    } else if (entry.mode === "work") {
      await controller.openWorkThread(decodeWorkThreadId(entry.threadId), entry.title);
    } else {
      await controller.openCodeThread(decodeCodeThreadId(entry.threadId), entry.title);
    }
  }

  function openCommandProject(target: CommandProject): void {
    const project = projectController.allProjects.find(
      (candidate) => String(candidate.id) === target.projectId,
    );
    if (project === undefined) return;
    void openSelectedProject(project);
  }

  /**
   * The commands this window offers, rebuilt from the same authoritative state
   * the visible controls read. Each entry closes over the callback its ordinary
   * control already uses, so a command is a second route to an action, never a
   * second authority for it.
   */
  const octantCommands = buildOctantCommands({
    activeMode,
    modes: enabledModes(controller.settings),
    onSelectMode: handleSelectMode,
    onNewThread: () => void controller.openDraftThread(activeMode),
    onOpenSearch: openThreadSearch,
    onOpenSettings: () => void controller.openSettings(),
    threads: threadSearchThreads
      .filter((thread) => thread.lifecycle === "active")
      .map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        mode: thread.mode,
        ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      })),
    onOpenThread: (thread) => {
      // The entry keeps its thread's own Project so a cross-Project open
      // dispatches the Project switch, exactly like the sidebar's open
      // handlers, instead of a plain open-tab the server-authoritative
      // workspace policy rejects.
      const threadProjectId =
        thread.projectId === undefined ? undefined : decodeProjectId(thread.projectId);
      if (thread.mode === "chat") {
        void controller.openChatThread(
          decodeChatThreadId(thread.threadId),
          thread.title,
          threadProjectId,
        );
        return;
      }
      if (thread.mode === "work") {
        void controller.openWorkThread(
          decodeWorkThreadId(thread.threadId),
          thread.title,
          undefined,
          threadProjectId,
        );
        return;
      }
      void controller.openCodeThread(
        decodeCodeThreadId(thread.threadId),
        thread.title,
        undefined,
        threadProjectId,
      );
    },
    projects: projectController.projects
      .filter((project) => project.lifecycle === "active" && enabledProjectTypes.has(project.type))
      .map((project) => ({
        projectId: String(project.id),
        name: project.name,
        mode: project.type,
      })),
    onOpenProject: openCommandProject,
    // Only profiles the host loaded and marked compatible with the active mode
    // are offered; an unloaded or incompatible profile would be a dead entry.
    profiles:
      executionProfileController.status === "loading" ||
      executionProfileController.status === "error"
        ? []
        : executionProfileController.profiles
            .filter((profile) => profile.compatibleModes.includes(activeMode))
            .map((profile) => ({
              profileId: String(profile.id),
              displayName: profile.displayName,
              executionPolicyLabel: EXECUTION_POLICY_LABEL[profile.defaultExecutionPolicy],
            })),
    onSelectProfile: (profile) => {
      const target = executionProfileController.profiles.find(
        (candidate) => String(candidate.id) === profile.profileId,
      );
      if (target === undefined) return;
      executionProfileController.selectProfile(target.id);
    },
    skills: commandSkills,
    appleProjects,
    onOpenAppleProject: (project) => {
      // The thread's own controller, not the window's reader: the window's
      // reader binds to no thread and so knows no checkout to open against.
      const view = activeCodeThreadView;
      if (view === undefined) return;
      void controller.openCodeSurface({
        kind: "apple-workbench",
        threadId: view.thread.id,
        title: "Apple workbench",
        projectPath: project.projectPath as never,
      });
    },
  });

  const usageSurface = (
    <UsageWorkspace
      client={usageDashboardClient}
      isNarrow={isNarrow}
      onBack={() => setUsageOpen(false)}
      {...(pendingUsageFilter === undefined ? {} : { initialFilter: pendingUsageFilter })}
    />
  );
  const settingsSurface = (
    <ShellThemeRoot
      {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
      {...(themeController.draft?.typography === undefined && props.typography === undefined
        ? {}
        : { typography: themeController.draft?.typography ?? props.typography })}
      {...(themeController.draft === undefined ? {} : { theme: themeController.draft })}
    >
      <SettingsSurfaceErrorBoundary onReload={() => globalThis.location.reload()}>
        <Suspense
          fallback={
            <main className="shell-boundary">
              <ShellState
                eyebrow="Settings"
                message="Loading the Octant settings surface."
                state="loading"
                title="Opening Settings"
              />
            </main>
          }
        >
          <LazySettingsView
            chatController={chatController}
            codeController={codeController}
            discoveryController={discoveryController}
            executionProfiles={
              <ExecutionProfileWorkflow
                controller={executionProfileController}
                variant="settings"
              />
            }
            extensionClient={extensionClient}
            {...(props.hostBridge?.selectLocalPluginFolder === undefined
              ? {}
              : {
                  pickLocalPluginFolder: async () => {
                    const selected = await props.hostBridge!.selectLocalPluginFolder!();
                    return selected.kind === "selected"
                      ? { receiptId: selected.receiptId, displayName: selected.displayName }
                      : undefined;
                  },
                })}
            agentRunSettingsClient={agentRunSettingsClient}
            automationNotificationClient={automationNotificationClient}
            isNarrow={isNarrow}
            nativeBoundsAvailable={nativeHost !== undefined}
            onBack={controller.closeSettings}
            onDeepLinkApplied={controller.clearPendingSettingsDeepLink}
            onResetLayout={controller.resetActiveLayout}
            onResetNativeBounds={controller.resetNativeBounds}
            onSearchChange={controller.setSettingsSearch}
            onSettingsChange={controller.updateSettings}
            pendingDeepLink={controller.pendingSettingsDeepLink}
            providerController={providerController}
            search={controller.settingsSearch}
            settings={controller.settings}
            sidebarVibrancySupported={sidebarVibrancySupported}
            themeController={themeController}
            diagnosticsExportClient={diagnosticsExportClient}
            hostControlClient={hostControlClient}
            {...(hostFederationLifecycle === undefined ? {} : { hostFederationLifecycle })}
            githubClient={githubClient}
            usageClient={usageClient}
            visibleSettings={controller.visibleSettings}
          />
        </Suspense>
      </SettingsSurfaceErrorBoundary>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-announcement-sequence={controller.announcementSequence}
        style={visuallyHiddenStyle}
      >
        {controller.announcement}
      </p>
    </ShellThemeRoot>
  );

  const shell = (
    <ZenRoot
      active={zen.active}
      onCycleSpace={(step) => void zen.cycleSpace(step)}
      onExit={zen.exitZen}
      onToggle={() => {
        if (zen.active) zen.exitZen();
        else void zen.enterZen();
      }}
      zen={
        zen.space === null ? (
          <div className="zen-surface zen-surface--loading" role="status">
            Opening Zen…
          </div>
        ) : (
          <ZenSurface
            assistant={zen.assistant}
            focusZone={zen.focusZone}
            renderTerminal={({ element, activity }) => {
              // The card acts under the thread that owns the shell, so its
              // posture is that thread's own. A thread this window can no
              // longer see is a card that opens nothing.
              const owner = codeController.bootstrap?.threads.find(
                (candidate) => String(candidate.id) === String(element.sourceContext.threadId),
              );
              if (owner === undefined) return undefined;
              return (
                <ZenTerminalCard
                  client={codeClient}
                  createOperationId={createCodeOperationId}
                  executionPolicy={owner.executionPolicy}
                  live={activity.activity === "live"}
                  scope={{ checkoutId: element.checkoutId, threadId: owner.id }}
                  terminalId={element.terminalId}
                />
              );
            }}
            renderCanvas={({ element }) => {
              // The card reads the same document a workspace tab reads, so it
              // needs the same client and no authority of its own. Without one
              // the card says it cannot read rather than showing nothing.
              if (canvasClient === undefined) return undefined;
              return <ZenCanvasCard canvasId={element.canvasId} client={canvasClient} />;
            }}
            renderResearchDock={({ dock }) => {
              // The dock shows the bound thread's own browsing context. Zen
              // holds no browser client of its own; it hands over the binding
              // and the shell's client, and the server decides what that
              // thread's context may reach.
              if (browserAutomationClient === undefined) return undefined;
              return (
                <ZenResearchDock
                  client={browserAutomationClient}
                  dock={dock}
                  {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
                  onCollapse={(collapsed) =>
                    void zen.dockResearch({
                      thread: {
                        threadId:
                          dock.sourceContext.threadKind === "code"
                            ? decodeCodeThreadId(String(dock.sourceContext.threadId))
                            : decodeWorkThreadId(String(dock.sourceContext.threadId)),
                        mode: dock.sourceContext.threadKind === "code" ? "code" : "work",
                      },
                      width: dock.width,
                      collapsed,
                    })
                  }
                  onUndock={() => void zen.dockResearch({ thread: null })}
                />
              );
            }}
            spacesBusy={zen.panelBusy}
            onAddSpace={(name) => void zen.addSpace(name)}
            onRemoveSpace={(spaceId) => void zen.removeSpace(spaceId)}
            onRenameSpace={(spaceId, name) => void zen.renameSpace(spaceId, name)}
            onShowSpace={(spaceId) => void zen.showSpace(spaceId)}
            {...(zen.backgroundObjectUrl === undefined
              ? {}
              : { backgroundImageUrl: zen.backgroundObjectUrl })}
            backgroundStatus={zen.backgroundStatus}
            assistantOpen={zen.assistantOpen}
            barCollapsed={zen.barCollapsed}
            {...(zen.message === undefined ? {} : { message: zen.message })}
            panelBusy={zen.panelBusy}
            threadEntries={zen.threadEntries}
            threadPickerOpen={zen.threadPickerOpen}
            threadQuery={zen.threadQuery}
            onAddTimer={(durationMs) => void zen.addTimer(durationMs)}
            onPinThread={(catalogRef) => void zen.pinThread(catalogRef)}
            onCloseAssistant={() => zen.setAssistantOpen(false)}
            onCloseThreadPicker={() => zen.setThreadPickerOpen(false)}
            onContinueThread={(catalogRef) => void continueZenThread(catalogRef)}
            renderLiveThread={(input) =>
              resolveZenLiveThreadCard({ ...input, clients: zenLiveThreadClients })
            }
            onConfirmRecipePreview={(action) => void zen.confirmRecipePreview(action)}
            onCreateReference={(url, label) =>
              void zen.createReference(url, label).catch(() => undefined)
            }
            onUploadBackground={(file) => void zen.uploadBackground(file).catch(() => undefined)}
            onCreateWidget={(kind) => void zen.createWidget(kind).catch(() => undefined)}
            onExit={zen.exitZen}
            onExpandBar={() => zen.setBarCollapsed(false)}
            onHideBar={() => zen.setBarCollapsed(true)}
            navigatorAssistant={navigatorAssistant}
            onAssistantTurn={() => zen.refreshAssistant()}
            onOpenAssistant={() => zen.openAssistant()}
            onOpenSettings={(target) => void controller.openSettings(target)}
            onOpenThreads={(query) => void zen.openThreads(query)}
            onAddChecklistItem={zen.addChecklistItem}
            onRemoveElement={(elementId) => void zen.removeElement(elementId)}
            onRemoveChecklistItem={zen.removeChecklistItem}
            onReorderChecklistItem={zen.reorderChecklistItem}
            onSaveNotes={zen.saveNotes}
            onTimerAction={(elementId, action, durationMs) =>
              void zen.timerAction(elementId, action, durationMs)
            }
            onRefreshTimers={() => void zen.refreshTimers()}
            onSetChecklistItemCompleted={zen.setChecklistItemCompleted}
            onUpdateAppearance={(appearance) => void zen.updateAppearance(appearance)}
            onUpdateElement={(element) => void zen.updateElement(element)}
            onUpdateViewport={(viewport) => void zen.updateViewport(viewport)}
            space={zen.space}
          />
        )
      }
    >
      {hostFederationLifecycle === undefined ? null : (
        <FederatedHostsLifecycleStrip lifecycle={hostFederationLifecycle} />
      )}
      <ShellFrame
        standaloneSurface={
          controller.settingsOpen ? settingsSurface : usageOpen ? usageSurface : undefined
        }
        {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
        {...(themeController.draft?.typography === undefined && props.typography === undefined
          ? {}
          : { typography: themeController.draft?.typography ?? props.typography })}
        {...(themeController.draft === undefined ? {} : { theme: themeController.draft })}
        chrome={
          <WindowChrome
            activeSurface={activeSurface}
            {...(props.developmentAuthentication === undefined
              ? {}
              : { developmentAuthentication: props.developmentAuthentication })}
            dockAvailable={preferredDockSurface !== undefined}
            dockExpanded={dockOpen}
            dockLabel={
              dockResolution.kind === "surface"
                ? dockResolution.surface.label
                : (preferredDockSurface?.label ?? "Utility dock")
            }
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            isNarrow={isNarrow}
            material={material}
            {...(sidebarCollapsed && !isNarrow
              ? { onExpandSidebar: () => setSidebarCollapsedPersistent(false) }
              : {})}
            onOpenZen={() => void zen.enterZen()}
            onRecoverZen={() => void zen.recoverZen()}
            onToggleDock={toggleDock}
            zenRecoveryNeeded={zen.recoveryNeeded}
          />
        }
        contextSidebarWidth={contextSidebarWidth}
        material={material}
        onCommitSidebarWidth={(width) => {
          setPreviewSidebarWidth(width);
          void controller.updateSettings({ sidebarWidth: width });
        }}
        onPreviewSidebarWidth={setPreviewSidebarWidth}
        sidebarCollapsed={sidebarCollapsed && !isNarrow}
        sidebarVibrancyMode={presentedShellSettings?.sidebarBackground.vibrancyMode ?? "off"}
        sidebar={
          <ShellSidebar
            {...(activeMode === "chat"
              ? {
                  ...(chatController.errorMessage === undefined
                    ? {}
                    : { chatErrorMessage: chatController.errorMessage }),
                  ...(chatController.status === "ready"
                    ? {}
                    : { chatStatus: chatController.status }),
                }
              : {})}
            {...(activeMode === "chat"
              ? {
                  chatNavigation: {
                    actions: {
                      "new-chat": createChat,
                      "artifact-library": openArtifactLibrary,
                      plugins: openSkillsSettings,
                    },
                  },
                }
              : {})}
            {...(activeMode === "code"
              ? {
                  codeNavigation: {
                    actions: {
                      "new-code-thread": () => openDraftInActiveProject("code"),
                      automations: openAutomationCenter,
                      "artifact-library": openArtifactLibrary,
                      plugins: openSkillsSettings,
                      "thread-board": () => {
                        setRailPlaceholder(undefined);
                        setAutomationCenterOpen(false);
                        setArtifactLibraryOpen(false);
                        setCodeBoardOpen(true);
                      },
                      "pull-requests": () =>
                        openRailPlaceholder(
                          "Pull requests",
                          "Pull request review for Code threads is reserved for a later preview.",
                        ),
                    },
                  },
                }
              : {})}
            {...(activeMode === "work"
              ? {
                  workNavigation: {
                    actions: {
                      "new-work-thread": () => openDraftInActiveProject("work"),
                      automations: openAutomationCenter,
                      "artifact-library": openArtifactLibrary,
                      plugins: openSkillsSettings,
                      "thread-board": () =>
                        openRailPlaceholder(
                          "Thread board",
                          "The Work Thread Board will show runtime-derived threads and server-authoritative status.",
                        ),
                    },
                  },
                }
              : {})}
            onAddFolder={() => setCreateOpen(true)}
            onOpenSearch={openThreadSearch}
            {...(isNarrow ? {} : { onCollapseSidebar: () => setSidebarCollapsedPersistent(true) })}
            onOpenSettings={(deepLink) => void controller.openSettings(deepLink)}
            onOpenZen={() => void zen.enterZen()}
            onRetryChat={() => void chatController.retry()}
            onSelectMode={handleSelectMode}
            settings={presentedShellSettings ?? controller.settings}
            workspace={controller.workspace}
            resolvedSidebarBackground={resolvedSidebarBackground}
            backgroundFetcher={sidebarBackgroundFetcher}
            projectSection={
              projectController.status === "loading" ? (
                <p className="project-nav__status" role="status">
                  Loading Projects…
                </p>
              ) : projectController.status === "disconnected" ? (
                <div className="project-nav__status" role="alert">
                  <span>{projectController.errorMessage}</span>
                  <OctantButton onClick={projectController.retry} type="button" variant="secondary">
                    Retry
                  </OctantButton>
                </div>
              ) : (
                <ProjectSidebarSection
                  {...(activeMode === "code"
                    ? {
                        projectViewsEnabled: true,
                        projectViewSwitcherPresentation: (
                          presentedShellSettings ?? controller.settings
                        ).projectViewSwitcherPresentation,
                      }
                    : {})}
                  activityMode={activeMode}
                  {...(activeProjectId === undefined ? {} : { activeProjectId })}
                  {...(activeMode === "chat" && chatProjectThreadListRequest !== undefined
                    ? { expandProjectThreadsRequest: chatProjectThreadListRequest }
                    : {})}
                  {...((activeMode === "chat" &&
                    chatController.status === "ready" &&
                    activeChatThreadId !== undefined) ||
                  (activeMode === "code" &&
                    codeController.status === "ready" &&
                    activeCodeThreadId !== undefined) ||
                  (activeMode === "work" &&
                    workNavigation.status === "ready" &&
                    activeWorkThreadId !== undefined)
                    ? {
                        activeThreadId:
                          activeMode === "code"
                            ? String(activeCodeThreadId)
                            : activeMode === "work"
                              ? String(activeWorkThreadId)
                              : String(activeChatThreadId),
                      }
                    : {})}
                  archivedProjects={projectController.archivedProjects}
                  availabilityByProject={projectController.availabilityByProject}
                  {...(activeMode === "chat"
                    ? (chatController.navigation?.length ?? 0) > 0
                      ? {
                          addProjectLabel: "chat-project" as const,
                          onAddProject: () => setCreateOpen(true),
                        }
                      : {}
                    : {
                        onAddProject: () => setCreateOpen(true),
                        unfiledLabel: "Recents" as const,
                      })}
                  onArchive={(projectId) => void projectController.setArchived(projectId, true)}
                  onMove={(projectId, pinned) => void projectController.move(projectId, pinned)}
                  {...(activeMode === "chat"
                    ? {
                        newThreadVerb: "chat" as const,
                        onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                      }
                    : activeMode === "code"
                      ? {
                          newThreadVerb: "thread" as const,
                          onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                        }
                      : activeMode === "work"
                        ? {
                            newThreadVerb: "thread" as const,
                            onNewThreadInProject: (projectId) => void openDraftInProject(projectId),
                          }
                        : {})}
                  onReorder={(projectId, pinned, beforeProjectId, afterProjectId) =>
                    void projectController.move(projectId, pinned, beforeProjectId, afterProjectId)
                  }
                  onRestore={(projectId) => void projectController.setArchived(projectId, false)}
                  onProjectOpen={openSelectedProject}
                  {...(activeMode === "chat" && chatController.status === "ready"
                    ? {
                        onSelectThread: selectChatThread,
                        threads: chatController.navigation,
                      }
                    : activeMode === "code"
                      ? {
                          onSelectThread: selectCodeThread,
                          threadActions: codeThreadRowActions,
                          onRenameThread: renameCodeThreadFromRow,
                          ...(markedThreadGroups === undefined
                            ? codeController.status === "ready"
                              ? { threads: codeProjectThreads.map(withProviderMark) }
                              : {}
                            : { threadGroups: markedThreadGroups }),
                        }
                      : activeMode === "work"
                        ? {
                            onSelectThread: selectWorkThread,
                            ...(markedThreadGroups === undefined
                              ? workNavigation.status === "ready"
                                ? { threads: workProjectThreads.map(withProviderMark) }
                                : {}
                              : { threadGroups: markedThreadGroups }),
                          }
                        : {})}
                  {...(activeMode === "chat"
                    ? {}
                    : {
                        threadStatus: projectThreadsAccess.status,
                        ...(projectThreadsAccess.errorMessage === undefined
                          ? {}
                          : { threadErrorMessage: projectThreadsAccess.errorMessage }),
                        onRetryThreads: () => projectThreadsAccess.onRetry?.(),
                      })}
                  projects={projectController.projects}
                />
              )
            }
          />
        }
        sidebarResizable={!isNarrow}
        sidebarWidth={sidebarWidth}
        wideContextOpen={!isNarrow && dockOpen}
        workspace={
          <>
            <div className="primary-workspace-layer">
              {railPlaceholder === undefined ? null : (
                <div className="rail-placeholder" role="status">
                  <ShellState
                    action={{
                      label: "Back to workspace",
                      onClick: () => setRailPlaceholder(undefined),
                    }}
                    eyebrow="Sidebar"
                    message={railPlaceholder.message}
                    state="neutral"
                    title={railPlaceholder.title}
                  />
                </div>
              )}
              {codeBoardOpen && activeMode === "code" ? (
                <div className="code-board-layer">
                  <CodeThreadBoard
                    loadBoard={(query) => codeClient.queryBoard(query)}
                    projects={codeBoardProjects}
                    onClose={() => setCodeBoardOpen(false)}
                    onOpenThread={(threadId) => {
                      const thread = codeController.bootstrap?.threads.find(
                        (candidate) => String(candidate.id) === String(threadId),
                      );
                      setCodeBoardOpen(false);
                      void controller.openCodeThread(
                        threadId,
                        thread?.title ?? "Code thread",
                        undefined,
                        thread?.projectId,
                      );
                    }}
                  />
                </div>
              ) : null}
              {artifactLibraryOpen ? (
                <div className="artifact-library-layer">
                  <ArtifactLibrarySurface
                    onClose={() => setArtifactLibraryOpen(false)}
                    onCreate={() => {
                      // An artifact carries the thread it was made in, so there
                      // is nowhere to put one that has no origin. Starting a
                      // thread is what "new artifact" means here.
                      setArtifactLibraryOpen(false);
                      createChat();
                    }}
                    onOpen={(entry) => {
                      setArtifactLibraryOpen(false);
                      void controller.openCanvas({
                        mode: entry.mode,
                        title: entry.title,
                        canvasId: entry.canvasId,
                        projectId: entry.projectId,
                      });
                    }}
                    serverUrl={props.launch.serverUrl}
                    {...(props.projectWindowCapability === undefined
                      ? {}
                      : { windowCapability: props.projectWindowCapability })}
                  />
                </div>
              ) : null}
              {automationCenterVisible ? (
                <div className="automation-center-layer">
                  <AutomationCenter
                    catalog={automationEditorCatalog}
                    client={automationClient}
                    // What each connected host is called, so a routine's row and
                    // the environment filter never disagree about a name. The
                    // host this window runs on is always "Local", whatever the
                    // machine is called and whatever it runs.
                    environmentNames={
                      new Map(hosts.map((host) => [String(host.hostId), host.displayName] as const))
                    }
                    localHostId={String(LOCAL_HOST_ID)}
                    narrow={isNarrow}
                    notificationClient={automationNotificationClient}
                    onClose={() => setAutomationCenterOpen(false)}
                    onOpenThread={(target) => {
                      setAutomationCenterOpen(false);
                      if (target.mode === "code") {
                        void controller.openCodeThread(
                          decodeCodeThreadId(target.threadId),
                          target.title,
                        );
                      } else {
                        void controller.openWorkThread(
                          decodeWorkThreadId(target.threadId),
                          target.title,
                        );
                      }
                    }}
                  />
                </div>
              ) : null}
              <ProjectMemoryInspectorProvider onOpen={openMemoryInspector}>
                <WorkspaceView
                  onNewThreadInProject={(projectId) => void openDraftInProject(projectId)}
                  appleToolchainClient={appleToolchainClient}
                  agentRunClient={agentRunClient}
                  agentRunSettingsClient={agentRunSettingsClient}
                  chatClient={chatClient}
                  chatController={chatController}
                  chatReadCursorStore={chatReadCursorStore}
                  onPinTerminal={(request) => void zen.pinTerminal(request)}
                  onPinCanvasInFocusZone={(request) => void zen.pinCanvas(request)}
                  onDockResearch={(request) =>
                    void zen.dockResearch({
                      thread: {
                        threadId:
                          request.mode === "code"
                            ? decodeCodeThreadId(request.threadId)
                            : decodeWorkThreadId(request.threadId),
                        mode: request.mode,
                      },
                    })
                  }
                  codeController={codeController}
                  codeControllers={codeThreadControllers}
                  extensionClient={extensionClient}
                  workPromotionController={workPromotionController}
                  codeProviderChoices={codeProviderChoices}
                  hosts={hosts}
                  selectedCreateHostId={createHostId}
                  createHostViewScope={createHostViewScope}
                  {...(lastSelectedHealthyHostId === undefined
                    ? {}
                    : { lastSelectedHealthyHostId })}
                  onSelectCreateHost={handleSelectCreateHost}
                  {...(controller.workspace.focusedGroupId === undefined
                    ? {}
                    : { focusedGroupId: controller.workspace.focusedGroupId })}
                  layout={controller.presentedLayout}
                  memoryRevision={projectController.memoryRevision}
                  availabilityByProject={projectController.availabilityByProject}
                  {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
                  folderBrowseClient={folderBrowseClient}
                  githubClient={githubClient}
                  githubCloneClient={githubCloneClient}
                  hostId={createHostId}
                  hidden={railPlaceholder !== undefined || codeBoardOpen || automationCenterVisible}
                  onActivate={controller.activateTab}
                  tabActivation={controller.tabActivation}
                  onClearFocus={controller.clearFocus}
                  onClose={controller.closeTab}
                  onCommitResize={controller.commitSplitResize}
                  onCreateChat={createChat}
                  onCreateChatProjectThread={handleCreateChatProjectThread}
                  onOpenChatThread={(threadId, title, projectId) => {
                    // A thread this window's sidebar controller has never seen
                    // (a branch minted from a tab's own controller) must reach
                    // navigation the same way a draft-created thread does:
                    // through an authoritative bootstrap reload.
                    if (
                      !chatController.navigation.some((item) => item.threadId === String(threadId))
                    ) {
                      void chatController.refreshNavigation();
                    }
                    void controller.openChatThread(threadId, title, projectId);
                  }}
                  onViewAllChatProjectThreads={viewAllChatProjectThreads}
                  onOpenSideChat={(sidecar) => void controller.openSideChat(sidecar)}
                  {...(activeMode === "chat" && draftCreating ? { chatWelcomeCreating: true } : {})}
                  {...(activeMode === "chat" && draftError !== undefined
                    ? { chatWelcomeError: draftError }
                    : {})}
                  providerReady={providerReady}
                  {...(discoveryController.message === undefined
                    ? {}
                    : { providerBootstrapMessage: discoveryController.message })}
                  onOpenDraftThread={(mode) => void controller.openDraftThread(mode)}
                  workCreateThreadAvailable={workCreateThreadAvailable}
                  workMutationClient={workMutationClient}
                  workThreadClient={workThreadClient}
                  onWorkThreadUpdated={workNavigation.applyThread}
                  workTurnClient={workTurnClient}
                  workRequestClient={workRequestClient}
                  workOverviewClient={workOverviewClient}
                  workResearchClient={workResearchClient}
                  goalClient={goalClient}
                  goalLoopClient={goalLoopClient}
                  shipClient={shipClient}
                  planClient={planClient}
                  onOpenCodeFile={({ threadId, relativePath }) => {
                    void controller.openCodeSurface({
                      kind: "code-file",
                      threadId,
                      title: relativePath,
                      relativePath,
                    });
                  }}
                  usageDashboardClient={usageDashboardClient}
                  onOpenUsageDashboard={(filter) => {
                    setPendingUsageFilter(filter);
                    setUsageOpen(true);
                  }}
                  browserAutomationClient={browserAutomationClient}
                  computerUseClient={computerUseClient}
                  onComputerUseSessionChange={onComputerUseSessionChange}
                  isNarrow={isNarrow}
                  onFocus={controller.focusGroup}
                  onDropTab={controller.dropTab}
                  onCreateWorkThread={handleCreateWorkThread}
                  onOpenWorkThread={(threadId, projectId) => {
                    const thread = workNavigation.navigation.find(
                      (candidate) => candidate.threadId === String(threadId),
                    );
                    void controller.openWorkThread(
                      threadId,
                      thread?.title ?? "Work thread",
                      undefined,
                      projectId,
                    );
                  }}
                  onArchiveProject={(projectId) =>
                    void projectController.setArchived(projectId, true)
                  }
                  onMove={controller.moveTab}
                  onOpenCodeThread={(threadId, title, projectId) =>
                    void controller.openCodeThread(threadId, title, undefined, projectId)
                  }
                  onToggleCanvasPin={(groupId, tab) => {
                    if (tab.kind === "canvas") void controller.toggleCanvasTabPin(groupId, tab);
                  }}
                  onOpenCodeSurface={(kind, threadId, title, terminalId) =>
                    void controller.openCodeSurface(
                      kind === "code-terminal"
                        ? {
                            kind,
                            threadId,
                            title,
                            ...(terminalId === undefined ? {} : { terminalId }),
                          }
                        : { kind, threadId, title },
                    )
                  }
                  onPreviewResize={controller.previewSplitResize}
                  onReorder={controller.reorderTab}
                  onRelinkProject={projectController.relink}
                  onRenameProject={projectController.rename}
                  onSplit={controller.splitGroup}
                  projects={projectController.allProjects}
                  providerController={providerController}
                  renderTabAccessory={(tab, groupId) => {
                    if (tab.kind !== "project") return null;
                    const snapshot = contextSnapshotsByProject.get(tab.projectId);
                    const health = snapshot?.next.plan.health;
                    if (health === undefined || health === "healthy") return null;
                    return (
                      <ContextTabWarning
                        health={health}
                        label={tab.title}
                        onOpen={() => {
                          const element = document.activeElement;
                          if (!(element instanceof HTMLElement)) return;
                          if (tab.projectId === activeProjectId) {
                            openDockSurface("context", element);
                            return;
                          }
                          void controller.activateTab(groupId, tab.id).then(() => {
                            dockOpener.current = { element, logicalTarget: "dock" };
                            setDockProjectId(tab.projectId);
                            setDockSurface("context");
                            projectController.clearMemory();
                            if (controller.settings?.lastContextSurface !== "context") {
                              void controller.updateSettings({ lastContextSurface: "context" });
                            }
                          });
                        }}
                      />
                    );
                  }}
                  statusBar={
                    contextController.snapshot === undefined ? null : (
                      <ContextStatusBar
                        focus={{ kind: "thread" }}
                        onOpenInspector={() => {
                          const element = document.activeElement;
                          if (element instanceof HTMLElement) openDockSurface("context", element);
                        }}
                        snapshot={contextController.snapshot}
                      />
                    )
                  }
                  workspace={controller.workspace}
                  {...(controller.availableSurfaces === undefined
                    ? {}
                    : { availableSurfaces: controller.availableSurfaces })}
                  mode={controller.workspace.activeMode}
                  {...(controller.crossContextOffer === undefined
                    ? {}
                    : {
                        crossContextOffer: {
                          message: controller.crossContextOffer.message,
                          canOpenInNewWindow:
                            controller.crossContextOffer.newWindowProjectId !== undefined &&
                            controller.canOpenCrossContextInNewWindow,
                        },
                      })}
                  onOpenSurface={(surface, groupId, browserContextId) =>
                    controller.openSurface(surface, groupId, browserContextId)
                  }
                  onDismissCrossContextOffer={controller.dismissCrossContextOffer}
                  onOpenCrossContextInNewWindow={() =>
                    void controller.openCrossContextInNewWindow()
                  }
                  environmentPresentation={
                    controller.environmentPresentation ?? defaultEnvironmentPresentationState()
                  }
                  onSetEnvironmentPresentation={(next) =>
                    void controller.setEnvironmentPresentation(next)
                  }
                  projectClient={projectController.client}
                  projectServerUrl={props.launch.serverUrl}
                  {...(props.projectWindowCapability === undefined
                    ? {}
                    : { projectWindowCapability: props.projectWindowCapability })}
                  previewClient={previewClient}
                  canvasClient={canvasClient}
                  onOpenCanvasReference={(card) =>
                    void controller.openCanvas({
                      mode: card.scope.mode,
                      title: card.title,
                      canvasId: card.canvasId,
                      projectId: card.scope.workspace.projectId as never,
                    })
                  }
                  onOpenCanvas={(entry) =>
                    void controller.openCanvas({
                      mode: entry.mode,
                      title: entry.title,
                      canvasId: entry.canvasId,
                      projectId: entry.projectId,
                    })
                  }
                  draftProviderGroups={draftProviderGroups}
                  codeProviderGroups={codeProviderGroups}
                  workProviderGroups={workProviderGroups}
                  {...(projectController.activeProject === undefined
                    ? {}
                    : { draftProjectName: projectController.activeProject.name })}
                  {...(effectiveDraftProviderInstanceId === undefined
                    ? {}
                    : { draftSelectedProviderInstanceId: effectiveDraftProviderInstanceId })}
                  {...(effectiveDraftModelId === undefined
                    ? {}
                    : { draftSelectedModelId: effectiveDraftModelId })}
                  onDraftSelectProvider={(selection) => {
                    setDraftProviderInstanceId(selection.providerInstanceId);
                    setDraftModelId(selection.modelId);
                  }}
                  onDraftCreateThread={handleDraftCreateThread}
                  onDraftCreateCodeThread={handleDraftCreateCodeThread}
                  onChangeCodeNewThreadWorkspace={projectController.setCodeNewThreadWorkspace}
                  draftCodeExecute={codeController.execute}
                  onCreateProject={(mode, name, receiptId) =>
                    projectController.create(mode, name, receiptId, createHostId)
                  }
                  {...(draftCreating ? { onDraftCreating: true } : {})}
                  {...(draftError === undefined ? {} : { onDraftError: draftError })}
                  {...(draftPendingMessage === undefined
                    ? {}
                    : { onDraftPendingMessage: draftPendingMessage })}
                  onAttachFolder={() => setCreateOpen(true)}
                  onOpenProviderSettings={() =>
                    void controller.openSettings({ section: "providers" })
                  }
                  onOpenSettings={() => void controller.openSettings()}
                  draftExecutionProfile={
                    <ExecutionProfileWorkflow
                      controller={executionProfileController}
                      variant="composer"
                    />
                  }
                />
              </ProjectMemoryInspectorProvider>
            </div>
            <RightUtilityDock
              availableSurfaces={availableDockSurfaces}
              context={
                contextController.snapshot === undefined ? (
                  // A thread nothing has planned yet is an empty panel, not a
                  // failed one: no alert, and no Retry that could not change
                  // the answer.
                  contextController.status === "not-planned" ? (
                    <ShellState
                      eyebrow="Context"
                      message="It appears once this thread takes its first turn."
                      state="neutral"
                      title="No context plan yet"
                    />
                  ) : (
                    <ShellState
                      {...(contextController.status === "disconnected"
                        ? { action: { label: "Retry context", onClick: contextController.retry } }
                        : {})}
                      eyebrow="Context"
                      message={
                        contextController.errorMessage ?? "Loading the authoritative context plan."
                      }
                      {...(contextController.status === "disconnected" ? { role: "alert" } : {})}
                      state={
                        contextController.status === "disconnected" ? "disconnected" : "loading"
                      }
                      title={
                        contextController.status === "disconnected"
                          ? "Context is unavailable"
                          : "Loading context"
                      }
                    />
                  )
                ) : (
                  <ContextInspector
                    busy={contextController.status === "updating"}
                    onClose={closeDock}
                    onRebuild={() => void contextController.rebuild()}
                    onSetExcluded={(entryId, excluded) =>
                      void contextController.setExcluded(entryId, excluded)
                    }
                    onSetPinned={(entryId, pinned) =>
                      void contextController.setPinned(entryId, pinned)
                    }
                    snapshot={contextController.snapshot}
                  />
                )
              }
              isNarrow={isNarrow}
              navigator={
                <NavigatorPanel
                  controller={navigatorAssistant}
                  onClose={closeDock}
                  onOpenSettings={(target) => void controller.openSettings(target)}
                />
              }
              onClose={closeDock}
              onCommitWidth={(width) => {
                setPreviewContextWidth(width);
                void controller.updateSettings({ contextSidebarWidth: width });
              }}
              onPreviewWidth={setPreviewContextWidth}
              onSelectSurface={(surface) => {
                const opener = document.activeElement;
                if (opener instanceof HTMLElement) openDockSurface(surface, opener);
              }}
              projectMemory={
                dockProject === undefined ? null : (
                  <ProjectMemoryInspector
                    busy={projectController.memoryBusy}
                    embedded
                    {...(projectController.memoryErrorMessage === undefined
                      ? {}
                      : { errorMessage: projectController.memoryErrorMessage })}
                    {...(projectController.memory === undefined
                      ? {}
                      : { memory: projectController.memory })}
                    onClose={closeDock}
                    onCreate={projectController.createMemory}
                    onLoad={projectController.loadMemory}
                    onRetract={projectController.retractMemory}
                    onRetry={projectController.retryMemory}
                    onSupersede={projectController.supersedeMemory}
                    onTransfer={projectController.transferMemory}
                    project={dockProject}
                    projects={memoryTransferProjects}
                    status={projectController.memoryStatus}
                  />
                )
              }
              resolution={dockResolution}
              width={contextSidebarWidth}
            />
          </>
        }
      >
        {createOpen ? (
          <ProjectCreateDialog
            folderBrowseClient={folderBrowseClient}
            hostId={createHostId}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            mode={controller.workspace.activeMode}
            onClose={() => setCreateOpen(false)}
            onCreate={(mode, name, receiptId) =>
              projectController.create(mode, name, receiptId, createHostId)
            }
            onCreated={(projectId, mode, name) =>
              void openDraftInKnownProject(projectId, mode, name)
            }
          />
        ) : null}
        {searchOpen ? (
          <ThreadSearchOverlay
            mode={activeMode}
            threads={threadSearchThreads}
            projects={threadSearchProjects}
            unfiledLabel={activeMode === "chat" ? "Unfiled" : "Recents"}
            listing={threadSearchListing}
            {...(activeMode === "chat"
              ? {
                  archivedListing: threadSearchArchivedListing,
                  onQueryChange: setSearchQuery,
                }
              : {})}
            onClose={closeThreadSearch}
            onOpenThread={(hit) => {
              closeThreadSearch();
              // The hit keeps its source thread's Project so a cross-Project
              // open dispatches the Project switch, exactly like the sidebar's
              // own open handlers, instead of a plain open-tab the
              // server-authoritative workspace policy rejects.
              const hitProjectId =
                hit.projectId === undefined ? undefined : decodeProjectId(hit.projectId);
              if (hit.mode === "chat") {
                void controller.openChatThread(
                  decodeChatThreadId(hit.threadId),
                  hit.title,
                  hitProjectId,
                );
                return;
              }
              if (hit.mode === "work") {
                void controller.openWorkThread(
                  decodeWorkThreadId(hit.threadId),
                  hit.title,
                  undefined,
                  hitProjectId,
                );
                return;
              }
              void controller.openCodeThread(
                decodeCodeThreadId(hit.threadId),
                hit.title,
                undefined,
                hitProjectId,
              );
            }}
          />
        ) : null}
        {/* One palette for the window. Zen is a deliberate full-surface focus
          mode, so the chord stays inert while it is active. */}
        {zen.active ? null : <CommandPalette />}
        {/* One quick-open for the window, scoped to the Code thread currently
          in view. Mounting it per tab would make one chord open a dialog for
          every split pane at once. */}
        {zen.active || activeCodeThreadView === undefined ? null : (
          <CodeSearchDialog
            checkoutId={activeCodeThreadView.checkout.id}
            onOpenFile={(relativePath) => {
              void controller.openCodeSurface({
                kind: "code-file",
                threadId: activeCodeThreadView.thread.id,
                title: relativePath,
                relativePath,
              });
            }}
            {...(props.launch.serverUrl === undefined ? {} : { serverUrl: props.launch.serverUrl })}
            {...(props.projectWindowCapability === undefined
              ? {}
              : { windowCapability: props.projectWindowCapability })}
            threadId={activeCodeThreadView.thread.id}
          />
        )}
        <FirstRunOnboarding
          chatModelGroups={chatProviderGroups}
          controller={firstRunController}
          navigatorModelGroups={chatProviderGroups}
          onClearNavigatorDefault={clearNavigatorDefault}
          onSaveProfile={saveUserProfile}
          onSelectChatDefault={selectChatDefaultModel}
          onSelectColorScheme={selectColorScheme}
          onSelectModeSwitcher={(modeSwitcherPresentation) =>
            controller.updateSettings({ modeSwitcherPresentation })
          }
          onSelectNavigatorDefault={selectNavigatorDefault}
          onToggleChat={(chatEnabled) => controller.updateSettings({ chatEnabled })}
          onToggleWork={(workEnabled) => controller.updateSettings({ workEnabled })}
          workspace={firstRunWorkspace}
          profile={controller.settings?.userProfile ?? defaultShellSettings().userProfile}
          readiness={firstRunReadiness}
          {...(firstRunDiscoveryNotice === undefined
            ? {}
            : { discoveryNotice: firstRunDiscoveryNotice })}
          {...(firstRunChatDefault === undefined ? {} : { chatDefault: firstRunChatDefault })}
          {...(controller.settings?.navigatorAssistant.defaultProvider === undefined
            ? {}
            : { navigatorDefault: controller.settings.navigatorAssistant.defaultProvider })}
          onOpenProviderSettings={() => void controller.openSettings({ section: "providers" })}
          onRescan={() => void discoveryController.scan()}
          scanning={discoveryController.scanning}
        />
        <p
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-announcement-sequence={controller.announcementSequence}
          style={visuallyHiddenStyle}
        >
          {controller.announcement}
          {controller.announcementSequence > 0 ? (
            <span
              style={{
                clip: "rect(0 0 0 0)",
                clipPath: "inset(50%)",
                height: 1,
                overflow: "hidden",
                position: "absolute",
                whiteSpace: "nowrap",
                width: 1,
              }}
            >
              {" "}
              Event {controller.announcementSequence}.
            </span>
          ) : null}
        </p>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-project-announcement-sequence={projectController.announcementSequence}
        >
          {projectController.announcement}
        </p>
      </ShellFrame>
      <ComputerUseActivitySurface
        client={computerUseClient}
        excludedSessions={visibleComputerUseSessions}
      />
    </ZenRoot>
  );

  return (
    <OctantCommandProvider commands={octantCommands}>
      {/* Held here rather than with any Code pane: a thread's controller has to
        outlive the surfaces reading it, so closing a diff tab never tears down
        the turn that thread is running. */}
      <CodeThreadControllerSlots
        client={codeClient}
        readCursorStore={codeReadCursorStore}
        registry={codeThreadControllers}
        threadIds={openCodeThreadIds}
      />
      <ProjectThreadsProvider value={projectThreadsAccess}>{shell}</ProjectThreadsProvider>
    </OctantCommandProvider>
  );
}

function focusLogicalOpener(opener: InspectorOpener): void {
  const current =
    opener.element.isConnected && opener.element.closest("[hidden]") === null
      ? opener.element
      : document.querySelector<HTMLElement>(`[data-${opener.logicalTarget}-opener="true"]`);
  current?.focus();
}

function useResolvedMaterial(
  preference: "opaque" | "system",
  hostBridge: OctantHostBridge | undefined,
): ResolvedSidebarMaterial {
  const [material, setMaterial] = useState<ResolvedSidebarMaterial>("opaque");
  useEffect(() => {
    if (hostBridge === undefined) {
      setMaterial(preference === "system" ? "translucent" : "opaque");
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    setMaterial("opaque");
    if (preference === "system") {
      unsubscribe = hostBridge.subscribeResolvedMaterial((resolved) => {
        setMaterial(resolved === "translucent" ? "translucent" : "opaque");
      });
    }
    let preferenceRequest: Promise<void>;
    try {
      preferenceRequest = Promise.resolve(hostBridge.setSidebarMaterialPreference(preference));
    } catch {
      preferenceRequest = Promise.reject(new Error("Host preference request failed."));
    }
    void preferenceRequest.catch(() => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (!disposed) setMaterial("opaque");
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [hostBridge, preference]);
  return material;
}

/**
 * Tell the host whether it may check for updates on its own.
 *
 * The preference is persisted with the rest of the shell settings, and the host
 * process starts with automatic checks off, so this is what turns them on. That
 * ordering is deliberate: a host that defaulted to on would check once on every
 * launch before it learned the person had said not to.
 */
function useAutomaticUpdateCheckSync(
  hostBridge: OctantHostBridge | undefined,
  automaticUpdateChecks: boolean | undefined,
): void {
  const setAutomatic = hostBridge?.setAutomaticAppUpdateChecks;
  useEffect(() => {
    if (setAutomatic === undefined || automaticUpdateChecks === undefined) return;
    void setAutomatic(automaticUpdateChecks).catch(() => undefined);
  }, [automaticUpdateChecks, setAutomatic]);
}

function useSidebarVibrancySupported(hostBridge: OctantHostBridge | undefined): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    if (hostBridge === undefined || hostBridge.getHostCapabilities === undefined) {
      setSupported(false);
      return;
    }
    let disposed = false;
    const result = hostBridge.getHostCapabilities();
    if (result instanceof Promise) {
      result
        .then((capabilities) => {
          if (!disposed) setSupported(capabilities.sidebarVibrancySupported);
        })
        .catch(() => {
          if (!disposed) setSupported(false);
        });
    } else {
      setSupported(result.sidebarVibrancySupported);
    }
    return () => {
      disposed = true;
    };
  }, [hostBridge]);
  return supported;
}

function useSidebarBackgroundFetcher(
  serverUrl: string,
  windowCapability: string | undefined,
): (backgroundId: string) => Promise<Blob> {
  return useCallback(
    async (backgroundId: string) => {
      const headers: Record<string, string> = {};
      if (windowCapability !== undefined) {
        headers["x-octant-window-capability"] = windowCapability;
      }
      const response = await fetch(`${serverUrl}/api/theme/sidebar-backgrounds/${backgroundId}`, {
        headers,
      });
      if (!response.ok) {
        throw new Error(`Sidebar background fetch failed: ${response.status}`);
      }
      return response.blob();
    },
    [serverUrl, windowCapability],
  );
}

function useSidebarVibrancyModeSync(
  hostBridge: OctantHostBridge | undefined,
  vibrancyMode: "off" | "subtle" | "strong",
  supported: boolean,
): void {
  useEffect(() => {
    if (hostBridge === undefined || hostBridge.setSidebarVibrancyMode === undefined || !supported) {
      return;
    }
    void Promise.resolve(hostBridge.setSidebarVibrancyMode(vibrancyMode)).catch(() => {
      // Host may reject unsupported modes; ignore silently.
    });
  }, [hostBridge, vibrancyMode, supported]);
}

function activeSurfaceTitle(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): string {
  const group = findWorkspaceGroup(layout, activeGroupId);
  return group?.tabs.find((tab) => tab.id === group.activeTabId)?.title ?? "Octant";
}

function activeChatThreadTabId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): ChatThreadId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "chat-thread" ? tab.threadId : undefined;
}

function activeDraftProjectId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): ProjectId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "draft-thread" ? tab.projectId : undefined;
}

function activeDraftTabKey(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): string | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "draft-thread"
    ? `${String(tab.id)}:${tab.projectId === undefined ? "unfiled" : String(tab.projectId)}`
    : undefined;
}

/**
 * The local Code thread the focused group is showing. When the focused group
 * shows a utility surface (Browser, Files, Side Chat, Preview) instead, the
 * Code thread visible in a sibling split pane stays active so its transcript
 * is not unloaded just because the user clicked into the other pane.
 */
export function activeCodeThreadTabId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): CodeThreadId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  const focused = localCodeThreadTabId(tab);
  if (focused !== undefined) return focused;
  switch (tab?.kind) {
    case "browser":
    case "files":
    case "side-chat":
    case "preview":
      return visibleLocalCodeThreadTabId(layout);
    default:
      return undefined;
  }
}

/**
 * Every local Code thread this window has open, in any group of the Code tree.
 *
 * Keyed on the thread, not the tab: a thread's overview, diff, terminal, and
 * workbench are several tabs of one conversation, and giving each its own
 * controller would open the same thread's stream several times over.
 */
export function openLocalCodeThreadIds(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
): ReadonlyArray<CodeThreadId> {
  const open: CodeThreadId[] = [];
  collect(layout);
  return open;

  function collect(node: import("@octant/contracts/shell").WorkspaceLayoutNode): void {
    if (node.kind !== "group") {
      collect(node.first);
      collect(node.second);
      return;
    }
    for (const tab of node.tabs) {
      const threadId = openCodeTabThreadId(tab);
      if (threadId === undefined) continue;
      if (open.some((candidate) => String(candidate) === String(threadId))) continue;
      open.push(threadId);
    }
  }
}

function openCodeTabThreadId(
  tab: import("@octant/contracts/shell").WorkspaceTab,
): CodeThreadId | undefined {
  const local = localCodeThreadTabId(tab);
  if (local !== undefined) return local;
  // An Apple workbench tab is bound to a Code thread like the other surfaces.
  // The active-thread lookup leaves it out because focus resting there does not
  // make it the thread in view; it still needs that thread's own controller.
  if (tab.kind !== "apple-workbench") return undefined;
  if ("hostId" in tab && tab.hostId !== undefined) return undefined;
  return tab.threadId;
}

function localCodeThreadTabId(
  tab: import("@octant/contracts/shell").WorkspaceTab | undefined,
): CodeThreadId | undefined {
  if (tab !== undefined && "hostId" in tab && tab.hostId !== undefined) return undefined;
  switch (tab?.kind) {
    case "code-overview":
    case "code-file":
    case "code-diff":
    case "code-terminal":
    case "code-test":
    case "code-git":
    case "code-pr":
    case "code-local-review":
      return tab.threadId;
    default:
      return undefined;
  }
}

function visibleLocalCodeThreadTabId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
): CodeThreadId | undefined {
  if (layout.kind === "group") {
    return localCodeThreadTabId(layout.tabs.find((tab) => tab.id === layout.activeTabId));
  }
  return visibleLocalCodeThreadTabId(layout.first) ?? visibleLocalCodeThreadTabId(layout.second);
}

function activeWorkThreadTabId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): string | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "work-thread" && tab.hostId === undefined ? String(tab.threadId) : undefined;
}

function activeProjectTabId(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  activeGroupId: import("@octant/contracts/shell").TabGroupId,
): ProjectId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "project" ? tab.projectId : undefined;
}

function findWorkspaceGroup(
  layout: import("@octant/contracts/shell").WorkspaceLayoutNode,
  groupId: import("@octant/contracts/shell").TabGroupId,
): Extract<import("@octant/contracts/shell").WorkspaceLayoutNode, { kind: "group" }> | undefined {
  if (layout.kind === "group") return layout.groupId === groupId ? layout : undefined;
  return findWorkspaceGroup(layout.first, groupId) ?? findWorkspaceGroup(layout.second, groupId);
}

function useNarrowViewport(): boolean {
  const query = "(max-width: 960px)";
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function launchFromLocation(href: string): ShellLaunch | undefined {
  try {
    const url = new URL(href);
    const launchTokenFragment = url.hash.startsWith("#launchToken=");
    const windowIdParam = url.searchParams.get("windowId");
    const serverUrl = url.searchParams.get("serverUrl");
    const developmentWebBootstrap = url.searchParams.get("developmentWebBootstrap") === "1";
    if (serverUrl === null && !launchTokenFragment) return undefined;
    const resolvedServerUrl =
      serverUrl === null ? `${url.origin}${url.pathname === "/" ? "" : url.pathname}` : serverUrl;
    const parsedServerUrl = new URL(resolvedServerUrl);
    if (parsedServerUrl.protocol !== "http:" && parsedServerUrl.protocol !== "https:") {
      return undefined;
    }
    const windowId = windowIdParam === null ? undefined : decodeWindowId(windowIdParam);
    return {
      serverUrl: parsedServerUrl.toString(),
      ...(windowId === undefined ? {} : { windowId }),
      ...(developmentWebBootstrap ? { developmentWebBootstrap: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

function isProjectWindowCapability(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "octant.shell.sidebar-collapsed.v1";

function readSidebarCollapsed(scope: { readonly localStorage?: Storage }): boolean {
  try {
    return scope.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(scope: { readonly localStorage?: Storage }, collapsed: boolean) {
  try {
    if (collapsed) scope.localStorage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    else scope.localStorage?.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
  } catch {
    // Presentation persistence is best-effort.
  }
}

/**
 * What a Code thread's status dot says.
 *
 * An open follow-up outranks everything: it is the one state a person has to
 * come back to. A waiting or interrupted thread is asking for something too.
 * `working` is deliberately absent — the host reports no per-thread run state
 * to the sidebar, and a dot that pulses on a thread nothing is running would
 * be a lie.
 */
function codeThreadActivity(thread: {
  readonly followUp?: boolean;
  readonly lifecycle: "active" | "waiting" | "interrupted" | "archived";
  readonly unread?: boolean;
}): ThreadRowActivity {
  if (thread.followUp === true) return "attention";
  if (thread.lifecycle === "waiting" || thread.lifecycle === "interrupted") return "attention";
  if (thread.unread === true) return "unread";
  return "idle";
}
