import type { OctantMode } from "@octant/contracts/modes";
import type { ModeSwitcherPresentation } from "@octant/contracts/shell";
import { ChevronDown, Code2, FolderKanban, MessageSquare, type LucideIcon } from "lucide-react";
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
  chat: MessageSquare,
  work: FolderKanban,
  code: Code2,
};

export interface ModeSwitcherProps {
  readonly actions?: ReactNode;
  readonly activeMode: OctantMode;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly presentation: ModeSwitcherPresentation;
}

export function ModeSwitcher(props: ModeSwitcherProps) {
  const modes = modeOrder.filter((mode) => props.modes.includes(mode));
  const selectMode = (mode: OctantMode) => {
    if (mode !== props.activeMode) props.onSelectMode(mode);
  };

  const switcher =
    props.presentation === "buttons" ? (
      <div aria-label="Workspace mode" className="mode-switcher window-no-drag" role="group">
        {modes.map((mode) => {
          const ModeIcon = modeIcons[mode];
          return (
            <OctantButton
              aria-pressed={props.activeMode === mode}
              className="mode-button"
              key={mode}
              onClick={() => selectMode(mode)}
              type="button"
              variant={props.activeMode === mode ? "secondary" : "ghost"}
            >
              <ModeIcon aria-hidden="true" size={14} strokeWidth={1.7} />
              <span>{modeLabels[mode]}</span>
            </OctantButton>
          );
        })}
      </div>
    ) : null;

  if (props.presentation === "buttons") {
    if (props.actions === undefined) return switcher;
    return (
      <div className="sidebar__chrome">
        {switcher}
        <div className="sidebar__chrome-actions">{props.actions}</div>
      </div>
    );
  }

  const ActiveIcon = modeIcons[props.activeMode];
  const items: Array<OctantMenuItem> = modes.map((mode) => {
    const ModeIcon = modeIcons[mode];
    return {
      description: modeDescriptions[mode],
      icon: <ModeIcon size={15} strokeWidth={1.7} />,
      label: modeLabels[mode],
      value: mode,
    };
  });
  const dropdown = (
    <div className="mode-switcher mode-switcher--dropdown window-no-drag">
      <OctantMenu
        items={items}
        onValueChange={(value) => {
          const mode = modes.find((candidate) => candidate === value);
          if (mode !== undefined) selectMode(mode);
        }}
        trigger={
          <>
            <ActiveIcon aria-hidden="true" size={14} strokeWidth={1.7} />
            <span>{modeLabels[props.activeMode]}</span>
            <ChevronDown
              aria-hidden="true"
              className="octant-menu__trigger-chevron"
              size={14}
              strokeWidth={1.7}
            />
          </>
        }
        triggerLabel={`Workspace mode, ${modeLabels[props.activeMode]}`}
        value={props.activeMode}
      />
    </div>
  );
  if (props.actions === undefined) return dropdown;
  return (
    <div className="sidebar__chrome">
      {dropdown}
      <div className="sidebar__chrome-actions">{props.actions}</div>
    </div>
  );
}
