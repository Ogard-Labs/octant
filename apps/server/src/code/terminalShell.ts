import { existsSync } from "node:fs";

/**
 * The shell an Octant terminal opens. zsh comes first because the terminal's
 * state handling is written for it and macOS always has it, but a stock
 * Ubuntu host has no `/bin/zsh`: Bubblewrap then failed every terminal with
 * "execvp /bin/zsh: No such file or directory". Such a host gets bash, or the
 * POSIX shell every Linux system carries.
 */
export function defaultTerminalShell(exists: (path: string) => boolean = existsSync): string {
  return TERMINAL_SHELL_CANDIDATES.find((shell) => exists(shell)) ?? "/bin/sh";
}

const TERMINAL_SHELL_CANDIDATES = ["/bin/zsh", "/bin/bash", "/bin/sh"] as const;
