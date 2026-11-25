import { MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES } from "@octant/contracts";
import { findThreadMentionTags } from "@octant/domain";
import type { ComposerInputElement } from "../composer/ComposerInput";
import { ThreadReferenceChip } from "../threadReferences/ThreadReferenceChip";
import type { ThreadMentionChip, ThreadMentions } from "./ThreadMentionPicker";

export interface ThreadMentionChipProps {
  readonly chip: ThreadMentionChip;
  readonly mentions: ThreadMentions;
  readonly draft: string;
  readonly onDraftChange: (draft: string, caretIndex: number) => void;
  readonly textarea: () => ComposerInputElement | null;
}

/** A mentioned thread in the prompt: what this turn reads of it, and how to take it back. */
export function ThreadMentionInlineChip(props: ThreadMentionChipProps) {
  const { chip, mentions } = props;
  const canReceive = mentions.dialogueEnabled === true && chip.mode === "chat";
  const openSideChat = mentions.onOpenSideChat;

  // The mention and the text that shows it leave together: text left behind
  // would read as a mention the turn no longer carries.
  function remove() {
    let draft = props.draft;
    let caretIndex = draft.length;
    for (const tag of findThreadMentionTags(draft, mentions.chips).toReversed()) {
      if (String(tag.chip.threadId) !== String(chip.threadId)) continue;
      // A chip is written with one space after it; taking the chip takes that
      // space where it would leave two, or one at the start of the draft.
      const opensWithSpace = tag.start === 0 || /\s/.test(draft[tag.start - 1] ?? "");
      const end = opensWithSpace && draft[tag.end] === " " ? tag.end + 1 : tag.end;
      draft = `${draft.slice(0, tag.start)}${draft.slice(end)}`;
      caretIndex = tag.start;
    }
    mentions.onRemoveChip(chip.threadId);
    props.onDraftChange(draft, caretIndex);
    queueMicrotask(() => {
      const element = props.textarea();
      if (element === null) return;
      element.focus();
      element.setSelectionRange(caretIndex, caretIndex);
    });
  }

  return (
    <ThreadReferenceChip
      access={canReceive ? "Can receive a message" : "Read-only"}
      actions={[
        ...(openSideChat === undefined
          ? []
          : [
              {
                label: chip.hasSideChat === true ? "Reopen Side Chat" : "Side Chat",
                onSelect: () => openSideChat(chip.threadId),
                disabled: chip.unavailableReason !== undefined,
              },
            ]),
        { label: "Remove", onSelect: remove },
      ]}
      fallback={{ mode: chip.mode, placement: chip.placementLabel }}
      receipt={`This turn reads up to its last ${String(
        MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES,
      )} messages${canReceive ? ", and it can receive a message." : ", read-only."}`}
      threadId={String(chip.threadId)}
      title={chip.title}
      {...(chip.unavailableReason === undefined
        ? {}
        : { unavailableReason: chip.unavailableReason })}
    />
  );
}
