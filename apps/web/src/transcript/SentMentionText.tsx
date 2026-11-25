import { findSentThreadMentions } from "@octant/domain";
import { Fragment, type ReactNode } from "react";
import { ThreadReferenceChip } from "../threadReferences/ThreadReferenceChip";
import { useThreadReferences } from "../threadReferences/useThreadReferences";
import { useTrackerReferenceResolutions } from "../tracker/TrackerReferenceContext";
import { renderWithTrackerReferences } from "../tracker/TrackerReferenceText";

/**
 * A message's text with its tracker tags and the threads it mentioned as chips.
 * The turn records only the mentioned ids, so a mention is a chip while this
 * window lists its thread and otherwise stays the text the person wrote.
 */
export function SentMentionText(props: {
  readonly text: string;
  readonly threadMentionIds: ReadonlyArray<string>;
}) {
  const { text } = props;
  const { spans, byIdentity } = useTrackerReferenceResolutions(text);
  const references = useThreadReferences();
  const mentions = findSentThreadMentions(
    text,
    props.threadMentionIds,
    (threadId) => references.find(threadId)?.thread.title,
  );
  const between = (start: number, end: number): ReactNode =>
    renderWithTrackerReferences(
      text.slice(start, end),
      spans
        .filter((span) => span.start >= start && span.end <= end)
        .map((span) => ({ ...span, start: span.start - start, end: span.end - start })),
      byIdentity,
    );
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    parts.push(
      <Fragment key={`text-${String(cursor)}`}>{between(cursor, mention.start)}</Fragment>,
      <ThreadReferenceChip
        key={`mention-${String(mention.start)}`}
        threadId={mention.threadId}
        title={mention.text.slice(2, -1)}
      />,
    );
    cursor = mention.end;
  }
  parts.push(<Fragment key={`text-${String(cursor)}`}>{between(cursor, text.length)}</Fragment>);
  return <p className="tracker-reference-text">{parts}</p>;
}
