import { bracketSpans, findThreadMentionTags } from "./threadMentionChips";
import { formatThreadMentionChip } from "./threadMentionChipText";

/** One chip a sent message shows: the thread it names, and where its text stands. */
export interface SentThreadMention {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly threadId: string;
}

/**
 * Where the threads a sent message mentioned stand in its text. The message
 * records the mentioned ids in the order its text shows them, and no title, so
 * a message that holds exactly one chip text for each id pairs them in order,
 * a thread renamed since included. Otherwise (chip text typed by hand, or one
 * thread named twice) an id takes the text its thread's title reads as now,
 * unless another of the ids, unlisted or renamed, could stand there instead.
 * An id this window does not list, and text whose thread cannot be told, stay
 * ordinary text, and a chip only ever opens a thread the message mentioned.
 */
export function findSentThreadMentions(
  text: string,
  threadIds: ReadonlyArray<string>,
  titleOf: (threadId: string) => string | undefined,
): ReadonlyArray<SentThreadMention> {
  if (threadIds.length === 0) return [];
  const spans = bracketSpans(text);
  const spanTexts = new Set(spans.map((span) => span.text));
  const mentions = threadIds.map((threadId) => {
    const title = titleOf(threadId);
    const chipText = title === undefined ? undefined : formatThreadMentionChip(title);
    return {
      threadId,
      title,
      /** The text this thread's title reads as now, when the message holds it. */
      ownText: chipText !== undefined && spanTexts.has(chipText) ? chipText : undefined,
    };
  });
  // An id whose title reads as text standing elsewhere means the order cannot
  // be trusted, unless another id already accounts for that text in its own
  // place: then the thread was renamed to a title the message already held.
  const inOrder =
    spans.length === mentions.length &&
    mentions.every(
      (mention, index) =>
        mention.ownText === undefined ||
        mention.ownText === spans[index]?.text ||
        spans.every(
          (span, at) => span.text !== mention.ownText || mentions[at]?.ownText === span.text,
        ),
    );
  if (inOrder) {
    return spans.flatMap((span, index) => {
      const mention = mentions[index];
      return mention === undefined || mention.title === undefined
        ? []
        : [{ ...span, threadId: mention.threadId }];
    });
  }
  const unplaced = mentions.some((mention) => mention.ownText === undefined);
  const named = mentions.flatMap(({ threadId, title, ownText }) => {
    if (title === undefined || ownText === undefined) return [];
    const places = spans.filter((span) => span.text === ownText).length;
    const claims = mentions.filter((mention) => mention.ownText === ownText).length;
    return unplaced && places > claims ? [] : [{ threadId, title }];
  });
  return findThreadMentionTags(text, named).map(({ chip, ...place }) => ({
    ...place,
    threadId: chip.threadId,
  }));
}
