import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Button as ShadcnButton, buttonVariants, type ButtonProps } from "../shadcn/button";
import { cn } from "../shadcn/utils";

export type OctantButtonProps = ButtonProps;

/**
 * The class list of an Octant button, for a control another recipe renders as
 * its own element (a menu trigger) that must still look like the button.
 */
export function octantButtonClassName(options: Pick<ButtonProps, "variant" | "size"> = {}): string {
  return cn(buttonVariants(options), "window-no-drag");
}

/** Octant button adapter over the owned shadcn/Base UI Button recipe. */
export const OctantButton = forwardRef<HTMLButtonElement, OctantButtonProps>(function OctantButton(
  { className, ...props },
  ref,
) {
  return <ShadcnButton className={cn("window-no-drag", className)} ref={ref} {...props} />;
});

export type OctantIconButtonProps = Omit<ComponentProps<typeof ShadcnButton>, "children"> & {
  readonly label: string;
  readonly children: ReactNode;
};

/** Dense icon control used by shell chrome; keeps product `shell-icon-button` class. */
export const OctantIconButton = forwardRef<HTMLButtonElement, OctantIconButtonProps>(
  function OctantIconButton({ className, label, title = label, children, ...props }, ref) {
    return (
      <ShadcnButton
        aria-label={label}
        className={cn("shell-icon-button", "window-no-drag", className)}
        ref={ref}
        size="icon"
        title={title}
        variant="ghost"
        {...props}
      >
        {children}
      </ShadcnButton>
    );
  },
);
