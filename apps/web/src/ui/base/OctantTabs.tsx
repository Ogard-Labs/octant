import type { ComponentProps } from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../shadcn/tabs";
import { cn } from "../shadcn/utils";

export function OctantTabs(props: ComponentProps<typeof Tabs>) {
  return <Tabs {...props} />;
}

export function OctantTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return <TabsList className={cn("window-no-drag", className)} {...props} />;
}

export function OctantTabsTab({ className, ...props }: ComponentProps<typeof TabsTab>) {
  return <TabsTab className={cn("window-no-drag", className)} {...props} />;
}

export function OctantTabsPanel({ className, ...props }: ComponentProps<typeof TabsPanel>) {
  return <TabsPanel className={cn(className)} {...props} />;
}
