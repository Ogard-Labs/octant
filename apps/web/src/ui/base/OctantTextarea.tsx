import { forwardRef, type ComponentProps } from "react";
import { Textarea } from "../shadcn/textarea";
import { cn } from "../shadcn/utils";

export type OctantTextareaProps = ComponentProps<typeof Textarea>;

function classListHas(className: string | undefined, token: string): boolean {
  return className !== undefined && className.split(/\s+/).includes(token);
}

/** Octant textarea adapter over the owned shadcn Textarea recipe. */
export const OctantTextarea = forwardRef<HTMLTextAreaElement, OctantTextareaProps>(
  function OctantTextarea({ className, unstyled, ...props }, ref) {
    // `.composer-input` is the system prompt, not a form field. Wearing
    // rounded-md / border / shadow-xs / focus-visible:ring here is the dual
    // paint that made Code welcome look like a 10px field inside a 20px card.
    const composerOwned = classListHas(className, "composer-input");
    return (
      <Textarea
        className={cn("window-no-drag", className)}
        ref={ref}
        {...(unstyled === true || composerOwned ? { unstyled: true } : {})}
        {...props}
      />
    );
  },
);
