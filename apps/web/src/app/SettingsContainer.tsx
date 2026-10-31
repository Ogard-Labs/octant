import type { ThemeTypography } from "@octant/contracts/theme";
import type { UsageQueryFilter } from "@octant/contracts/usage-rpc";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
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
import type { useShellController } from "../shell/useShellController";
import type { useBackgroundImageLibrary } from "../shell/useShellPresentation";
import type { useThemeController } from "../theme/useThemeController";
import { UsageNamesProvider } from "../usage/UsageName";
import type { useWorkSettings } from "../work/useWorkSettings";
import type { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { createLaunchedShellClients } from "./createLaunchedShellClients";
import type { ShellActions } from "./shellActions";

type HostFederationLifecycle = NonNullable<
  ReturnType<typeof useHostFederationLifecycle>
>["lifecycle"];

export interface SettingsContainerProps {
  readonly actions: Pick<ShellActions, "setUsageOpen">;
  readonly allProjects: ReturnType<typeof useProjectController>["allProjects"];
  readonly availableFonts?: ReadonlyArray<string>;
  readonly backgroundImageLibrary: ReturnType<typeof useBackgroundImageLibrary>;
  readonly chatController: ChatController;
  readonly browserAutomationClient?: Pick<
    BrowserAutomationClient,
    "manageExtensions" | "manageProfiles"
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
    agentRunSettingsClient,
    automationNotificationClient,
    canvasClient,
    desktopPaneClient,
    diagnosticsExportClient,
    extensionClient,
    folderBrowseClient,
    hostControlClient,
    protectedFilesClient,
    localUsageHistoryClient,
    nativeHarnessClient,
    providerUsageLimitsClient,
    replicaMembershipClient,
    replicaStoreSettingsClient,
    replicaSyncStatusClient,
    safeNetworksClient,
    secretStoresClient,
    usageClient,
    usageDashboardClient,
  } = props.clients;
  const selectLocalPluginFolder = props.hostBridge?.selectLocalPluginFolder;
  const chatThreads = chatController.bootstrap?.threads;
  const workThreads = workNavigation.bootstrap?.threads;
  const codeThreads = codeController.bootstrap?.threads;
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

  const usageSurface = (
    <Suspense
      fallback={
        <div aria-label="Opening usage" className="workspace-rail-loading" role="status">
          Opening usage…
        </div>
      }
    >
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
        {...(pendingUsageFilter === undefined ? {} : { initialFilter: pendingUsageFilter })}
        usageQuery={usageClient}
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
      {...(canvasClient === undefined ? {} : { canvasClient })}
      {...(desktopPaneClient === undefined ? {} : { desktopPaneClient })}
      {...(replicaStoreSettingsClient === undefined ? {} : { replicaStoreSettingsClient })}
      {...(safeNetworksClient === undefined ? {} : { safeNetworksClient })}
      {...(secretStoresClient === undefined ? {} : { secretStoresClient })}
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
