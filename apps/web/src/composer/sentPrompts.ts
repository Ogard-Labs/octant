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

/**
 * What ArrowUp may recall: nothing while anything sits beside the prompt
 * (counts of attachments, uploads, receipts or selections), since a recalled
 * prompt would be sent with context it never had.
 */
export function promptsToRecall(
  beside: Readonly<Record<string, number>>,
  prompts: () => ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  return Object.values(beside).some((count) => count > 0) ? undefined : prompts();
}
