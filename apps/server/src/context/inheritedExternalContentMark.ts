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
