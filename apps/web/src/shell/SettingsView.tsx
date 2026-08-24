import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Search, Settings2 } from "lucide-react";
import type { ShellSettings } from "@octant/contracts/shell";
import {
  type SettingsDeepLink,
  type SettingsSectionId,
  type SettingsSettingId,
} from "@octant/contracts";
import {
  decodeSidebarBackgroundPresetId,
  decodeThemeHexColor,
  type SidebarBackground,
  type SidebarVibrancyMode,
} from "@octant/contracts/theme";
import { SIDEBAR_BACKGROUND_PRESETS } from "@octant/theme/backgrounds";
import type { ImplementedSettingId } from "./useShellController";
import type { ProviderController } from "../providers/useProviderController";
import type { DiscoveryController } from "../providers/useDiscoveryController";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";
import { ProviderDiscoverySection } from "../providers/ProviderDiscoverySection";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantSlider } from "../ui/base/OctantSlider";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isSettingsSectionAvailable,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";
import { SettingsNavigation, type SettingsNavigationItem } from "./SettingsNavigation";
import { ChatSettingsView } from "../chat/ChatSettingsView";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import { CodeSettingsView } from "../code/CodeSettingsView";
import { UsageDashboard } from "../usage/UsageDashboard";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import { DiagnosticsExportControl } from "../support/DiagnosticsExportControl";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { HostSettingsSection } from "../host/HostSettingsSection";
import { FederatedHostsLifecyclePanel } from "../host/FederatedHostsLifecyclePanel";
import { GitHubConnectionSettings } from "../settings/GitHubConnectionSettings";
import {
  type SettingsNativeCapabilities,
  type SettingsSectionEntry,
  filterSectionsForNavigator,
  findSection,
  findSetting,
  isSettingAvailable,
  listAvailableSections,
  searchSettings,
  settingId,
} from "../settings/registry";
import { octantSettingsRegistry } from "../settings/octantSettingsRegistry";
import { KeybindingSettings } from "../keybindings/KeybindingSettings";
import { NavigatorAssistantSettingsView } from "../settings/NavigatorAssistantSettingsView";
import { UserProfileSettingsView } from "../profile/UserProfileSettingsView";
import { SettingRow } from "../settings/primitives";
import { SettingsSearchResults } from "../settings/SettingsSearchResults";
import { useSettingsRoute } from "../settings/useSettingsRoute";
import { ExtensionsSettingsView } from "../extensions/ExtensionsSettingsView";
import type { ThemeController } from "../theme/useThemeController";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { AgentRunSettingsPanel } from "../agents/AgentRunSettingsPanel";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import { ThemeAppearanceEditor } from "../theme/ThemeAppearanceEditor";
import { AppUpdateSettings } from "../settings/AppUpdateSettings";
import type { OctantHostBridge } from "./hostBridge";
import "../styles/settings.css";
import "../styles/extensions-settings.css";

export interface SettingsViewProps {
  readonly chatController?: ChatController;
  readonly codeController?: CodeController;
  readonly nativeBoundsAvailable: boolean;
  readonly onBack?: () => void;
  readonly onResetLayout: () => void;
  readonly onResetNativeBounds: () => void;
  readonly onSearchChange: (value: string) => void;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
  readonly search: string;
  readonly settings: ShellSettings;
  readonly sidebarVibrancySupported: boolean;
  readonly hostBridge?: OctantHostBridge;
  /**
   * Implemented setting ids. Kept as a stable contract of what is implemented;
   * the registry is the source of truth for rendering and search.
   */
  readonly visibleSettings: ReadonlyArray<ImplementedSettingId>;
  readonly providerController?: ProviderController;
  readonly discoveryController?: DiscoveryController;
  readonly usageClient?: UsageClient;
  readonly diagnosticsExportClient?: DiagnosticsExportClient;
  readonly hostControlClient?: HostControlClient;
  readonly hostFederationLifecycle?: HostFederationLifecycle;
  readonly githubClient?: GithubClient;
  readonly extensionClient?: ExtensionClient;
  readonly pickLocalPluginFolder?: () => Promise<
    Readonly<{ receiptId: string; displayName: string }> | undefined
  >;
  readonly isNarrow?: boolean;
  /**
   * Optional deep link applied on mount. Other app surfaces request a deep link
   * through the shell controller's `openSettings(section, setting?)`.
   */
  readonly initialDeepLink?: SettingsDeepLink | undefined;
  readonly pendingDeepLink?: SettingsDeepLink | undefined;
  readonly onDeepLinkApplied?: () => void;
  readonly themeController?: ThemeController;
  readonly executionProfiles?: ReactNode;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly automationNotificationClient?: AutomationNotificationClient;
  /**
   * Stand-in override for first-party plugin effectiveness. Production uses
   * the bundled catalog default; tests pass a map to prove a disabled
   * settings-section contribution disappears.
   */
  readonly effectivePlugins?: ReadonlyMap<FirstPartyPluginComponentId, boolean>;
}

const SECTION_LABELS: Readonly<Partial<Record<SettingsSectionId, string>>> = Object.fromEntries(
  octantSettingsRegistry.sections.map((s) => [s.id, s.label]),
);

const SECTION_DESCRIPTIONS: Readonly<Partial<Record<SettingsSectionId, string>>> = {
  general: "Choose which modes are available in this app.",
  appearance: "Choose how Octant looks. Use a built-in theme or make your own.",
  chat: "Defaults for new Chat conversations.",
  work: "Defaults for Work threads.",
  code: "Defaults for Code threads and delivery.",
  "navigator-assistant": "The models Navigator uses to converse and to review images.",
  providers: "Connect providers, manage authentication, and pick default models.",
  profiles: "Reusable execution profiles for agent runs.",
  agents: "How agent runs behave in this app.",
  skills: "Skills and extensions available to agents.",
  usage: "Activity and usage across providers.",
  advanced: "Layout resets and diagnostics.",
};

const APPEARANCE_SECTION = (): SettingsSectionEntry =>
  findSection(octantSettingsRegistry, "appearance")!;
const ADVANCED_SECTION = (): SettingsSectionEntry =>
  findSection(octantSettingsRegistry, "advanced")!;

export function SettingsView(props: SettingsViewProps) {
  const capabilities: SettingsNativeCapabilities = {
    nativeBoundsAvailable: props.nativeBoundsAvailable,
    sidebarVibrancySupported: props.sidebarVibrancySupported,
  };
  const availableSections = listAvailableSections(octantSettingsRegistry, capabilities).filter(
    (section) =>
      isSettingsSectionAvailable(
        section.id,
        props.effectivePlugins ?? FIRST_PARTY_PLUGINS_EFFECTIVE,
      ),
  );
  const route = useSettingsRoute({
    availableSections,
    capabilities,
    registry: octantSettingsRegistry,
    ...(props.initialDeepLink === undefined ? {} : { initialDeepLink: props.initialDeepLink }),
  });

  // Apply a pending deep link requested from another app surface (e.g. an
  // empty state or provider error) once, then report it consumed.
  const appliedPendingRef = useRef(false);
  const pendingDeepLink = props.pendingDeepLink;
  const onDeepLinkApplied = props.onDeepLinkApplied;
  useEffect(() => {
    if (pendingDeepLink === undefined) {
      appliedPendingRef.current = false;
      return;
    }
    if (appliedPendingRef.current) return;
    appliedPendingRef.current = true;
    route.applyDeepLink(pendingDeepLink);
    onDeepLinkApplied?.();
  }, [pendingDeepLink, route, onDeepLinkApplied]);

  const hasQuery = props.search.trim() !== "";
  const navSections = filterSectionsForNavigator(availableSections, capabilities, props.search);
  const searchResults = searchSettings(availableSections, capabilities, props.search);
  const navItems: SettingsNavigationItem[] = navSections.map((section) => ({
    id: section.id,
    label: section.label,
  }));

  const handleSearchSelect = (link: SettingsDeepLink) => {
    route.applyDeepLink(link);
    props.onSearchChange("");
  };

  return (
    <section aria-label="Settings" className="settings-view">
      <aside aria-label="Settings sidebar" className="settings-view__sidebar">
        <div className="settings-view__sidebar-titlebar window-drag-region">
          <span aria-hidden="true" className="settings-view__traffic-light-space" />
          <span className="settings-view__drag-space" />
        </div>
        <div className="settings-view__sidebar-content">
          {props.onBack === undefined ? null : (
            <button
              className="setnav-item window-no-drag settings-view__back"
              onClick={props.onBack}
              type="button"
            >
              <ArrowLeft aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
              <span>Back to app</span>
            </button>
          )}
          <div className="settings-view__all-settings">
            <Settings2 aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
            <span>All settings</span>
          </div>
          <label className="settings-view__field settings-view__field--search">
            <span className="settings-view__search-label">Search settings</span>
            <Search aria-hidden="true" className="settings-view__search-icon" size={13} />
            <OctantInput
              aria-label="Search settings"
              className="settings-view__text-input"
              onChange={(event) => props.onSearchChange(event.currentTarget.value)}
              placeholder="Search settings…"
              type="search"
              value={props.search}
            />
          </label>
          <SettingsNavigation
            activeSection={route.activeSection}
            onSelect={route.openSection}
            sections={navItems}
          />
        </div>
      </aside>
      <div className="settings-view__workspace">
        <div aria-hidden="true" className="settings-view__workspace-titlebar window-drag-region" />
        <main className="settings-view__content">
          <div className="settings-view__content-inner">
            <header className="settings-view__header">
              <h1 className="setpane-title" id="settings-heading">
                {hasQuery ? "Search settings" : (SECTION_LABELS[route.activeSection] ?? "Settings")}
              </h1>
              {!hasQuery && SECTION_DESCRIPTIONS[route.activeSection] !== undefined ? (
                <p className="setpane-note">{SECTION_DESCRIPTIONS[route.activeSection]}</p>
              ) : null}
            </header>
            {hasQuery ? (
              <SettingsSearchResults
                query={props.search}
                results={searchResults}
                sectionLabels={SECTION_LABELS}
                onSelect={handleSearchSelect}
                onEscape={() => props.onSearchChange("")}
              />
            ) : (
              <ActiveSectionContent
                activeSection={route.activeSection}
                capabilities={capabilities}
                focusedSetting={route.focusedSetting}
                props={props}
              />
            )}
            {!hasQuery && availableSections.length === 0 ? (
              <p className="settings-view__empty" role="status">
                No implemented settings are available.
              </p>
            ) : null}
          </div>
        </main>
      </div>
    </section>
  );
}

interface ActiveSectionContentProps {
  readonly activeSection: SettingsSectionId;
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly props: SettingsViewProps;
  readonly capabilities: SettingsNativeCapabilities;
}

function ActiveSectionContent({
  activeSection,
  focusedSetting,
  props,
  capabilities,
}: ActiveSectionContentProps) {
  switch (activeSection) {
    case "general":
      return <GeneralSection focusedSetting={focusedSetting} props={props} />;
    case "appearance":
      return (
        <AppearanceSection
          capabilities={capabilities}
          focusedSetting={focusedSetting}
          props={props}
        />
      );
    case "chat":
      return props.chatController?.bootstrap !== undefined ? (
        <div id="settings-chat">
          <ChatSettingsView
            key={props.chatController.bootstrap.settings.version}
            {...(props.chatController.settingsMessage === undefined
              ? {}
              : { message: props.chatController.settingsMessage })}
            onUpdate={props.chatController.updateSettings}
            {...(props.providerController?.snapshot === undefined
              ? {}
              : { providerSnapshot: props.providerController.snapshot })}
            settings={props.chatController.bootstrap.settings}
          />
        </div>
      ) : null;
    case "code":
      return props.codeController?.bootstrap !== undefined ? (
        <div id="settings-code">
          <CodeSettingsView
            key={props.codeController.bootstrap.settings.version}
            onUpdate={props.codeController.updateSettings}
            settings={props.codeController.bootstrap.settings}
          />
        </div>
      ) : null;
    case "navigator-assistant":
      return (
        <NavigatorAssistantSettingsView
          focusedSetting={focusedSetting}
          onSettingsChange={props.onSettingsChange}
          {...(props.providerController?.snapshot === undefined
            ? {}
            : { providerSnapshot: props.providerController.snapshot })}
          settings={props.settings.navigatorAssistant}
        />
      );
    case "providers":
      return props.providerController !== undefined ? (
        <ProvidersSection
          discoveryController={props.discoveryController}
          providerController={props.providerController}
        />
      ) : null;
    case "profiles":
      return props.executionProfiles ?? null;
    case "agents":
      return props.agentRunSettingsClient !== undefined ? (
        <div id="settings-agents">
          <AgentRunSettingsPanel client={props.agentRunSettingsClient} />
        </div>
      ) : null;
    case "advanced":
      return (
        <AdvancedSection
          capabilities={capabilities}
          focusedSetting={focusedSetting}
          props={props}
          {...(props.diagnosticsExportClient === undefined
            ? {}
            : { diagnosticsExportClient: props.diagnosticsExportClient })}
        />
      );
    case "usage":
      return props.usageClient !== undefined ? (
        <div id="settings-usage">
          <UsageDashboard
            client={props.usageClient}
            {...(props.isNarrow === undefined ? {} : { isNarrow: props.isNarrow })}
            showHeading={false}
          />
        </div>
      ) : null;
    case "host":
      return props.hostControlClient !== undefined ? (
        <HostSettingsSection
          client={props.hostControlClient}
          {...(props.automationNotificationClient === undefined
            ? {}
            : { automationNotifications: props.automationNotificationClient })}
          {...(props.hostFederationLifecycle === undefined
            ? {}
            : { hostFederationLifecycle: props.hostFederationLifecycle })}
        />
      ) : props.hostFederationLifecycle !== undefined ? (
        <section aria-label="Host" id="settings-host">
          <p>
            Host lifecycle, backup, and recovery controls are available on the host machine only.
          </p>
          <FederatedHostsLifecyclePanel lifecycle={props.hostFederationLifecycle} />
        </section>
      ) : (
        <section aria-label="Host" id="settings-host">
          <p>
            Host lifecycle, backup, and recovery controls are available on the host machine only.
          </p>
        </section>
      );
    case "github":
      return props.githubClient !== undefined ? (
        <GitHubConnectionSettings client={props.githubClient} />
      ) : (
        <section aria-label="GitHub" id="settings-github">
          <p>
            The GitHub connection is managed on the owning host. Open Settings on that host to set
            up or inspect the account.
          </p>
        </section>
      );
    case "skills":
      return props.extensionClient !== undefined ? (
        <ExtensionsSettingsView
          client={props.extensionClient}
          showHeading={false}
          {...(props.pickLocalPluginFolder === undefined
            ? {}
            : { pickLocalPluginFolder: props.pickLocalPluginFolder })}
        />
      ) : null;
    default:
      return null;
  }
}

function ProvidersSection(props: {
  readonly providerController: ProviderController;
  readonly discoveryController: DiscoveryController | undefined;
}) {
  const discoveryController = props.discoveryController;
  const scan = discoveryController?.scan;

  async function checkInstalledProviders(): Promise<void> {
    await discoveryController?.scan();
    // Discovery may auto-register installed runtimes while the scan is in
    // flight. Read the authoritative registry after the scan so those
    // instances are checked too; disabled auto-registered providers remain
    // untouched until the user explicitly enables them.
    const enabledInstanceIds = props.providerController
      .readInstances()
      .filter((instance) => instance.enabled)
      .map((instance) => instance.id);
    await Promise.all(
      enabledInstanceIds.map((instanceId) => props.providerController.probe(instanceId)),
    );
  }

  useEffect(() => {
    if (scan === undefined) return;
    void scan();
  }, [scan]);

  return (
    <div id="settings-providers">
      <ProviderSettingsView
        busy={props.providerController.busy}
        credentialManagementAvailable={props.providerController.credentialManagementAvailable}
        defaults={props.providerController.defaults}
        discovery={
          discoveryController === undefined ? null : (
            <ProviderDiscoverySection
              connectingPaths={discoveryController.connectingPaths}
              instances={props.providerController.instances}
              {...(discoveryController.message === undefined
                ? {}
                : { message: discoveryController.message })}
              onConnect={discoveryController.connect}
              onScan={checkInstalledProviders}
              scanning={
                discoveryController.scanning || props.providerController.probingIds.size > 0
              }
              snapshot={discoveryController.snapshot}
            />
          )
        }
        instances={props.providerController.instances}
        {...(props.discoveryController?.snapshot === undefined
          ? {}
          : { discoverySnapshot: props.discoveryController.snapshot })}
        {...(props.providerController.message === undefined
          ? {}
          : { message: props.providerController.message })}
        observedByInstance={props.providerController.observedByInstance}
        onChangeBinary={props.providerController.changeBinary}
        onChangeClaudeConfiguration={props.providerController.changeClaudeConfiguration}
        onChangeDevinConfiguration={props.providerController.changeDevinConfiguration}
        onChangeKiloConfiguration={props.providerController.changeKiloConfiguration}
        onChangePiConfiguration={props.providerController.changePiConfiguration}
        onChangeOhMyPiConfiguration={props.providerController.changeOhMyPiConfiguration}
        onChangeOllamaConfiguration={props.providerController.changeOllamaConfiguration}
        onChangeMistralVibeConfiguration={props.providerController.changeMistralVibeConfiguration}
        onChangeGrokConfiguration={props.providerController.changeGrokConfiguration}
        onChangeOpenAiCompatibleConfiguration={
          props.providerController.changeOpenAiCompatibleConfiguration
        }
        onChangeAnthropicCompatibleConfiguration={
          props.providerController.changeAnthropicCompatibleConfiguration
        }
        onChangeAzureFoundryConfiguration={props.providerController.changeAzureFoundryConfiguration}
        onClearProviderCredential={props.providerController.clearProviderCredential}
        onBeginProviderAuthentication={props.providerController.beginProviderAuthentication}
        onCompleteProviderAuthentication={props.providerController.completeProviderAuthentication}
        onCreate={props.providerController.create}
        onCreateClaude={props.providerController.createClaude}
        onCreateMistralVibe={props.providerController.createMistralVibe}
        onCreateGrok={props.providerController.createGrok}
        onCreateOllama={props.providerController.createOllama}
        onCreateOpenAiCompatible={props.providerController.createOpenAiCompatible}
        onCreateAnthropicCompatible={props.providerController.createAnthropicCompatible}
        onCreateAzureFoundry={props.providerController.createAzureFoundry}
        onPermissionPersistenceChange={props.providerController.updatePermissionPersistence}
        onProbe={props.providerController.probe}
        onProviderOrderChange={props.providerController.updateProviderOrder}
        onAgentEligibleModelsChange={props.providerController.updateAgentEligibleModels}
        onVerifyFoundryTools={props.providerController.verifyFoundryTools}
        onProviderCredentialStatus={props.providerController.providerCredentialStatus}
        onRemove={props.providerController.remove}
        onRename={props.providerController.rename}
        onRetry={props.providerController.retry}
        onSetEnabled={props.providerController.setEnabled}
        probingIds={props.providerController.probingIds}
        status={props.providerController.status}
      />
    </div>
  );
}

interface SectionProps {
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly props: SettingsViewProps;
}

function GeneralSection({ focusedSetting, props }: SectionProps) {
  return (
    <section aria-label="General" id="settings-general">
      <div className="setgroup">
        <SettingRow
          description="How you are shown inside Octant. There is no account behind this, and none of it is required."
          focused={focusedSetting === settingId("user-profile")}
          label="Your profile"
          scope="app"
          settingId="user-profile"
        >
          <UserProfileSettingsView
            onSettingsChange={props.onSettingsChange}
            profile={props.settings.userProfile}
          />
        </SettingRow>
        <SettingRow
          focused={focusedSetting === settingId("enable-chat")}
          label="Enable Chat"
          scope="app"
          settingId="enable-chat"
        >
          <OctantSwitch
            checked={props.settings.chatEnabled}
            label="Enable Chat"
            onCheckedChange={(checked) => props.onSettingsChange({ chatEnabled: checked })}
          />
        </SettingRow>
        <SettingRow
          focused={focusedSetting === settingId("enable-work")}
          label="Enable Work"
          scope="app"
          settingId="enable-work"
        >
          <OctantSwitch
            checked={props.settings.workEnabled}
            label="Enable Work"
            onCheckedChange={(checked) => props.onSettingsChange({ workEnabled: checked })}
          />
        </SettingRow>
        <SettingRow
          description="The chords that reach Octant's global surfaces on this machine."
          focused={focusedSetting === settingId("keybindings")}
          label="Keyboard shortcuts"
          scope="app"
          settingId="keybindings"
        >
          <KeybindingSettings />
        </SettingRow>
        <SettingRow
          description="Octant updates itself only when you ask it to, and never while work is running."
          focused={focusedSetting === settingId("app-updates")}
          label="Updates"
          scope="app"
          settingId="app-updates"
        >
          <AppUpdateSettings
            automaticChecks={props.settings.automaticUpdateChecks}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            onAutomaticChecksChange={(enabled) =>
              props.onSettingsChange({ automaticUpdateChecks: enabled })
            }
          />
        </SettingRow>
      </div>
    </section>
  );
}

interface AppearanceSectionProps extends SectionProps {
  readonly capabilities: SettingsNativeCapabilities;
}

function AppearanceSection({ focusedSetting, props, capabilities }: AppearanceSectionProps) {
  const isAvailable = (id: string) =>
    isSettingAvailable(findSetting(APPEARANCE_SECTION(), settingId(id))!, capabilities);
  return (
    <section aria-label="Appearance" id="settings-appearance">
      {props.themeController !== undefined ? (
        <ThemeAppearanceEditor controller={props.themeController} />
      ) : null}
      <div className="setgroup">
        {isAvailable("sidebar-width") ? (
          <SettingRow
            focused={focusedSetting === settingId("sidebar-width")}
            label="Sidebar width"
            scope="app"
            settingId="sidebar-width"
          >
            <OctantSlider
              aria-label="Sidebar width"
              className="settings-view__range"
              max={420}
              min={220}
              onChange={(event) =>
                props.onSettingsChange({ sidebarWidth: Number(event.currentTarget.value) })
              }
              value={props.settings.sidebarWidth}
            />
          </SettingRow>
        ) : null}
        {isAvailable("sidebar-material") ? (
          <SettingRow
            description="Use the system sidebar material when available."
            focused={focusedSetting === settingId("sidebar-material")}
            label="Translucent sidebar"
            scope="app"
            settingId="sidebar-material"
          >
            <OctantSwitch
              checked={
                props.settings.sidebarMaterial === "system" &&
                (
                  props.themeController?.draft?.sidebarBackground ??
                  props.settings.sidebarBackground
                ).vibrancyMode !== "off"
              }
              describedBy="sidebar-material-description"
              label="Translucent sidebar"
              onCheckedChange={(checked) => {
                props.onSettingsChange({ sidebarMaterial: checked ? "system" : "opaque" });
                const background =
                  props.themeController?.draft?.sidebarBackground ??
                  props.settings.sidebarBackground;
                if (
                  checked &&
                  props.sidebarVibrancySupported &&
                  background.vibrancyMode === "off"
                ) {
                  props.themeController?.updateDraft({
                    sidebarBackground: { ...background, vibrancyMode: "subtle" },
                  });
                }
              }}
            />
            {props.settings.sidebarMaterial === "system" ? (
              <p
                className="settings-view__effective-note"
                data-visible-when-material="opaque"
                id="translucent-sidebar-effective-note"
              >
                Translucency is unavailable, so Octant is using an opaque sidebar.
              </p>
            ) : null}
          </SettingRow>
        ) : null}
        {isAvailable("mode-switcher") ? (
          <SettingRow
            focused={focusedSetting === settingId("mode-switcher")}
            label="Mode switcher"
            scope="app"
            settingId="mode-switcher"
          >
            <OctantNativeSelect
              aria-label="Mode switcher"
              className="settings-view__select"
              onChange={(event) =>
                props.onSettingsChange({
                  modeSwitcherPresentation: event.currentTarget
                    .value as ShellSettings["modeSwitcherPresentation"],
                })
              }
              value={props.settings.modeSwitcherPresentation}
            >
              <option value="buttons">Compact buttons</option>
              <option value="dropdown">Dropdown</option>
            </OctantNativeSelect>
          </SettingRow>
        ) : null}
        {isAvailable("project-view-switcher") ? (
          <SettingRow
            description="How the Code sidebar offers saved project views."
            focused={focusedSetting === settingId("project-view-switcher")}
            label="Project view switcher"
            scope="app"
            settingId="project-view-switcher"
          >
            <OctantNativeSelect
              aria-label="Project view switcher"
              className="settings-view__select"
              onChange={(event) =>
                props.onSettingsChange({
                  projectViewSwitcherPresentation: event.currentTarget
                    .value as ShellSettings["projectViewSwitcherPresentation"],
                })
              }
              value={props.settings.projectViewSwitcherPresentation}
            >
              <option value="dropdown">Dropdown</option>
              <option value="inline">Icon buttons</option>
            </OctantNativeSelect>
          </SettingRow>
        ) : null}
        {isAvailable("sidebar-background") ? (
          <SettingRow
            description="Choose a preset gradient, a custom image, or none. Adjust the overlay color and opacity for readability."
            focused={focusedSetting === settingId("sidebar-background")}
            label="Sidebar background"
            scope="app"
            settingId="sidebar-background"
          >
            <SidebarBackgroundSettings
              background={
                props.themeController?.draft?.sidebarBackground ?? props.settings.sidebarBackground
              }
              onSettingsChange={(patch) => {
                if (patch.sidebarBackground !== undefined && props.themeController !== undefined) {
                  props.themeController.updateDraft({ sidebarBackground: patch.sidebarBackground });
                } else {
                  props.onSettingsChange(patch);
                }
              }}
              sidebarVibrancySupported={props.sidebarVibrancySupported}
            />
          </SettingRow>
        ) : null}
      </div>
    </section>
  );
}

interface AdvancedSectionProps extends SectionProps {
  readonly capabilities: SettingsNativeCapabilities;
  readonly diagnosticsExportClient?: DiagnosticsExportClient;
}

function AdvancedSection({
  focusedSetting,
  props,
  capabilities,
  diagnosticsExportClient,
}: AdvancedSectionProps) {
  const resetBoundsAvailable = isSettingAvailable(
    findSetting(ADVANCED_SECTION(), settingId("reset-window-bounds"))!,
    capabilities,
  );
  return (
    <section aria-label="Advanced" id="settings-advanced">
      <div className="setgroup">
        <SettingRow
          focused={focusedSetting === settingId("reset-layout")}
          label="Reset active mode layout"
          scope="app"
          settingId="reset-layout"
        >
          <OctantButton
            className="settings-view__action"
            onClick={props.onResetLayout}
            type="button"
            variant="secondary"
          >
            Reset active mode layout
          </OctantButton>
        </SettingRow>
        {resetBoundsAvailable ? (
          <SettingRow
            focused={focusedSetting === settingId("reset-window-bounds")}
            label="Reset native window bounds"
            scope="app"
            settingId="reset-window-bounds"
          >
            <OctantButton
              className="settings-view__action"
              onClick={props.onResetNativeBounds}
              type="button"
              variant="secondary"
            >
              Reset native window bounds
            </OctantButton>
          </SettingRow>
        ) : null}
        {diagnosticsExportClient !== undefined ? (
          <SettingRow
            focused={focusedSetting === settingId("export-diagnostics")}
            label="Export diagnostics"
            scope="host"
            settingId="export-diagnostics"
          >
            <DiagnosticsExportControl client={diagnosticsExportClient} />
          </SettingRow>
        ) : null}
      </div>
    </section>
  );
}

interface SidebarBackgroundSettingsProps {
  readonly background: SidebarBackground;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
  readonly sidebarVibrancySupported: boolean;
}

function SidebarBackgroundSettings({
  background,
  onSettingsChange,
  sidebarVibrancySupported,
}: SidebarBackgroundSettingsProps) {
  const setBackground = (next: SidebarBackground) => {
    onSettingsChange({ sidebarBackground: next });
  };

  const vibrancyMode: SidebarVibrancyMode = sidebarVibrancySupported
    ? background.vibrancyMode
    : "off";

  return (
    <div className="settings-view__setting">
      <label className="settings-view__field">
        <span>Background type</span>
        <OctantNativeSelect
          aria-label="Sidebar background type"
          className="settings-view__select"
          onChange={(event) => {
            const kind = event.currentTarget.value;
            if (kind === "none") {
              setBackground({
                kind: "none",
                overlayColor: background.overlayColor,
                overlayOpacity: background.overlayOpacity,
                vibrancyMode: background.vibrancyMode,
              });
            } else if (kind === "preset") {
              const first = SIDEBAR_BACKGROUND_PRESETS[0];
              if (first !== undefined) {
                const wasNone = background.kind === "none";
                setBackground({
                  kind: "preset",
                  presetId: decodeSidebarBackgroundPresetId(first.id),
                  overlayColor: wasNone
                    ? decodeThemeHexColor(first.suggestedOverlayColor)
                    : background.overlayColor,
                  overlayOpacity: wasNone
                    ? first.suggestedOverlayOpacity
                    : background.overlayOpacity,
                  vibrancyMode: background.vibrancyMode,
                });
              }
            } else if (kind === "custom") {
              if (background.kind === "custom") {
                setBackground(background);
              }
            }
          }}
          value={background.kind === "custom" ? "custom" : background.kind}
        >
          <option value="none">None</option>
          <option value="preset">Preset</option>
          <option value="custom">Custom</option>
        </OctantNativeSelect>
      </label>
      {background.kind === "preset" ? (
        <div className="settings-view__field" aria-label="Sidebar background presets">
          <span>Preset</span>
          <div
            className="settings-view__preset-grid"
            role="radiogroup"
            aria-label="Sidebar background presets"
          >
            {SIDEBAR_BACKGROUND_PRESETS.map((preset) => {
              const selected = background.presetId === preset.id;
              return (
                <OctantButton
                  aria-checked={selected}
                  aria-label={preset.displayName}
                  className="settings-view__preset-swatch"
                  key={preset.id}
                  onClick={() =>
                    setBackground({
                      kind: "preset",
                      presetId: decodeSidebarBackgroundPresetId(preset.id),
                      overlayColor: background.overlayColor,
                      overlayOpacity: background.overlayOpacity,
                      vibrancyMode: background.vibrancyMode,
                    })
                  }
                  role="radio"
                  style={{ background: preset.cssBackground }}
                  type="button"
                  variant="ghost"
                />
              );
            })}
          </div>
        </div>
      ) : null}
      {background.kind === "custom" ? (
        <p className="settings-view__effective-note">
          Custom backgrounds can be uploaded from the sidebar background picker.
        </p>
      ) : null}
      <label className="settings-view__field">
        <span>Overlay color</span>
        <OctantInput
          aria-label="Sidebar overlay color"
          className="settings-view__text-input"
          onChange={(event) =>
            setBackground({
              ...background,
              overlayColor: event.currentTarget.value as never,
            } as SidebarBackground)
          }
          type="color"
          value={background.overlayColor}
        />
      </label>
      <label className="settings-view__field">
        <span>Overlay opacity</span>
        <OctantSlider
          aria-label="Sidebar overlay opacity"
          className="settings-view__range"
          max={100}
          min={0}
          onChange={(event) =>
            setBackground({
              ...background,
              overlayOpacity: Number(event.currentTarget.value),
            } as SidebarBackground)
          }
          step={1}
          value={background.overlayOpacity}
        />
      </label>
      {sidebarVibrancySupported ? (
        <label className="settings-view__field">
          <span>Vibrancy mode</span>
          <OctantNativeSelect
            aria-label="Sidebar vibrancy mode"
            className="settings-view__select"
            onChange={(event) =>
              setBackground({
                ...background,
                vibrancyMode: event.currentTarget.value as SidebarVibrancyMode,
              } as SidebarBackground)
            }
            value={vibrancyMode}
          >
            <option value="off">Off</option>
            <option value="subtle">Subtle</option>
            <option value="strong">Strong</option>
          </OctantNativeSelect>
        </label>
      ) : null}
    </div>
  );
}
