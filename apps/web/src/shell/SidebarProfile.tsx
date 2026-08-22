import type { SettingsDeepLink } from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import { Compass, Gauge, Plug, Settings, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { UserAvatar } from "../profile/UserAvatar";

export interface SidebarProfileProps {
  readonly onOpenNavigator: () => void;
  /** False until Navigator has a host-configured model; the row is then absent. */
  readonly navigatorAvailable?: boolean;
  readonly onOpenSettings: (deepLink?: SettingsDeepLink) => void;
  /** Absent on a window that cannot enter Zen, which keeps the row off entirely. */
  readonly onOpenZen?: () => void;
  readonly profile: UserProfile;
}

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
      <button
        aria-controls={disclosureId}
        aria-expanded={open}
        className="sidebar-item window-no-drag"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
      >
        <UserAvatar profile={props.profile} size={22} />
        <span className="sidebar-label">{name === "" ? "Set your name" : name}</span>
      </button>
      {open ? (
        <div
          className="sidebar-profile__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
          ref={disclosure}
        >
          <ProfileAction
            icon={Settings}
            label="Settings"
            onClick={() => select(() => props.onOpenSettings())}
          />
          {props.navigatorAvailable === true ? (
            <ProfileAction
              icon={Compass}
              label="Navigator"
              onClick={() => select(() => props.onOpenNavigator())}
            />
          ) : null}
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
    <button
      className="sidebar-profile__action window-no-drag"
      onClick={props.onClick}
      type="button"
    >
      <Icon aria-hidden={true} className="icon" size={16} strokeWidth={1.5} />
      <span>{props.label}</span>
    </button>
  );
}
