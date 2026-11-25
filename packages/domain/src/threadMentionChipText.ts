/**
 * A chip is written into the draft as `#[Title]`. Bracket delimiters exist
 * because thread titles contain spaces: a bare `#Title` chip could not be
 * told apart from ordinary prose that follows it, so deleting part of the
 * title would silently leave a chip pointing at text the user no longer sees.
 * Brackets make chip presence a decidable substring check.
 */
export function formatThreadMentionChip(title: string): string {
  return `#[${collapseChipTitle(title)}]`;
}

/**
 * Chip titles are single-line and length-capped: a chip is an inline token in a
 * textarea, so an embedded newline would break the draft it lives in.
 */
function collapseChipTitle(title: string): string {
  const collapsed = title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[[\]]/g, "")
    .trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 119)}…`;
}

/**
 * Title a Side Chat sidecar as being *about* its source thread, so the sidecar
 * reads as a question lane rather than a duplicate of the source conversation.
 */
export function sideChatTitle(sourceTitle: string): string {
  const trimmed = collapseChipTitle(sourceTitle);
  const title = `Side Chat about ${trimmed.length === 0 ? "this thread" : trimmed}`;
  return title.length <= 400 ? title : `${title.slice(0, 399)}…`;
}
