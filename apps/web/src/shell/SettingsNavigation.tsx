import type { SettingsSectionId } from "@octant/contracts";
import {
  Blocks,
  Brain,
  ChartNoAxesColumnIncreasing,
  Code2,
  Database,
  FolderSync,
  Gauge,
  Hexagon,
  Image,
  Keyboard,
  Link2,
  MessagesSquare,
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
  Type,
  type IconComponent,
} from "../ui/icons";
import { useEffect, useRef } from "react";
import type { octantSettingsNavigation } from "../settings/octantSettingsNavigation";
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
   remember, and how far it runs unattended; Data & devices is what this
   computer stores and the other machines it talks to.

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

interface SettingsPagePlace {
  readonly group: (typeof SETTINGS_GROUPS)[number];
  readonly icon: IconComponent;
}

/* A group lists its pages in the order they are written here, whatever order
   the registry supplies them in. Every page Settings has is placed; a page
   folded into another has no row, so it has no place either. */
const SETTINGS_PAGE_PLACES = {
  general: { group: "General", icon: Settings2 },
  appearance: { group: "Look & feel", icon: Palette },
  background: { group: "Look & feel", icon: Image },
  text: { group: "Look & feel", icon: Type },
  sidebar: { group: "Look & feel", icon: PanelLeft },
  keybindings: { group: "Look & feel", icon: Keyboard },
  providers: { group: "AI", icon: Plug },
  harness: { group: "AI", icon: Hexagon },
  voice: { group: "AI", icon: Mic },
  "chat-work": { group: "AI", icon: MessagesSquare },
  code: { group: "AI", icon: Code2 },
  skills: { group: "Tools", icon: Blocks },
  "computer-use": { group: "Tools", icon: Monitor },
  integrations: { group: "Tools", icon: Link2 },
  permissions: { group: "Safety", icon: ShieldCheck },
  limits: { group: "Safety", icon: Gauge },
  "secret-stores": { group: "Safety", icon: KeyRound },
  memory: { group: "Safety", icon: Brain },
  data: { group: "Data & devices", icon: Database },
  sync: { group: "Data & devices", icon: FolderSync },
  "remote-access": { group: "Data & devices", icon: Radio },
  host: { group: "Data & devices", icon: Server },
  usage: { group: "Data & devices", icon: ChartNoAxesColumnIncreasing },
} satisfies Record<keyof typeof octantSettingsNavigation, SettingsPagePlace>;

const placeOf: Readonly<Partial<Record<SettingsSectionId, SettingsPagePlace>>> =
  SETTINGS_PAGE_PLACES;

const SETTINGS_PAGE_ORDER = new Map(
  Object.keys(SETTINGS_PAGE_PLACES).map((id, index) => [id, index]),
);

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
          .filter((section) => placeOf[section.id]?.group === group)
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
                const Icon = placeOf[section.id]?.icon;
                if (Icon === undefined) return null;
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
