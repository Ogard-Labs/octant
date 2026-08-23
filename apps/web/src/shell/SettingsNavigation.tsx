import type { SettingsSectionId } from "@octant/contracts";
import {
  Blocks,
  Bot,
  ChartNoAxesColumnIncreasing,
  Code2,
  Compass,
  FolderGit2,
  MessageCircle,
  Palette,
  Server,
  Settings2,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from "lucide-react";
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

const SETTINGS_GROUPS = ["Personal", "Modes", "Agents", "Integrations", "System"] as const;

const SETTINGS_NAVIGATION_META: Readonly<
  Record<
    SettingsSectionId,
    { readonly group: (typeof SETTINGS_GROUPS)[number]; readonly icon: LucideIcon }
  >
> = {
  general: { group: "Personal", icon: Settings2 },
  appearance: { group: "Personal", icon: Palette },
  chat: { group: "Modes", icon: MessageCircle },
  work: { group: "Modes", icon: Bot },
  code: { group: "Modes", icon: Code2 },
  "navigator-assistant": { group: "Personal", icon: Compass },
  providers: { group: "Agents", icon: Bot },
  profiles: { group: "Agents", icon: UserRound },
  agents: { group: "Agents", icon: Bot },
  skills: { group: "Agents", icon: Blocks },
  usage: { group: "System", icon: ChartNoAxesColumnIncreasing },
  host: { group: "System", icon: Server },
  github: { group: "Integrations", icon: FolderGit2 },
  advanced: { group: "System", icon: SlidersHorizontal },
};

/**
 * Persistent Settings section navigator.
 *
 * Renders one button per available section. Selecting a button switches the
 * active section through `onSelect` (route state, not anchor scrolling) and
 * the active section is marked with `aria-current` so screen readers and
 * styling can identify it.
 */
export function SettingsNavigation({ sections, activeSection, onSelect }: SettingsNavigationProps) {
  if (sections.length === 0) return null;
  return (
    <nav aria-label="Settings sections" className="settings-navigation">
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
                      className="setnav-item window-no-drag"
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
