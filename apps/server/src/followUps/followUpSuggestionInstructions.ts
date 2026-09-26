import { FOLLOW_UP_BLOCK_LANGUAGE, type ProviderContextBlock } from "@octant/contracts";

/**
 * How any model offers the next tasks, in every mode and on every provider.
 * The text is one fixed block, with no mode, thread, or time in it, so it
 * never breaks a provider's prefix cache; the host decides per thread what
 * each target may create.
 */
export const FOLLOW_UP_SUGGESTION_INSTRUCTIONS: ProviderContextBlock = {
  kind: "instructions",
  text: [
    "At the end of a turn you may suggest up to three follow-ups the user could start next. Suggest them only when there is clear, separable next work; most replies need none. Emit them only as the last thing in your reply, in exactly this form:",
    `\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}`,
    '{"suggestions":[{"title":"...","prompt":"...","target":"new-thread"}]}',
    "```",
    'where target is "same-thread" (continue here), "new-thread" (a fresh thread in the same Project), or "new-worktree" (Code only: a fresh thread on its own worktree), title is a few words, and prompt stands on its own for a reader with none of this conversation. Suggestions create nothing until the user confirms one.',
  ].join("\n"),
};
