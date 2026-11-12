import type { SettingsSectionId } from "@octant/contracts";
import {
  Bell,
  Blocks,
  Brain,
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
  Network,
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

/* Six groups, each one question a person brings to Settings. General is who
   you are and what Octant tells you; Look & feel is how it looks and is
   driven; AI is which model answers and how each mode starts; Tools is what a
   running agent may reach; Safety is what an agent may touch, reach and
   remember; Data & devices is what this computer stores and the other
   machines it talks to.

   Privacy & data had grown to seven pages that answered three different
   questions (permissions, storage, other devices), Modes stood apart from the
   models its pages choose, and Advanced held two pages. */
const SETTINGS_GROUPS = [
  "General",
  "Look & feel",
  "AI",
  "Tools",
  "Safety",
  "Data & devices",
] as const;

/* A group lists its pages in the order they are written here, whatever order
   the registry supplies them in. */
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
  providers: { group: "AI", icon: Plug },
  harness: { group: "AI", icon: Hexagon },
  voice: { group: "AI", icon: Mic },
  chat: { group: "AI", icon: MessageCircle },
  work: { group: "AI", icon: FolderOpen },
  code: { group: "AI", icon: Code2 },
  skills: { group: "Tools", icon: Blocks },
  "computer-use": { group: "Tools", icon: Monitor },
  "device-tools": { group: "Tools", icon: TabletSmartphone },
  github: { group: "Tools", icon: FolderGit2 },
  linear: { group: "Tools", icon: ListTodo },
  permissions: { group: "Safety", icon: ShieldCheck },
  access: { group: "Safety", icon: Network },
  "secret-stores": { group: "Safety", icon: KeyRound },
  memory: { group: "Safety", icon: Brain },
  data: { group: "Data & devices", icon: Database },
  sync: { group: "Data & devices", icon: FolderSync },
  "remote-access": { group: "Data & devices", icon: Radio },
  host: { group: "Data & devices", icon: Server },
  usage: { group: "Data & devices", icon: ChartNoAxesColumnIncreasing },
};

const SETTINGS_PAGE_ORDER = new Map(
  Object.keys(SETTINGS_NAVIGATION_META).map((id, index) => [id, index]),
);

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
        const groupedSections = sections
          .filter((section) => SETTINGS_NAVIGATION_META[section.id].group === group)
          .toSorted(
            (left, right) =>
              (SETTINGS_PAGE_ORDER.get(left.id) ?? 0) - (SETTINGS_PAGE_ORDER.get(right.id) ?? 0),
          );
        if (groupedSections.length === 0) return null;
        return (
          <div className="settings-navigation__group" key={group}>
            <p className="oct-nav-group setnav-section">{group}</p>
            <ul>
              {groupedSections.map((section) => {
                const isActive = section.id === activeSection;
                const Icon = SETTINGS_NAVIGATION_META[section.id].icon;
                return (
                  <li key={section.id}>
                    <OctantButton
                      aria-current={isActive ? "page" : undefined}
                      className="oct-nav-name setnav-item window-no-drag justify-start rounded-lg"
                      onClick={() => onSelect(section.id)}
                      type="button"
                      variant="bare"
                    >
                      <Icon aria-hidden="true" className="icon" size={16} />
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
