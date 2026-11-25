import { lazyOr } from "../lib/lazyOr";
import type { ThreadReferenceChipProps } from "./ThreadReferenceChip";

/** The chip, its card and their styles load when a text first names a thread. */
export const LazyThreadReferenceChip = lazyOr<ThreadReferenceChipProps>(
  async () => (await import("./ThreadReferenceChip")).ThreadReferenceChip,
  ({ title }) => <span>{title}</span>,
);
