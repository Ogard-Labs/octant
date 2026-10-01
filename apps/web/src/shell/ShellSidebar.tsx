import type { EnvironmentSelection } from "@octant/client-runtime/environment-selection";
import type { FederatedHostState } from "@octant/client-runtime";
import { EnvironmentFilter } from "./EnvironmentFilter";
import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain/mode-policy";
import type { SettingsDeepLink } from "@octant/contracts";
import type { ShellSettings, WindowWorkspace } from "@octant/contracts/shell";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import type { ResolvedSidebarBackground } from "@octant/theme/backgrounds";
import { PanelLeftClose, Search, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AUTOMATION_CENTER_NAVIGATION_ENABLED } from "../automation/automationCenterGate";
import { AGENTS_CENTER_NAVIGATION_ENABLED } from "../agents/agentsCenterGate";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  resolveSidebarContributions,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";
import { IconButton } from "./IconButton";
import { ModeSwitcher } from "./ModeSwitcher";
import { SidebarBackgroundLayer, type BackgroundFetcher } from "./SidebarBackgroundLayer";
import { SidebarCountTiles, type SidebarTile } from "./SidebarCountTiles";
import { SidebarRail, type SidebarRailProject } from "./SidebarRail";
import { SidebarMore } from "./SidebarMore";
import { SidebarProfile } from "./SidebarProfile";
import { SidebarNavigation, type SidebarNavigationProps } from "./SidebarNavigation";
import {
  layoutSidebarDestinations,
  sidebarNavigationDescriptor,
  type SidebarNavigationInput,
} from "./navigationModel";

export interface ShellSidebarProps {
  readonly backgroundCoveredByWorkspace?: boolean;
  readonly activeDestination?: SidebarNavigationProps["activeDestination"];
  /**
   * Overrides the Automation Center navigation gate.
   * Defaults to {@link AUTOMATION_CENTER_NAVIGATION_ENABLED}.
   */
  readonly automationsEnabled?: boolean;
  readonly agentsCenterEnabled?: boolean;
  /** Absent on a host that serves no library, which keeps the row off entirely. */
  readonly artifactLibraryAvailable?: boolean;
  readonly imageLibraryAvailable?: boolean;
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
  /** The all-Projects collection shown as a second left sidebar. */
  readonly projectsDirectory?: ReactNode;
  readonly resolvedSidebarBackground?: ResolvedSidebarBackground | undefined;
  readonly backgroundFetcher?: BackgroundFetcher | undefined;
  /** Overrides bundled plugin activation so a disabled GitHub package can hide its rows. */
  readonly firstPartyPluginsEffective?: ReadonlyMap<FirstPartyPluginComponentId, boolean>;
  /** Snapshot `issues-read` availability. Absent or false hides the Issues row. */
  readonly githubIssuesReadAvailable?: boolean;
  /** Threads waiting on the user right now; mirrors the dock badge count. */
  readonly inboxCount?: number;
  /**
   * The current mode's counts for the Running, To review, and Done today
   * tiles, with where each one goes. Absent leaves those tiles out.
   */
  readonly countTiles?: {
    readonly running: number;
    readonly toReview: number;
    readonly doneToday: number;
    readonly onOpenRunning?: () => void;
    readonly onOpenReview?: () => void;
    readonly onOpenDone?: () => void;
  };
  /**
   * The in-place filter over the current mode's thread rows. Absent keeps the
   * Search icon on the command overlay, as before the filter existed.
   */
  readonly threadFilter?: {
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
    /** Enter hands the text to the command overlay, which searches every thread. */
    readonly onSearchEverywhere?: (query: string) => void;
  };
  /**
   * Present while the sidebar is collapsed to its icon rail: the sidebar then
   * draws the rail instead of the full column, from the same destinations,
   * counts, and modes.
   */
  readonly rail?: {
    readonly onExpand: () => void;
    readonly projects: ReadonlyArray<SidebarRailProject>;
    readonly onOpenActivity?: () => void;
  };
}

const NEW_THREAD_DESTINATIONS = new Set(["new-chat", "new-code-thread", "new-work-thread"]);

export function ShellSidebar(props: ShellSidebarProps) {
  const modes = enabledModes(props.settings);
  const searchAlwaysShown = props.settings.sidebarSearchPresentation === "field";
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  const filter = props.threadFilter;
  const filterShown = filter !== undefined && (searchAlwaysShown || searchOpen);
  useEffect(() => {
    if (searchOpen && !searchAlwaysShown) searchField.current?.focus();
  }, [searchOpen, searchAlwaysShown]);
  const closeSearch = () => {
    setSearchOpen(false);
    filter?.onQueryChange("");
  };
  const activeMode = props.workspace.activeMode;
  const chatReady = activeMode === "chat" && props.chatNavigation !== undefined;
  const codeReady = activeMode === "code" && props.codeNavigation !== undefined;
  const workReady = activeMode === "work" && props.workNavigation !== undefined;
  const codeActions = codeReady ? props.codeNavigation.actions : {};
  const workActions = workReady ? props.workNavigation.actions : {};
  const sidebarContributions = resolveSidebarContributions(
    activeMode,
    props.firstPartyPluginsEffective ?? FIRST_PARTY_PLUGINS_EFFECTIVE,
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
    inbox: navigationActions.inbox === undefined ? "unavailable" : "available",
    artifactLibrary: props.artifactLibraryAvailable === false ? "unavailable" : "available",
    imageLibrary: props.imageLibraryAvailable === true ? "available" : "unavailable",
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
    githubIssues:
      codeActions["github-issues"] === undefined ||
      !sidebarContributions.has("github-issues") ||
      props.githubIssuesReadAvailable !== true
        ? "unavailable"
        : "available",
    linearIssues:
      codeActions["linear-issues"] === undefined || !sidebarContributions.has("linear-issues")
        ? "unavailable"
        : "available",
    threadBoard:
      (codeActions["thread-board"] !== undefined || workActions["thread-board"] !== undefined) &&
      sidebarContributions.has("thread-board")
        ? "available"
        : "unavailable",
  };
  const destinationLayout = layoutSidebarDestinations({
    activeMode,
    customization: props.settings.sidebarDestinations,
    input: navigationInput,
    moreEnabled: props.settings.sidebarMoreEnabled,
  });
  // New thread lives in the header now, so its row would say the same thing
  // twice. With the tiles on, Inbox and Board each have a tile that goes
  // where their row went.
  const newThreadId = destinationLayout.rows.find((id) => NEW_THREAD_DESTINATIONS.has(id));
  const newThread = newThreadId === undefined ? undefined : navigationActions[newThreadId];
  const newThreadLabel =
    newThreadId === undefined ? undefined : sidebarNavigationDescriptor(newThreadId).label;
  const tilesShown = props.settings.sidebarCountTiles && props.countTiles !== undefined;
  const destinationRows = destinationLayout.rows.filter(
    (id) =>
      !NEW_THREAD_DESTINATIONS.has(id) &&
      !(tilesShown && (id === "inbox" || id === "thread-board")),
  );
  const boardAction = navigationActions["thread-board"];
  const tiles: ReadonlyArray<SidebarTile> =
    !tilesShown || props.countTiles === undefined
      ? []
      : [
          {
            id: "inbox",
            count: props.inboxCount ?? 0,
            ...(navigationActions.inbox === undefined ? {} : { onSelect: navigationActions.inbox }),
            active: props.activeDestination === "inbox",
          },
          {
            id: "running",
            count: props.countTiles.running,
            ...((props.countTiles.onOpenRunning ?? boardAction) === undefined
              ? {}
              : { onSelect: props.countTiles.onOpenRunning ?? boardAction }),
            active: props.activeDestination === "thread-board",
          },
          {
            id: "review",
            count: props.countTiles.toReview,
            ...(props.countTiles.onOpenReview === undefined
              ? {}
              : { onSelect: props.countTiles.onOpenReview }),
          },
          {
            id: "done",
            count: props.countTiles.doneToday,
            ...(props.countTiles.onOpenDone === undefined
              ? {}
              : { onSelect: props.countTiles.onOpenDone }),
          },
        ];
  const secondaryActions = destinationLayout.menu.flatMap((descriptor) => {
    const action = navigationActions[descriptor.id];
    return action === undefined ? [] : [{ ...descriptor, onSelect: action }];
  });
  const moreActions = destinationLayout.more.flatMap((descriptor) => {
    const action = navigationActions[descriptor.id];
    return action === undefined ? [] : [{ ...descriptor, onSelect: action }];
  });
  if (props.rail !== undefined) {
    return (
      <SidebarRail
        activeMode={activeMode}
        destinations={destinationRows.flatMap((id) => {
          const action = navigationActions[id];
          return id === "projects" || action === undefined
            ? []
            : [
                {
                  id,
                  label: sidebarNavigationDescriptor(id).label,
                  onSelect: action,
                  active: props.activeDestination === id,
                },
              ];
        })}
        modes={modes}
        nativeHost={props.nativeHost === true}
        {...(newThread === undefined || newThreadLabel === undefined
          ? {}
          : { newThread: { label: newThreadLabel, onSelect: () => newThread() } })}
        onExpand={props.rail.onExpand}
        {...(props.rail.onOpenActivity === undefined
          ? {}
          : { onOpenActivity: props.rail.onOpenActivity })}
        {...(navigationActions.projects === undefined
          ? {}
          : { onOpenProjects: navigationActions.projects })}
        {...(props.onOpenSearch === undefined ? {} : { onOpenSearch: props.onOpenSearch })}
        onOpenSettings={() => props.onOpenSettings()}
        onSelectMode={props.onSelectMode}
        projects={props.rail.projects}
        tiles={tiles}
      />
    );
  }
  return (
    <aside
      aria-label="Octant sidebar"
      className={`sidebar${props.projectsDirectory === undefined ? "" : " sidebar--projects"}`}
      data-octant-sidebar
    >
      {props.backgroundCoveredByWorkspace !== true &&
      props.resolvedSidebarBackground !== undefined &&
      props.backgroundFetcher !== undefined ? (
        <SidebarBackgroundLayer
          resolved={props.resolvedSidebarBackground}
          fetcher={props.backgroundFetcher}
        />
      ) : null}
      <div className="sidebar__primary">
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
                <span className="sidebar__primary-actions">
                  {filter === undefined || searchAlwaysShown ? (
                    filter === undefined ? (
                      <IconButton
                        data-navigation-id="search"
                        icon={Search}
                        label="Search"
                        onClick={props.onOpenSearch}
                      />
                    ) : null
                  ) : (
                    <IconButton
                      aria-expanded={searchOpen}
                      data-navigation-id="search"
                      icon={Search}
                      label="Search"
                      onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                    />
                  )}
                  {newThread === undefined || newThreadLabel === undefined ? null : (
                    <IconButton
                      className="sidebar__new-thread"
                      data-navigation-id={newThreadId}
                      icon={SquarePen}
                      label={newThreadLabel}
                      onClick={() => newThread()}
                    />
                  )}
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
          {filterShown && filter !== undefined ? (
            <div className="sidebar-search" role="search">
              <Search
                aria-hidden="true"
                className="sidebar-search__icon"
                size={14}
                strokeWidth={1.8}
              />
              <OctantInput
                aria-label="Filter threads"
                className="sidebar-search__field"
                onChange={(event) => filter.onQueryChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !searchAlwaysShown) {
                    event.preventDefault();
                    closeSearch();
                  } else if (event.key === "Enter" && filter.onSearchEverywhere !== undefined) {
                    event.preventDefault();
                    filter.onSearchEverywhere(filter.query);
                  }
                }}
                placeholder="Filter threads"
                title="Type to filter this list. Enter searches every thread."
                ref={searchField}
                type="search"
                value={filter.query}
              />
              {searchAlwaysShown ? null : (
                <IconButton
                  className="sidebar-search__close"
                  icon={X}
                  label="Close search"
                  onClick={closeSearch}
                />
              )}
            </div>
          ) : null}
          {tiles.length === 0 ? null : <SidebarCountTiles tiles={tiles} />}
          <SidebarNavigation
            {...(props.activeDestination === undefined
              ? {}
              : { activeDestination: props.activeDestination })}
            actions={navigationActions}
            {...(props.inboxCount === undefined || props.inboxCount === 0
              ? {}
              : { counts: { inbox: props.inboxCount } })}
            input={navigationInput}
            {...(moreActions.length === 0
              ? {}
              : {
                  more: (
                    <SidebarMore
                      {...(props.activeDestination === undefined
                        ? {}
                        : { activeDestination: props.activeDestination })}
                      items={moreActions}
                      onCustomizeSidebar={() =>
                        props.onOpenSettings({
                          section: "appearance",
                          setting: "sidebar-destinations",
                        })
                      }
                    />
                  ),
                })}
            projectSection={
              props.projectsDirectory === undefined ? props.projectSection : undefined
            }
            rows={destinationRows}
          />
          {chatStatusMessage === undefined ? null : (
            <div
              className="project-nav__status sidebar__chat-status"
              role={
                props.chatErrorMessage !== undefined || props.chatStatus === "disconnected"
                  ? "alert"
                  : "status"
              }
            >
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
      </div>
      {props.projectsDirectory === undefined ? null : (
        <section aria-label="Projects sidebar" className="sidebar__projects-pane window-no-drag">
          {props.projectsDirectory}
        </section>
      )}
    </aside>
  );
}
