import type { SettingsDeepLink } from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import {
  Blocks,
  Bot,
  ChevronUp,
  Compass,
  Gauge,
  Library,
  Plug,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { UserAvatar } from "../profile/UserAvatar";
import { OctantButton } from "../ui/base/OctantButton";
import type { SidebarAppMenuDescriptorId } from "./navigationModel";

export interface SidebarSecondaryAction {
  readonly id: SidebarAppMenuDescriptorId;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface SidebarProfileProps {
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
  agents: Users,
  automations: Bot,
  "artifact-library": Library,
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
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDivElement>(null);
  const openZen = props.onOpenZen;
  const name = props.profile.displayName ?? "";

  useEffect(() => {
    if (open) disclosure.current?.querySelector("button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (disclosure.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function close(): void {
    setOpen(false);
    trigger.current?.focus();
  }

  function select(action: () => void): void {
    close();
    action();
  }

  return (
    <div className="sidebar-foot sidebar-profile">
      <OctantButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="sidebar-item window-no-drag justify-start"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
        variant="ghost"
      >
        <UserAvatar profile={props.profile} size={22} />
        <span className="sidebar-label">{name === "" ? "Set your name" : name}</span>
        <ChevronUp aria-hidden="true" className="sidebar-profile__chevron" size={14} />
      </OctantButton>
      {open ? (
        <div
          aria-label="Octant menu"
          className="sidebar-profile__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = Array.from(
              disclosure.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
            );
            if (items.length === 0) return;
            event.preventDefault();
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowUp"
                    ? (current - 1 + items.length) % items.length
                    : (current + 1) % items.length;
            items[next]?.focus();
          }}
          ref={disclosure}
          role="menu"
        >
          {props.secondaryActions === undefined || props.secondaryActions.length === 0 ? null : (
            <div aria-label="Workspace" className="sidebar-profile__group" role="group">
              <span className="sidebar-profile__group-label">Workspace</span>
              {props.secondaryActions.map((action) => (
                <ProfileAction
                  icon={secondaryIcons[action.id]}
                  key={action.id}
                  label={action.label}
                  onClick={() => select(action.onSelect)}
                />
              ))}
            </div>
          )}
          <div aria-label="Octant" className="sidebar-profile__group" role="group">
            <span className="sidebar-profile__group-label">Octant</span>
            {props.navigatorAvailable === true ? (
              <ProfileAction
                icon={Compass}
                label="Navigator"
                onClick={() => select(() => props.onOpenNavigator())}
              />
            ) : null}
            <ProfileAction
              icon={Settings}
              label="Settings"
              onClick={() => select(() => props.onOpenSettings())}
            />
            <ProfileAction
              icon={Gauge}
              label="Usage"
              onClick={() => select(() => props.onOpenSettings({ section: "usage" }))}
            />
            <ProfileAction
              icon={Plug}
              label="Providers"
              onClick={() => select(() => props.onOpenSettings({ section: "providers" }))}
            />
            {openZen === undefined ? null : (
              <ProfileAction icon={Sparkles} label="Zen mode" onClick={() => select(openZen)} />
            )}
          </div>
        </div>
      ) : null}
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
    // A plain button whose visible text is its accessible name — nothing but
    // the aria-hidden icon sits beside it, so no wrapper can swallow the label.
    <OctantButton
      className="sidebar-profile__action window-no-drag justify-start"
      onClick={props.onClick}
      role="menuitem"
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden={true} className="icon" size={16} strokeWidth={1.5} />
      <span>{props.label}</span>
    </OctantButton>
  );
}
