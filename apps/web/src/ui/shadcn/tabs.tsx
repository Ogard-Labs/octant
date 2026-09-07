import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "./utils";

export function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("inline-flex h-8 w-fit items-center gap-1 text-muted-foreground", className)}
      data-slot="tabs-list"
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex h-7 flex-none cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-selected:bg-muted data-selected:text-foreground",
        className,
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      className={cn("mt-2 outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}
