/**
 * What the person typed, pasted, or dictated into a composer, so a send can say
 * so. Provenance belongs to a draft, not to a string: each composer keeps the
 * last text the person's own input left in its draft scope (a thread's or new
 * task's draft key, else the composer instance), so typing in one composer never
 * makes the same words in another count, and a send asks the scope it sends
 * from. A composer's own input events (typing, paste, cut, undo, dictation)
 * note the text they leave; a button, template, recipe, or prefill replaces a
 * draft without going through them, which forgets the scope's note unless the
 * text is the person's own restored draft (a thread switch or a stash brings the
 * note back with the draft). A send claims "typed by the person" only when the
 * exact text it sends is the one its scope holds, so a draft a button prefilled
 * counts only after the person changed it. The claim is only a claim: the host
 * believes it on the person's own routes and nowhere else.
 */
const SCOPE_LIMIT = 256;
const typed = new Map<string, string>();

/** The draft scope of an open thread's composer. */
export function threadDraftScope(mode: "chat" | "work" | "code", threadId: string): string {
  return `${mode}:${threadId}`;
}

/** Called by a composer's input after the person's own edit in `scope`. */
export function noteTypedComposerText(scope: string, text: string): void {
  const trimmed = text.trim();
  typed.delete(scope);
  if (trimmed.length === 0) return;
  typed.set(scope, trimmed);
  // A scope forgotten only costs a claim, never grants one.
  while (typed.size > SCOPE_LIMIT) {
    const oldest = typed.keys().next();
    if (oldest.done === true) break;
    typed.delete(oldest.value);
  }
}

/**
 * A caller replaced the scope's draft with `text` without the person's input:
 * the note stays only when the text is the one the person typed (a restored
 * draft), so a later prefill of the same words cannot inherit it.
 */
export function composerTextReplaced(scope: string, text: string): void {
  if (typed.get(scope) !== text.trim()) typed.delete(scope);
}

/** Whether the person's own input last left exactly this text in the scope's draft. */
export function composerTextWasTyped(scope: string, text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && typed.get(scope) === trimmed;
}

/** `{ typedByPerson: true }` for a send of text the scope's person typed, else nothing. */
export function typedClaimFor(scope: string, text: string): { readonly typedByPerson?: true } {
  return composerTextWasTyped(scope, text) ? { typedByPerson: true } : {};
}

/**
 * A new-task composer cannot hand its scope to the handler that builds the
 * command, so its submit leaves the answer here for that command. Every
 * composer's submit replaces it, so a send that never reached the host leaves
 * nothing for another composer's identical text to find.
 */
let armed: string | undefined;

/** A composer's submit: whether `text` is what the person typed in `scope`. */
export function armTypedClaim(scope: string, text: string): void {
  armed = composerTextWasTyped(scope, text) ? text.trim() : undefined;
}

/** The claim a composer's submit armed for exactly this text; it is spent by being read. */
export function armedTypedClaimFor(text: string): { readonly typedByPerson?: true } {
  const claim = armed !== undefined && armed === text.trim();
  armed = undefined;
  return claim ? { typedByPerson: true } : {};
}

/** Forgets one scope's note, or every note, for a test or a closed draft. */
export function forgetTypedComposerText(scope?: string): void {
  if (scope === undefined) {
    typed.clear();
    armed = undefined;
  } else typed.delete(scope);
}
