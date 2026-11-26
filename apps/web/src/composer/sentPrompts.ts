const RECALL_LIMIT = 100;

/**
 * The prompts the person sent in a thread, newest first, for ArrowUp recall:
 * each item read as the person's own text (or skipped), blanks dropped, and a
 * prompt sent twice in a row recalled once.
 */
export function sentPromptsNewestFirst<Item>(
  items: ReadonlyArray<Item>,
  read: (item: Item) => string | undefined,
): ReadonlyArray<string> {
  const prompts: Array<string> = [];
  for (let index = items.length - 1; index >= 0 && prompts.length < RECALL_LIMIT; index -= 1) {
    const item = items[index];
    const text = item === undefined ? undefined : read(item)?.trim();
    if (text === undefined || text === "" || prompts.at(-1) === text) continue;
    prompts.push(text);
  }
  return prompts;
}
