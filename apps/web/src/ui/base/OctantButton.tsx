import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Button, type ButtonProps } from "../shadcn/button";
import { cn } from "../shadcn/utils";

export type OctantButtonProps = ButtonProps;

/** Octant button adapter over the owned shadcn/Base UI Button recipe. */
export const OctantButton = forwardRef<HTMLButtonElement, OctantButtonProps>(function OctantButton(
  { className, ...props },
  ref,
) {
  return <Button className={cn("window-no-drag", className)} ref={ref} {...props} />;
});

export type OctantIconButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  readonly label: string;
  readonly children: ReactNode;
};

/** Dense icon control used by shell chrome; keeps product `shell-icon-button` class. */
export const OctantIconButton = forwardRef<HTMLButtonElement, OctantIconButtonProps>(
  function OctantIconButton({ className, label, title = label, children, ...props }, ref) {
    return (
      <Button
        aria-label={label}
        className={cn("shell-icon-button", "window-no-drag", className)}
        ref={ref}
        size="icon"
        title={title}
        variant="ghost"
        {...props}
      >
        {children}
      </Button>
    );
  },
);
