import type { OctantMode } from "@octant/contracts/modes";
import type { ModeSwitcherPresentation } from "@octant/contracts/shell";
import {
  BriefcaseBusiness,
  ChevronDown,
  Code2,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";

const modeOrder: ReadonlyArray<OctantMode> = ["chat", "work", "code"];
const modeLabels: Record<OctantMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};
const modeDescriptions: Record<OctantMode, string> = {
  chat: "Conversation with shared virtual context",
  work: "Work with local files and documents",
  code: "Build, debug, and ship software",
};
const modeIcons: Record<OctantMode, LucideIcon> = {
  chat: MessageCircle,
  work: BriefcaseBusiness,
  code: Code2,
};

export interface ModeSwitcherProps {
  readonly actions?: ReactNode;
  readonly activeMode: OctantMode;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly presentation: ModeSwitcherPresentation;
}

/**
 * The setting keeps its stored "buttons"/"dropdown" values; visually they are
 * the design system's icons and menu presentations of the mode switcher. The
 * active surface is marked with `aria-current="page"` in both, so what a
 * screen reader announces never depends on which presentation is on.
 */
export function ModeSwitcher(props: ModeSwitcherProps) {
  const modes = modeOrder.filter((mode) => props.modes.includes(mode));
  const selectMode = (mode: OctantMode) => {
    if (mode !== props.activeMode) props.onSelectMode(mode);
  };

  const items: Array<OctantMenuItem> = modes.map((mode) => {
    const ModeIcon = modeIcons[mode];
    return {
      description: modeDescriptions[mode],
      icon: <ModeIcon size={16} strokeWidth={1.7} />,
      label: modeLabels[mode],
      value: mode,
    };
  });

  const switcher =
    props.presentation === "buttons" ? (
      <div
        aria-label="Workspace mode"
        className="modeswitch window-no-drag"
        data-oct-modeswitch="icons"
        role="group"
      >
        <span className="mode-switcher__brand">Octant</span>
        {modes.map((mode) => {
          const ModeIcon = modeIcons[mode];
          const active = props.activeMode === mode;
          return (
            <OctantButton
              {...(active ? { "aria-current": "page" as const } : {})}
              className="mode window-no-drag"
              key={mode}
              onClick={() => selectMode(mode)}
              // The label is clipped to the accessible name in the icons
              // presentation, so the tooltip carries it for sighted hovers.
              title={modeLabels[mode]}
              type="button"
              variant="ghost"
            >
              <span aria-hidden="true" className="mode__icon-frame">
                <ModeIcon className="icon" size={16} strokeWidth={1.5} />
              </span>
              <span className="mode-label">{modeLabels[mode]}</span>
            </OctantButton>
          );
        })}
      </div>
    ) : (
      <OctantMenu
        items={items}
        onValueChange={(value) => {
          const mode = modes.find((candidate) => candidate === value);
          if (mode !== undefined) selectMode(mode);
        }}
        trigger={
          <>
            <span className="mode-switcher__brand">Octant</span>
            <span className="mode-switcher__context">{modeLabels[props.activeMode]}</span>
            <ChevronDown
              aria-hidden="true"
              className="icon mode-caret"
              size={16}
              strokeWidth={1.5}
            />
          </>
        }
        triggerClassName="mode-trigger"
        triggerLabel={`Workspace mode, ${modeLabels[props.activeMode]}`}
        value={props.activeMode}
      />
    );

  if (props.actions === undefined) return switcher;
  return (
    <div className="sidebar__chrome">
      {switcher}
      <div className="sidebar__chrome-actions">{props.actions}</div>
    </div>
  );
}
