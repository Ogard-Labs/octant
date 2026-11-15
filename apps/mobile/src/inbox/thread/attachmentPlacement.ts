import type { ChatAttachment } from "@octant/contracts";

/**
 * Where each attachment is drawn: under the message it was sent with, keyed by
 * that message's content id, or under "" (above the transcript) when it names
 * no turn or its turn's message is not shown.
 */
export function placeAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly turns: ReadonlyArray<{
    readonly id: unknown;
    readonly userMessageRef: { readonly contentId: unknown };
  }>;
  readonly shownMessageIds: ReadonlyArray<string>;
}): ReadonlyMap<string, ReadonlyArray<ChatAttachment>> {
  const messageForTurn = new Map(
    input.turns.map((turn) => [String(turn.id), String(turn.userMessageRef.contentId)]),
  );
  const shown = new Set(input.shownMessageIds);
  const placed = new Map<string, Array<ChatAttachment>>();
  for (const attachment of input.attachments) {
    const message =
      attachment.turnId === undefined ? undefined : messageForTurn.get(String(attachment.turnId));
    const key = message !== undefined && shown.has(message) ? message : "";
    placed.set(key, [...(placed.get(key) ?? []), attachment]);
  }
  return placed;
}
