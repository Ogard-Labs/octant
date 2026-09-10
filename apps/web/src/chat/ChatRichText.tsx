import { useCallback } from "react";
import { Markdown } from "../markdown/Markdown";
import { useTrackerReferenceResolutions } from "../tracker/TrackerReferenceContext";
import { splitPlainTextWithTrackerReferences } from "../tracker/TrackerReferenceText";

export interface ChatRichTextProps {
  readonly body: string;
}

/**
 * A reply, rendered as Markdown with tracker references resolved in its prose.
 *
 * The resolution is why this is a thread surface rather than the shared
 * renderer: it reaches the tracker over the network, on a debounce, so a
 * previewed file must not go through here just to be shown as Markdown.
 */
export function ChatRichText(props: ChatRichTextProps) {
  const { byIdentity } = useTrackerReferenceResolutions(props.body);
  // Stable per resolution set so the memoized renderer below can keep its
  // parse; an inline closure would be a new prop on every render.
  const transformText = useCallback(
    (text: string) => splitPlainTextWithTrackerReferences(text, byIdentity),
    [byIdentity],
  );
  return <Markdown body={props.body} className="chat-rich-text" transformText={transformText} />;
}
