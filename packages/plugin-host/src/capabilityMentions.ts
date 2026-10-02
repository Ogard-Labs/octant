import type { ExtensionSelection } from "@octant/contracts/extensions";
import { isBrowserUseSelection } from "./browserUsePlugin";
import { isComputerUseSelection } from "./computerUsePlugin";

/**
 * An app-owned `@` token still present in outgoing draft text without the
 * selection it names. The composers resolve `@Computer` and `@Browser` into
 * structured selections through the typeahead; one that reaches the provider
 * as plain text describes a capability the turn does not carry and invites
 * the model to improvise around the gap, so a send that still carries one is
 * refused instead.
 */
export interface UnattachedCapabilityMention {
  readonly label: "Computer" | "Browser";
  readonly token: "@computer" | "@browser";
}

const CAPABILITY_MENTION_TOKENS: ReadonlyArray<{
  readonly label: UnattachedCapabilityMention["label"];
  readonly matches: (selection: ExtensionSelection) => boolean;
  readonly pattern: RegExp;
  readonly token: UnattachedCapabilityMention["token"];
}> = [
  {
    label: "Computer",
    matches: isComputerUseSelection,
    pattern: /(?:^|\s)@computer\b/i,
    token: "@computer",
  },
  {
    label: "Browser",
    matches: isBrowserUseSelection,
    pattern: /(?:^|\s)@browser\b/i,
    token: "@browser",
  },
];

export function unattachedCapabilityMentions(
  prompt: string,
  selections: ReadonlyArray<ExtensionSelection>,
): ReadonlyArray<UnattachedCapabilityMention> {
  return CAPABILITY_MENTION_TOKENS.flatMap((capability) =>
    capability.pattern.test(prompt) && !selections.some(capability.matches)
      ? [{ label: capability.label, token: capability.token }]
      : [],
  );
}

/**
 * The refusal reason a refused send shows beside the composer.
 *
 * `mentionsAttach` names whether this composer can attach the token at all: a
 * first-message composer with no suggestion list cannot tell the person to
 * pick one, so it points them at the thread that can.
 */
export function unattachedCapabilityMentionCopy(
  mentions: ReadonlyArray<UnattachedCapabilityMention>,
  mentionsAttach = true,
): string {
  const listed = mentions.map((mention) => `@${mention.label}`).join(" and ");
  const subject = `${listed} ${mentions.length === 1 ? "is" : "are"} not attached to this message.`;
  return mentionsAttach
    ? `${subject} Pick the mention from the suggestion list, or remove the token, then send again.`
    : `${subject} Remove the token and send again, or start the thread and pick ${listed} from the suggestion list there.`;
}
