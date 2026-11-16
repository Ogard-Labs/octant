/**
 * A provider's own slash command runs inside its runtime in every mode and at
 * every level, as in the provider's own app (maintainer decision,
 * 2026-11-16). Octant does not refuse one for the mode: the level's tool
 * rules, which the runtime was launched under, decide what the command may
 * then do, so Plan stays read-only and Chat keeps no folder and no shell.
 */

/**
 * The provider command a prompt runs: its first word is `/name` for a name
 * the provider listed. Ordinary text that starts with a slash (a path, a
 * fraction) is not a command unless the provider listed that name.
 */
export function providerCommandOf(
  prompt: string,
  commands: ReadonlyArray<{ readonly name: string }> | undefined,
): string | undefined {
  if (commands === undefined || commands.length === 0) return undefined;
  const match = /^\s*\/([^\s/]+)(?:\s|$)/u.exec(prompt);
  const name = match?.[1];
  if (name === undefined) return undefined;
  return commands.some((command) => command.name === name) ? name : undefined;
}
