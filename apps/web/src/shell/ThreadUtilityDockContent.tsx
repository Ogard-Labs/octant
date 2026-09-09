import { Suspense } from "react";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { dockModules } from "./dockModuleRegistry";
import { DockModuleBoundary } from "./DockModuleBoundary";
import { ShellState } from "./ShellState";
import type { ThreadUtilityDockContentProps } from "./dockModuleContext";
export type { ThreadUtilityDockContentProps, ThreadUtilityDockSubject } from "./dockModuleContext";

export function ThreadUtilityDockContent(props: ThreadUtilityDockContentProps) {
  const Module = dockModules[props.surface];
  const label =
    RIGHT_UTILITY_DOCK_SURFACES.find((surface) => surface.id === props.surface)?.label ?? "tool";
  return (
    <DockModuleBoundary
      key={`${props.surface}:${props.subject.mode}:${props.subject.threadId}:${props.subject.checkoutId ?? ""}`}
    >
      <Suspense fallback={<ShellState state="loading" title={`Loading ${label}`} />}>
        <Module {...props} />
      </Suspense>
    </DockModuleBoundary>
  );
}
