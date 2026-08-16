import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Button } from "../ui/shadcn/button";
import { cn } from "../ui/shadcn/utils";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly icon: LucideIcon;
  readonly label: string;
}

/** Shell icon control backed by the Octant/shadcn button recipe. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon: Icon, label, title = label, type = "button", ...buttonProps },
  ref,
) {
  return (
    <Button
      {...buttonProps}
      aria-label={label}
      className={cn("shell-icon-button", "window-no-drag", className)}
      ref={ref}
      size="icon"
      title={title}
      type={type}
      variant="ghost"
    >
      <Icon aria-hidden="true" size={15} strokeWidth={1.7} />
    </Button>
  );
});
