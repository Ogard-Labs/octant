import type { VirtualItem } from "@tanstack/react-virtual";

export interface TranscriptScrollMemory {
  readonly offset: number;
  readonly measurements: ReadonlyArray<VirtualItem>;
  readonly following: boolean;
  /**
   * The key of the first row when the offset was taken. An offset only means
   * something over the rows it was measured against: a thread that reopens on
   * its newest page no longer starts with the rows loaded earlier.
   */
  readonly firstKey: string | undefined;
}

export const scrollMemory = new Map<string, TranscriptScrollMemory>();

/** Test seam: forget saved offsets so restoration cases start from an empty map. */
export function resetTranscriptScrollMemory(): void {
  scrollMemory.clear();
}
