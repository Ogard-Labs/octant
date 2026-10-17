import { forwardRef, type ComponentProps } from "react";
import { fieldPaint } from "./field-paint";
import { cn } from "./utils";

export type InputProps = ComponentProps<"input"> & {
  /** Skip the frame (height, border, background, radius, padding) where a feature
   * draws it itself, such as a search box inside a bordered toolbar or a
   * stepper's middle segment. Placeholder, selection and font stay. */
  readonly unstyled?: boolean;
};

/*
 * The frame is what a feature replaces when it draws the field's box itself;
 * the rest is the field's semantics (font, caret, selection, placeholder,
 * disabled and invalid states) and stays with every input so those states keep
 * following the theme.
 */
const frameRecipe = cn("h-8 px-2.5 py-1", fieldPaint);

const fieldRecipe =
  "w-full min-w-0 text-base text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm";

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", unstyled, ...props },
  ref,
) {
  return (
    <input
      className={cn(fieldRecipe, unstyled === true ? undefined : frameRecipe, className)}
      data-slot="input"
      ref={ref}
      type={type}
      {...props}
    />
  );
});
