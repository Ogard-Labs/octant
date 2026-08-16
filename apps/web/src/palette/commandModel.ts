/**
 * The one command vocabulary shared by the `/` composer affordance and the
 * global command palette.
 *
 * A command is a *receipt of something the host already offers*, never a new
 * authority. Building one never grants anything: an `address` command hands the
 * composer the same reference a user could type by hand, and a `run` command
 * closes over the exact callback the ordinary mouse-driven control invokes. A
 * source that cannot answer on this host contributes no commands at all, so a
 * listed entry is always one the user could have reached another way.
 */

export type OctantCommandGroup =
  | "Skills"
  | "Agent profiles"
  | "Modes"
  | "Threads"
  | "Projects"
  | "Settings";

/**
 * `run` invokes the callback the equivalent visible control already uses.
 *
 * `address` writes a composer reference (for example `$skill-id`) into the
 * draft resolution path the composer already owns. It carries no selection of
 * its own: the host re-resolves the reference and decides whether it is
 * allowed, exactly as it does when the reference is typed.
 */
export type OctantCommandAction =
  | { readonly kind: "run"; readonly run: () => void }
  | { readonly kind: "address"; readonly reference: string };

export interface OctantCommand {
  readonly id: string;
  readonly title: string;
  readonly group: OctantCommandGroup;
  /** Words shown beside the title. State is always spelled out, never coloured. */
  readonly detail?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly action: OctantCommandAction;
}

/** The `/` token under the caret, or `undefined` when the affordance is closed. */
export interface SlashCommandToken {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/** How many rows either surface will render for one query. */
const MAX_RESULTS = 60;

/**
 * Find the `/` token the caret is inside.
 *
 * The affordance belongs to the *start of the draft* only, and closes as soon
 * as whitespace separates the caret from the slash. That keeps it out of the
 * way of ordinary prose (`and/or`), and makes it structurally impossible for a
 * `#` thread mention and a `/` command to be open at the same time, because a
 * `#` glued to a preceding `/` is not a mention either.
 */
export function parseSlashCommandToken(
  draft: string,
  caretIndex: number | null,
): SlashCommandToken | undefined {
  if (caretIndex === null) return undefined;
  const caret = Math.max(0, Math.min(caretIndex, draft.length));
  if (caret < 1 || draft[0] !== "/") return undefined;
  const head = draft.slice(1, caret);
  if (/\s/.test(head)) return undefined;
  return { query: head, start: 0, end: caret };
}

/**
 * Remove the `/` token once its command has been chosen, leaving any prose the
 * user had already typed after it untouched.
 */
export function applySlashCommandToken(
  draft: string,
  token: SlashCommandToken,
): { readonly draft: string; readonly caretIndex: number } {
  return {
    draft: `${draft.slice(0, token.start)}${draft.slice(token.end)}`,
    caretIndex: token.start,
  };
}

/**
 * Rank commands for a query: a title prefix beats a word start, which beats any
 * other match on the title, detail, group, or keywords. Ties keep the order the
 * caller built, so a host's own ordering survives.
 */
export function filterOctantCommands(
  commands: ReadonlyArray<OctantCommand>,
  query: string,
): ReadonlyArray<OctantCommand> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return commands.slice(0, MAX_RESULTS);
  const scored: Array<{ readonly command: OctantCommand; readonly rank: number }> = [];
  for (const command of commands) {
    const rank = scoreCommand(command, needle);
    if (rank !== undefined) scored.push({ command, rank });
  }
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.command);
}

function scoreCommand(command: OctantCommand, needle: string): number | undefined {
  const title = command.title.toLowerCase();
  if (title.startsWith(needle)) return 0;
  if (title.split(/\s+/).some((word) => word.startsWith(needle))) return 1;
  if (title.includes(needle)) return 2;
  const haystack = [command.detail ?? "", command.group, ...(command.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle) ? 3 : undefined;
}

/** Group commands for display while preserving the ranked order within a group. */
export function groupOctantCommands(commands: ReadonlyArray<OctantCommand>): ReadonlyArray<{
  readonly group: OctantCommandGroup;
  readonly commands: ReadonlyArray<OctantCommand>;
}> {
  const order: Array<OctantCommandGroup> = [];
  const byGroup = new Map<OctantCommandGroup, Array<OctantCommand>>();
  for (const command of commands) {
    const existing = byGroup.get(command.group);
    if (existing === undefined) {
      order.push(command.group);
      byGroup.set(command.group, [command]);
    } else {
      existing.push(command);
    }
  }
  return order.map((group) => ({ group, commands: byGroup.get(group) ?? [] }));
}
