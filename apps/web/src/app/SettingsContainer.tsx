import type { ThemeTypography } from "@octant/contracts/theme";
import type { UsageQueryFilter } from "@octant/contracts/usage-rpc";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { ServerProject } from "@octant/contracts/server-projects";
import { memo, Suspense, useMemo } from "react";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import type { useHostFederationLifecycle } from "../host/useHostFederationLifecycle";
import type { useProjectController } from "../projects/useProjectController";
import type { useDiscoveryController } from "../providers/useDiscoveryController";
import type { ProviderController } from "../providers/useProviderController";
import { UsageWorkspace } from "../shell/deferredSurfaces";
import type { OctantHostBridge } from "../shell/hostBridge";
import { ShellSettingsSurface } from "../shell/ShellSettingsSurface";
import { SurfaceLoading } from "../surface/SurfaceLoading";
import type { useShellController } from "../shell/useShellController";
import type { useBackgroundImageLibrary } from "../shell/useShellPresentation";
import type { useThemeController } from "../theme/useThemeController";
import { UsageNamesProvider } from "../usage/UsageName";
import type { useWorkSettings } from "../work/useWorkSettings";
import type { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";
import { openUsageSubject as openUsageSubjectThread } from "./usageSubjectOpener";

type HostFederationLifecycle = NonNullable<
  ReturnType<typeof useHostFederationLifecycle>
>["lifecycle"];

export interface SettingsContainerProps {
  readonly projectTerminalClient?: ProjectTerminalClient;
  readonly projectActionStoragePrefix?: string;
  readonly onOpenServerProject?: (project: ServerProject) => void;
  readonly actions: Pick<
    ShellActions,
    "openChatThread" | "setUsageOpen" | "selectChatThread" | "selectWorkThread" | "selectCodeThread"
  >;
  readonly allProjects: ReturnType<typeof useProjectController>["allProjects"];
  readonly availableFonts?: ReadonlyArray<string>;
  readonly backgroundImageLibrary: ReturnType<typeof useBackgroundImageLibrary>;
  readonly chatController: ChatController;
  readonly browserAutomationClient?: Pick<
    BrowserAutomationClient,
    "manageExtensions" | "manageFlows" | "manageProfiles"
  >;
  readonly clients: ReturnType<typeof createLaunchedShellClients>;
  readonly codeController: CodeController;
  readonly controller: ReturnType<typeof useShellController>;
  readonly discoveryController: ReturnType<typeof useDiscoveryController>;
  readonly githubClient: NonNullable<Parameters<typeof ShellSettingsSurface>[0]["githubClient"]>;
  readonly hostBridge?: OctantHostBridge;
  readonly hostFederationLifecycle?: HostFederationLifecycle;
  readonly hostReservesTitlebarInset: boolean;
  readonly isNarrow: boolean;
  readonly linearClient: NonNullable<
    Parameters<typeof ShellSettingsSurface>[0]["integrationClient"]
  >;
  readonly nativeBoundsAvailable: boolean;
  readonly pendingUsageFilter?: UsageQueryFilter;
  readonly projectNamesById: ReadonlyMap<string, string>;
  readonly providerController: ProviderController;
  readonly settings: NonNullable<ReturnType<typeof useShellController>["settings"]>;
  /** Which standalone surface covers the workspace. */
  readonly surface: "settings" | "usage";
  /** `"sheet"` when Settings floats over the workspace instead of covering it. */
  readonly presentation?: "page" | "sheet";
  readonly sidebarVibrancySupported: boolean;
  readonly themeController: ReturnType<typeof useThemeController>;
  readonly typography?: ThemeTypography;
  readonly workNavigation: ReturnType<typeof useWorkThreadNavigation>;
  readonly workSettings: ReturnType<typeof useWorkSettings>;
}

/**
 * Settings and the Usage page: the two standalone surfaces that cover the
 * workspace. Mounted only while one is open, so the transcript underneath
 * pays nothing for them. While open they take the shell's controllers whole,
 * because Settings edits what those controllers own.
 */
export const SettingsContainer = memo(function SettingsContainer(props: SettingsContainerProps) {
  const {
    actions,
    allProjects,
    backgroundImageLibrary,
    chatController,
    codeController,
    controller,
    discoveryController,
    githubClient,
    hostFederationLifecycle,
    hostReservesTitlebarInset,
    isNarrow,
    linearClient,
    nativeBoundsAvailable,
    pendingUsageFilter,
    projectNamesById,
    providerController,
    settings,
    sidebarVibrancySupported,
    themeController,
    workNavigation,
    workSettings,
  } = props;
  const {
    agentGrantClient,
    agentRunSettingsClient,
    automationNotificationClient,
    canvasClient,
    desktopPaneClient,
    diagnosticsExportClient,
    extensionClient,
    folderBrowseClient,
    hostControlClient,
    protectedFilesClient,
    archivedWorktreesClient,
    diskCleanupClient,
    personMemoryClient,
    localUsageHistoryClient,
    nativeHarnessClient,
    providerUsageLimitsClient,
    replicaMembershipClient,
    replicaStoreSettingsClient,
    replicaSyncStatusClient,
    safeNetworksClient,
    secretStoresClient,
    shieldServersClient,
    providerToolingClient,
    serverProjectsClient,
    usageClient,
    usageDashboardClient,
    benchmarksClient,
    chatClient,
  } = props.clients;
  const selectLocalPluginFolder = props.hostBridge?.selectLocalPluginFolder;
  const selectSkillFolder = props.hostBridge?.selectSkillFolder;
  const pickSkillFolder = useMemo(
    () =>
      selectSkillFolder === undefined ||
      extensionClient.resolveSkillFolder === undefined ||
      !extensionClient.toolGrantsAvailable
        ? undefined
        : async () => {
            const selected = await selectSkillFolder();
            return selected.kind === "selected"
              ? extensionClient.resolveSkillFolder?.(
                  selected.receiptId,
                  AbortSignal.timeout(15_000),
                )
              : undefined;
          },
    [selectSkillFolder, extensionClient],
  );
  const chatThreads = chatController.bootstrap?.threads;
  const workThreads = workNavigation.bootstrap?.threads;
  const codeThreads = codeController.bootstrap?.threads;
  const codeProjects = useMemo(
    () =>
      allProjects
        .filter((project) => project.type === "code")
        .map((project) => ({ id: String(project.id), name: project.name })),
    [allProjects],
  );
  const usageNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const instance of providerController.instances)
      names.set(`provider/${instance.id}`, instance.displayName);
    for (const project of allProjects) names.set(`project/${project.id}`, project.name);
    for (const thread of chatThreads ?? []) names.set(`chat-thread/${thread.id}`, thread.title);
    for (const thread of workThreads ?? []) names.set(`work-thread/${thread.id}`, thread.title);
    for (const thread of codeThreads ?? []) names.set(`code-thread/${thread.id}`, thread.title);
    return names;
  }, [allProjects, chatThreads, codeThreads, providerController.instances, workThreads]);

  // Only threads can be opened from Usage; any other subject stays put.
  const openUsageSubject = (subjectType: string, subjectId: string) => {
    const leaveUsage = () => {
      actions.setUsageOpen(false);
      if (props.surface === "settings") controller.closeSettings();
    };
    openUsageSubjectThread(subjectType, subjectId, {
      selectChatThread: (id) => {
        leaveUsage();
        actions.selectChatThread(id);
      },
      selectWorkThread: (id) => {
        leaveUsage();
        actions.selectWorkThread(id);
      },
      selectCodeThread: (id) => {
        leaveUsage();
        actions.selectCodeThread(id);
      },
      openChatThread: (id, title, projectId) => {
        leaveUsage();
        return actions.openChatThread(id, title, projectId);
      },
      listedChatThreadIds: new Set(chatController.navigation.map((row) => String(row.threadId))),
      chatThreadRow: (id) => {
        const thread = chatThreads?.find((candidate) => String(candidate.id) === id);
        return thread === undefined
          ? undefined
          : { title: thread.title, projectId: thread.projectId };
      },
    });
  };

  const usageSurface = (
    <Suspense fallback={<SurfaceLoading label="Opening usage" measure="reading" />}>
      <UsageWorkspace
        client={usageDashboardClient}
        {...(localUsageHistoryClient === undefined
          ? {}
          : { historyClient: localUsageHistoryClient })}
        providers={providerController.instances}
        {...(providerUsageLimitsClient === undefined
          ? {}
          : { providerLimitsClient: providerUsageLimitsClient })}
        isNarrow={isNarrow}
        onBack={() => actions.setUsageOpen(false)}
        onOpenSubject={openUsageSubject}
        {...(pendingUsageFilter === undefined ? {} : { initialFilter: pendingUsageFilter })}
        usageQuery={usageClient}
        diagnosticsClient={usageClient}
        benchmarksClient={benchmarksClient}
        chatClient={chatClient}
        providerSnapshot={providerController.snapshot}
        codeProjects={codeProjects}
      />
    </Suspense>
  );
  const settingsSurface = (
    <ShellSettingsSurface
      {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
      {...(themeController.draft?.typography === undefined && props.typography === undefined
        ? {}
        : { typography: themeController.draft?.typography ?? props.typography })}
      {...(themeController.draft === undefined ? {} : { theme: themeController.draft })}
      chatController={chatController}
      workSettings={workSettings}
      codeController={codeController}
      discoveryController={discoveryController}
      extensionClient={extensionClient}
      projectNames={projectNamesById}
      {...(pickSkillFolder === undefined ? {} : { pickSkillFolder })}
      {...(selectLocalPluginFolder === undefined
        ? {}
        : {
            pickLocalPluginFolder: async () => {
              const selected = await selectLocalPluginFolder();
              return selected.kind === "selected"
                ? { receiptId: selected.receiptId, displayName: selected.displayName }
                : undefined;
            },
          })}
      agentRunSettingsClient={agentRunSettingsClient}
      nativeHarnessClient={nativeHarnessClient}
      automationNotificationClient={automationNotificationClient}
      isNarrow={isNarrow}
      nativeBoundsAvailable={nativeBoundsAvailable}
      reservesTitlebarInset={hostReservesTitlebarInset}
      {...(props.presentation === undefined ? {} : { presentation: props.presentation })}
      onBack={controller.closeSettings}
      onDeepLinkApplied={controller.clearPendingSettingsDeepLink}
      onResetLayout={controller.resetActiveLayout}
      onResetNativeBounds={controller.resetNativeBounds}
      onSearchChange={controller.setSettingsSearch}
      onSettingsChange={controller.updateSettings}
      {...(controller.pendingSettingsDeepLink === undefined
        ? {}
        : { pendingDeepLink: controller.pendingSettingsDeepLink })}
      providerController={providerController}
      search={controller.settingsSearch}
      settings={settings}
      sidebarVibrancySupported={sidebarVibrancySupported}
      themeController={themeController}
      diagnosticsExportClient={diagnosticsExportClient}
      hostControlClient={hostControlClient}
      {...(props.browserAutomationClient === undefined
        ? {}
        : { browserAutomationClient: props.browserAutomationClient })}
      protectedFilesClient={protectedFilesClient}
      archivedWorktreesClient={archivedWorktreesClient}
      diskCleanupClient={diskCleanupClient}
      personMemoryClient={personMemoryClient}
      {...(canvasClient === undefined ? {} : { canvasClient })}
      {...(desktopPaneClient === undefined ? {} : { desktopPaneClient })}
      {...(replicaStoreSettingsClient === undefined ? {} : { replicaStoreSettingsClient })}
      {...(safeNetworksClient === undefined ? {} : { safeNetworksClient })}
      {...(secretStoresClient === undefined ? {} : { secretStoresClient })}
      {...(shieldServersClient === undefined ? {} : { shieldServersClient })}
      {...(providerToolingClient === undefined ? {} : { providerToolingClient })}
      {...(serverProjectsClient === undefined ? {} : { serverProjectsClient })}
      agentGrantClient={agentGrantClient}
      codeProjectId={controller.workspace?.contextByMode.code.projectId ?? undefined}
      workProjectId={controller.workspace?.contextByMode.work.projectId ?? undefined}
      {...(props.onOpenServerProject === undefined
        ? {}
        : { onOpenServerProject: props.onOpenServerProject })}
      {...(props.projectTerminalClient === undefined
        ? {}
        : { projectTerminalClient: props.projectTerminalClient })}
      {...(props.projectActionStoragePrefix === undefined
        ? {}
        : { projectActionStoragePrefix: props.projectActionStoragePrefix })}
      {...(replicaMembershipClient === undefined ? {} : { replicaMembershipClient })}
      replicaSyncStatusClient={replicaSyncStatusClient}
      folderBrowseClient={folderBrowseClient}
      workThreads={(workThreads ?? []).map((thread) => ({
        id: String(thread.id),
        title: thread.title,
      }))}
      {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
      {...(hostFederationLifecycle === undefined ? {} : { hostFederationLifecycle })}
      githubClient={githubClient}
      integrationClient={linearClient}
      usageClient={usageClient}
      benchmarksClient={benchmarksClient}
      chatClient={chatClient}
      codeProjects={codeProjects}
      onOpenUsageSubject={openUsageSubject}
      {...(providerUsageLimitsClient === undefined ? {} : { providerUsageLimitsClient })}
      {...(localUsageHistoryClient === undefined ? {} : { localUsageHistoryClient })}
      backgroundImageLibrary={backgroundImageLibrary}
      announcement={controller.announcement}
      announcementSequence={controller.announcementSequence}
    />
  );

  return (
    <UsageNamesProvider names={usageNames}>
      {props.surface === "settings" ? settingsSurface : usageSurface}
    </UsageNamesProvider>
  );
});
