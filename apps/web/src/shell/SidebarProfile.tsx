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
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { useAccountUsage } from "../usage/accountUsage";
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
 * The profile row's trigger: the stable control at the foot of the sidebar that
 * focus returns to when a card above it, or a dialog it opened, goes away.
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

/** The ring's radius around the 24px face, inside the rail's 36px face. */
const RING_RADIUS = 15;

/**
 * The same person at the foot of the icon rail: one round face, their picture
 * or initials, with what is left of their tightest plan window drawn as a ring
 * around it. It replaced a Settings gear and one usage ring per provider, two
 * kinds of thing at the foot where one does: Settings, Usage and every
 * provider's reading are in the menu it opens.
 */
export function RailAccount(props: SidebarProfileProps) {
  const label = profileLabel(props.profile);
  const usage = useAccountUsage();
  const lowest = usage.lowest;
  const circumference = 2 * Math.PI * RING_RADIUS;
  const name =
    lowest === undefined
      ? `Account menu, ${label}`
      : `Account menu, ${label}, ${String(lowest.percent)}% of plan usage left`;
  return (
    <OctantMenuRoot>
      <OctantTooltip label={label} side="right">
        <OctantMenuTrigger
          aria-label={name}
          className="sidebar-rail__button rail-account window-no-drag"
        >
          <span aria-hidden="true" className="sidebar-rail__face rail-account__face">
            <UserAvatar profile={props.profile} size={24} />
            {lowest === undefined ? null : (
              <svg className="rail-account__ring" viewBox="0 0 34 34">
                <circle className="rail-account__track" cx="17" cy="17" r={RING_RADIUS} />
                <circle
                  className="rail-account__arc"
                  cx="17"
                  cy="17"
                  data-level={lowest.level}
                  r={RING_RADIUS}
                  strokeDasharray={`${((circumference * lowest.percent) / 100).toFixed(2)} ${circumference.toFixed(2)}`}
                />
              </svg>
            )}
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
  return (
    <OctantMenuPortal>
      <OctantMenuPositioner align={props.side === "right" ? "end" : "start"} side={props.side}>
        <OctantMenuPopup aria-label="Octant menu" className="w-[min(248px,calc(100vw-24px))]">
          {usage.lines.length === 0 ? null : (
            <>
              <OctantMenuGroup aria-label="Plan usage">
                <OctantMenuGroupLabel>Plan usage</OctantMenuGroupLabel>
                {usage.lines.map((line) => (
                  <OctantMenuItem
                    aria-label={`${line.instance.displayName}, ${line.lowest.short} ${String(line.lowest.percent)}% left`}
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
                      {line.reset === undefined ? null : (
                        <span className="truncate oct-menu-detail">{line.reset}</span>
                      )}
                    </span>
                    <span className="rail-account__left" data-level={line.lowest.level}>
                      {line.lowest.short} {line.lowest.percent}%
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
            <ProfileAction
              icon={Settings}
              label="Settings"
              onClick={() => props.onOpenSettings()}
            />
            <ProfileAction
              icon={PanelLeft}
              label="Customize sidebar"
              onClick={() =>
                props.onOpenSettings({ section: "appearance", setting: "sidebar-destinations" })
              }
            />
            <ProfileAction icon={ChartNoAxesColumn} label="Usage" onClick={openUsage} />
            <ProfileAction
              icon={Plug}
              label="Providers"
              onClick={() => props.onOpenSettings({ section: "providers" })}
            />
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
}) {
  const Icon = props.icon;
  return (
    <OctantMenuItem onClick={props.onClick}>
      <Icon aria-hidden={true} className="icon" size={16} />
      <span>{props.label}</span>
    </OctantMenuItem>
  );
}
