import { FOLLOW_UP_BLOCK_LANGUAGE, type ProviderContextBlock } from "@octant/contracts";

/**
 * How any model offers the next tasks, and predicts the person's next message,
 * in every mode and on every provider.
 * The text is one fixed block, with no mode, thread, or time in it, so it
 * never breaks a provider's prefix cache; the host decides per thread what
 * each target may create.
 */
export const FOLLOW_UP_SUGGESTION_INSTRUCTIONS: ProviderContextBlock = {
  kind: "instructions",
  text: [
    "End your reply with one fenced block, after any decision block, in exactly this form:",
    `\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}`,
    '{"next":"...","suggestions":[{"title":"...","prompt":"...","target":"new-thread"}]}',
    "```",
    'next is the message the user is most likely to send you next, written as they would type it: their voice, one short line, such as "yes, go ahead" or "now add tests for that". Never write it as yourself or as a question to the user, and leave it out when you cannot guess with confidence.',
    'suggestions is up to three follow-ups the user could start next. Offer them only when there is clear, separable next work; most replies leave the list empty. target is "same-thread" (continue here), "new-thread" (a fresh thread in the same Project), or "new-worktree" (Code only: a fresh thread on its own worktree), title is a few words, and prompt stands on its own for a reader with none of this conversation.',
    "Leave the block out when it would hold nothing. Neither field sends or creates anything until the user chooses it.",
  ].join("\n"),
};
