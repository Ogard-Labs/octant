import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { ArrowLeft, Check, Menu, Search, X } from "lucide-react";
import type { ShellSettings } from "@octant/contracts/shell";
import {
  type SettingsDeepLink,
  type SettingsSectionId,
  type SettingsSettingId,
} from "@octant/contracts";
import {
  DEFAULT_APP_BACKGROUND,
  decodeSidebarBackgroundPresetId,
  decodeThemeHexColor,
  type SidebarBackground,
  type SidebarVibrancyMode,
} from "@octant/contracts/theme";
import { SIDEBAR_BACKGROUND_PRESETS } from "@octant/theme/backgrounds";
import { isImageProfileDriverKind, resolveAppBackground } from "@octant/domain";
import type { ProviderController } from "../providers/useProviderController";
import type { DiscoveryController } from "../providers/useDiscoveryController";
import { ProviderSettingsView } from "../providers/ProviderSettingsView";
import { ProviderDiscoverySection } from "../providers/ProviderDiscoverySection";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SliderField } from "../settings/SliderField";
import { DefaultFolderSettings } from "../settings/DefaultFolderSettings";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isSettingsSectionAvailable,
  resolveSettingsSectionContribution,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";
import { SettingsNavigation, type SettingsNavigationItem } from "./SettingsNavigation";
import { SidebarDestinationSettings } from "./SidebarDestinationSettings";
import { PluginSettingsSection } from "./PluginSettingsSection";
import { ChatSettingsView } from "../chat/ChatSettingsView";
import type { ChatController } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import { CodeSettingsView } from "../code/CodeSettingsView";
import { UsageDashboard } from "../usage/UsageDashboard";
import { ProviderUsageHistoryWorkspace } from "../usage/ProviderUsageHistoryWorkspace";
import type { LocalUsageHistoryClient } from "@octant/client-runtime/provider-usage-history-client";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import { DiagnosticsExportControl } from "../support/DiagnosticsExportControl";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { HostControlClient } from "@octant/client-runtime/host-control-client";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import { HostDataSettingsSection, HostSettingsSection } from "../host/HostSettingsSection";
import { RemoteAccessSettingsSection } from "../host/RemoteAccessSettingsSection";
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
import { VoiceSettingsView } from "../settings/VoiceSettingsView";
import { ImageGenerationSettingsView } from "../settings/ImageGenerationSettingsView";
import { ComputerUseSettingsView } from "../settings/ComputerUseSettingsView";
import { UserProfileSettingsView } from "../profile/UserProfileSettingsView";
import { SettingGroup, SettingRow, SettingsSection } from "../settings/primitives";
import {
  AppBackgroundSettings,
  type BackgroundImageLibrary,
} from "../settings/AppBackgroundSettings";
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
import { remoteAccessAdministrationOf, type OctantHostBridge } from "./hostBridge";
import { openExternalUrl } from "./openExternalUrl";
import "../styles/settings.css";
import "../styles/settings-specialty.css";
import "../styles/extensions-settings.css";

export interface SettingsViewProps {
  readonly chatController?: ChatController;
  readonly codeController?: CodeController;
  readonly nativeBoundsAvailable: boolean;
  readonly onBack?: () => void;
  readonly onResetLayout: () => void;
  readonly onResetNativeBounds: () => void;
  readonly onSearchChange: (value: string) => void;
  /** May resolve to whether the host accepted the patch; a void result is read as accepted. */
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => Promise<boolean> | boolean | void;
  readonly search: string;
  readonly settings: ShellSettings;
  readonly sidebarVibrancySupported: boolean;
  readonly hostBridge?: OctantHostBridge;
  /**
   * Implemented setting ids. Kept as a stable contract of what is implemented;
   * the registry is the source of truth for rendering and search.
   */
  readonly providerController?: ProviderController;
  readonly discoveryController?: DiscoveryController;
  readonly usageClient?: UsageClient;
  readonly providerUsageLimitsClient?: ProviderUsageLimitsClient;
  readonly localUsageHistoryClient?: LocalUsageHistoryClient;
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
  /** The host's photo library for the welcome background; absent on hosts without one. */
  readonly backgroundImageLibrary?: BackgroundImageLibrary;
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
  general: "Choose app-wide defaults, updates, and network behavior.",
  profile: "Choose how you appear inside Octant. Everything is optional and kept on this Mac.",
  appearance: "Choose how Octant looks. Use a built-in theme or make your own.",
  keybindings: "Change the shortcuts that reach Octant's global surfaces.",
  chat: "Defaults for new Chat conversations.",
  code: "Defaults for Code threads and delivery.",
  "navigator-assistant": "The models Navigator uses to converse and to review images.",
  voice: "The providers that turn speech into text and text into speech.",
  "image-generation": "Choose connected providers and models for image generation.",
  "computer-use": "Control applications through the bundled Computer use plugin.",
  providers: "Connect providers, manage authentication, and pick default models.",
  harness: "Octant's own agent loop for API-key and local models: which model does which job.",
  skills:
    "Skills extend what agents can do. Review the source, then trust and enable only what you want.",
  github: "Connection and repository access on the selected host.",
  host: "The host process: its status, startup, notifications, and maintenance.",
  data: "What this host stores, how long it keeps threads, and how to back it up.",
  usage: "Activity and usage across providers.",
};

const APPEARANCE_SECTION = (): SettingsSectionEntry =>
  findSection(octantSettingsRegistry, "appearance")!;
const HOST_SECTION = (): SettingsSectionEntry => findSection(octantSettingsRegistry, "host")!;

/**
 * Settings that moved to another page keep answering the links that name
 * their old one: an empty state, a doc, or a remote client built against the
 * earlier layout still lands on the control.
 */
const MOVED_SETTINGS: ReadonlyArray<{
  readonly from: SettingsSectionId;
  readonly setting: string;
  readonly to: SettingsSectionId;
}> = [
  { from: "general", setting: "user-profile", to: "profile" },
  { from: "general", setting: "marketplace-fetches", to: "skills" },
  { from: "appearance", setting: "stream-replies", to: "chat" },
  { from: "appearance", setting: "project-view-switcher", to: "code" },
  { from: "host", setting: "data-map", to: "data" },
  { from: "host", setting: "thread-retention", to: "data" },
];

function currentSettingsLink(link: SettingsDeepLink): SettingsDeepLink {
  const moved = MOVED_SETTINGS.find(
    (entry) => entry.from === link.section && entry.setting === link.setting,
  );
  return moved === undefined ? link : { ...link, section: moved.to };
}

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
    ...(props.initialDeepLink === undefined
      ? {}
      : { initialDeepLink: currentSettingsLink(props.initialDeepLink) }),
  });
  const narrow = props.isNarrow === true;
  const contentRef = useRef<HTMLDivElement>(null);
  const previousSection = useRef(route.activeSection);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const navigationClose = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const sectionChanged = previousSection.current !== route.activeSection;
    previousSection.current = route.activeSection;
    // A focused deep link lets SettingRow scroll the requested control into
    // view. Reset only ordinary section changes, so a user never lands halfway
    // down a newly selected Settings page while deep links keep their target.
    if (!sectionChanged || route.focusedSetting !== undefined) return;
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  }, [route.activeSection, route.focusedSetting]);

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
    route.applyDeepLink(currentSettingsLink(pendingDeepLink));
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
        <main className="settings-view__content" ref={contentRef}>
          <div className="settings-view__content-inner">
            <header className="settings-view__header">
              <h1 className="oct-title" id="settings-heading">
                {currentSectionLabel}
              </h1>
              {!hasQuery && SECTION_DESCRIPTIONS[route.activeSection] !== undefined ? (
                <p className="oct-subtitle">{SECTION_DESCRIPTIONS[route.activeSection]}</p>
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
                onOpenSection={route.openSection}
                pluginSettingsEntryPoints={pluginSettingsEntryPoints}
                props={props}
              />
            )}
            {!hasQuery && availableSections.length === 0 ? (
              <p className="settings-view__empty" role="status">
                No settings are available on this host.
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
  readonly onOpenSection: (sectionId: SettingsSectionId) => void;
  readonly pluginSettingsEntryPoints: ReadonlyMap<string, string>;
  readonly props: SettingsViewProps;
  readonly capabilities: SettingsNativeCapabilities;
}

function ActiveSectionContent({
  activeSection,
  focusedSetting,
  onOpenSection,
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
    case "profile":
      return <ProfileSection focusedSetting={focusedSetting} props={props} />;
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
      // Stream replies is this app's own preference, so it stays on the page
      // while the host's Chat defaults are still loading or unreachable.
      return (
        <div className="settings-section-stack" id="settings-chat">
          {props.chatController?.bootstrap === undefined ? null : (
            <ChatSettingsView
              {...(props.chatController.settingsMessage === undefined
                ? {}
                : { message: props.chatController.settingsMessage })}
              onUpdate={props.chatController.updateSettings}
              {...(props.providerController?.snapshot === undefined
                ? {}
                : { providerSnapshot: props.providerController.snapshot })}
              settings={props.chatController.bootstrap.settings}
            />
          )}
          <SettingsSection title="Replies">
            <div className="setgroup">
              <SettingRow
                label="Stream replies"
                description="Show answers as they arrive. Turn off to wait for the finished answer; reasoning stays expandable."
                scope="app"
                settingId="stream-replies"
                focused={focusedSetting === settingId("stream-replies")}
              >
                <OctantSwitch
                  label="Stream replies"
                  checked={props.settings.streamReplies !== false}
                  onCheckedChange={(checked) => props.onSettingsChange({ streamReplies: checked })}
                />
              </SettingRow>
            </div>
          </SettingsSection>
        </div>
      );
    case "code":
      return (
        <div className="settings-code-stack" id="settings-code">
          {props.codeController?.bootstrap === undefined ? null : (
            <CodeSettingsView
              focusedSetting={focusedSetting}
              onUpdate={props.codeController.updateSettings}
              settings={props.codeController.bootstrap.settings}
            />
          )}
          <OpenInApplicationSettings
            applications={props.settings.openInApplications}
            {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
            onChange={(openInApplications) => props.onSettingsChange({ openInApplications })}
          />
          <SettingsSection title="Sidebar">
            <div className="setgroup">
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
            </div>
          </SettingsSection>
        </div>
      );
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
    case "voice":
      return (
        <VoiceSettingsView
          focusedSetting={focusedSetting}
          onSettingsChange={props.onSettingsChange}
          onOpenProviders={() => onOpenSection("providers")}
          {...(props.providerController?.snapshot === undefined
            ? {}
            : { providerSnapshot: props.providerController.snapshot })}
          settings={props.settings.voice}
        />
      );
    case "image-generation":
      return (
        <ImageGenerationSettingsView
          onSettingsChange={props.onSettingsChange}
          onOpenProviders={() => onOpenSection("providers")}
          {...(props.providerController?.snapshot === undefined
            ? {}
            : { providerSnapshot: props.providerController.snapshot })}
          {...(props.providerController === undefined
            ? {}
            : { providerController: props.providerController })}
          settings={props.settings.imageGeneration}
        />
      );
    case "computer-use":
      return (
        <ComputerUseSettingsView
          settings={props.settings.computerUse}
          onSettingsChange={props.onSettingsChange}
          {...(props.hostBridge === undefined ? {} : { bridge: props.hostBridge })}
        />
      );
    case "providers":
      return props.providerController !== undefined ? (
        <ProvidersSection
          discoveryController={props.discoveryController}
          {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
          providerController={props.providerController}
        />
      ) : null;
    case "harness":
      // Everything the Octant Harness decides lives on this one page: which
      // model does which job, and whether its model may start helper agents
      // (the one place the creation posture's Ask and Automatic differ).
      return (
        <div className="settings-section-stack" id="settings-harness">
          {props.nativeHarnessClient === undefined ? null : (
            <>
              <p className="native-harness-panel__lead">
                Models connected through API keys or local endpoints appear under{" "}
                <strong>Octant</strong> in the model picker. Assign models to roles below.
              </p>
              <NativeHarnessRoutingPanel
                client={props.nativeHarnessClient}
                hostId={LOCAL_HOST_ID}
                onOpenProviders={() => onOpenSection("providers")}
                providers={nativeHarnessProviderOptions(props.providerController)}
              />
            </>
          )}
          {props.agentRunSettingsClient === undefined ? null : (
            <AgentRunSettingsPanel client={props.agentRunSettingsClient} />
          )}
        </div>
      );
    case "usage":
      return props.usageClient !== undefined ? (
        <UsageSettingsSection
          client={props.usageClient}
          {...(props.isNarrow === undefined ? {} : { isNarrow: props.isNarrow })}
          {...(props.localUsageHistoryClient === undefined
            ? {}
            : { historyClient: props.localUsageHistoryClient })}
          {...(props.providerUsageLimitsClient === undefined
            ? {}
            : {
                limits: (
                  <ProviderUsageLimitsPanel
                    client={props.providerUsageLimitsClient}
                    instances={props.providerController?.instances ?? []}
                  />
                ),
              })}
        />
      ) : null;
    case "remote-access": {
      const administration = remoteAccessAdministrationOf(props.hostBridge);
      return administration !== undefined ? (
        <RemoteAccessSettingsSection bridge={administration} />
      ) : (
        <section aria-label="Remote access" id="settings-remote-access">
          <p>
            Enabling the remote listener and pairing devices happen on the host machine, in the
            Octant desktop app or with the <code>octant pair</code> and <code>octant auth</code>{" "}
            commands.
          </p>
        </section>
      );
    }
    case "host": {
      const maintenance = (
        <MaintenanceSection
          capabilities={capabilities}
          focusedSetting={focusedSetting}
          props={props}
          {...(props.diagnosticsExportClient === undefined
            ? {}
            : { diagnosticsExportClient: props.diagnosticsExportClient })}
        />
      );
      return props.hostControlClient !== undefined ? (
        <HostSettingsSection
          client={props.hostControlClient}
          {...(props.automationNotificationClient === undefined
            ? {}
            : { automationNotifications: props.automationNotificationClient })}
          {...(props.hostFederationLifecycle === undefined
            ? {}
            : { hostFederationLifecycle: props.hostFederationLifecycle })}
          maintenance={maintenance}
          {...(focusedSetting === undefined ? {} : { focusedSetting })}
        />
      ) : (
        <section aria-label="Host" className="settings-section-stack" id="settings-host">
          <p>Host lifecycle controls are available on the host machine only.</p>
          {props.hostFederationLifecycle === undefined ? null : (
            <FederatedHostsLifecyclePanel lifecycle={props.hostFederationLifecycle} />
          )}
          {maintenance}
        </section>
      );
    }
    case "data":
      return props.hostControlClient !== undefined ? (
        <HostDataSettingsSection
          client={props.hostControlClient}
          {...(focusedSetting === undefined ? {} : { focusedSetting })}
        />
      ) : (
        <section aria-label="Data & privacy" id="settings-data">
          <p>Backup, recovery, and retention controls are available on the host machine only.</p>
        </section>
      );
    case "skills":
      // Marketplace fetches is this host's own switch, so it stays reachable
      // while the extension catalog is loading or unavailable.
      return (
        <div className="settings-section-stack" id="settings-skills">
          {props.extensionClient === undefined ? null : (
            <ExtensionsSettingsView
              client={props.extensionClient}
              marketplaceFetchesEnabled={props.settings.marketplaceFetchesEnabled}
              showHeading={false}
              {...(props.pickLocalPluginFolder === undefined
                ? {}
                : { pickLocalPluginFolder: props.pickLocalPluginFolder })}
            />
          )}
          <MarketplaceSection focusedSetting={focusedSetting} props={props} />
        </div>
      );
    default:
      return null;
  }
}

function ProvidersSection(props: {
  readonly providerController: ProviderController;
  readonly discoveryController: DiscoveryController | undefined;
  readonly hostBridge?: OctantHostBridge;
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
        presentationObservedByInstance={props.providerController.presentationObservedByInstance}
        onOpenExternalUrl={(url) => openExternalUrl(props.hostBridge, url)}
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
        onChangeFxConfiguration={props.providerController.changeFxConfiguration}
        onChangeOpenAiCompatibleConfiguration={
          props.providerController.changeOpenAiCompatibleConfiguration
        }
        onChangeOpenAiImageConfiguration={props.providerController.changeOpenAiImageConfiguration}
        onChangeGeminiImageConfiguration={props.providerController.changeGeminiImageConfiguration}
        onChangeBflImageConfiguration={props.providerController.changeBflImageConfiguration}
        onChangeIdeogramImageConfiguration={
          props.providerController.changeIdeogramImageConfiguration
        }
        onChangeAnthropicCompatibleConfiguration={
          props.providerController.changeAnthropicCompatibleConfiguration
        }
        onChangeAzureFoundryConfiguration={props.providerController.changeAzureFoundryConfiguration}
        onClearProviderCredential={props.providerController.clearProviderCredential}
        onBeginProviderAuthentication={props.providerController.beginProviderAuthentication}
        onCompleteProviderAuthentication={props.providerController.completeProviderAuthentication}
        onUpdateProviderCli={props.providerController.updateProviderCli}
        onCreate={props.providerController.create}
        onCreateClaude={props.providerController.createClaude}
        onCreateMistralVibe={props.providerController.createMistralVibe}
        onCreateGrok={props.providerController.createGrok}
        onCreateGlm={props.providerController.createGlm}
        onCreateGemini={props.providerController.createGemini}
        onCreateCline={props.providerController.createCline}
        onCreateQwen={props.providerController.createQwen}
        onCreateFx={props.providerController.createFx}
        onCreateOllama={props.providerController.createOllama}
        onCreateOpenAiCompatible={props.providerController.createOpenAiCompatible}
        onCreateAnthropicCompatible={props.providerController.createAnthropicCompatible}
        onCreateAzureFoundry={props.providerController.createAzureFoundry}
        onCreateOpenAiImage={props.providerController.createOpenAiImage}
        onCreateGeminiImage={props.providerController.createGeminiImage}
        onCreateBflImage={props.providerController.createBflImage}
        onCreateIdeogramImage={props.providerController.createIdeogramImage}
        onPermissionPersistenceChange={props.providerController.updatePermissionPersistence}
        onProbe={props.providerController.probe}
        onProviderOrderChange={props.providerController.updateProviderOrder}
        onAgentEligibleModelsChange={props.providerController.updateAgentEligibleModels}
        onHiddenModelsChange={props.providerController.updateHiddenModels}
        onVerifyFoundryTools={props.providerController.verifyFoundryTools}
        onProviderCredentialStatus={props.providerController.providerCredentialStatus}
        onRemove={props.providerController.remove}
        onRename={props.providerController.rename}
        onRetry={props.providerController.retry}
        onSetEnabled={props.providerController.setEnabled}
        onDataTagsChange={props.providerController.setDataTags}
        onModelDataTagsChange={props.providerController.setModelDataTags}
        probingIds={props.providerController.probingIds}
        updatingIds={props.providerController.updatingIds}
        status={props.providerController.status}
      />
    </div>
  );
}

interface SectionProps {
  readonly focusedSetting: SettingsSettingId | undefined;
  readonly props: SettingsViewProps;
}

const COMPLETED_THREAD_ARCHIVE_CHOICES: ReadonlyArray<number> = [1, 3, 7, 14, 30, 90];

/**
 * The window before a completed thread is archived, as a short list of
 * choices plus Never. A value chosen elsewhere that the list lacks is still
 * shown as itself rather than snapping to the nearest choice.
 */
function CompletedThreadArchiveSelect(props: {
  readonly afterDays: number | null;
  readonly onChange: (afterDays: number | null) => void;
}) {
  const days =
    props.afterDays === null || COMPLETED_THREAD_ARCHIVE_CHOICES.includes(props.afterDays)
      ? COMPLETED_THREAD_ARCHIVE_CHOICES
      : [...COMPLETED_THREAD_ARCHIVE_CHOICES, props.afterDays].sort((left, right) => left - right);
  return (
    <OctantSelectField
      aria-label="Archive completed threads"
      id="completed-thread-archive"
      onValueChange={(value) => props.onChange(value === "never" ? null : Number(value))}
      options={[
        { id: "never", label: "Never" },
        ...days.map((count) => ({
          id: String(count),
          label: count === 1 ? "After 1 day" : `After ${String(count)} days`,
        })),
      ]}
      value={props.afterDays === null ? "never" : String(props.afterDays)}
    />
  );
}

function ProfileSection({ focusedSetting, props }: SectionProps) {
  return (
    <section aria-label="Profile" className="settings-section-stack" id="settings-profile">
      <SettingsSection title="Your identity">
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
        </div>
      </SettingsSection>
    </section>
  );
}

function GeneralSection({ focusedSetting, props }: SectionProps) {
  return (
    <section aria-label="General" className="settings-section-stack" id="settings-general">
      <SettingsSection title="Available modes">
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
      </SettingsSection>
      <SettingsSection
        description="Octant updates itself only when you ask it to, and never while work is running."
        title="Updates"
      >
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
      </SettingsSection>
      <SettingsSection title="Files">
        <div className="setgroup">
          <SettingRow
            description="Where Work and Code threads started without a Project keep their files, and where artifact files are mirrored unless a Project says otherwise."
            focused={focusedSetting === settingId("default-folder")}
            label="Default folder"
            scope="host"
            settingId="default-folder"
          >
            <DefaultFolderSettings
              folder={props.settings.defaultFolder}
              onFolderChange={(folder) => props.onSettingsChange({ defaultFolder: folder })}
            />
          </SettingRow>
        </div>
      </SettingsSection>
      <SettingsSection title="Threads">
        <div className="setgroup">
          <SettingRow
            description="A completed thread rests in its shelf, then moves to the archive. Archiving keeps everything."
            focused={focusedSetting === settingId("completed-thread-archive")}
            label="Archive completed threads"
            scope="host"
            settingId="completed-thread-archive"
          >
            <CompletedThreadArchiveSelect
              afterDays={props.settings.completedThreadArchiveAfterDays}
              onChange={(afterDays) =>
                props.onSettingsChange({ completedThreadArchiveAfterDays: afterDays })
              }
            />
          </SettingRow>
        </div>
      </SettingsSection>
    </section>
  );
}

/**
 * Whether catalog search may reach third-party registries. It lived in
 * General, but the only thing it changes is Skills & Extensions, which sent
 * its readers back to General to find it.
 */
function MarketplaceSection({ focusedSetting, props }: SectionProps) {
  return (
    <SettingsSection title="Marketplace">
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
    </SettingsSection>
  );
}

function KeybindingsSection({ focusedSetting }: Pick<SectionProps, "focusedSetting">) {
  return (
    <section aria-label="Keybindings" className="settings-section-stack" id="settings-keybindings">
      <SettingsSection title="Keyboard shortcuts">
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
      </SettingsSection>
    </section>
  );
}

interface AppearanceSectionProps extends SectionProps {
  readonly capabilities: SettingsNativeCapabilities;
}

function AppearanceSection({ focusedSetting, props, capabilities }: AppearanceSectionProps) {
  const theme = props.themeController?.draft ?? props.themeController?.settings;
  const resolvedBackground = theme === undefined ? undefined : resolveAppBackground(theme);
  const sidebarDecorationSuspended =
    resolvedBackground !== undefined &&
    resolvedBackground.kind !== "none" &&
    resolvedBackground.coversSidebar;
  const isAvailable = (id: string) =>
    isSettingAvailable(findSetting(APPEARANCE_SECTION(), settingId(id))!, capabilities);
  const sidebarBackground =
    props.themeController?.draft?.sidebarBackground ?? props.settings.sidebarBackground;
  // One control for what used to be two: a Translucent sidebar switch and a
  // Vibrancy mode select that read and wrote the same material.
  const glass: SidebarVibrancyMode =
    props.settings.sidebarMaterial === "system" ? sidebarBackground.vibrancyMode : "off";
  return (
    <section aria-label="Appearance" className="settings-section-stack" id="settings-appearance">
      {props.themeController !== undefined ? (
        <ThemeAppearanceEditor
          controller={props.themeController}
          {...(focusedSetting === undefined ? {} : { focusedSetting })}
        />
      ) : null}
      <SettingsSection title="Window">
        <div className="setgroup">
          {isAvailable("sidebar-material") ? (
            <SettingRow
              description="The frosted material behind the sidebar and around the cards. Off paints it solid."
              focused={focusedSetting === settingId("sidebar-material")}
              label="Glass"
              scope="app"
              settingId="sidebar-material"
            >
              <OctantToggleGroup<SidebarVibrancyMode>
                aria-label="Glass"
                onValueChange={(value) => {
                  const selected = value[0];
                  if (selected === undefined) return;
                  props.onSettingsChange({
                    sidebarMaterial: selected === "off" ? "opaque" : "system",
                  });
                  if (selected === sidebarBackground.vibrancyMode) return;
                  const next = { ...sidebarBackground, vibrancyMode: selected };
                  if (props.themeController !== undefined) {
                    void props.themeController.applyPatch({ sidebarBackground: next });
                  } else {
                    props.onSettingsChange({ sidebarBackground: next });
                  }
                }}
                value={[glass]}
              >
                <OctantToggleGroupItem value="off">Off</OctantToggleGroupItem>
                <OctantToggleGroupItem value="subtle">Subtle</OctantToggleGroupItem>
                <OctantToggleGroupItem value="strong">Strong</OctantToggleGroupItem>
              </OctantToggleGroup>
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
              description="Let the glass show through the cards as well."
              focused={focusedSetting === settingId("workspace-material")}
              label="Glass cards"
              scope="app"
              settingId="workspace-material"
            >
              <OctantSwitch
                checked={props.settings.workspaceMaterial === "system" && glass !== "off"}
                describedBy="workspace-material-description"
                disabled={glass === "off"}
                label="Glass cards"
                onCheckedChange={(checked) => {
                  props.onSettingsChange({ workspaceMaterial: checked ? "system" : "opaque" });
                }}
              />
              {glass === "off" ? (
                <p className="settings-view__effective-note" id="workspace-material-effective-note">
                  Turn on Glass first.
                </p>
              ) : null}
            </SettingRow>
          ) : null}
        </div>
      </SettingsSection>
      {isAvailable("app-background") || isAvailable("sidebar-background") ? (
        <SettingsSection className="settings-app-background" title="Background">
          {isAvailable("app-background") && props.themeController !== undefined ? (
            <>
              <AppBackgroundSettings
                background={
                  (props.themeController.draft ?? props.themeController.settings)?.appBackground ??
                  DEFAULT_APP_BACKGROUND
                }
                focused={focusedSetting === settingId("app-background")}
                increasedContrast={
                  (props.themeController.draft ?? props.themeController.settings)
                    ?.increasedContrast === true
                }
                library={props.backgroundImageLibrary}
                onChange={(appBackground) => {
                  void props.themeController?.applyPatch({ appBackground });
                }}
              />
            </>
          ) : null}
          <div className="setgroup">
            {isAvailable("sidebar-background") ? (
              <SettingRow
                description="A preset gradient behind the sidebar, or none. Adjust the overlay color and opacity for readability."
                focused={focusedSetting === settingId("sidebar-background")}
                label="Sidebar background"
                scope="app"
                settingId="sidebar-background"
              >
                <SidebarBackgroundSettings
                  suspended={sidebarDecorationSuspended}
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
                />
              </SettingRow>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
      <SettingsSection title="Sidebar">
        <div className="setgroup">
          {isAvailable("sidebar-width") ? (
            <SettingRow
              focused={focusedSetting === settingId("sidebar-width")}
              label="Sidebar width"
              scope="app"
              settingId="sidebar-width"
            >
              <SliderField
                aria-label="Sidebar width"
                className="settings-view__range"
                // A width saved by dragging the sidebar's edge is fractional, and
                // the read-out showed all of it: "357.890625px".
                format={(value) => `${String(Math.round(value))}px`}
                max={420}
                min={220}
                onChange={(event) =>
                  props.onSettingsChange({ sidebarWidth: Number(event.currentTarget.value) })
                }
                value={props.settings.sidebarWidth}
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-destinations") ? (
            <SettingRow
              description="Choose which destinations appear in the sidebar, where they live, and in what order."
              focused={focusedSetting === settingId("sidebar-destinations")}
              label="Sidebar destinations"
              scope="app"
              settingId="sidebar-destinations"
            >
              <SidebarDestinationSettings
                customization={props.settings.sidebarDestinations}
                onChange={(sidebarDestinations) => props.onSettingsChange({ sidebarDestinations })}
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-more") ? (
            <SettingRow
              description="Reveal the menu-only destinations and Customize sidebar under a More row at the end of the sidebar navigation. Off keeps them in the account menu."
              focused={focusedSetting === settingId("sidebar-more")}
              label="More row in the sidebar"
              scope="app"
              settingId="sidebar-more"
            >
              <OctantSwitch
                checked={props.settings.sidebarMoreEnabled}
                describedBy="sidebar-more-description"
                label="More row in the sidebar"
                onCheckedChange={(checked) =>
                  props.onSettingsChange({ sidebarMoreEnabled: checked })
                }
              />
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
        </div>
      </SettingsSection>
      <SettingsSection
        description="Choose which facts a thread row in the sidebar shows. A hidden property is omitted rather than left as a gap."
        title="Sidebar thread rows"
      >
        <SettingGroup label="Projects rows">
          {isAvailable("sidebar-projects-branch") ? (
            <SettingRow
              description="Show the branch or worktree a thread works in."
              focused={focusedSetting === settingId("sidebar-projects-branch")}
              label="Branch"
              scope="app"
              settingId="sidebar-projects-branch"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.projects.branch}
                label="Branch on Projects rows"
                onCheckedChange={(branch) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      projects: { ...props.settings.sidebarRowProperties.projects, branch },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-projects-pull-request") ? (
            <SettingRow
              description="Show the number and state of a thread's linked pull request."
              focused={focusedSetting === settingId("sidebar-projects-pull-request")}
              label="Pull request"
              scope="app"
              settingId="sidebar-projects-pull-request"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.projects.pullRequest}
                label="Pull request on Projects rows"
                onCheckedChange={(pullRequest) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      projects: {
                        ...props.settings.sidebarRowProperties.projects,
                        pullRequest,
                      },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-projects-last-updated") ? (
            <SettingRow
              description="Show how long ago a thread last moved."
              focused={focusedSetting === settingId("sidebar-projects-last-updated")}
              label="Last updated"
              scope="app"
              settingId="sidebar-projects-last-updated"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.projects.lastUpdated}
                label="Last updated on Projects rows"
                onCheckedChange={(lastUpdated) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      projects: {
                        ...props.settings.sidebarRowProperties.projects,
                        lastUpdated,
                      },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-projects-status") ? (
            <SettingRow
              description="Show a thread's working, waiting, or unread mark."
              focused={focusedSetting === settingId("sidebar-projects-status")}
              label="Status"
              scope="app"
              settingId="sidebar-projects-status"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.projects.status}
                label="Status on Projects rows"
                onCheckedChange={(status) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      projects: { ...props.settings.sidebarRowProperties.projects, status },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
        </SettingGroup>
        <SettingGroup label="Activity rows">
          {isAvailable("sidebar-activity-project") ? (
            <SettingRow
              description="Show the Project a thread belongs to."
              focused={focusedSetting === settingId("sidebar-activity-project")}
              label="Project"
              scope="app"
              settingId="sidebar-activity-project"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.activity.project}
                label="Project on Activity rows"
                onCheckedChange={(project) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      activity: { ...props.settings.sidebarRowProperties.activity, project },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-activity-branch") ? (
            <SettingRow
              description="Show the branch or worktree a thread works in."
              focused={focusedSetting === settingId("sidebar-activity-branch")}
              label="Branch"
              scope="app"
              settingId="sidebar-activity-branch"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.activity.branch}
                label="Branch on Activity rows"
                onCheckedChange={(branch) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      activity: { ...props.settings.sidebarRowProperties.activity, branch },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-activity-pull-request") ? (
            <SettingRow
              description="Show the number and state of a thread's linked pull request."
              focused={focusedSetting === settingId("sidebar-activity-pull-request")}
              label="Pull request"
              scope="app"
              settingId="sidebar-activity-pull-request"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.activity.pullRequest}
                label="Pull request on Activity rows"
                onCheckedChange={(pullRequest) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      activity: {
                        ...props.settings.sidebarRowProperties.activity,
                        pullRequest,
                      },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-activity-last-updated") ? (
            <SettingRow
              description="Show how long ago a thread last moved."
              focused={focusedSetting === settingId("sidebar-activity-last-updated")}
              label="Last updated"
              scope="app"
              settingId="sidebar-activity-last-updated"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.activity.lastUpdated}
                label="Last updated on Activity rows"
                onCheckedChange={(lastUpdated) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      activity: {
                        ...props.settings.sidebarRowProperties.activity,
                        lastUpdated,
                      },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
          {isAvailable("sidebar-activity-status") ? (
            <SettingRow
              description="Show a thread's working, waiting, or unread mark."
              focused={focusedSetting === settingId("sidebar-activity-status")}
              label="Status"
              scope="app"
              settingId="sidebar-activity-status"
            >
              <OctantSwitch
                checked={props.settings.sidebarRowProperties.activity.status}
                label="Status on Activity rows"
                onCheckedChange={(status) =>
                  props.onSettingsChange({
                    sidebarRowProperties: {
                      ...props.settings.sidebarRowProperties,
                      activity: { ...props.settings.sidebarRowProperties.activity, status },
                    },
                  })
                }
              />
            </SettingRow>
          ) : null}
        </SettingGroup>
      </SettingsSection>
      <SettingsSection title="Reading">
        <div className="setgroup">
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
        </div>
      </SettingsSection>
      {props.themeController === undefined ? null : (
        <SettingsSection
          description="Return every appearance setting to its default."
          title="Reset"
        >
          <div className="setgroup">
            {/* The section says Reset and its note says what returns to its
                default, so the row and its button each said "Reset appearance"
                a second and third time. */}
            <SettingRow
              focused={focusedSetting === settingId("reset-appearance")}
              label="Appearance"
              scope="app"
              settingId="reset-appearance"
            >
              <OctantButton
                className="settings-view__action"
                onClick={() => void props.themeController?.reset()}
                size="sm"
                type="button"
                variant="secondary"
              >
                Reset
              </OctantButton>
            </SettingRow>
          </div>
        </SettingsSection>
      )}
    </section>
  );
}

interface MaintenanceSectionProps extends SectionProps {
  readonly capabilities: SettingsNativeCapabilities;
  readonly diagnosticsExportClient?: DiagnosticsExportClient;
}

/**
 * Usage has two honest answers and this page owes the reader the useful one
 * first.
 *
 * The Octant ledger counts what this host recorded, and states plainly that it
 * has no pricing metadata, so it can never say what anything cost. The
 * provider history reads what the installed providers wrote down themselves,
 * which does carry cost, a daily series, and a per-model share. The cost view
 * was reachable only from a per-thread link, so the page a person opens from
 * the account menu was the one that structurally cannot answer "what am I
 * spending". It leads now, and the ledger stays one toggle away.
 */
function UsageSettingsSection(props: {
  readonly client: UsageClient;
  readonly historyClient?: LocalUsageHistoryClient;
  readonly isNarrow?: boolean;
  readonly limits?: ReactNode;
}) {
  const [source, setSource] = useState<"provider" | "octant">(
    props.historyClient === undefined ? "octant" : "provider",
  );
  const sourceControl =
    props.historyClient === undefined ? undefined : (
      <OctantToggleGroup<"provider" | "octant">
        aria-label="Usage source"
        value={[source]}
        onValueChange={(values) => {
          const next = values[0];
          if (next !== undefined) setSource(next);
        }}
      >
        <OctantToggleGroupItem value="provider">Provider history</OctantToggleGroupItem>
        <OctantToggleGroupItem value="octant">Octant records</OctantToggleGroupItem>
      </OctantToggleGroup>
    );
  return (
    <div className="settings-usage-stack" id="settings-usage">
      {source === "provider" && props.historyClient !== undefined ? (
        <ProviderUsageHistoryWorkspace
          client={props.historyClient}
          embedded
          sourceControl={sourceControl}
          {...(props.limits === undefined ? {} : { limits: props.limits })}
        />
      ) : (
        <>
          {sourceControl}
          <UsageDashboard
            client={props.client}
            {...(props.isNarrow === undefined ? {} : { isNarrow: props.isNarrow })}
            showHeading={false}
          />
          {props.limits}
        </>
      )}
    </div>
  );
}

/** Layout resets and the diagnostics bundle, at the end of the Host page. */
function MaintenanceSection({
  focusedSetting,
  props,
  capabilities,
  diagnosticsExportClient,
}: MaintenanceSectionProps) {
  const resetBoundsAvailable = isSettingAvailable(
    findSetting(HOST_SECTION(), settingId("reset-window-bounds"))!,
    capabilities,
  );
  return (
    <section aria-label="Maintenance" id="settings-maintenance">
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
  readonly suspended: boolean;
  readonly background: SidebarBackground;
  readonly onSettingsChange: (patch: Partial<ShellSettings>) => void;
}

/**
 * The gradient behind the sidebar. Its material (Off, Subtle, Strong) is the
 * Glass control, and there is no Custom choice: nothing in the app uploads a
 * sidebar image, so choosing Custom did nothing and pointed at a picker that
 * does not exist. A background already stored as custom still renders; it
 * reads as None here until another choice replaces it.
 */
function SidebarBackgroundSettings({
  suspended,
  background,
  onSettingsChange,
}: SidebarBackgroundSettingsProps) {
  const setBackground = (next: SidebarBackground) => {
    onSettingsChange({ sidebarBackground: next });
  };

  return (
    <div className="settings-view__setting">
      {suspended ? (
        <p className="settings-view__hint">
          Workspace background covers the sidebar. Turn off Cover the sidebar to use these saved
          settings.
        </p>
      ) : null}
      <label className="settings-view__field">
        <span>Background type</span>
        <OctantSelectField
          aria-label="Sidebar background type"
          disabled={suspended}
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
            }
          }}
          options={[
            { id: "none", label: "None" },
            { id: "preset", label: "Preset" },
          ]}
          value={background.kind === "preset" ? "preset" : "none"}
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
                  disabled={suspended}
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
                >
                  {selected ? (
                    <span aria-hidden="true" className="settings-view__selection-mark">
                      <Check size={14} strokeWidth={2} />
                    </span>
                  ) : null}
                </OctantButton>
              );
            })}
          </div>
        </div>
      ) : null}
      <label className="settings-view__field">
        <span>Overlay color</span>
        <OctantInput
          aria-label="Sidebar overlay color"
          disabled={suspended}
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
        <SliderField
          aria-label="Sidebar overlay opacity"
          disabled={suspended}
          className="settings-view__range"
          format={(value) => `${String(value)}%`}
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
