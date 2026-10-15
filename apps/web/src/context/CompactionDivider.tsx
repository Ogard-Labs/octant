import type { ContextCompactionReceipt } from "@octant/contracts/context";
import { OctantSeparatorWithLabel } from "../ui/base/OctantSeparator";
import { useComposerContextMeterScope } from "./composerContextMeterScope";
import { compactionResultLine } from "./sessionCompactionPresentation";

/**
 * The compactions the host journaled for the open thread, oldest first. The
 * controller answers for the active pane's thread only, so a transcript in any
 * other pane gets none rather than another thread's receipts.
 */
export function useCompactionReceipts(): ReadonlyArray<ContextCompactionReceipt> {
  const scope = useComposerContextMeterScope();
  return scope.visible ? (scope.compaction?.controller.state?.completedCompactions ?? []) : [];
}

/**
 * Where each compaction falls among a transcript's rows: before the first row
 * that ended after the compaction completed, so a requested compaction sits
 * between two turns and a runtime's own sits ahead of the reply it happened in.
 * A row with no time of its own takes the time of the row before it. Compactions
 * after every row come back as `trailing`. A compaction ahead of the first
 * loaded row belongs to history that is not loaded, so it is left out.
 */
export function placeCompactions<T>(
  items: ReadonlyArray<T>,
  receipts: ReadonlyArray<ContextCompactionReceipt>,
  itemAt: (item: T) => string | undefined,
): {
  readonly before: ReadonlyMap<number, ReadonlyArray<ContextCompactionReceipt>>;
  readonly trailing: ReadonlyArray<ContextCompactionReceipt>;
} {
  const before = new Map<number, ContextCompactionReceipt[]>();
  const trailing: ContextCompactionReceipt[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  const times = items.map((item) => {
    const at = itemAt(item);
    if (at !== undefined) previous = Date.parse(at);
    return previous;
  });
  for (const receipt of receipts) {
    const completed = Date.parse(receipt.completedAt);
    const index = times.findIndex((time) => time > completed);
    if (index === 0) continue;
    if (index === -1) {
      trailing.push(receipt);
      continue;
    }
    before.set(index, [...(before.get(index) ?? []), receipt]);
  }
  return { before, trailing };
}

/** A quiet rule that says the session was compacted here, and how. */
export function CompactionDivider(props: { readonly receipt: ContextCompactionReceipt }) {
  const names = useComposerContextMeterScope().compaction?.names;
  const line = compactionResultLine(
    { status: "completed", receipt: props.receipt },
    names ?? { provider: () => undefined, model: () => undefined },
  );
  return (
    <OctantSeparatorWithLabel aria-label={line} className="py-3" data-compaction-divider="">
      {line}
    </OctantSeparatorWithLabel>
  );
}
