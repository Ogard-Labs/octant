import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Skip the field recipe. The composer prompt is Octant-owned (0038). */
  readonly unstyled?: boolean;
};

/*
 * `field-sizing-content` grows the box with what is typed instead of holding a
 * fixed height, so `min-h` is a floor rather than the size.
 */
const fieldRecipe =
  "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, unstyled, ...props },
  ref,
) {
  return (
    <textarea
      className={cn("resize-none", unstyled === true ? undefined : fieldRecipe, className)}
      data-slot="textarea"
      ref={ref}
      {...props}
    />
  );
});
