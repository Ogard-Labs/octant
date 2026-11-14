import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  Tooltip,
  TooltipPopup,
  TooltipPortal,
  TooltipPositioner,
  TooltipTrigger,
} from "../shadcn/tooltip";

export interface OctantTooltipProps {
  readonly children: ReactElement;
  readonly label: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "right" | "bottom" | "left";
  /**
   * `"inverted"` is the compact label chip. `"card"` puts structured content
   * on the ordinary raised surface instead: content that paints its own
   * `--oct-fg` text disappears against the inverted ground.
   */
  readonly surface?: "inverted" | "card";
  /**
   * A one-word chip for the rail: it opens beside the control, centred on it,
   * and stays small so it covers as little of the sidebar as it must.
   */
  readonly compact?: boolean;
}

/**
 * How focus last arrived: by a pointer press, by a key that moves focus, or by
 * a key that acts (Escape, Enter, Space), which is how a sheet or a menu hands
 * focus back to its trigger. Only the key that moves focus earns a tooltip.
 */
let lastInput: "pointer" | "navigation" | "action" = "action";
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
let watchers = 0;
const onPointerDown = () => {
  lastInput = "pointer";
};
const onKeyDown = (event: KeyboardEvent) => {
  lastInput = NAVIGATION_KEYS.has(event.key) ? "navigation" : "action";
};

function useWatchInputModality(): void {
  useEffect(() => {
    if (watchers === 0) {
      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("keydown", onKeyDown, true);
    }
    watchers += 1;
    return () => {
      watchers -= 1;
      if (watchers === 0) {
        window.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("keydown", onKeyDown, true);
      }
    };
  }, []);
}

/**
 * Opaque, collision-aware tooltip for compact shell controls. It opens on
 * hover (after the shared delay) and on keyboard focus-visible, never on focus
 * a click or a sheet's return of focus caused, and it closes on pointer leave,
 * on a press and on Escape. Left to the library, focus handed back to the rail's
 * Settings button after the sheet closed opened a tooltip that pointer leave
 * could not close, and it covered the account row.
 */
export function OctantTooltip(props: OctantTooltipProps) {
  useWatchInputModality();
  const [open, setOpen] = useState(false);
  // Escape closes it from wherever focus is; a press and pointer leave are
  // the library's own closes (closeOnClick and the hover hook).
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [open]);
  return (
    <Tooltip
      onOpenChange={(next, details) => {
        if (next && details.reason === "trigger-focus" && lastInput !== "navigation") return;
        setOpen(next);
      }}
      open={open}
    >
      <TooltipTrigger closeOnClick delay={350} render={props.children} />
      <TooltipPortal>
        <TooltipPositioner
          align={props.align ?? "center"}
          className="octant-tooltip__positioner"
          side={props.side ?? "bottom"}
          sideOffset={props.compact === true ? 6 : 8}
        >
          <TooltipPopup
            className={[
              "octant-tooltip",
              props.surface === "card" ? "octant-tooltip--card" : "",
              props.compact === true ? "octant-tooltip--compact" : "",
            ]
              .filter((name) => name !== "")
              .join(" ")}
            role="tooltip"
          >
            {props.label}
          </TooltipPopup>
        </TooltipPositioner>
      </TooltipPortal>
    </Tooltip>
  );
}
