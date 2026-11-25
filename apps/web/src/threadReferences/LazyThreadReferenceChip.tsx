import { lazy, Suspense, type ComponentType } from "react";
import type { ThreadReferenceChipProps } from "./ThreadReferenceChip";

/**
 * The chip, its card and their styles load when a text first names a thread,
 * not with the window. A chip that cannot load (a tab left open across an
 * update asks for a file the host no longer has) reads as the thread's name:
 * thrown out of render, the failure would take the composer down with it.
 *
 * Awaited in a try rather than given a rejection handler, for the reason the
 * sidebar's card is: the window build moves a `.then` on an import inside its
 * own stylesheet wait.
 */
async function importThreadReferenceChip(): Promise<{
  readonly default: ComponentType<ThreadReferenceChipProps>;
}> {
  try {
    const module = await import("./ThreadReferenceChip");
    return { default: module.ThreadReferenceChip };
  } catch {
    return { default: ({ title }) => <span>{title}</span> };
  }
}

const ThreadReferenceChip = lazy(importThreadReferenceChip);

export function LazyThreadReferenceChip(props: ThreadReferenceChipProps) {
  return (
    <Suspense fallback={<span>{props.title}</span>}>
      <ThreadReferenceChip {...props} />
    </Suspense>
  );
}
