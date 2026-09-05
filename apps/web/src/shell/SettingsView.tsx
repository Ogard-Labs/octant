import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { ArrowLeft, ChevronDown, Menu, Search, X } from "lucide-react";
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
import { isImageProfileDriverKind } from "@octant/domain";
import type { ImplementedSettingId } from "./useShellController";
import type { ProviderController } from "../providers/useProviderController";
import type { DiscoveryController } from "../providers/useDiscoveryController";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";
import { ProviderDiscoverySection } from "../providers/ProviderDiscoverySection";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSlider } from "../ui/base/OctantSlider";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isSettingsSectionAvailable,
  resolveSettingsSectionContribution,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";
import { SettingsNavigation, type SettingsNavigationItem } from "./SettingsNavigation";
import { PluginSettingsSection } from "./PluginSettingsSection";
import { ChatSettingsView } from "../chat/ChatSettingsView";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import { CodeSettingsView } from "../code/CodeSettingsView";
import { UsageDashboard } from "../usage/UsageDashboard";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { DiagnosticsExportControl } from "../support/DiagnosticsExportControl";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import { HostSettingsSection } from "../host/HostSettingsSection";
import { FederatedHostsLifecyclePanel } from "../host/FederatedHostsLifecyclePanel";
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
import {
  NativeHarnessRoutingPanel,
  type NativeHarnessProviderOption,
} from "../harness/NativeHarnessRoutingPanel";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { isNativeHarnessDriverKind } from "@octant/domain";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import { ThemeAppearanceEditor } from "../theme/ThemeAppearanceEditor";
import { AppUpdateSettings } from "../settings/AppUpdateSettings";
import {
  MarketplaceFetchDisclosure,
  MarketplaceFetchSettings,
} from "../settings/MarketplaceFetchSettings";
import { OpenInApplicationSettings } from "../settings/OpenInApplicationSettings";
import { ProviderUsageLimitsPanel } from "../usage/ProviderUsageLimitsPanel";
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
  readonly providerUsageLimitsClient?: ProviderUsageLimitsClient;
  readonly diagnosticsExportClient?: DiagnosticsExportClient;
  readonly hostControlClient?: HostControlClient;
  readonly hostFederationLifecycle?: HostFederationLifecycle;
  readonly githubClient?: GithubClient;
  readonly integrationClient?: IntegrationClient;
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
  readonly nativeHarnessClient?: NativeHarnessClient;
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
  general: "Choose app-wide defaults, identity, updates, and network behavior.",
  appearance: "Choose how Octant looks. Use a built-in theme or make your own.",
  keybindings: "Change the shortcuts that reach Octant's global surfaces.",
  chat: "Defaults for new Chat conversations.",
  work: "Defaults for tasks.",
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
  const effectivePlugins = props.effectivePlugins ?? FIRST_PARTY_PLUGINS_EFFECTIVE;
  const availableSections = listAvailableSections(octantSettingsRegistry, capabilities).filter(
    (section) => isSettingsSectionAvailable(section.id, effectivePlugins),
  );
  const pluginSettingsEntryPoints = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of availableSections) {
      const contribution = resolveSettingsSectionContribution(section.id, effectivePlugins);
      if (contribution?.entryPoint !== undefined) {
        map.set(section.id, contribution.entryPoint);
      }
    }
    return map;
  }, [availableSections, effectivePlugins]);
  const route = useSettingsRoute({
    availableSections,
    capabilities,
    registry: octantSettingsRegistry,
    ...(props.initialDeepLink === undefined ? {} : { initialDeepLink: props.initialDeepLink }),
  });
  const narrow = props.isNarrow === true;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const navigationClose = useRef<HTMLButtonElement>(null);

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

  const debouncedSearch = useDebouncedValue(props.search, 120);
  // Leave search mode as soon as the input clears. Debounce only the
  // expensive filter; otherwise selecting a result keeps the results panel
  // mounted for 120ms and the destination setting never appears.
  const hasQuery = props.search.trim() !== "";
  const navSections = filterSectionsForNavigator(availableSections, capabilities, debouncedSearch);
  const searchResults = searchSettings(availableSections, capabilities, debouncedSearch);
  const navItems: SettingsNavigationItem[] = navSections.map((section) => ({
    id: section.id,
    label: section.label,
  }));

  const handleSearchSelect = (link: SettingsDeepLink) => {
    route.applyDeepLink(link);
    props.onSearchChange("");
  };
  const currentSectionLabel = hasQuery
    ? "Search settings"
    : (SECTION_LABELS[route.activeSection] ?? "Settings");
  const navigation = (
    <SettingsNavigation
      activeSection={route.activeSection}
      onSelect={(sectionId) => {
        route.openSection(sectionId);
        setNavigationOpen(false);
      }}
      sections={navItems}
    />
  );

  return (
    <section
      aria-label="Settings"
      className={narrow ? "settings-view settings-view--narrow" : "settings-view"}
    >
      {narrow ? null : (
        <aside aria-label="Settings sidebar" className="settings-view__sidebar">
          <div className="settings-view__sidebar-titlebar window-drag-region">
            <span aria-hidden="true" className="settings-view__traffic-light-space" />
            <span className="settings-view__drag-space" />
          </div>
          <div className="settings-view__sidebar-content">
            <SettingsSearchField onChange={props.onSearchChange} value={props.search} />
            <div className="settings-view__navigation-scroll">{navigation}</div>
            {props.onBack === undefined ? null : (
              <footer className="settings-view__sidebar-footer">
                <OctantButton
                  className="setnav-item window-no-drag settings-view__back justify-start"
                  onClick={props.onBack}
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
                  <span>Back to app</span>
                </OctantButton>
              </footer>
            )}
          </div>
        </aside>
      )}
      <div className="settings-view__workspace">
        {narrow ? (
          <header className="settings-view__mobile-header">
            <div className="settings-view__mobile-titlebar window-drag-region">
              {props.onBack === undefined ? null : (
                <OctantButton
                  className="settings-view__mobile-back window-no-drag"
                  onClick={props.onBack}
                  type="button"
                  variant="ghost"
                >
                  <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.5} />
                  <span>Back to app</span>
                </OctantButton>
              )}
              <span className="settings-view__mobile-title">{currentSectionLabel}</span>
              <OctantButton
                aria-expanded={navigationOpen}
                aria-haspopup="dialog"
                className="settings-view__mobile-sections window-no-drag"
                onClick={() => setNavigationOpen(true)}
                ref={navigationTrigger}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Menu aria-hidden="true" size={16} strokeWidth={1.5} />
                <span>Settings sections</span>
              </OctantButton>
            </div>
            <SettingsSearchField
              className="settings-view__mobile-search"
              onChange={props.onSearchChange}
              value={props.search}
            />
          </header>
        ) : (
          <div className="settings-view__workspace-titlebar window-drag-region">
            <nav
              aria-label="Settings breadcrumb"
              className="settings-view__breadcrumb window-no-drag"
            >
              <span>Settings</span>
              <span aria-hidden="true">/</span>
              <strong>{currentSectionLabel}</strong>
            </nav>
          </div>
        )}
        <main className="settings-view__content">
          <div className="settings-view__content-inner">
            <header className="settings-view__header">
              <h1 className="setpane-title" id="settings-heading">
                {currentSectionLabel}
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
                pluginSettingsEntryPoints={pluginSettingsEntryPoints}
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
      {narrow && navigationOpen ? (
        <OctantDialog
          className="settings-view__drawer"
          initialFocus={navigationClose}
          label="Settings sections"
          onClose={() => setNavigationOpen(false)}
          open
          restoreFocus={navigationTrigger}
        >
          <header className="settings-view__drawer-header">
            <h2>Settings sections</h2>
            <OctantIconButton
              label="Close Settings sections"
              onClick={() => setNavigationOpen(false)}
              ref={navigationClose}
              type="button"
            >
              <X aria-hidden="true" size={16} strokeWidth={1.5} />
            </OctantIconButton>
          </header>
          <div className="settings-view__drawer-body">{navigation}</div>
        </OctantDialog>
      ) : null}
    </section>
  );
}

function SettingsSearchField(props: {
  readonly className?: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  return (
    <div
      className={
        props.className === undefined
          ? "settings-view__field settings-view__field--search"
          : `settings-view__field settings-view__field--search ${props.className}`
      }
    >
      <label className="settings-view__search-label" htmlFor={inputId}>
        Search settings
      </label>
      <Search aria-hidden="true" className="settings-view__search-icon" size={14} />
      <OctantInput
        aria-label="Search settings"
        className="settings-view__text-input"
        id={inputId}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder="Search settings…"
        ref={input}
        type="search"
        value={props.value}
      />
      {props.value === "" ? null : (
        <OctantIconButton
          className="settings-view__search-clear"
          label="Clear settings search"
          onClick={() => {
            props.onChange("");
            input.current?.focus();
          }}
          type="button"
        >
          <X aria-hidden="true" size={14} strokeWidth={1.5} />
        </OctantIconButton>
      )}
    </div>
  );
}

interface ActiveSectionContentProps {
  readonly activeSection: SettingsSectionId;
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly pluginSettingsEntryPoints: ReadonlyMap<string, string>;
  readonly props: SettingsViewProps;
  readonly capabilities: SettingsNativeCapabilities;
}

function ActiveSectionContent({
  activeSection,
  focusedSetting,
  pluginSettingsEntryPoints,
  props,
  capabilities,
}: ActiveSectionContentProps) {
  const pluginEntryPoint = pluginSettingsEntryPoints.get(activeSection);
  if (pluginEntryPoint !== undefined) {
    return (
      <PluginSettingsSection
        entryPoint={pluginEntryPoint}
        githubClient={props.githubClient}
        integrationClient={props.integrationClient}
      />
    );
  }
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
    case "keybindings":
      return <KeybindingsSection focusedSetting={focusedSetting} />;
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
        <div className="settings-code-stack" id="settings-code">
          <CodeSettingsView
            key={props.codeController.bootstrap.settings.version}
            onUpdate={props.codeController.updateSettings}
            settings={props.codeController.bootstrap.settings}
          />
          <OpenInApplicationSettings
            applications={props.settings.openInApplications}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            onChange={(openInApplications) => props.onSettingsChange({ openInApplications })}
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
          {props.nativeHarnessClient === undefined ? null : (
            <NativeHarnessRoutingPanel
              client={props.nativeHarnessClient}
              hostId={LOCAL_HOST_ID}
              providers={nativeHarnessProviderOptions(props.providerController)}
            />
          )}
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
        <div className="settings-usage-stack" id="settings-usage">
          <UsageDashboard
            client={props.usageClient}
            {...(props.isNarrow === undefined ? {} : { isNarrow: props.isNarrow })}
            showHeading={false}
          />
          {props.providerUsageLimitsClient === undefined ? null : (
            <ProviderUsageLimitsPanel
              client={props.providerUsageLimitsClient}
              instances={props.providerController?.instances ?? []}
            />
          )}
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
    case "skills":
      return props.extensionClient !== undefined ? (
        <ExtensionsSettingsView
          client={props.extensionClient}
          marketplaceFetchesEnabled={props.settings.marketplaceFetchesEnabled}
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
      .filter((instance) => instance.enabled && !isImageProfileDriverKind(instance.driverKind))
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
        onChangeGooseConfiguration={props.providerController.changeGooseConfiguration}
        onChangeGlmConfiguration={props.providerController.changeGlmConfiguration}
        onChangeGeminiConfiguration={props.providerController.changeGeminiConfiguration}
        onChangeCopilotConfiguration={props.providerController.changeCopilotConfiguration}
        onChangeClineConfiguration={props.providerController.changeClineConfiguration}
        onChangeQwenConfiguration={props.providerController.changeQwenConfiguration}
        onChangeOpenAiCompatibleConfiguration={
          props.providerController.changeOpenAiCompatibleConfiguration
        }
        onChangeOpenAiImageConfiguration={props.providerController.changeOpenAiImageConfiguration}
        onChangeGeminiImageConfiguration={props.providerController.changeGeminiImageConfiguration}
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
        onCreateGlm={props.providerController.createGlm}
        onCreateGemini={props.providerController.createGemini}
        onCreateCline={props.providerController.createCline}
        onCreateQwen={props.providerController.createQwen}
        onCreateOllama={props.providerController.createOllama}
        onCreateOpenAiCompatible={props.providerController.createOpenAiCompatible}
        onCreateAnthropicCompatible={props.providerController.createAnthropicCompatible}
        onCreateAzureFoundry={props.providerController.createAzureFoundry}
        onCreateOpenAiImage={props.providerController.createOpenAiImage}
        onCreateGeminiImage={props.providerController.createGeminiImage}
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
    <section aria-label="General" className="settings-section-stack" id="settings-general">
      <div className="settings-card-section settings-card-section--open">
        <h2>Available modes</h2>
        <div className="setgroup">
          <SettingRow
            description="Show Chat in the mode switcher. Existing threads stay stored when hidden."
            focused={focusedSetting === settingId("enable-chat")}
            label="Chat"
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
            description="Show Work in the mode switcher. Existing threads stay stored when hidden."
            focused={focusedSetting === settingId("enable-work")}
            label="Work"
            scope="app"
            settingId="enable-work"
          >
            <OctantSwitch
              checked={props.settings.workEnabled}
              label="Enable Work"
              onCheckedChange={(checked) => props.onSettingsChange({ workEnabled: checked })}
            />
          </SettingRow>
        </div>
      </div>
      <details
        className="settings-card-section settings-card-section--open settings-profile-disclosure"
        open={focusedSetting === settingId("user-profile") ? true : undefined}
      >
        <summary>
          <span className="settings-profile-disclosure__summary-copy">
            <h2>Profile</h2>
            <span>{props.settings.userProfile.displayName ?? "Not set"}</span>
          </span>
          <ChevronDown aria-hidden="true" size={16} strokeWidth={1.5} />
        </summary>
        <div className="setgroup">
          <SettingRow
            description="How you are shown inside Octant. There is no account behind this, and none of it is required."
            focused={focusedSetting === settingId("user-profile")}
            label="Your profile"
            labelledBySection
            scope="app"
            settingId="user-profile"
          >
            <UserProfileSettingsView
              onSettingsChange={props.onSettingsChange}
              profile={props.settings.userProfile}
            />
          </SettingRow>
        </div>
      </details>
      <div className="settings-card-section settings-card-section--open">
        <h2>Updates</h2>
        <p className="settings-section-note">
          Octant updates itself only when you ask it to, and never while work is running.
        </p>
        <div className="setgroup">
          <AppUpdateSettings
            automaticChecks={props.settings.automaticUpdateChecks}
            focused={focusedSetting === settingId("app-updates")}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            onAutomaticChecksChange={(enabled) =>
              props.onSettingsChange({ automaticUpdateChecks: enabled })
            }
            onReleaseRingChange={(ring) => props.onSettingsChange({ releaseRing: ring })}
          />
        </div>
      </div>
      <div className="settings-card-section settings-card-section--open">
        <h2>Marketplace</h2>
        <div className="setgroup">
          <SettingRow
            description="Skill and extension catalog search contacts third-party registries only when you ask."
            focused={focusedSetting === settingId("marketplace-fetches")}
            label="Marketplace fetches"
            scope="host"
            settingId="marketplace-fetches"
          >
            <MarketplaceFetchSettings
              enabled={props.settings.marketplaceFetchesEnabled}
              onEnabledChange={(enabled) =>
                props.onSettingsChange({ marketplaceFetchesEnabled: enabled })
              }
            />
          </SettingRow>
        </div>
        <MarketplaceFetchDisclosure />
      </div>
    </section>
  );
}

function KeybindingsSection({ focusedSetting }: Pick<SectionProps, "focusedSetting">) {
  return (
    <section aria-label="Keybindings" className="settings-section-stack" id="settings-keybindings">
      <div className="settings-card-section settings-card-section--open">
        <h2>Keyboard shortcuts</h2>
        <div className="setgroup">
          <SettingRow
            description="Click a shortcut, then press the replacement chord. Changes take effect immediately."
            focused={focusedSetting === settingId("keybindings")}
            label="Shortcuts"
            labelledBySection
            scope="app"
            settingId="keybindings"
          >
            <KeybindingSettings />
          </SettingRow>
        </div>
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
    <section aria-label="Appearance" className="settings-section-stack" id="settings-appearance">
      {props.themeController !== undefined ? (
        <ThemeAppearanceEditor controller={props.themeController} />
      ) : null}
      <div className="settings-card-section settings-card-section--open">
        <h2>Workspace and reading</h2>
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
                    void props.themeController?.applyPatch({
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
          {isAvailable("workspace-material") ? (
            <SettingRow
              description="Extend translucency from the sidebar across the whole workspace."
              focused={focusedSetting === settingId("workspace-material")}
              label="Translucent workspace"
              scope="app"
              settingId="workspace-material"
            >
              <OctantSwitch
                checked={
                  props.settings.workspaceMaterial === "system" &&
                  props.settings.sidebarMaterial === "system" &&
                  (
                    props.themeController?.draft?.sidebarBackground ??
                    props.settings.sidebarBackground
                  ).vibrancyMode !== "off"
                }
                describedBy="workspace-material-description"
                disabled={
                  props.settings.sidebarMaterial !== "system" ||
                  (
                    props.themeController?.draft?.sidebarBackground ??
                    props.settings.sidebarBackground
                  ).vibrancyMode === "off"
                }
                label="Translucent workspace"
                onCheckedChange={(checked) => {
                  props.onSettingsChange({ workspaceMaterial: checked ? "system" : "opaque" });
                }}
              />
              {props.settings.sidebarMaterial !== "system" ||
              (props.themeController?.draft?.sidebarBackground ?? props.settings.sidebarBackground)
                .vibrancyMode === "off" ? (
                <p className="settings-view__effective-note" id="workspace-material-effective-note">
                  Turn on Translucent sidebar first.
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
              <OctantToggleGroup<ShellSettings["modeSwitcherPresentation"]>
                aria-label="Mode switcher"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected !== undefined) {
                    props.onSettingsChange({ modeSwitcherPresentation: selected });
                  }
                }}
                value={[props.settings.modeSwitcherPresentation]}
              >
                <OctantToggleGroupItem value="buttons">Buttons</OctantToggleGroupItem>
                <OctantToggleGroupItem value="dropdown">Dropdown</OctantToggleGroupItem>
              </OctantToggleGroup>
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
              <OctantToggleGroup<ShellSettings["projectViewSwitcherPresentation"]>
                aria-label="Project view switcher"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected !== undefined) {
                    props.onSettingsChange({ projectViewSwitcherPresentation: selected });
                  }
                }}
                value={[props.settings.projectViewSwitcherPresentation]}
              >
                <OctantToggleGroupItem value="dropdown">Dropdown</OctantToggleGroupItem>
                <OctantToggleGroupItem value="inline">Buttons</OctantToggleGroupItem>
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
          {isAvailable("transcript-text-size") ? (
            <SettingRow
              description="Conversation text in Chat, Work, and Code threads."
              focused={focusedSetting === settingId("transcript-text-size")}
              label="Transcript text size"
              scope="app"
              settingId="transcript-text-size"
            >
              <OctantToggleGroup<ShellSettings["transcriptTextSize"]>
                aria-label="Transcript text size"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected !== undefined)
                    props.onSettingsChange({ transcriptTextSize: selected });
                }}
                value={[props.settings.transcriptTextSize]}
              >
                <OctantToggleGroupItem value="small">Small</OctantToggleGroupItem>
                <OctantToggleGroupItem value="medium">Medium</OctantToggleGroupItem>
                <OctantToggleGroupItem value="large">Large</OctantToggleGroupItem>
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
          {isAvailable("transcript-width") ? (
            <SettingRow
              description="Maximum width of transcript and composer columns."
              focused={focusedSetting === settingId("transcript-width")}
              label="Transcript width"
              scope="app"
              settingId="transcript-width"
            >
              <OctantToggleGroup<ShellSettings["transcriptWidth"]>
                aria-label="Transcript width"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected !== undefined) props.onSettingsChange({ transcriptWidth: selected });
                }}
                value={[props.settings.transcriptWidth]}
              >
                <OctantToggleGroupItem value="narrow">Narrow</OctantToggleGroupItem>
                <OctantToggleGroupItem value="medium">Medium</OctantToggleGroupItem>
                <OctantToggleGroupItem value="wide">Wide</OctantToggleGroupItem>
              </OctantToggleGroup>
            </SettingRow>
          ) : null}
          {isAvailable("thread-provider-icons") ? (
            <SettingRow
              description="Show a compact provider mark before each thread title."
              focused={focusedSetting === settingId("thread-provider-icons")}
              label="Provider icons in thread list"
              scope="app"
              settingId="thread-provider-icons"
            >
              <OctantSwitch
                checked={props.settings.showThreadProviderIcons}
                label="Provider icons in thread list"
                onCheckedChange={(showThreadProviderIcons) =>
                  props.onSettingsChange({ showThreadProviderIcons })
                }
              />
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
                  props.themeController?.draft?.sidebarBackground ??
                  props.settings.sidebarBackground
                }
                onSettingsChange={(patch) => {
                  if (
                    patch.sidebarBackground !== undefined &&
                    props.themeController !== undefined
                  ) {
                    void props.themeController.applyPatch({
                      sidebarBackground: patch.sidebarBackground,
                    });
                  } else {
                    props.onSettingsChange(patch);
                  }
                }}
                sidebarVibrancySupported={props.sidebarVibrancySupported}
              />
            </SettingRow>
          ) : null}
        </div>
      </div>
      {props.themeController === undefined ? null : (
        <div className="settings-card-section settings-card-section--open">
          <h2>Reset</h2>
          <div className="setgroup">
            <SettingRow
              description="Return every appearance setting to its default."
              label="Reset appearance"
              scope="app"
              settingId="reset-appearance"
            >
              <OctantButton
                onClick={() => void props.themeController?.reset()}
                size="sm"
                type="button"
                variant="secondary"
              >
                Reset appearance
              </OctantButton>
            </SettingRow>
          </div>
        </div>
      )}
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
      <div className="settings-card-section settings-card-section--open">
        <h2>Maintenance</h2>
        <div className="setgroup">
          <SettingRow
            description="Restores the current mode's pane arrangement, sidebar, and dock to defaults. Threads and data are kept."
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
              description="Moves and resizes the native window to its default bounds. Workspace data is kept."
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
              description="Creates a local support bundle from the selected host. Review it before sharing."
              focused={focusedSetting === settingId("export-diagnostics")}
              label="Export diagnostics"
              scope="host"
              settingId="export-diagnostics"
            >
              <DiagnosticsExportControl client={diagnosticsExportClient} />
            </SettingRow>
          ) : null}
        </div>
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
        <OctantSelectField
          aria-label="Sidebar background type"
          className="settings-view__select"
          onValueChange={(kind) => {
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
          options={[
            { id: "none", label: "None" },
            { id: "preset", label: "Preset" },
            { id: "custom", label: "Custom" },
          ]}
          value={background.kind === "custom" ? "custom" : background.kind}
        />
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
          <OctantSelectField
            aria-label="Sidebar vibrancy mode"
            className="settings-view__select"
            onValueChange={(value) =>
              setBackground({
                ...background,
                vibrancyMode: value as SidebarVibrancyMode,
              } as SidebarBackground)
            }
            options={[
              { id: "off", label: "Off" },
              { id: "subtle", label: "Subtle" },
              { id: "strong", label: "Strong" },
            ]}
            value={vibrancyMode}
          />
        </label>
      ) : null}
    </div>
  );
}

/** The direct-endpoint providers a slot may name, with the models each reports. */
function nativeHarnessProviderOptions(
  controller: SettingsViewProps["providerController"],
): ReadonlyArray<NativeHarnessProviderOption> {
  if (controller === undefined) return [];
  return controller.instances
    .filter((instance) => instance.enabled && isNativeHarnessDriverKind(instance.driverKind))
    .map((instance) => ({
      instanceId: String(instance.id),
      label: instance.displayName,
      models: (controller.observedByInstance.get(instance.id)?.models ?? []).map((model) => ({
        id: String(model.id),
        label: model.displayName,
      })),
    }))
    .filter((option) => option.models.length > 0);
}
