import type { SettingsDeepLink } from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import { Compass, Gauge, Plug, Settings, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentType, type Ref } from "react";
import { UserAvatar } from "../profile/UserAvatar";
import { OctantButton } from "../ui/base/OctantButton";

export interface SidebarProfileProps {
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
    <div className="sidebar-profile">
      <OctantButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="sidebar-profile__trigger justify-start"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
        variant="ghost"
      >
        <UserAvatar profile={props.profile} size={22} />
        <span className="sidebar-profile__name">{name === "" ? "Set your name" : name}</span>
      </OctantButton>
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
          <ProfileAction
            icon={Compass}
            label="Navigator"
            onClick={() => select(() => props.onOpenSettings({ section: "navigator-assistant" }))}
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
      ) : null}
    </div>
  );
}

function ProfileAction(props: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly icon: ComponentType<{ readonly "aria-hidden": true; readonly size: number }>;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <OctantButton
      className="sidebar-profile__action justify-start"
      onClick={props.onClick}
      ref={props.buttonRef}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden={true} size={14} />
      <span>{props.label}</span>
    </OctantButton>
  );
}
