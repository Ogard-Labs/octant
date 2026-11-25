import { lazyOr } from "../lib/lazyOr";
import { TrackerReferenceText } from "../tracker/TrackerReferenceText";

const LazySentMentionText = lazyOr<{
  readonly text: string;
  readonly threadMentionIds: ReadonlyArray<string>;
}>(
  async () => (await import("./SentMentionText")).SentMentionText,
  ({ text }) => <TrackerReferenceText asParagraph text={text} />,
);

/**
 * A person's message as they sent it, with its tracker tags and the threads it
 * mentioned shown as chips. A message that recorded no mention is its own text.
 */
export function SentMessageText(props: {
  readonly text: string;
  readonly threadMentionIds?: ReadonlyArray<string> | undefined;
}) {
  return props.threadMentionIds === undefined || props.threadMentionIds.length === 0 ? (
    <TrackerReferenceText asParagraph text={props.text} />
  ) : (
    <LazySentMentionText text={props.text} threadMentionIds={props.threadMentionIds} />
  );
}
