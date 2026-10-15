import type { EventEnvelope } from "@octant/contracts";
import type { Journal } from "./journal";

/**
 * Shared bounds for rebuilding an in-memory projection from the journal.
 *
 * Every hydrator must fail closed when the scan exceeds the cap: serving a
 * silently truncated projection reports current for state the host never
 * finished reading. Aggregate-type replay keeps unrelated journal growth from
 * counting against the cap, so an ordinary long-lived host does not abort a
 * small projection's restart.
 *
 * The cap counts only the projection's own rows and bounds start-up time, not
 * memory: rows are applied one batch at a time, so a rebuild holds no more
 * than the state the projection keeps while running anyway. Decoding a
 * million rows takes about 15 s. At 100,000, a Work user some 25,000 turns in
 * (a few turn rows each) would have found the host refusing to start.
 */
export const JOURNAL_HYDRATION_MAX_SCAN = 1_000_000;
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

/**
 * Every row of the given aggregate types in journal order, read type by type
 * through the (type, sequence) index and merged, so a store rebuilding itself
 * never reads, decodes, or counts another store's rows. Reads one batch per
 * type at a time.
 */
export function* replayAggregateTypesInOrder(
  journal: Pick<Journal, "replayAggregateType">,
  aggregateTypes: ReadonlyArray<string>,
): Generator<EventEnvelope, void, undefined> {
  const streams = aggregateTypes.map((aggregateType) => ({
    aggregateType,
    afterSequence: 0,
    batch: [] as ReadonlyArray<EventEnvelope>,
    index: 0,
    exhausted: false,
  }));
  const head = (stream: (typeof streams)[number]): EventEnvelope | undefined => {
    if (stream.index < stream.batch.length) return stream.batch[stream.index];
    if (stream.exhausted) return undefined;
    stream.batch = journal.replayAggregateType({
      aggregateType: stream.aggregateType,
      afterSequence: stream.afterSequence,
      limit: JOURNAL_HYDRATION_BATCH_SIZE,
    });
    stream.index = 0;
    if (stream.batch.length < JOURNAL_HYDRATION_BATCH_SIZE) stream.exhausted = true;
    return stream.batch[0];
  };
  for (;;) {
    let next: (typeof streams)[number] | undefined;
    let nextEnvelope: EventEnvelope | undefined;
    for (const stream of streams) {
      const envelope = head(stream);
      if (
        envelope !== undefined &&
        (nextEnvelope === undefined || envelope.globalSequence < nextEnvelope.globalSequence)
      ) {
        next = stream;
        nextEnvelope = envelope;
      }
    }
    if (next === undefined || nextEnvelope === undefined) return;
    next.index += 1;
    next.afterSequence = nextEnvelope.globalSequence;
    yield nextEnvelope;
  }
}
