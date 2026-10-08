import type { SettingsSectionId } from "@octant/contracts";
import {
  Blocks,
  ChartNoAxesColumnIncreasing,
  Code2,
  Compass,
  Database,
  FolderGit2,
  FolderOpen,
  FolderSync,
  Hexagon,
  Image as ImageIcon,
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

/* Personal is how Octant looks and behaves for you; Models is which model or
   provider answers each job; Agents is what an agent may do once running. */
const SETTINGS_GROUPS = [
  "Personal",
  "Modes",
  "Models",
  "Agents",
  "Integrations",
  "System",
] as const;

const SETTINGS_NAVIGATION_META: Readonly<
  Record<
    SettingsSectionId,
    { readonly group: (typeof SETTINGS_GROUPS)[number]; readonly icon: LucideIcon }
  >
> = {
  general: { group: "Personal", icon: Settings2 },
  profile: { group: "Personal", icon: UserRound },
  appearance: { group: "Personal", icon: Palette },
  sidebar: { group: "Personal", icon: PanelLeft },
  keybindings: { group: "Personal", icon: Keyboard },
  chat: { group: "Modes", icon: MessageCircle },
  work: { group: "Modes", icon: FolderOpen },
  code: { group: "Modes", icon: Code2 },
  providers: { group: "Models", icon: Plug },
  harness: { group: "Models", icon: Hexagon },
  "navigator-assistant": { group: "Models", icon: Compass },
  voice: { group: "Models", icon: Mic },
  "image-generation": { group: "Models", icon: ImageIcon },
  "computer-use": { group: "Agents", icon: Monitor },
  "device-tools": { group: "Agents", icon: TabletSmartphone },
  skills: { group: "Agents", icon: Blocks },
  github: { group: "Integrations", icon: FolderGit2 },
  linear: { group: "Integrations", icon: ListTodo },
  host: { group: "System", icon: Server },
  data: { group: "System", icon: Database },
  sync: { group: "System", icon: FolderSync },
  "remote-access": { group: "System", icon: Radio },
  usage: { group: "System", icon: ChartNoAxesColumnIncreasing },
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
                      className="setnav-item window-no-drag justify-start"
                      onClick={() => onSelect(section.id)}
                      type="button"
                      variant="ghost"
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
