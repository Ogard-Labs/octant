import type { KeyboardEvent } from "react";
import { suggestionPlaceholder, useComposerSuggestion } from "../followUps/FollowUpSuggestionChips";

export interface ComposerSuggestionInput {
  /** "Reply…", or the suggested next message while the composer is empty. */
  readonly placeholder: string;
  /** The empty composer is showing a suggestion it takes on Tab. */
  readonly suggested: boolean;
  /** Takes the suggestion on a bare Tab; answers whether it did. */
  readonly takeOnTab: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * The placeholder and Tab of a thread's follow-up composer, the same in Chat,
 * Work, and Code. The words stay "Reply…" whether or not a turn is running:
 * switching to "Send the next message…" mid-turn changed the box under the
 * person's eyes. When the latest reply suggested a next message here, the
 * empty composer shows it and a bare Tab puts it in the draft; with text
 * typed, or a modifier held, Tab keeps its ordinary meaning.
 */
export function useComposerSuggestionInput(
  draft: string,
  apply: (text: string) => void,
): ComposerSuggestionInput {
  const suggestion = useComposerSuggestion();
  const offered = draft.length === 0 ? suggestion : undefined;
  return {
    placeholder: offered === undefined ? "Reply…" : suggestionPlaceholder(offered.prompt),
    suggested: offered !== undefined,
    takeOnTab: (event) => {
      if (
        offered === undefined ||
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.nativeEvent.isComposing
      ) {
        return false;
      }
      event.preventDefault();
      apply(offered.prompt);
      offered.markUsed();
      return true;
    },
  };
}
