import type { TrackerMention } from "@octant/contracts";
import { findSentThreadMentions, findTrackerMentionSpans } from "@octant/domain";
import { Fragment, type ReactNode } from "react";
import { ThreadReferenceChip } from "../threadReferences/ThreadReferenceChip";
import { TrackerMentionChip } from "../trackerMentions/TrackerMentionChip";
import { useThreadReferences } from "../threadReferences/useThreadReferences";
import { useTrackerReferenceResolutions } from "../tracker/TrackerReferenceContext";
import { renderWithTrackerReferences } from "../tracker/TrackerReferenceText";

/**
 * A message's text with its tracker tags and what it mentioned as chips. The
 * turn records only a thread's id, so a thread is a chip while this window
 * lists it and otherwise stays the text the person wrote. A pull request or
 * issue is drawn from the turn's own record and the text, asking no tracker.
 */
export function SentMentionText(props: {
  readonly text: string;
  readonly threadMentionIds: ReadonlyArray<string>;
  readonly trackerMentions: ReadonlyArray<TrackerMention>;
}) {
  const { text } = props;
  const { spans, byIdentity } = useTrackerReferenceResolutions(text);
  const references = useThreadReferences();
  const threads = findSentThreadMentions(
    text,
    props.threadMentionIds,
    (threadId) => references.find(threadId)?.thread.title,
  ).map((mention) => ({
    start: mention.start,
    end: mention.end,
    chip: (
      <ThreadReferenceChip
        key={`mention-${String(mention.start)}`}
        threadId={mention.threadId}
        title={mention.text.slice(2, -1)}
      />
    ),
  }));
  const recorded = new Map(props.trackerMentions.map((mention) => [mention.url, mention]));
  const items = findTrackerMentionSpans(text).flatMap((span) => {
    const mention = recorded.get(span.mention.url);
    return mention === undefined
      ? []
      : [
          {
            start: span.start,
            end: span.end,
            chip: (
              <TrackerMentionChip
                key={`item-${String(span.start)}`}
                mention={mention}
                title={span.title}
              />
            ),
          },
        ];
  });
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
  for (const mention of [...threads, ...items].sort((left, right) => left.start - right.start)) {
    parts.push(
      <Fragment key={`text-${String(cursor)}`}>{between(cursor, mention.start)}</Fragment>,
      mention.chip,
    );
    cursor = mention.end;
  }
  parts.push(<Fragment key={`text-${String(cursor)}`}>{between(cursor, text.length)}</Fragment>);
  return <p className="tracker-reference-text">{parts}</p>;
}
