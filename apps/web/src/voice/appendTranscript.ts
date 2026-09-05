/**
 * A transcript joins the draft as more of the same message: separated by one
 * space from what was already typed, never replacing it. The person still
 * reads and sends the result.
 */
export function appendTranscript(draft: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken.length === 0) return draft;
  if (draft.length === 0) return spoken;
  return /\s$/.test(draft) ? `${draft}${spoken}` : `${draft} ${spoken}`;
}
