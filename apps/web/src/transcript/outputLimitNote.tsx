import type { ComposerDraftMode } from "../composer/composerThreadDraftStore";
import { composerThreadDrafts } from "../composer/composerThreadDraftStore";
import { useThreadStatsScope } from "../threadStats/threadStatsScope";
import { OctantButton } from "../ui/base/OctantButton";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import "./output-limit-note.css";

/** What Continue puts in the composer. Sending stays the person's move. */
export const OUTPUT_LIMIT_CONTINUE_DRAFT = "Continue from where you left off.";

interface OutputLimitContinueTarget {
  readonly draft: () => void;
}

const OutputLimitContinueContext = createContext<OutputLimitContinueTarget | undefined>(undefined);

/**
 * Continue reuses the composer's unsent draft — the same place a follow-up
 * waits — and never sends. An existing draft is kept and the line is appended.
 */
export function OutputLimitContinueProvider(props: {
  readonly mode: ComposerDraftMode | undefined;
  readonly threadId: string | undefined;
  readonly children: ReactNode;
}) {
  const { mode, threadId } = props;
  const draft = useCallback(() => {
    if (mode === undefined || threadId === undefined) return;
    const existing = composerThreadDrafts.read(mode, threadId);
    const text =
      existing === undefined || existing.text.trim() === ""
        ? OUTPUT_LIMIT_CONTINUE_DRAFT
        : `${existing.text.trimEnd()}\n\n${OUTPUT_LIMIT_CONTINUE_DRAFT}`;
    composerThreadDrafts.write(mode, threadId, {
      text,
      caretIndex: text.length,
      stagedDropped: existing?.stagedDropped === true,
    });
  }, [mode, threadId]);
  const value = useMemo(() => ({ draft }), [draft]);
  return (
    <OutputLimitContinueContext.Provider value={value}>
      {props.children}
    </OutputLimitContinueContext.Provider>
  );
}

/** The quiet line under a reply the output limit cut off, with Continue. */
export function OutputLimitNote(props: {
  readonly cutOff: boolean;
  readonly onDraft: (text: string) => void;
}) {
  if (!props.cutOff) return null;
  return (
    <p className="output-limit-note" role="note">
      <span>This reply was cut off at the output limit.</span>
      <OctantButton
        className="output-limit-note__continue"
        onClick={() => props.onDraft(OUTPUT_LIMIT_CONTINUE_DRAFT)}
        type="button"
        variant="bare"
      >
        Continue
      </OctantButton>
    </p>
  );
}

/**
 * Shows the note only on the transcript whose latest recorded turn was cut
 * off. Continue drafts into that thread's composer and sends nothing.
 */
export function TranscriptOutputLimitNote(props: { readonly restoreKey: string }) {
  const scope = useThreadStatsScope();
  const target = useContext(OutputLimitContinueContext);
  const latest = scope.summary?.turns.at(-1);
  const ownsTurn =
    latest !== undefined &&
    (props.restoreKey === latest.threadId || props.restoreKey.endsWith(`:${latest.threadId}`));
  if (latest?.stopReason !== "max-tokens" || !ownsTurn || target === undefined) return null;
  return <OutputLimitNote cutOff onDraft={() => target.draft()} />;
}
