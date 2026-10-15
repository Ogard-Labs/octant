import {
  decodeContextSubjectRef,
  type ContextCompactionReceipt,
  type ContextSubjectRef,
} from "@octant/contracts/context";
import { useEffect, useState } from "react";
import { OctantSeparatorWithLabel } from "../ui/base/OctantSeparator";
import { useComposerContextMeterScope } from "./composerContextMeterScope";
import { compactionResultLine } from "./sessionCompactionPresentation";

/**
 * The compactions the host journaled for one thread, oldest first. Each pane
 * asks the host about its own thread, so a pane that is not the active one
 * still shows its dividers and no pane ever shows another thread's. It asks
 * again when the transcript's rows change, which is when a turn may have
 * compacted the session, and when the active thread's own compaction state
 * moves.
 */
export function useCompactionReceipts(
  subject: ContextSubjectRef | undefined,
  rowCount: number,
): ReadonlyArray<ContextCompactionReceipt> {
  const compaction = useComposerContextMeterScope().compaction;
  const client = compaction?.client;
  const activeCount = compaction?.controller.state?.completedCompactions?.length;
  const [read, setRead] = useState<{
    readonly key: string;
    readonly receipts: ReadonlyArray<ContextCompactionReceipt>;
  }>();
  const aggregateType = subject?.aggregateType;
  const aggregateId = subject?.aggregateId;
  const key = aggregateType === undefined ? "" : `${aggregateType}:${aggregateId}`;
  useEffect(() => {
    if (client === undefined || aggregateType === undefined || aggregateId === undefined) return;
    const abort = new AbortController();
    client
      .readCompaction({ aggregateType, aggregateId }, abort.signal)
      .then((state) => {
        if (!abort.signal.aborted) setRead({ key, receipts: state.completedCompactions ?? NONE });
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [activeCount, aggregateId, aggregateType, client, key, rowCount]);
  // An answer for a thread this transcript no longer shows is never drawn.
  return read !== undefined && read.key === key ? read.receipts : NONE;
}

/** The compaction subject of one thread, for a transcript to show its own dividers. */
export function threadCompactionSubject(
  aggregateType: "chat-thread" | "work-thread" | "code-thread",
  threadId: string,
): ContextSubjectRef {
  return decodeContextSubjectRef({ aggregateType, aggregateId: threadId });
}

const NONE: ReadonlyArray<ContextCompactionReceipt> = [];

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
