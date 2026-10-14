import { CanvasId, CanvasVersionId, type CanvasVersion } from "@octant/contracts";
import { Schema } from "effect";
import {
  recordReaderMark,
  type ReaderMarking,
  type ThreadOutsideContentMarks,
} from "../context/inheritedExternalContentMark";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** One aggregate per Canvas; a Canvas purge erases it with the Canvas. */
export const CANVAS_OUTSIDE_CONTENT_AGGREGATE_TYPE = "canvas-outside-content";
export const CANVAS_OUTSIDE_CONTENT_CARRIED = "canvas.outside-content-carried@1";

/** The source label a Canvas's reader is marked under; it names the channel. */
export const CANVAS_READER_SOURCE_LABEL = "canvas";

/**
 * A version of the Canvas was written while the thread it belongs to, or the
 * managed child writing it, was marked with outside content. One event per
 * writer: the first marked version it wrote is named, and the Canvas carries
 * the mark from then on, because a later version is written by an agent that
 * read the earlier ones.
 */
export const CanvasOutsideContentCarried = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  writerId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type CanvasOutsideContentCarried = typeof CanvasOutsideContentCarried.Type;

export const decodeCanvasOutsideContentCarried = Schema.decodeUnknownSync(
  CanvasOutsideContentCarried,
);

export function registerCanvasOutsideContentEvents(registry: EventRegistry): EventRegistry {
  return registry.register(CANVAS_OUTSIDE_CONTENT_CARRIED, 1, CanvasOutsideContentCarried);
}

/** The journal's largest replay page. */
const WRITERS_PAGE = 1_000;

/**
 * The threads and managed children whose marked writes a Canvas carries, read
 * from the journal itself so no projection can fall behind it. Every page is
 * read: the count is the aggregate's head, which the next record must name.
 */
export function canvasOutsideContentWriters(
  journal: Pick<Journal, "replayAggregate">,
  canvasId: string,
): ReadonlyArray<string> {
  const writers: string[] = [];
  let afterVersion = 0;
  while (true) {
    const page = journal.replayAggregate({
      aggregateType: CANVAS_OUTSIDE_CONTENT_AGGREGATE_TYPE,
      aggregateId: canvasId,
      afterVersion,
      limit: WRITERS_PAGE,
    });
    for (const event of page) {
      writers.push(decodeCanvasOutsideContentCarried(event.payload).writerId);
      afterVersion = event.aggregateVersion;
    }
    if (page.length < WRITERS_PAGE) return writers;
  }
}

/**
 * Who writes a version: the thread it belongs to, and a managed child when one
 * is its author. A thread's own agent revises under a fresh agent id that is
 * never marked, so it adds nothing; a person writes as the local user.
 */
export function canvasVersionWriters(version: CanvasVersion): ReadonlyArray<string> {
  const threadId = String(version.definition.provenance.threadId);
  const author = version.createdBy;
  return author.kind === "agent" && String(author.actorId) !== threadId
    ? [threadId, String(author.actorId)]
    : [threadId];
}

/**
 * Marks a thread or managed child whose model is about to read a Canvas, when
 * the Canvas carries outside content.
 *
 * It carries it when a version was written while its writer was marked (see
 * `CanvasEventStore`), and also when the thread it belongs to is marked now: a
 * Canvas written before the host recorded marks at write time carries none,
 * and its thread's mark is the evidence left. A writer's own read passes on
 * nothing, since the writer already read what it wrote, so a thread reading
 * its own Canvas after a person cleared it is not marked again by it.
 *
 * A mark recorded at write time is the Canvas's own: a person's Clear on the
 * writer covers the writer, which read what marked it, and not every thread
 * that will read the Canvas. Call this after the Canvas is read and before
 * anything from it is handed on; `refused` means the caller withholds it.
 */
export function markCanvasReader(input: {
  readonly journal: Pick<Journal, "replayAggregate">;
  readonly marks: ThreadOutsideContentMarks;
  readonly readerId: string;
  readonly canvasId: string;
  readonly canvasThreadId: string;
  readonly correlationId: () => string;
}): ReaderMarking {
  let carries: boolean;
  try {
    carries =
      canvasOutsideContentWriters(input.journal, input.canvasId).some(
        (writerId) => writerId !== input.readerId,
      ) ||
      (input.canvasThreadId !== input.readerId && input.marks.isMarked(input.canvasThreadId));
  } catch {
    return { status: "refused" };
  }
  if (!carries) return { status: "nothing-to-mark" };
  return recordReaderMark({
    marks: input.marks,
    readerThreadId: input.readerId,
    sourceLabel: CANVAS_READER_SOURCE_LABEL,
    contentReference: `${CANVAS_READER_SOURCE_LABEL}-${input.canvasId}`,
    correlationId: input.correlationId,
  });
}
