import { lazy, Suspense, type ComponentType } from "react";
import { railUsageLines, useAccountUsage } from "./accountUsage";
import type { RailUsageRingsProps } from "./RailUsageRings";

/**
 * The rings load after the window: the figures they draw arrive after it
 * anyway. They import none of the readings, which would split those out of the
 * first bundle and grow it. Rings that cannot load leave the account menu's
 * Usage row: thrown out of render, the failure would take the whole window down
 * for a glance at a figure. Awaited in a try for the reason
 * `importThreadRowInfoCard` is.
 */
const RailUsageRings = lazy(
  async (): Promise<{ readonly default: ComponentType<RailUsageRingsProps> }> => {
    try {
      const module = await import("./RailUsageRings");
      return { default: module.RailUsageRings };
    } catch {
      return { default: () => null };
    }
  },
);

/**
 * What is left of each account's plan, above the person's face at the foot of
 * the rail. An account that reports no window draws nothing, because an empty
 * ring would claim a limit nobody reported.
 */
export function RailUsage(props: { readonly onOpenUsage: () => void }) {
  const lines = railUsageLines(useAccountUsage());
  return lines.length === 0 ? null : (
    <Suspense fallback={null}>
      <RailUsageRings lines={lines} onOpenUsage={props.onOpenUsage} />
    </Suspense>
  );
}
