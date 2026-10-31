import type { SettingsSectionId } from "@octant/contracts";
import {
  Bell,
  Blocks,
  ChartNoAxesColumnIncreasing,
  Code2,
  Database,
  FolderGit2,
  FolderOpen,
  FolderSync,
  Hexagon,
  Keyboard,
  ListTodo,
  MessageCircle,
  Monitor,
  Mic,
  PanelLeft,
  Palette,
  Plug,
  Radio,
  Server,
  Settings2,
  KeyRound,
  ShieldCheck,
  TabletSmartphone,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export type { SettingsSectionId } from "@octant/contracts";

export interface SettingsNavigationItem {
  readonly id: SettingsSectionId;
  readonly label: string;
}

export interface SettingsNavigationProps {
  readonly sections: ReadonlyArray<SettingsNavigationItem>;
  readonly activeSection: SettingsSectionId;
  readonly onSelect: (sectionId: SettingsSectionId) => void;
}

/* General is who you are and what Octant tells you; Look & feel is how it
   looks and is driven; AI & models is which model answers each job; Tools is
   what an agent may reach once running; Privacy & data is what is remembered,
   stored, and shared; Advanced is the host process, the machines it reaches
   over SSH, and its usage. */
const SETTINGS_GROUPS = [
  "General",
  "Look & feel",
  "Modes",
  "AI & models",
  "Tools",
  "Privacy & data",
  "Advanced",
] as const;

const SETTINGS_NAVIGATION_META: Readonly<
  Record<
    SettingsSectionId,
    { readonly group: (typeof SETTINGS_GROUPS)[number]; readonly icon: LucideIcon }
  >
> = {
  general: { group: "General", icon: Settings2 },
  profile: { group: "General", icon: UserRound },
  notifications: { group: "General", icon: Bell },
  appearance: { group: "Look & feel", icon: Palette },
  sidebar: { group: "Look & feel", icon: PanelLeft },
  keybindings: { group: "Look & feel", icon: Keyboard },
  chat: { group: "Modes", icon: MessageCircle },
  work: { group: "Modes", icon: FolderOpen },
  code: { group: "Modes", icon: Code2 },
  providers: { group: "AI & models", icon: Plug },
  harness: { group: "AI & models", icon: Hexagon },
  voice: { group: "AI & models", icon: Mic },
  skills: { group: "Tools", icon: Blocks },
  "computer-use": { group: "Tools", icon: Monitor },
  "device-tools": { group: "Tools", icon: TabletSmartphone },
  github: { group: "Tools", icon: FolderGit2 },
  linear: { group: "Tools", icon: ListTodo },
  permissions: { group: "Privacy & data", icon: ShieldCheck },
  "secret-stores": { group: "Privacy & data", icon: KeyRound },
  data: { group: "Privacy & data", icon: Database },
  sync: { group: "Privacy & data", icon: FolderSync },
  "remote-access": { group: "Privacy & data", icon: Radio },
  host: { group: "Advanced", icon: Server },
  usage: { group: "Advanced", icon: ChartNoAxesColumnIncreasing },
};

/** The page's nav icon, shared with the tile in that page's header. */
export function settingsSectionIcon(id: SettingsSectionId): LucideIcon {
  return SETTINGS_NAVIGATION_META[id].icon;
}

/**
 * Persistent Settings section navigator.
 *
 * Renders one button per available section. Selecting a button switches the
 * active section through `onSelect` (route state, not anchor scrolling) and
 * the active section is marked with `aria-current` so screen readers and
 * styling can identify it.
 */
export function SettingsNavigation({ sections, activeSection, onSelect }: SettingsNavigationProps) {
  const navigation = useRef<HTMLElement>(null);
  // A section at the end of the list (Usage, opened from the account menu)
  // otherwise opens with its highlighted row below the fold, leaving the
  // nearest visible row to read as the current page.
  useEffect(() => {
    navigation.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSection]);
  if (sections.length === 0) return null;
  return (
    <nav aria-label="Settings sections" className="settings-navigation" ref={navigation}>
      {SETTINGS_GROUPS.map((group) => {
        const groupedSections = sections.filter(
          (section) => SETTINGS_NAVIGATION_META[section.id].group === group,
        );
        if (groupedSections.length === 0) return null;
        return (
          <div className="settings-navigation__group" key={group}>
            <p className="setnav-section">{group}</p>
            <ul>
              {groupedSections.map((section) => {
                const isActive = section.id === activeSection;
                const Icon = SETTINGS_NAVIGATION_META[section.id].icon;
                return (
                  <li key={section.id}>
                    <OctantButton
                      aria-current={isActive ? "page" : undefined}
                      className="setnav-item window-no-drag justify-start rounded-lg"
                      onClick={() => onSelect(section.id)}
                      type="button"
                      variant="bare"
                    >
                      <Icon aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
                      <span>{section.label}</span>
                    </OctantButton>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
