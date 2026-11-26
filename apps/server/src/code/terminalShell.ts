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
 * How an agent's command is typed so its shell reports that it finished and
 * with what exit code, and the pattern that reads that back.
 *
 * The completion is part of the same input the shell parses with the command,
 * never a second line typed ahead into the terminal: a foreground program
 * that reads its input (a dev server, a test watcher) swallowed a typed-ahead
 * line, and a Ctrl-C flushed it, so the command never said it finished.
 *
 * Windows PowerShell has no POSIX `printf` and its `$?` is a Boolean, and
 * Command Prompt cannot print an escape character, so both print a plain-text
 * marker ending its line; PowerShell does too because a Windows 10 console
 * host may drop an OSC sequence. The pattern needs the marker's whole frame
 * (the closing BEL, or the line end), so a read that stops inside `exit=127`
 * is not taken as exit code 1, and takes a signed code, as Windows reports.
 * The shell's echo of the typed input never matches: there the exit code is
 * still a variable, not digits.
 */
export function terminalCompletion(
  shell: string,
  marker: string,
): { readonly wrap: (command: string) => string; readonly pattern: RegExp } {
  const plain = new RegExp(
    `octant=${marker};exit=(-?\\d+)(?:\\u001b\\[[0-9;?]*[A-Za-z])*\\r?\\n`,
    "g",
  );
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      // A native program sets `$LASTEXITCODE` (to a new value, even an equal
      // number) and nothing else does, so its code is reported when it ran,
      // even where a failed native program also leaves an error record
      // ($PSNativeCommandUseErrorActionPreference). Otherwise `$?` and the
      // newest error record decide: a failed cmdlet, or one run with
      // -ErrorAction Ignore that leaves no record, reports 1 rather than an
      // earlier program's code. `$LASTEXITCODE` itself is never assigned, so
      // a later command still reads what the last program left.
      return {
        wrap: (command) =>
          `$octantLastError = $Error[0]; $octantLastExit = $global:LASTEXITCODE; . { ${command} }; $octantOk = $?; $octantExit = if (-not [object]::ReferenceEquals($global:LASTEXITCODE, $octantLastExit) -and $LASTEXITCODE) { $LASTEXITCODE } elseif ($octantOk -and ($Error.Count -eq 0 -or [object]::ReferenceEquals($Error[0], $octantLastError))) { 0 } else { 1 }; [Console]::WriteLine("octant=${marker};exit=$octantExit")`,
        pattern: plain,
      };
    case "cmd.exe":
      // A successful built-in leaves ERRORLEVEL as it was, so `(call )` sets
      // it to 0 first; `%^ERRORLEVEL%` is expanded when `call` runs, after the
      // command, not when the line is read.
      return {
        wrap: (command) => `(call ) & (${command}) & call echo octant=${marker};exit=%^ERRORLEVEL%`,
        pattern: plain,
      };
    default:
      return {
        wrap: (command) => `{ ${command}\r}; printf '\\033]777;octant=${marker};exit=%s\\007' "$?"`,
        pattern: new RegExp(`\\u001b\\]777;octant=${marker};exit=(-?\\d+)\\u0007`, "g"),
      };
  }
}
