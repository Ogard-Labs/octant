import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain/mode-policy";
import type { ShellSettings, WindowWorkspace } from "@octant/contracts/shell";
import type { ResolvedSidebarBackground } from "@octant/theme/backgrounds";
import { Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { AUTOMATION_CENTER_NAVIGATION_ENABLED } from "../automation/automationCenterGate";
import { OctantButton } from "../ui/base/OctantButton";
import {
  resolveSidebarContributions,
  type FirstPartyPluginComponentId,
} from "./contributionRegistry";
import { IconButton } from "./IconButton";
import { ModeSwitcher } from "./ModeSwitcher";
import { SidebarBackgroundLayer, type BackgroundFetcher } from "./SidebarBackgroundLayer";
import { SidebarNavigation, type SidebarNavigationProps } from "./SidebarNavigation";

/**
 * Stand-in for the server's first-party plugin activation state. Both
 * components are seeded and enabled by default with no toggle UI yet, so
 * this is a constant, not a live query; ADR 0001 step 4 replaces it with a
 * value sourced from the server's plugin gate once the board and GitHub
 * plugins are seeded (see docs/decisions/0001-plugin-architecture.md).
 */
const FIRST_PARTY_PLUGINS_EFFECTIVE: ReadonlyMap<FirstPartyPluginComponentId, boolean> = new Map([
  ["board", true],
  ["github-integration", true],
]);

export interface ShellSidebarProps {
  /**
   * Overrides the Automation Center navigation gate.
   * Defaults to {@link AUTOMATION_CENTER_NAVIGATION_ENABLED}.
   */
  readonly automationsEnabled?: boolean;
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
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
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
  return (
    <aside aria-label="Octant sidebar" className="sidebar" data-octant-sidebar>
      {props.resolvedSidebarBackground !== undefined && props.backgroundFetcher !== undefined ? (
        <SidebarBackgroundLayer
          resolved={props.resolvedSidebarBackground}
          fetcher={props.backgroundFetcher}
        />
      ) : null}
      <div className="sidebar__native-leading">
        <span
          aria-hidden="true"
          className="sidebar__traffic-light-space"
          data-traffic-light-safe-space
        />
        <span aria-hidden="true" className="sidebar__drag-surface window-drag-region" />
      </div>
      <div className="sidebar__content window-no-drag" data-octant-sidebar-content>
        <ModeSwitcher
          actions={
            <>
              <IconButton
                data-navigation-id="search"
                icon={Search}
                label="Search"
                onClick={props.onOpenSearch}
                title="Search ⌘K"
              />
              <span className="sidebar__chrome-activity" data-octant-sidebar-chrome-actions />
            </>
          }
          activeMode={props.workspace.activeMode}
          modes={modes}
          onSelectMode={props.onSelectMode}
          presentation={props.settings.modeSwitcherPresentation}
        />
        <SidebarNavigation
          actions={{
            ...(chatReady ? props.chatNavigation.actions : {}),
            ...codeActions,
            ...workActions,
          }}
          input={{
            activeMode,
            // Gated by A3/A4 integration: never expose a dead Automations destination.
            automationsEnabled: props.automationsEnabled ?? AUTOMATION_CENTER_NAVIGATION_ENABLED,
            createThread:
              chatReady ||
              codeActions["new-code-thread"] !== undefined ||
              workActions["new-work-thread"] !== undefined
                ? "available"
                : "unavailable",
            plugins: "available",
            projects: "available",
            pullRequests:
              codeActions["pull-requests"] === undefined ||
              !sidebarContributions.has("pull-requests")
                ? "unavailable"
                : "available",
            threadBoard:
              (codeActions["thread-board"] !== undefined ||
                workActions["thread-board"] !== undefined) &&
              sidebarContributions.has("thread-board")
                ? "available"
                : "unavailable",
          }}
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
              <OctantButton onClick={props.onOpenSettings} type="button" variant="ghost">
                Open Chat settings
              </OctantButton>
            )}
          </div>
        )}
        <OctantButton
          className="sidebar__utility sidebar__utility--settings justify-start"
          onClick={props.onOpenSettings}
          type="button"
          variant="ghost"
        >
          <Settings aria-hidden="true" size={14} strokeWidth={1.7} />
          <span>Settings</span>
        </OctantButton>
      </div>
    </aside>
  );
}
