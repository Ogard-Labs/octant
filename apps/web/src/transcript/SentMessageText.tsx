import type { TrackerMention } from "@octant/contracts";
import { lazyOr } from "../lib/lazyOr";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";

const LazySentMentionText = lazyOr<{
  readonly text: string;
  readonly threadMentionIds: ReadonlyArray<string>;
  readonly trackerMentions: ReadonlyArray<TrackerMention>;
}>(
  async () => (await import("./SentMentionText")).SentMentionText,
  ({ text }) => <TrackerReferenceText asParagraph text={text} />,
);

/**
 * A person's message as they sent it, with its tracker tags and the threads,
 * pull requests and issues it mentioned shown as chips. A message that recorded
 * no mention is its own text.
 */
export function SentMessageText(props: {
  readonly text: string;
  readonly threadMentionIds?: ReadonlyArray<string> | undefined;
  readonly trackerMentions?: ReadonlyArray<TrackerMention> | undefined;
}) {
  const threadMentionIds = props.threadMentionIds ?? [];
  const trackerMentions = props.trackerMentions ?? [];
  return threadMentionIds.length === 0 && trackerMentions.length === 0 ? (
    <TrackerReferenceText asParagraph text={props.text} />
  ) : (
    <LazySentMentionText
      text={props.text}
      threadMentionIds={threadMentionIds}
      trackerMentions={trackerMentions}
    />
  );
}
