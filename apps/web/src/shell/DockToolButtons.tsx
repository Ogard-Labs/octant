import { Ellipsis } from "lucide-react";
import { Fragment, useRef, useState, type KeyboardEvent } from "react";
import { DockToolIcon, dockToolIcon } from "./dockToolIcons";
import { groupDockTools } from "./dockToolGroups";
import type { DockToolButton, DockToolButtonsModel } from "./dockToolButtonsModel";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import { IconButton } from "./IconButton";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { OctantTooltip } from "../ui/base/OctantTooltip";

export interface DockToolButtonsProps {
  readonly model: DockToolButtonsModel;
  readonly onPress: (surface: RightUtilityDockSurfaceId, opener: HTMLElement) => void;
}

const ITEM_SELECTOR = "[data-dock-tool-item]";

/**
 * One icon button per tool at the right of the title band. Pressing opens the
 * tool as a pane and pressing again closes it; a pressed button is a tool that
 * is on screen. The row is a toolbar with one Tab stop and arrow-key movement,
 * and a press never moves focus off the button.
 */
export function DockToolButtons(props: DockToolButtonsProps) {
  const { buttons, more } = props.model;
  const toolbar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const count = buttons.length + (more.length > 0 ? 1 : 0);
  if (count === 0) return null;
  const stop = Math.min(current, count - 1);

  function items(): ReadonlyArray<HTMLElement> {
    return [...(toolbar.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
  }

  function move(event: KeyboardEvent<HTMLDivElement>): void {
    const all = items();
    const index = all.findIndex((item) => item === document.activeElement);
    if (index < 0) return;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % all.length
        : event.key === "ArrowLeft"
          ? (index - 1 + all.length) % all.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    all[target]?.focus();
  }

  return (
    <div
      aria-label="Tools"
      className="dock-tool-buttons window-no-drag"
      onFocus={(event) => {
        const index = items().findIndex((item) => item === event.target);
        if (index >= 0) setCurrent(index);
      }}
      onKeyDown={move}
      ref={toolbar}
      role="toolbar"
    >
      {buttons.map((button, index) => (
        <ToolButton
          button={button}
          key={button.id}
          onPress={props.onPress}
          tabStop={index === stop}
        />
      ))}
      {more.length === 0 ? null : (
        <MoreTools onPress={props.onPress} tabStop={buttons.length === stop} tools={more} />
      )}
    </div>
  );
}

function describe(button: DockToolButton): string | undefined {
  if (button.disabledReason !== undefined) return button.disabledReason;
  return button.open ? "Open" : undefined;
}

function ToolButton(props: {
  readonly button: DockToolButton;
  readonly onPress: DockToolButtonsProps["onPress"];
  readonly tabStop: boolean;
}) {
  const { button } = props;
  const description = describe(button);
  const disabled = button.disabledReason !== undefined;
  return (
    <OctantTooltip label={disabled ? `${button.label}. ${button.disabledReason}` : button.label}>
      <IconButton
        aria-pressed={button.pressed}
        // Disabled by aria so the button keeps its place in the arrow-key
        // order and its tooltip can still say why.
        {...(disabled ? { "aria-disabled": true } : {})}
        {...(description === undefined ? {} : { "aria-description": description })}
        className="window-chrome__button dock-tool-buttons__button"
        data-dock-open={button.open ? "true" : undefined}
        data-dock-tool-item=""
        data-dock-tool={button.id}
        icon={dockToolIcon(button.id)}
        label={button.label}
        onClick={(event) => {
          if (!disabled) props.onPress(button.id, event.currentTarget);
        }}
        tabIndex={props.tabStop ? 0 : -1}
        // The tooltip names the button; a native title would say it twice.
        title=""
        type="button"
      />
    </OctantTooltip>
  );
}

function MoreTools(props: {
  readonly onPress: DockToolButtonsProps["onPress"];
  readonly tabStop: boolean;
  readonly tools: ReadonlyArray<DockToolButton>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = props.tools.some((tool) => tool.pressed);
  const groups = groupDockTools(props.tools);
  return (
    <OctantMenuRoot>
      <OctantTooltip label="More tools">
        <OctantMenuTrigger
          render={
            <IconButton
              className="window-chrome__button dock-tool-buttons__button"
              data-dock-tool-item=""
              data-dock-tools-shown={shown ? "true" : undefined}
              icon={Ellipsis}
              label="More tools"
              ref={trigger}
              tabIndex={props.tabStop ? 0 : -1}
              title=""
              type="button"
            />
          }
        />
      </OctantTooltip>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end">
          <OctantMenuPopup aria-label="More tools">
            {groups.map((group, index) => (
              <Fragment key={group.label}>
                {index === 0 ? null : <OctantMenuSeparator />}
                <OctantMenuGroup aria-label={group.label} className="dock-utility-launcher__group">
                  {groups.length > 1 ? (
                    <OctantMenuGroupLabel>{group.label}</OctantMenuGroupLabel>
                  ) : null}
                  {group.surfaces.map((tool) => (
                    <OctantMenuCheckboxItem
                      {...(tool.disabledReason === undefined
                        ? {}
                        : { "aria-description": tool.disabledReason, disabled: true })}
                      checked={tool.pressed}
                      className="workspace-disclosure__action window-no-drag"
                      // A checkbox item keeps its menu open by default; this one
                      // opens or closes a pane, so the menu closes and focus
                      // goes back to its button.
                      closeOnClick
                      key={tool.id}
                      label={tool.label}
                      onCheckedChange={() => {
                        if (trigger.current !== null) props.onPress(tool.id, trigger.current);
                      }}
                    >
                      <DockToolIcon surface={tool.id} />
                      <span>{tool.label}</span>
                    </OctantMenuCheckboxItem>
                  ))}
                </OctantMenuGroup>
              </Fragment>
            ))}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}
