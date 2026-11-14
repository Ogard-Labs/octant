import { forwardRef } from "react";
import "./start-suggestion-chip.css";
import { OctantButton, type OctantButtonProps } from "../ui/base/OctantButton";

/**
 * The one chip every start screen uses for a suggested first prompt (Work's
 * starters, Code's prompts). It is a borderless 28px pill with a resting ink
 * fill; hover and keyboard focus deepen the fill, which keeps the label legible
 * over the start screen's ground. Plain ghost text on that ground read as a
 * caption, not a control.
 */
export const StartSuggestionChip = forwardRef<
  HTMLButtonElement,
  Omit<OctantButtonProps, "variant" | "size">
>(function StartSuggestionChip(props, ref) {
  const { className, ...rest } = props;
  return (
    <OctantButton
      ref={ref}
      className={className === undefined ? "start-suggestion-chip" : `start-suggestion-chip ${className}`}
      size="sm"
      type="button"
      variant="outline"
      {...rest}
    />
  );
});
