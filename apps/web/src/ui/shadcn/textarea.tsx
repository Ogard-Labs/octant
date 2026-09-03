import { forwardRef, type ComponentProps } from "react";
import { cn } from "./utils";

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Skip the field recipe. The composer prompt is Octant-owned (0038). */
  readonly unstyled?: boolean;
};

const fieldRecipe =
  "flex min-h-20 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm";

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
