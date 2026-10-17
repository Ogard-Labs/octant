import type { ChatAttemptHandoff } from "@octant/contracts";
import { providerKeepsConversation, type PickerGroup } from "@octant/domain";
import {
  conversationHandoffDisclosure,
  omissionsDisclosure,
  pendingProviderSwitchNotice,
} from "../code/providerSwitchHandoff";
import { providerModelLabel } from "./providerModelLabel";

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * What a Chat attempt or Work turn handed to its new provider session and what
 * stayed behind, in one sentence. A provider switch reads like Code's, so the
 * three modes disclose a handoff the same way; a branch says the source's later
 * replies did not come with it.
 */
export function threadHandoffDisclosure(
  handoff: ChatAttemptHandoff,
  label: (selection: { readonly providerInstanceId: string; readonly modelId: string }) => string,
): string {
  if (handoff.reason === "provider-switch") return conversationHandoffDisclosure(handoff, label);
  return [
    `Branched with ${count(handoff.messages, "recent message", "recent messages")} of the original conversation as text, up to the reply it was branched from.`,
    omissionsDisclosure(handoff),
    handoff.externalContentIngested ? " The original thread has taken in outside content." : "",
    " Hidden reasoning, tool activity, the original session and its later replies did not transfer.",
  ].join("");
}

/**
 * What the next message will do when it starts a new provider session: said
 * under the composer before the person sends, only when the selected provider
 * keeps its own session and the conversation so far is not in one of its
 * sessions, because another provider holds it or because a branch carries only
 * the original's messages.
 */
export function pendingThreadHandoffNotice(input: {
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selected: { readonly providerInstanceId: unknown; readonly modelId: unknown };
  /** The latest attempt or turn, whose provider holds the conversation so far. */
  readonly latest: { readonly providerInstanceId: unknown; readonly modelId: unknown } | undefined;
  /** A branch that has run no turn of its own yet. */
  readonly branchWithoutSession?: boolean;
}): string | undefined {
  const group = input.groups.find(
    (candidate) => String(candidate.instance.id) === String(input.selected.providerInstanceId),
  );
  if (group === undefined || !providerKeepsConversation(group.instance.driverKind))
    return undefined;
  const next = providerModelLabel(input.groups, input.selected);
  if (input.branchWithoutSession === true) {
    return `Your next message starts a new session on ${next}. The branched conversation goes as text; hidden reasoning and the original session do not carry over.`;
  }
  if (
    input.latest === undefined ||
    String(input.latest.providerInstanceId) === String(input.selected.providerInstanceId)
  )
    return undefined;
  return pendingProviderSwitchNotice(next, providerModelLabel(input.groups, input.latest));
}
