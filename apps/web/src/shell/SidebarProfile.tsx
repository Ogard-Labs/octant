import type { SettingsDeepLink } from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import {
  Archive,
  ChartNoAxesColumn,
  ChevronUp,
  Compass,
  FileStack,
  GitFork,
  Plug,
  Puzzle,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { UserAvatar } from "../profile/UserAvatar";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import type { SidebarAppMenuDescriptorId } from "./navigationModel";

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

const secondaryIcons: Record<SidebarAppMenuDescriptorId, LucideIcon> = {
  agents: GitFork,
  automations: Workflow,
  "artifact-library": FileStack,
  plugins: Puzzle,
};

/**
 * The person using this host, at the foot of the sidebar.
 *
 * The row names them rather than naming a destination, because the settings it
 * opens are theirs. A profile with no name says so and still opens the menu:
 * refusing to open until a name exists would hide the very place a name is set.
 */
export function SidebarProfile(props: SidebarProfileProps) {
  const openZen = props.onOpenZen;
  const name = props.profile.displayName ?? "";
  const label = name === "" ? "Set your name" : name;

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
          <UserAvatar profile={props.profile} size={22} />
          <span className="sidebar-label">{label}</span>
          <ChevronUp aria-hidden="true" className="sidebar-profile__chevron" size={14} />
        </OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner align="center" side="top">
            <OctantMenuPopup aria-label="Octant menu" className="w-[min(248px,calc(100vw-24px))]">
              {props.secondaryActions === undefined ||
              props.secondaryActions.length === 0 ? null : (
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
                  icon={ChartNoAxesColumn}
                  label="Usage"
                  onClick={() => props.onOpenSettings({ section: "usage" })}
                />
                <ProfileAction
                  icon={Plug}
                  label="Providers"
                  onClick={() => props.onOpenSettings({ section: "providers" })}
                />
                {openZen === undefined ? null : (
                  <ProfileAction icon={Sparkles} label="Zen mode" onClick={openZen} />
                )}
              </OctantMenuGroup>
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
    </div>
  );
}

function ProfileAction(props: {
  readonly icon: ComponentType<{
    readonly "aria-hidden": true;
    readonly className: string;
    readonly size: number;
    readonly strokeWidth: number;
  }>;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantMenuItem onClick={props.onClick}>
      <Icon aria-hidden={true} className="icon" size={16} strokeWidth={1.5} />
      <span>{props.label}</span>
    </OctantMenuItem>
  );
}
