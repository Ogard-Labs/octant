/**
 * The placeholder is the legend: it names the triggers a composer actually
 * mounts, so a reader learns that `/` runs a command, `@` names a file and
 * `#` names a thread without typing one by accident. A hint is passed only
 * where its typeahead is wired; an unmounted hint would promise a trigger
 * that does nothing.
 */
export const COMMAND_HINT = "/ commands";
export const FILE_HINT = "@ files";
export const THREAD_HINT = "# threads";

export function composerPlaceholder(
  lead: string,
  hints: ReadonlyArray<string | undefined>,
): string {
  return [lead, ...hints.filter((hint): hint is string => hint !== undefined)].join(" · ");
}
