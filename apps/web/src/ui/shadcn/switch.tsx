import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        "octant-switch",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
