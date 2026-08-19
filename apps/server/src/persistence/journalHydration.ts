/**
 * Shared bounds for rebuilding an in-memory projection from the journal.
 *
 * Every hydrator must fail closed when the scan exceeds the cap: serving a
 * silently truncated projection reports current for state the host never
 * finished reading. Aggregate-type replay keeps unrelated journal growth from
 * counting against the cap, so an ordinary long-lived host does not abort a
 * small projection's restart.
 */
export const JOURNAL_HYDRATION_MAX_SCAN = 100_000;
export const JOURNAL_HYDRATION_BATCH_SIZE = 1_000;

export interface JournalHydrationCursor {
  readonly afterSequence: number;
  readonly limit: number;
  readonly aggregateType?: string;
}

export interface JournalHydrationEnvelope {
  readonly globalSequence: number;
  readonly aggregateType?: string;
  readonly eventName: string;
  readonly eventVersion: number;
  readonly payload: unknown;
}

export type JournalHydrationStatus = "ok" | "snapshot-required";

export interface HydrateJournalProjectionInput {
  readonly replay: (cursor: JournalHydrationCursor) => ReadonlyArray<JournalHydrationEnvelope>;
  readonly apply: (envelope: JournalHydrationEnvelope) => void;
  readonly aggregateType?: string;
  readonly maxScan?: number;
}

export function requireJournalHydration(status: JournalHydrationStatus, label: string): void {
  if (status === "snapshot-required") {
    throw new Error(
      `${label} hydration exceeded the journal scan cap; a snapshot rebuild is required.`,
    );
  }
}

/**
 * Replay a projection from the journal in bounded batches. Returns
 * `snapshot-required` when the scan exceeds the cap so the caller can refuse
 * to serve a partial rebuild.
 */
export function hydrateJournalProjection(
  input: HydrateJournalProjectionInput,
): JournalHydrationStatus {
  const maxScan = input.maxScan ?? JOURNAL_HYDRATION_MAX_SCAN;
  let afterSequence = 0;
  let scanned = 0;
  for (;;) {
    const batch = input.replay({
      afterSequence,
      limit: JOURNAL_HYDRATION_BATCH_SIZE,
      ...(input.aggregateType === undefined ? {} : { aggregateType: input.aggregateType }),
    });
    if (batch.length === 0) return "ok";
    for (const envelope of batch) {
      afterSequence = envelope.globalSequence;
      scanned += 1;
      if (scanned > maxScan) return "snapshot-required";
      input.apply(envelope);
    }
    if (batch.length < JOURNAL_HYDRATION_BATCH_SIZE) return "ok";
  }
}
