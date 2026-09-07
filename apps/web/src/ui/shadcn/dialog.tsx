import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "./utils";

/*
 * The dialog's paint belongs to the token-driven chrome, not to Tailwind: the
 * `.octant-dialog__*` rules own position, scrim, surface, border, radius, and
 * shadow, and being unlayered they beat every layered utility anyway. Only
 * behavior that chrome does not express stays here as utilities: the
 * backdrop's enter/exit fade and the popup's default content padding.
 */
export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />;
}

export function DialogBackdrop({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      className={cn("data-ending-style:opacity-0 data-starting-style:opacity-0", className)}
      {...props}
    />
  );
}

export function DialogViewport({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Viewport>) {
  return <DialogPrimitive.Viewport className={cn(className)} {...props} />;
}

export function DialogPopup({ className, ...props }: ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Popup className={cn("relative p-4 outline-none", className)} {...props} />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}
