import type { SettingsDeepLink } from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import {
  Archive,
  Blocks,
  Bot,
  CalendarClock,
  ChartNoAxesColumn,
  ChevronUp,
  Compass,
  Images,
  Layers,
  PanelLeft,
  Plug,
  Route,
  Settings,
  Sparkles,
  type IconComponent,
} from "../ui/icons";
import type { ComponentType } from "react";
import { UserAvatar } from "../profile/UserAvatar";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantKbd } from "../ui/base/OctantKbd";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { RAIL_USAGE_LIMIT, useAccountUsage } from "../usage/accountUsage";
import { openGuidedTour } from "../tour/guidedTourState";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import type { SidebarAppMenuDescriptorId } from "./navigationModel";

/**
 * The account control: the rail's face, or the profile row where no rail
 * stands. It stays put, so focus returns to it when a card above it, or a
 * dialog it opened, goes away.
 */
export const SIDEBAR_ACCOUNT_TRIGGER_SELECTOR =
  "[data-octant-sidebar] [aria-label^='Account menu'], [data-octant-sidebar-rail] [aria-label^='Account menu']";

export interface SidebarSecondaryAction {
  readonly id: SidebarAppMenuDescriptorId;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface SidebarProfileProps {
  readonly onOpenArchive?: () => void;
  readonly onOpenNavigator: () => void;
  /** False until Navigator has a host-configured model; the row is then absent. */
  readonly navigatorAvailable?: boolean;
  readonly onOpenSettings: (deepLink?: SettingsDeepLink) => void;
  /** Absent on a window that cannot enter Zen, which keeps the row off entirely. */
  readonly onOpenZen?: () => void;
  readonly profile: UserProfile;
  /** The host's own key for Settings; absent where no key opens it (a browser). */
  readonly settingsShortcut?: string;
  readonly secondaryActions?: ReadonlyArray<SidebarSecondaryAction>;
}

export const secondaryIcons: Record<SidebarAppMenuDescriptorId, IconComponent> = {
  agents: Bot,
  automations: CalendarClock,
  "artifact-library": Layers,
  "image-library": Images,
  plugins: Blocks,
};

/**
 * The person using this host, at the foot of the sidebar.
 *
 * The row names them rather than naming a destination, because the settings it
 * opens are theirs. A profile with no name says so and still opens the menu:
 * refusing to open until a name exists would hide the very place a name is set.
 */
export function SidebarProfile(props: SidebarProfileProps) {
  const label = profileLabel(props.profile);
  return (
    <div className="sidebar-foot sidebar-profile">
      <OctantMenuRoot>
        {/*
          The trigger says what it opens and who for. The label span alone is
          not enough: the compact sidebar clips it, and the accessibility tree
          has reported the row as an unnamed button.
        */}
        <OctantMenuTrigger
          aria-label={`Account menu, ${label}`}
          className="sidebar-item window-no-drag justify-start"
        >
          <UserAvatar profile={props.profile} size={20} />
          <span className="oct-nav-name sidebar-label">{label}</span>
          <ChevronUp aria-hidden="true" className="sidebar-profile__chevron" size={14} />
        </OctantMenuTrigger>
        <AccountMenuPopup {...props} side="top" />
      </OctantMenuRoot>
    </div>
  );
}

/**
 * The same person at the foot of the icon rail: one round face, their picture
 * or initials, opening the account menu that holds Settings. What is left of
 * each plan stands above it as its own rings, so the face says only who.
 */
export function RailAccount(props: SidebarProfileProps) {
  const label = profileLabel(props.profile);
  return (
    <OctantMenuRoot>
      <OctantTooltip align="center" compact label={label} side="right">
        <OctantMenuTrigger
          aria-label={`Account menu, ${label}`}
          className="sidebar-rail__button rail-account window-no-drag"
        >
          <span aria-hidden="true" className="sidebar-rail__face rail-account__face">
            <UserAvatar profile={props.profile} size={24} />
          </span>
        </OctantMenuTrigger>
      </OctantTooltip>
      <AccountMenuPopup {...props} side="right" />
    </OctantMenuRoot>
  );
}

function profileLabel(profile: UserProfile): string {
  const name = profile.displayName ?? "";
  return name === "" ? "Set your name" : name;
}

function AccountMenuPopup(props: SidebarProfileProps & { readonly side: "top" | "right" }) {
  const openZen = props.onOpenZen;
  const usage = useAccountUsage();
  const openUsage = () => props.onOpenSettings({ section: "usage" });
  // The rail's rings already say this; the menu repeats it only where no rail
  // stands, or where the rail has more accounts than it rings.
  const usageLines = props.side === "top" || usage.length > RAIL_USAGE_LIMIT ? usage : [];
  const name = props.profile.displayName ?? "";
  return (
    <OctantMenuPortal>
      <OctantMenuPositioner align={props.side === "right" ? "end" : "start"} side={props.side}>
        <OctantMenuPopup aria-label="Octant menu" className="w-[min(248px,calc(100vw-24px))]">
          <OctantMenuGroup aria-label="Account">
            {/* The rail's face shows no name; the row under a sidebar does. */}
            <OctantMenuGroupLabel>
              <span className="truncate">
                {props.side === "right" && name !== "" ? name : "Account"}
              </span>
            </OctantMenuGroupLabel>
            <ProfileAction
              icon={Settings}
              label="Settings"
              onClick={() => props.onOpenSettings()}
              shortcut={props.settingsShortcut}
            />
            <ProfileAction icon={ChartNoAxesColumn} label="Usage" onClick={openUsage} />
            <ProfileAction
              icon={Plug}
              label="Providers"
              onClick={() => props.onOpenSettings({ section: "providers" })}
            />
            <ProfileAction
              icon={PanelLeft}
              label="Customize sidebar"
              onClick={() =>
                props.onOpenSettings({ section: "appearance", setting: "sidebar-destinations" })
              }
            />
          </OctantMenuGroup>
          <OctantMenuSeparator />
          {usageLines.length === 0 ? null : (
            <>
              <OctantMenuGroup aria-label="Plan usage">
                <OctantMenuGroupLabel>Plan usage</OctantMenuGroupLabel>
                {usageLines.map((line) => (
                  <OctantMenuItem
                    aria-label={`${line.instance.displayName}, ${line.lowest.short} ${line.lowest.standing}`}
                    key={String(line.instance.id)}
                    onClick={openUsage}
                  >
                    <ProviderGlyph
                      className="icon"
                      displayName={line.instance.displayName}
                      driverKind={line.instance.driverKind}
                      size={16}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{line.instance.displayName}</span>
                      {line.lowest.reset === undefined ? null : (
                        <span className="truncate oct-menu-detail">{line.lowest.reset}</span>
                      )}
                    </span>
                    <span className="rail-account__left" data-level={line.lowest.level}>
                      {line.lowest.short}{" "}
                      {line.lowest.level === "spent" ? "limit" : `${String(line.lowest.percent)}%`}
                    </span>
                  </OctantMenuItem>
                ))}
              </OctantMenuGroup>
              <OctantMenuSeparator />
            </>
          )}
          {props.secondaryActions === undefined || props.secondaryActions.length === 0 ? null : (
            <>
              <OctantMenuGroup aria-label="Workspace">
                <OctantMenuGroupLabel>Workspace</OctantMenuGroupLabel>
                {props.secondaryActions.map((action) => (
                  <ProfileAction
                    icon={secondaryIcons[action.id]}
                    key={action.id}
                    label={action.label}
                    onClick={action.onSelect}
                  />
                ))}
              </OctantMenuGroup>
              <OctantMenuSeparator />
            </>
          )}
          <OctantMenuGroup aria-label="Octant">
            <OctantMenuGroupLabel>Octant</OctantMenuGroupLabel>
            {props.navigatorAvailable === true ? (
              <ProfileAction
                icon={Compass}
                label="Navigator"
                onClick={() => props.onOpenNavigator()}
              />
            ) : null}
            {props.onOpenArchive === undefined ? null : (
              <ProfileAction icon={Archive} label="Archive" onClick={props.onOpenArchive} />
            )}
            {openZen === undefined ? null : (
              <ProfileAction icon={Sparkles} label="Zen mode" onClick={openZen} />
            )}
            <ProfileAction icon={Route} label="Take the tour" onClick={openGuidedTour} />
          </OctantMenuGroup>
        </OctantMenuPopup>
      </OctantMenuPositioner>
    </OctantMenuPortal>
  );
}

function ProfileAction(props: {
  readonly icon: ComponentType<{
    readonly "aria-hidden": true;
    readonly className: string;
    readonly size: number;
  }>;
  readonly label: string;
  readonly onClick: () => void;
  /** The key that does the same, as a quiet key cap at the row's end. */
  readonly shortcut?: string | undefined;
}) {
  const Icon = props.icon;
  return (
    <OctantMenuItem onClick={props.onClick}>
      <Icon aria-hidden={true} className="icon" size={16} />
      <span>{props.label}</span>
      {props.shortcut === undefined ? null : (
        <OctantKbd className="sidebar-item__key" decorative form="bare">
          {props.shortcut}
        </OctantKbd>
      )}
    </OctantMenuItem>
  );
}
