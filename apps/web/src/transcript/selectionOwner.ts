/**
 * One document `selectionchange` listener for every reply that offers an
 * action on selected text. Each reply used to add its own listener, so a long
 * transcript ran hundreds of callbacks and state updates per caret move. Now
 * only the replies holding the selection, and those that just lost it, hear
 * about it.
 */
type SelectionReader = (text: string) => void;

const readers = new Map<SelectionReader, () => HTMLElement | null>();
// Replies can nest (a quotable chat reply around a reply body), so the
// selection can have more than one owner.
let owners = new Set<SelectionReader>();

function onSelectionChange(): void {
  const selection = document.getSelection();
  const next = new Set<SelectionReader>();
  let text = "";
  if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0) {
    const { anchorNode, focusNode } = selection;
    text = selection.toString().trim();
    if (anchorNode !== null && focusNode !== null && text !== "") {
      for (const [reader, container] of readers) {
        const element = container();
        if (element?.contains(anchorNode) === true && element.contains(focusNode)) {
          next.add(reader);
        }
      }
    }
  }
  const previous = owners;
  owners = next;
  for (const reader of previous) if (!next.has(reader)) reader("");
  for (const reader of next) reader(text);
}

/** Calls `read` with the selected text while the selection lies within `container`, and "" when it leaves. */
export function followSelectionWithin(
  container: () => HTMLElement | null,
  read: SelectionReader,
): () => void {
  if (readers.size === 0) document.addEventListener("selectionchange", onSelectionChange);
  readers.set(read, container);
  return () => {
    readers.delete(read);
    owners.delete(read);
    if (readers.size === 0) document.removeEventListener("selectionchange", onSelectionChange);
  };
}
