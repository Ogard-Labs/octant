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
/** The last few texts each scope's person typed, for a field that shows its value late. */
const echoes = new Map<string, string[]>();
const ECHO_LIMIT = 8;

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
  echoes.set(
    scope,
    [...(echoes.get(scope) ?? []).filter((text) => text !== trimmed), trimmed].slice(-ECHO_LIMIT),
  );
  // A scope forgotten only costs a claim, never grants one.
  while (typed.size > SCOPE_LIMIT) {
    const oldest = typed.keys().next();
    if (oldest.done === true) break;
    typed.delete(oldest.value);
    echoes.delete(oldest.value);
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

/**
 * A native field showed `text` after the person typed it, perhaps a keystroke
 * late: the person's own earlier text is not a replacement, anything else is.
 */
export function composerValueShown(scope: string, text: string): void {
  const trimmed = text.trim();
  if (typed.get(scope) === trimmed || (echoes.get(scope) ?? []).includes(trimmed)) return;
  typed.delete(scope);
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
 * command, so the claim travels for the length of the one synchronous call that
 * hands the prompt over: `sendingTyped` sets it around that call and puts back
 * what it found, and the handler reads it with `typedSendClaim` before its
 * first await. Nothing outlives the call, so a submit that never reached a
 * handler leaves nothing, and a second submit cannot take the first one's claim.
 * A relay that waits before calling the handler loses the claim, never gains one.
 */
let sending: { readonly text: string } | undefined;

/** Runs `send`, a composer handing `text` to the handler that starts the thread, with its claim. */
export function sendingTyped<Result>(
  typedByPerson: boolean,
  text: string,
  send: () => Result,
): Result {
  const outer = sending;
  sending = typedByPerson ? { text: text.trim() } : undefined;
  try {
    return send();
  } finally {
    sending = outer;
  }
}

/** The claim of the send now being handed over, for exactly this text; read before the first await. */
export function typedSendClaim(text: string): { readonly typedByPerson?: true } {
  return sending !== undefined && sending.text === text.trim() ? { typedByPerson: true } : {};
}

/**
 * `fn`, called with the claim of `text` in `scope` as the draft holds it when
 * the call is made.
 */
export function withTypedSend<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
  scope: string,
  text: string,
): (...args: Args) => Result {
  return (...args) => sendingTyped(composerTextWasTyped(scope, text), text, () => fn(...args));
}

/** Forgets one scope's note, or every note, for a test or a closed draft. */
export function forgetTypedComposerText(scope?: string): void {
  if (scope === undefined) {
    typed.clear();
    echoes.clear();
  } else {
    typed.delete(scope);
    echoes.delete(scope);
  }
}
