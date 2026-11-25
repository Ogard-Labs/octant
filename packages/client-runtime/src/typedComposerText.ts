/**
 * What the person typed, pasted, or dictated into a composer, so a send can say
 * so. A composer's own input events (typing, paste, cut, undo, dictation) note
 * the text they leave; a button, template, recipe, or prefill writes a draft
 * without going through them, so its text is never noted. A send claims
 * "typed by the person" only when the exact text it sends was last left by the
 * person's own input, which makes a draft a button prefilled count only after
 * the person changed it. The claim is only a claim: the host believes it on the
 * person's own routes and nowhere else.
 */
const RECENT_LIMIT = 16;
const recent: string[] = [];

/** Called by a composer's input after the person's own edit. */
export function noteTypedComposerText(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const at = recent.indexOf(trimmed);
  if (at >= 0) recent.splice(at, 1);
  recent.push(trimmed);
  while (recent.length > RECENT_LIMIT) recent.shift();
}

/** Whether the person's own input last left exactly this text in a composer. */
export function composerTextWasTyped(text: string): boolean {
  return recent.includes(text.trim());
}

/** `{ typedByPerson: true }` for a send of text the person typed, else nothing. */
export function typedClaimFor(text: string): { readonly typedByPerson?: true } {
  return composerTextWasTyped(text) ? { typedByPerson: true } : {};
}

/** Forgets what was noted, for a test. */
export function forgetTypedComposerText(): void {
  recent.length = 0;
}
