/**
 * The answer a provider gets when it asks the person for a secret. A password
 * or key typed into the questionnaire would sit in the thread's journal and
 * the provider's own history, so the set is answered with this instead, and
 * the model is pointed at the channels that keep secrets out of the
 * conversation.
 */
export const SECRET_QUESTION_REFUSAL =
  "Octant does not collect secrets, passwords, or keys in chat. Ask the person to put it in a credential or environment setting outside the conversation, then continue without it.";

const SECRET_QUESTION =
  /\b(?:password|passphrase|passcode|api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|private[\s_-]?key|bearer[\s_-]?token)s?\b/iu;

/** Whether a question's text or header asks for a secret. */
export function asksForSecret(text: string): boolean {
  return SECRET_QUESTION.test(text);
}
