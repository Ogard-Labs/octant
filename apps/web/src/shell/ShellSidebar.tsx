import type { EnvironmentSelection } from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { EnvironmentFilter } from "./EnvironmentFilter";
import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain/mode-policy";
import type { SettingsDeepLink } from "@octant/contracts";
import type { ShellSettings, WindowWorkspace } from "@octant/contracts/shell";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import type { ResolvedSidebarBackground } from "@octant/theme/backgrounds";
import { PanelLeftClose, Search } from "lucide-react";
import type { ReactNode } from "react";
import { AUTOMATION_CENTER_NAVIGATION_ENABLED } from "../automation/automationCenterGate";
import { AGENTS_CENTER_NAVIGATION_ENABLED } from "../agents/agentsCenterGate";
import { OctantButton } from "../ui/base/OctantButton";
import { FIRST_PARTY_PLUGINS_EFFECTIVE, resolveSidebarContributions } from "./contributionRegistry";
import { IconButton } from "./IconButton";
import { ModeSwitcher } from "./ModeSwitcher";
import { SidebarBackgroundLayer, type BackgroundFetcher } from "./SidebarBackgroundLayer";
import { SidebarProfile } from "./SidebarProfile";
import { SidebarNavigation, type SidebarNavigationProps } from "./SidebarNavigation";
import { buildSidebarAppMenu, type SidebarNavigationInput } from "./navigationModel";

export interface ShellSidebarProps {
  /**
   * Overrides the Automation Center navigation gate.
   * Defaults to {@link AUTOMATION_CENTER_NAVIGATION_ENABLED}.
   */
  readonly automationsEnabled?: boolean;
  readonly agentsCenterEnabled?: boolean;
  /** Absent on a host that serves no library, which keeps the row off entirely. */
  readonly artifactLibraryAvailable?: boolean;
  /**
   * The connected hosts this window gathers from, and which one is this
   * machine. Absent on a window with no federation, which hides the filter
   * rather than offering a menu with one row in it.
   */
  readonly environments?: {
    readonly hostStates: ReadonlyArray<FederatedHostState>;
    readonly selection: EnvironmentSelection;
    readonly localHostId?: string;
    readonly onSelectionChange: (next: EnvironmentSelection) => void;
  };
  readonly chatErrorMessage?: string;
  /**
   * Mode navigation is actions only. Thread rows for every mode are rendered by
   * `projectSection`, which groups them under their Project; a second list here
   * would show the same threads twice.
   */
  readonly chatNavigation?: Pick<SidebarNavigationProps, "actions">;
  readonly chatStatus?: "loading" | "disconnected" | "conflict-reload";
  readonly codeNavigation?: {
    readonly actions: SidebarNavigationProps["actions"];
  };
  readonly workNavigation?: {
    readonly actions: SidebarNavigationProps["actions"];
  };
  readonly onAddFolder: () => void;
  readonly onOpenArchive?: () => void;
  readonly onOpenNavigator: () => void;
  /** Absent until Navigator has a model, so the profile menu does not advertise it. */
  readonly navigatorAvailable?: boolean;
  readonly nativeHost?: boolean;
  readonly onOpenSettings: (deepLink?: SettingsDeepLink) => void;
  /** Opens the App-level thread Search overlay. */
  readonly onOpenSearch?: () => void;
  /** Absent on a window that cannot enter Zen, which keeps the row off the menu. */
  readonly onOpenZen?: () => void;
  /** Hides the sidebar; the window chrome then offers the matching Show control. */
  readonly onCollapseSidebar?: () => void;
  readonly onRetryChat?: () => void;
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly settings: ShellSettings;
  readonly workspace: WindowWorkspace;
  readonly projectSection: ReactNode;
  readonly resolvedSidebarBackground?: ResolvedSidebarBackground | undefined;
  readonly backgroundFetcher?: BackgroundFetcher | undefined;
}

export function ShellSidebar(props: ShellSidebarProps) {
  const modes = enabledModes(props.settings);
  const activeMode = props.workspace.activeMode;
  const chatReady = activeMode === "chat" && props.chatNavigation !== undefined;
  const codeReady = activeMode === "code" && props.codeNavigation !== undefined;
  const workReady = activeMode === "work" && props.workNavigation !== undefined;
  const codeActions = codeReady ? props.codeNavigation.actions : {};
  const workActions = workReady ? props.workNavigation.actions : {};
  const sidebarContributions = resolveSidebarContributions(
    activeMode,
    FIRST_PARTY_PLUGINS_EFFECTIVE,
  );
  const chatStatusMessage =
    activeMode !== "chat"
      ? undefined
      : (props.chatErrorMessage ??
        (props.chatStatus === "loading"
          ? "Connecting to Chat…"
          : props.chatStatus === "conflict-reload"
            ? "Reloading Chat…"
            : props.chatStatus === "disconnected"
              ? "Chat is disconnected."
              : undefined));
  const navigationActions = {
    ...(chatReady ? props.chatNavigation.actions : {}),
    ...codeActions,
    ...workActions,
  };
  const navigationInput: SidebarNavigationInput = {
    activeMode,
    artifactLibrary: props.artifactLibraryAvailable === false ? "unavailable" : "available",
    automationsEnabled: props.automationsEnabled ?? AUTOMATION_CENTER_NAVIGATION_ENABLED,
    agentsCenterEnabled: props.agentsCenterEnabled ?? AGENTS_CENTER_NAVIGATION_ENABLED,
    createThread:
      chatReady ||
      codeActions["new-code-thread"] !== undefined ||
      workActions["new-work-thread"] !== undefined
        ? "available"
        : "unavailable",
    plugins: "available",
    projects: "available",
    pullRequests:
      codeActions["pull-requests"] === undefined || !sidebarContributions.has("pull-requests")
        ? "unavailable"
        : "available",
    threadBoard:
      (codeActions["thread-board"] !== undefined || workActions["thread-board"] !== undefined) &&
      sidebarContributions.has("thread-board")
        ? "available"
        : "unavailable",
  };
  const secondaryActions = buildSidebarAppMenu(navigationInput).flatMap((descriptor) => {
    const action = navigationActions[descriptor.id];
    return action === undefined ? [] : [{ ...descriptor, onSelect: action }];
  });
  return (
    <aside aria-label="Octant sidebar" className="sidebar" data-octant-sidebar>
      {props.resolvedSidebarBackground !== undefined && props.backgroundFetcher !== undefined ? (
        <SidebarBackgroundLayer
          resolved={props.resolvedSidebarBackground}
          fetcher={props.backgroundFetcher}
        />
      ) : null}
      {props.nativeHost === true ? (
        <div className="sidebar__native-leading">
          <span
            aria-hidden="true"
            className="sidebar__traffic-light-space"
            data-traffic-light-safe-space
          />
          {props.onCollapseSidebar === undefined ? null : (
            <IconButton
              className="sidebar__native-collapse"
              icon={PanelLeftClose}
              label="Hide sidebar"
              onClick={props.onCollapseSidebar}
            />
          )}
          <span aria-hidden="true" className="sidebar__drag-surface window-drag-region" />
        </div>
      ) : null}
      <div className="sidebar__content window-no-drag" data-octant-sidebar-content>
        {props.environments === undefined || props.environments.hostStates.length < 2 ? null : (
          <EnvironmentFilter
            hostStates={props.environments.hostStates}
            {...(props.environments.localHostId === undefined
              ? {}
              : { localHostId: props.environments.localHostId })}
            onSelectionChange={props.environments.onSelectionChange}
            selection={props.environments.selection}
          />
        )}
        <ModeSwitcher
          actions={
            <>
              <span className="sidebar__chrome-activity" data-octant-sidebar-chrome-actions />
              <span className="sidebar__primary-actions">
                <IconButton
                  data-navigation-id="search"
                  icon={Search}
                  label="Search"
                  onClick={props.onOpenSearch}
                />
                {props.nativeHost === true || props.onCollapseSidebar === undefined ? null : (
                  <IconButton
                    className="sidebar__browser-collapse"
                    icon={PanelLeftClose}
                    label="Hide sidebar"
                    onClick={props.onCollapseSidebar}
                  />
                )}
              </span>
            </>
          }
          activeMode={props.workspace.activeMode}
          modes={modes}
          onSelectMode={props.onSelectMode}
          presentation={props.settings.modeSwitcherPresentation}
        />
        <SidebarNavigation
          actions={navigationActions}
          input={navigationInput}
          projectSection={props.projectSection}
        />
        {chatStatusMessage === undefined ? null : (
          <div className="project-nav__status sidebar__chat-status" role="alert">
            <span>{chatStatusMessage}</span>
            {props.chatStatus === "disconnected" ? (
              <OctantButton onClick={props.onRetryChat} type="button" variant="ghost">
                Retry Chat
              </OctantButton>
            ) : null}
            {props.chatErrorMessage === undefined ? null : (
              <OctantButton
                onClick={() => props.onOpenSettings({ section: "chat" })}
                type="button"
                variant="ghost"
              >
                Open Chat settings
              </OctantButton>
            )}
          </div>
        )}
        <SidebarProfile
          navigatorAvailable={props.navigatorAvailable === true}
          {...(props.onOpenArchive === undefined ? {} : { onOpenArchive: props.onOpenArchive })}
          onOpenNavigator={props.onOpenNavigator}
          onOpenSettings={props.onOpenSettings}
          {...(props.onOpenZen === undefined ? {} : { onOpenZen: props.onOpenZen })}
          profile={props.settings?.userProfile ?? defaultShellSettings().userProfile}
          secondaryActions={secondaryActions}
        />
      </div>
    </aside>
  );
}
