import type { Journal } from "../persistence/journal";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "./externalContentIngestionStore";

/**
 * The outside-content mark a new thread starts with because what it is made
 * from comes from a marked thread: a fork, a branch, or a restore copies the
 * source's conversation, and a follow-up or side task carries text an agent
 * wrote there.
 */
export interface InheritedExternalContentMark {
  readonly sourceLabel: string;
  readonly contentReference: string;
}

export type RecordExternalContentIngestion = (
  input: RecordExternalContentIngestionInput,
) => ExternalContentIngestionResult;

export const INHERITED_MARK_REFUSAL =
  "The thread this comes from read outside content, and the new thread could not be marked with it, so nothing was created. Try again.";

export type InheritedMarkJournaling<A> =
  | { readonly status: "journaled"; readonly value: A }
  | { readonly status: "refused" };

/** Rolls the unit back when the mark is refused; never leaves this module. */
class InheritedMarkRefused extends Error {}

/**
 * Journals a new thread, and first the mark it inherits when it has one.
 *
 * The mark is appended on the new thread before the thread itself, in one
 * journal unit with it: no moment exists at which the thread is created and
 * unmarked, a mark that cannot be journaled refuses the creation, and a
 * creation that fails after the mark leaves no mark behind. Only a person's
 * Clear may forget a mark, so a failed creation cannot undo one with a later
 * event. Without a journal unit or a way to record the mark, a creation that
 * needs one is refused; an unmarked one needs neither.
 */
export function journalWithInheritedMark<A>(input: {
  readonly journal: Partial<Pick<Journal, "transaction">>;
  readonly record: RecordExternalContentIngestion | undefined;
  readonly threadId: string;
  readonly mark: InheritedExternalContentMark | undefined;
  /** Asked only when there is a mark to journal. */
  readonly correlationId: () => string;
  readonly journalThread: () => A;
}): InheritedMarkJournaling<A> {
  const { journal, record, mark } = input;
  if (mark === undefined) return { status: "journaled", value: input.journalThread() };
  if (journal.transaction === undefined || record === undefined) return { status: "refused" };
  try {
    return journal.transaction(() => {
      let recorded: ExternalContentIngestionResult;
      try {
        recorded = record({
          threadId: input.threadId,
          provenance: { origin: "external-content", sourceLabel: mark.sourceLabel },
          contentReference: mark.contentReference,
          correlationId: input.correlationId(),
          authorized: true,
        });
      } catch {
        throw new InheritedMarkRefused();
      }
      if (recorded.kind !== "recorded" && recorded.kind !== "already-recorded") {
        throw new InheritedMarkRefused();
      }
      return { status: "journaled" as const, value: input.journalThread() };
    });
  } catch (error) {
    if (error instanceof InheritedMarkRefused) return { status: "refused" };
    throw error;
  }
}

/** Where the host reads a thread's mark now and records a new one. */
export interface ThreadOutsideContentMarks {
  readonly record: RecordExternalContentIngestion;
  readonly isMarked: (threadId: string) => boolean;
}

/** What marking a thread that reads another thread's transcript came to. */
export type ReaderMarking =
  | { readonly status: "nothing-to-mark" }
  | { readonly status: "marked" }
  | { readonly status: "refused" };

/**
 * Marks a thread whose model is about to read another thread's transcript
 * (a `#thread` mention or a Side Chat source), when that thread is marked.
 *
 * The transcript carries what the marked thread read, so the reader is marked
 * as a fork or a branch would be, under the channel's own label. Call it after
 * the transcript is read and before its text is handed on, so the reader is
 * marked before its provider sees anything; anything that marked the source
 * was recorded before it could reach the source's transcript. A source a
 * person cleared passes on nothing, as for a fork.
 *
 * The reference names the source, so marking the same reader from the same
 * source again records nothing new until a person clears the reader, whose
 * clear forgets the reference. A mark that cannot be recorded, or a source
 * whose mark cannot be read, is `refused`: the caller withholds the text.
 */
export function markReaderOfMarkedThread(input: {
  readonly marks: ThreadOutsideContentMarks;
  readonly readerThreadId: string;
  readonly sourceThreadId: string;
  readonly sourceLabel: string;
  readonly correlationId: () => string;
}): ReaderMarking {
  // A thread reading itself already carries whatever mark it has.
  if (input.readerThreadId === input.sourceThreadId) return { status: "nothing-to-mark" };
  try {
    if (!input.marks.isMarked(input.sourceThreadId)) return { status: "nothing-to-mark" };
  } catch {
    return { status: "refused" };
  }
  return recordReaderMark({
    marks: input.marks,
    readerThreadId: input.readerThreadId,
    sourceLabel: input.sourceLabel,
    contentReference: `${input.sourceLabel}-${input.sourceThreadId}`,
    correlationId: input.correlationId,
  });
}

/**
 * Marks a thread whose model is about to read outside text that marked no
 * thread yet, such as a subagent's reply its parent has not taken in. Like
 * `markReaderOfMarkedThread`, it runs before the text is handed on, and a
 * `refused` mark means the caller withholds the text.
 */
export function recordReaderMark(input: {
  readonly marks: ThreadOutsideContentMarks;
  readonly readerThreadId: string;
  readonly sourceLabel: string;
  readonly contentReference: string;
  readonly correlationId: () => string;
}): ReaderMarking {
  try {
    const recorded = input.marks.record({
      threadId: input.readerThreadId,
      provenance: { origin: "external-content", sourceLabel: input.sourceLabel },
      contentReference: input.contentReference,
      correlationId: input.correlationId(),
      authorized: true,
    });
    return recorded.kind === "recorded" || recorded.kind === "already-recorded"
      ? { status: "marked" }
      : { status: "refused" };
  } catch {
    return { status: "refused" };
  }
}
