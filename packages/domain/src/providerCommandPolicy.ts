import type { ProviderExecutionPolicy } from "@octant/contracts";

/**
 * A provider's own slash command runs inside its runtime, where Octant cannot
 * see what it does before it does it: a command may start a shell, write
 * files, or change the runtime's own settings. Plan stays read-only and Chat
 * keeps no folder and no shell, so neither runs one; Work and Code outside
 * Plan run them as the provider's own app does (maintainer principle,
 * 2026-11-14).
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

/**
 * The command name a prompt opens with, `/name` in the shape a provider's
 * listed command takes (`ProviderSlashCommand`), whether or not any list
 * names it. A path (`/usr/bin`) has a second slash and is not one.
 */
function commandShapedOpening(prompt: string): string | undefined {
  const name = /^\s*\/([^\s/]+)(?:\s|$)/u.exec(prompt)?.[1];
  return name !== undefined && /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/u.test(name) ? name : undefined;
}

/**
 * Why a turn that runs a provider command is refused, or undefined when it may
 * run. In Plan and Chat a provider that lists commands at all has every
 * command-shaped opening refused, listed or not: the list a host holds is the
 * one a session last wrote for the provider, which may belong to another
 * Project, so a command this session's runtime would run could be missing
 * from it.
 */
export function providerCommandRefusal(input: {
  readonly prompt: string;
  readonly commands: ReadonlyArray<{ readonly name: string }> | undefined;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy?: ProviderExecutionPolicy;
}): string | undefined {
  if (input.mode !== "chat" && input.executionPolicy !== "plan") return undefined;
  const name = input.commands === undefined ? undefined : commandShapedOpening(input.prompt);
  if (name === undefined) return undefined;
  return input.mode === "chat"
    ? `/${name} is a command of this thread's provider, and Chat runs none: it keeps no folder and no shell. Send it from a Work or Code thread.`
    : `/${name} is a command of this thread's provider, and Plan runs none: Plan stays read-only. Choose another level to run it.`;
}
