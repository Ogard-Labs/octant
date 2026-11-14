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

/** Why a turn that runs a provider command is refused, or undefined when it may run. */
export function providerCommandRefusal(input: {
  readonly prompt: string;
  readonly commands: ReadonlyArray<{ readonly name: string }> | undefined;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy?: ProviderExecutionPolicy;
}): string | undefined {
  const name = providerCommandOf(input.prompt, input.commands);
  if (name === undefined) return undefined;
  if (input.mode === "chat") {
    return `/${name} is a command of this thread's provider, and Chat runs none: it keeps no folder and no shell. Send it from a Work or Code thread.`;
  }
  if (input.executionPolicy === "plan") {
    return `/${name} is a command of this thread's provider, and Plan runs none: Plan stays read-only. Choose another level to run it.`;
  }
  return undefined;
}
