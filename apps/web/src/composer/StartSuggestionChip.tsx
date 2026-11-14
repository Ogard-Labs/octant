import { forwardRef } from "react";
import { OctantButton, type OctantButtonProps } from "../ui/base/OctantButton";

/**
 * The one chip every start screen uses for a suggested first prompt (Work's
 * starters, Code's prompts). It is the chip button: a borderless 28px chip with
 * a resting ink fill; hover and keyboard focus deepen the fill, which keeps its
 * label legible over the start screen's ground. Plain ghost text on that
 * ground read as a caption, not a control.
 */
export const StartSuggestionChip = forwardRef<
  HTMLButtonElement,
  Omit<OctantButtonProps, "variant" | "size">
>(function StartSuggestionChip(props, ref) {
  return <OctantButton ref={ref} size="sm" type="button" variant="chip" {...props} />;
});
