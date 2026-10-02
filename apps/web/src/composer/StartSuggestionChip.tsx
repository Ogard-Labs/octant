import { forwardRef } from "react";
import { OctantButton, type OctantButtonProps } from "../ui/base/OctantButton";

/**
 * The one chip every start screen uses for a suggested first prompt (Work's
 * starters, Code's prompts). It is the outline button: a hairline and resting
 * fill mark it as pressable, hover and keyboard focus fill it further, and the
 * fill keeps its label legible over the start screen's ground. Plain ghost
 * text on that ground read as a caption, not a control.
 */
export const StartSuggestionChip = forwardRef<
  HTMLButtonElement,
  Omit<OctantButtonProps, "variant" | "size">
>(function StartSuggestionChip(props, ref) {
  return <OctantButton ref={ref} size="sm" type="button" variant="outline" {...props} />;
});
