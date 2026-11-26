import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { WindowsTerminalShell } from "@octant/contracts";
import { windowsSystemProgram } from "../process/windowsProcessTree";

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

/**
 * The shell a terminal opens on this host. A Windows host opens the shell
 * Settings › Code names (Windows PowerShell when nothing is chosen), never a
 * POSIX shell guessed from what might be installed; macOS and Linux keep the
 * login shell above.
 */
export function terminalShellFor(input: {
  readonly platform: NodeJS.Platform;
  readonly windowsShell: WindowsTerminalShell | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}): string {
  if (input.platform !== "win32") return defaultTerminalShell();
  const environment = input.environment ?? process.env;
  switch (input.windowsShell ?? "powershell") {
    case "powershell":
      return windowsSystemProgram("WindowsPowerShell\\v1.0\\powershell.exe", environment);
    case "pwsh":
      return win32.join(
        environment.ProgramFiles ?? environment.PROGRAMFILES ?? "C:\\Program Files",
        "PowerShell",
        "7",
        "pwsh.exe",
      );
    case "cmd":
      return windowsSystemProgram("cmd.exe", environment);
  }
}

/**
 * The arguments a Windows shell opens with: interactive with no banner, or
 * running one command and exiting. A shell this does not know is refused
 * (undefined) rather than handed POSIX `-lc`, which none of them read.
 */
export function windowsShellArguments(
  shell: string,
  command: string | undefined,
): ReadonlyArray<string> | undefined {
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      return command === undefined ? ["-NoLogo"] : ["-NoLogo", "-Command", command];
    case "cmd.exe":
      return command === undefined ? ["/D"] : ["/D", "/S", "/C", command];
    default:
      return undefined;
  }
}

/**
 * The line typed after an agent's command so the terminal says it finished
 * and with what exit code, in the syntax of the shell it runs in, and the
 * pattern that reads it back. Windows PowerShell has no POSIX `printf` and
 * its `$?` is a Boolean, so a POSIX marker never printed there and every
 * command timed out. Command Prompt cannot print an escape character, so its
 * marker is plain text. The shell's echo of the typed line never matches:
 * there the exit code is still a variable, not digits.
 */
export function terminalCompletion(
  shell: string,
  marker: string,
): { readonly command: string; readonly pattern: RegExp } {
  const pattern = new RegExp(`(?:\\u001b\\]777;)?octant=${marker};exit=(\\d+)\\u0007?`, "g");
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      // `$?` first, before anything else resets it; a failed native program
      // leaves its code in `$LASTEXITCODE`, a failed cmdlet leaves none.
      return {
        command: `$octantOk = $?; $octantExit = if ($octantOk) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; [Console]::Write("$([char]27)]777;octant=${marker};exit=$octantExit$([char]7)")`,
        pattern,
      };
    case "cmd.exe":
      return { command: `echo octant=${marker};exit=%ERRORLEVEL%`, pattern };
    default:
      return { command: `printf '\\033]777;octant=${marker};exit=%s\\007' "$?"`, pattern };
  }
}
