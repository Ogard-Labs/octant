import type { ProviderSlashCommand } from "@octant/contracts";

const MAX_SUGGESTIONS = 8;

/**
 * The name being typed when the whole message so far is a `/` and a name with
 * no space yet. A command anywhere else in a message is plain text to the
 * provider, so nothing is offered there.
 */
export function slashCommandQuery(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const typed = text.slice(1);
  return /\s/.test(typed) ? undefined : typed;
}

/** Names starting with the query first, then names containing it, at most eight. */
export function matchingSlashCommands(
  commands: ReadonlyArray<ProviderSlashCommand>,
  query: string,
): ReadonlyArray<ProviderSlashCommand> {
  const needle = query.toLowerCase();
  const starts: ProviderSlashCommand[] = [];
  const contains: ProviderSlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(command);
    else if (name.includes(needle)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}
