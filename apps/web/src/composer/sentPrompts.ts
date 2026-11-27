export interface SentPrompt {
  readonly id?: string;
  readonly text: string;
}

const RECALL_LIMIT = 100;

/**
 * The prompts the person sent in a thread, newest first, for ArrowUp recall:
 * each item read as the person's own text (or skipped), blanks dropped, and a
 * prompt sent twice in a row recalled once.
 */
export function sentPromptsNewestFirst<Item>(
  items: ReadonlyArray<Item>,
  read: (item: Item) => SentPrompt | undefined,
): ReadonlyArray<SentPrompt> {
  const prompts: Array<SentPrompt> = [];
  for (let index = items.length - 1; index >= 0 && prompts.length < RECALL_LIMIT; index -= 1) {
    const item = items[index];
    const prompt = item === undefined ? undefined : read(item);
    if (prompt === undefined) continue;
    const text = prompt.text.trim();
    if (text === "" || prompts.at(-1)?.text === text) continue;
    prompts.push({ ...prompt, text });
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
  prompts: () => ReadonlyArray<SentPrompt>,
): ReadonlyArray<SentPrompt> | undefined {
  return Object.values(beside).some((count) => count > 0) ? undefined : prompts();
}
