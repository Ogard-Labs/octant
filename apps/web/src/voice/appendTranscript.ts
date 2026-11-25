import { noteTypedComposerText } from "@octant/client-runtime/typed-composer-text";

/**
 * A transcript joins the draft as more of the same message: separated by one
 * space from what was already typed, never replacing it. The person still
 * reads and sends the result. What the person dictated is theirs as typing is,
 * so the joined draft is noted as typed.
 */
export function appendTranscript(draft: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken.length === 0) return draft;
  const joined =
    draft.length === 0 ? spoken : /\s$/.test(draft) ? `${draft}${spoken}` : `${draft} ${spoken}`;
  noteTypedComposerText(joined);
  return joined;
}
