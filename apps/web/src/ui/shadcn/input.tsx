import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export type InputProps = ComponentProps<"input"> & {
  /** Skip the field recipe where a feature draws the field's frame itself, such
   * as a search box inside a bordered toolbar or a stepper's middle segment. */
  readonly unstyled?: boolean;
};

const fieldRecipe =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm";

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", unstyled, ...props },
  ref,
) {
  return (
    <input
      className={cn(unstyled === true ? undefined : fieldRecipe, className)}
      data-slot="input"
      ref={ref}
      type={type}
      {...props}
    />
  );
});
