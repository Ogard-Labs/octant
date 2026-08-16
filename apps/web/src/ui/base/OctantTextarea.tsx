import { forwardRef, type ComponentProps } from "react";
import { Textarea } from "../shadcn/textarea";
import { cn } from "../shadcn/utils";

export type OctantTextareaProps = ComponentProps<typeof Textarea>;

/** Octant textarea adapter over the owned shadcn Textarea recipe. */
export const OctantTextarea = forwardRef<HTMLTextAreaElement, OctantTextareaProps>(
  function OctantTextarea({ className, ...props }, ref) {
    return <Textarea className={cn("window-no-drag", className)} ref={ref} {...props} />;
  },
);
