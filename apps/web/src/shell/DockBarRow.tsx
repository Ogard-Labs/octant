import { Check, Ellipsis } from "lucide-react";
import { useLayoutEffect, useState, type RefObject } from "react";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { IconButton } from "./IconButton";
import type { DockBarItem } from "./dockBarControls";

/** A 24px control, and the 4px between two. */
const CONTROL = 24;
const GAP = 4;
/** The bar's own inset: 12 leading, 8 trailing. */
const INSETS = 20;
/** Arrange and Close with the gaps around them. */
const TILE_CONTROLS = 2 * CONTROL + 2 * GAP;

function widthOf(items: ReadonlyArray<DockBarItem>): number {
  return items.reduce(
    (sum, item) =>
      sum + GAP + (item.kind === "button" ? CONTROL : item.options.length * CONTROL + GAP),
    0,
  );
}

/**
 * Whether a tool's controls, laid out in full, leave its name whole. Measured
 * from the bar's width, the name's natural width and a fixed width per control,
 * never from the controls' own rendered width, so folding them cannot change
 * the answer and flip back and forth.
 */
export function useFoldedControls(
  bar: RefObject<HTMLElement | null>,
  items: ReadonlyArray<DockBarItem>,
  trailing: number,
): boolean {
  const [folded, setFolded] = useState(false);
  const needed = widthOf(items);
  useLayoutEffect(() => {
    const node = bar.current;
    if (node === null || needed === 0) {
      setFolded(false);
      return;
    }
    const measure = () => {
      const name = node.querySelector<HTMLElement>(".dock-tile__name");
      const lead = name === null ? 0 : 14 + GAP + name.scrollWidth;
      // A bar with no measurable width (not laid out yet) folds nothing.
      setFolded(node.clientWidth > 0 && INSETS + lead + needed + trailing > node.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [bar, needed, trailing]);
  return folded;
}

export { TILE_CONTROLS };

/** A tool's bar controls, in a row of 24px icon buttons or folded into one menu. */
export function DockBarRow(props: {
  readonly items: ReadonlyArray<DockBarItem>;
  readonly folded: boolean;
  readonly toolLabel: string;
}) {
  if (props.items.length === 0) return null;
  if (props.folded) {
    return (
      <OctantMenuRoot>
        <OctantMenuTrigger
          aria-label={`More ${props.toolLabel} actions`}
          className="shell-icon-button dock-tile__control window-no-drag"
          title={`More ${props.toolLabel} actions`}
        >
          <Ellipsis aria-hidden="true" size={14} />
        </OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner>
            <OctantMenuPopup aria-label={`More ${props.toolLabel} actions`}>
              {props.items.map((item, index) =>
                item.kind === "button" ? (
                  <OctantMenuItem
                    className="workspace-disclosure__action window-no-drag"
                    disabled={item.disabled === true}
                    key={item.id}
                    onClick={item.onSelect}
                  >
                    <span>{item.label}</span>
                  </OctantMenuItem>
                ) : (
                  <OctantMenuGroup key={item.id}>
                    {index === 0 ? null : <OctantMenuSeparator />}
                    <OctantMenuGroupLabel>{item.label}</OctantMenuGroupLabel>
                    {item.options.map((option) => (
                      <OctantMenuItem
                        aria-checked={option.id === item.value}
                        className="workspace-disclosure__action window-no-drag"
                        key={option.id}
                        onClick={() => item.onChange(option.id)}
                        role="menuitemradio"
                      >
                        <span>{option.label}</span>
                        {option.id === item.value ? <Check aria-hidden="true" size={14} /> : null}
                      </OctantMenuItem>
                    ))}
                  </OctantMenuGroup>
                ),
              )}
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
    );
  }
  return (
    <div className="dock-tile__tool-controls">
      {props.items.map((item) =>
        item.kind === "button" ? (
          <IconButton
            className="dock-tile__control window-no-drag"
            disabled={item.disabled === true}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onClick={item.onSelect}
          />
        ) : (
          <div aria-label={item.label} className="dock-tile__choice" key={item.id} role="group">
            {item.options.map((option) => (
              <IconButton
                aria-pressed={option.id === item.value}
                className="dock-tile__control dock-tile__choice-option window-no-drag"
                icon={option.icon}
                key={option.id}
                label={option.label}
                onClick={() => item.onChange(option.id)}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
}
