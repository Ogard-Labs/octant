import type { OctantMode } from "@octant/contracts/modes";
import type { ModeSwitcherPresentation } from "@octant/contracts/shell";
import { ChevronDown, CodeXml, FolderOpen, MessageSquare, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import { visibleModeOf, visibleModes } from "./workKind";

export const modeLabels: Readonly<Record<OctantMode, string>> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};
const modeDescriptions: Readonly<Record<OctantMode, string>> = {
  chat: "Talk through questions with your models",
  work: "Chat, or work with the files in a folder",
  code: "Build, debug, and ship software",
};
export const modeIcons: Readonly<Record<OctantMode, LucideIcon>> = {
  chat: MessageSquare,
  work: FolderOpen,
  code: CodeXml,
};
const SEPARATE_MODE_ORDER: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

export interface ModeSwitcherProps {
  readonly actions?: ReactNode;
  /** The server's active mode; Chat and Work both show as Work. */
  readonly activeMode: OctantMode;
  /** The server modes Settings leaves enabled. */
  readonly modes: ReadonlyArray<OctantMode>;
  /** Folded, this only ever receives Work or Code. */
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly presentation: ModeSwitcherPresentation;
  /**
   * The remote client still lists Chat and Work separately, so it asks for the
   * three server modes; the shell folds Chat into Work.
   */
  readonly separateChat?: boolean;
}

/**
 * The setting keeps its stored "buttons"/"dropdown" values; visually they are
 * the design system's icons and menu presentations of the mode switcher. The
 * active surface is marked with `aria-current="page"` in both, so what a
 * screen reader announces never depends on which presentation is on.
 */
export function ModeSwitcher(props: ModeSwitcherProps) {
  const separate = props.separateChat === true;
  const modes: ReadonlyArray<OctantMode> = separate
    ? SEPARATE_MODE_ORDER.filter((mode) => props.modes.includes(mode))
    : visibleModes(props.modes);
  const activeMode: OctantMode = separate ? props.activeMode : visibleModeOf(props.activeMode);
  const selectMode = (mode: OctantMode) => {
    if (mode !== activeMode) props.onSelectMode(mode);
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
        data-oct-mode-count={modes.length}
        data-oct-modeswitch="icons"
        role="group"
      >
        <span className="mode-switcher__brand">Octant</span>
        <span className="modeswitch__tray">
          {modes.map((mode) => {
            const ModeIcon = modeIcons[mode];
            const active = activeMode === mode;
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
        </span>
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
            <span className="mode-switcher__context">{modeLabels[activeMode]}</span>
            <ChevronDown
              aria-hidden="true"
              className="icon mode-caret"
              size={16}
              strokeWidth={1.5}
            />
          </>
        }
        triggerClassName="mode-trigger"
        triggerLabel={`Workspace mode, ${modeLabels[activeMode]}`}
        value={activeMode}
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
