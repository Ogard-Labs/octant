import { lazy, Suspense, type ReactNode } from "react";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { SettingsDeepLink } from "@octant/contracts";
import type { ShellSettings } from "@octant/contracts/shell";
import type { ThemeTypography } from "@octant/contracts/theme";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import type { DiscoveryController } from "../providers/useDiscoveryController";
import type { ProviderController } from "../providers/useProviderController";
import type { ThemeController } from "../theme/useThemeController";
import { visuallyHiddenStyle } from "./shellCommandWiring";
import { SettingsSurfaceErrorBoundary } from "./SettingsSurfaceErrorBoundary";
import type { ImplementedSettingId } from "./useShellController";
import { ShellState } from "./ShellState";
import { ShellThemeRoot } from "./ShellFrame";
import type { OctantHostBridge } from "./hostBridge";
import type { BackgroundImageLibrary } from "../settings/AppBackgroundSettings";

const LazySettingsView = lazy(async () => {
  const module = await import("./SettingsView");
  return { default: module.SettingsView };
});

export interface ShellSettingsSurfaceProps {
  readonly availableFonts?: ReadonlyArray<string>;
  readonly typography?: ThemeTypography;
  readonly theme?: ThemeController["draft"];
  readonly chatController: ChatController;
  readonly codeController: CodeController;
  readonly discoveryController: DiscoveryController;
  readonly executionProfiles: ReactNode;
  readonly pickLocalPluginFolder?: () => Promise<
    Readonly<{ receiptId: string; displayName: string }> | undefined
  >;
  readonly agentRunSettingsClient: AgentRunSettingsClient;
  readonly nativeHarnessClient?: NativeHarnessClient;
  readonly automationNotificationClient: AutomationNotificationClient;
  readonly isNarrow: boolean;
  readonly nativeBoundsAvailable: boolean;
  readonly onBack: () => void;
  readonly onDeepLinkApplied: () => void;
  readonly onResetLayout: () => void;
  readonly onResetNativeBounds: () => void;
  readonly onSearchChange: (value: string) => void;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => Promise<boolean> | void;
  readonly pendingDeepLink?: SettingsDeepLink;
  readonly providerController: ProviderController;
  readonly search: string;
  readonly settings: ShellSettings;
  readonly sidebarVibrancySupported: boolean;
  readonly themeController: ThemeController;
  readonly diagnosticsExportClient: DiagnosticsExportClient;
  readonly hostControlClient: HostControlClient;
  readonly hostFederationLifecycle?: HostFederationLifecycle;
  readonly hostBridge?: OctantHostBridge;
  readonly githubClient: GithubClient;
  readonly integrationClient?: IntegrationClient;
  readonly usageClient: UsageClient;
  readonly providerUsageLimitsClient?: ProviderUsageLimitsClient;
  readonly visibleSettings: ReadonlyArray<ImplementedSettingId>;
  readonly backgroundImageLibrary?: BackgroundImageLibrary;
  readonly announcement: string;
  readonly announcementSequence: number;
  readonly extensionClient: ExtensionClient;
}

export function ShellSettingsSurface(props: ShellSettingsSurfaceProps) {
  return (
    <ShellThemeRoot
      {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
      {...(props.typography === undefined ? {} : { typography: props.typography })}
      {...(props.theme === undefined ? {} : { theme: props.theme })}
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
            chatController={props.chatController}
            codeController={props.codeController}
            discoveryController={props.discoveryController}
            executionProfiles={props.executionProfiles}
            extensionClient={props.extensionClient}
            {...(props.pickLocalPluginFolder === undefined
              ? {}
              : { pickLocalPluginFolder: props.pickLocalPluginFolder })}
            agentRunSettingsClient={props.agentRunSettingsClient}
            {...(props.nativeHarnessClient === undefined
              ? {}
              : { nativeHarnessClient: props.nativeHarnessClient })}
            automationNotificationClient={props.automationNotificationClient}
            isNarrow={props.isNarrow}
            nativeBoundsAvailable={props.nativeBoundsAvailable}
            onBack={props.onBack}
            onDeepLinkApplied={props.onDeepLinkApplied}
            onResetLayout={props.onResetLayout}
            onResetNativeBounds={props.onResetNativeBounds}
            onSearchChange={props.onSearchChange}
            onSettingsChange={props.onSettingsChange}
            pendingDeepLink={props.pendingDeepLink}
            providerController={props.providerController}
            search={props.search}
            settings={props.settings}
            sidebarVibrancySupported={props.sidebarVibrancySupported}
            themeController={props.themeController}
            {...(props.backgroundImageLibrary === undefined
              ? {}
              : { backgroundImageLibrary: props.backgroundImageLibrary })}
            diagnosticsExportClient={props.diagnosticsExportClient}
            hostControlClient={props.hostControlClient}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            {...(props.hostFederationLifecycle === undefined
              ? {}
              : { hostFederationLifecycle: props.hostFederationLifecycle })}
            githubClient={props.githubClient}
            {...(props.integrationClient === undefined
              ? {}
              : { integrationClient: props.integrationClient })}
            usageClient={props.usageClient}
            {...(props.providerUsageLimitsClient === undefined
              ? {}
              : { providerUsageLimitsClient: props.providerUsageLimitsClient })}
            visibleSettings={props.visibleSettings}
          />
        </Suspense>
      </SettingsSurfaceErrorBoundary>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-announcement-sequence={props.announcementSequence}
        style={visuallyHiddenStyle}
      >
        {props.announcement}
      </p>
    </ShellThemeRoot>
  );
}
