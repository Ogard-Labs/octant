import { win32 } from "node:path";
import type { ProviderInstance } from "@octant/contracts";
import { providerTerminalName } from "@octant/domain";
import { resolveProviderToolingAccount } from "./providerToolingAccount";

/**
 * What a provider terminal starts: the provider's own command-line program,
 * written as the command the terminal's shell runs, and the variables that
 * point it at the thread's account. The environment carries no secret: an
 * account signs in through its own folder, exactly as its turns do.
 */
export type ProviderTerminalLaunch =
  | {
      readonly status: "resolved";
      readonly name: string;
      readonly command: string;
      readonly environment: Readonly<Record<string, string>>;
    }
  | { readonly status: "refused"; readonly message: string };

/**
 * Resolves the program a thread's provider terminal opens, by the rules the
 * provider's own launch uses: the account's binary, its folder (the Claude
 * account's `CLAUDE_CONFIG_DIR`, the Codex account's `CODEX_HOME`), and the
 * environment its runtime starts with. A provider with no such program, or
 * one switched off, is refused rather than opened as a plain shell.
 */
export function resolveProviderTerminal(input: {
  readonly instance: ProviderInstance | undefined;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  /** The shell the terminal opens, which runs the program. */
  readonly shell: string;
  /** The thread's Strict value: the program gets the environment a turn there would. */
  readonly strict: boolean;
}): ProviderTerminalLaunch {
  const instance = input.instance;
  if (instance === undefined || !instance.enabled)
    return refused("This thread's provider is switched off or no longer set up.");
  const name = providerTerminalName(instance.driverKind);
  const account =
    name === undefined
      ? undefined
      : resolveProviderToolingAccount(
          instance,
          input.hostEnvironment,
          input.homeDirectory,
          input.strict,
        );
  if (name === undefined || account === undefined)
    return refused("This thread's provider has no command-line program Octant can open.");
  const command = programCommand(account.binary, input.platform, input.shell);
  if (command === undefined)
    return refused(
      `Octant cannot start ${name} from this terminal shell. Choose Windows PowerShell, PowerShell 7 or Command Prompt in Settings › Code.`,
    );
  const environment: Record<string, string> = {};
  for (const [variable, value] of Object.entries(account.environment)) {
    if (value !== undefined && !value.includes("\0")) environment[variable] = value;
  }
  return { status: "resolved", name, command, environment };
}

/**
 * The program as the terminal's shell runs it. A POSIX shell hands the
 * terminal over with `exec`, so the tab ends when the program does.
 */
function programCommand(
  binary: string,
  platform: NodeJS.Platform,
  shell: string,
): string | undefined {
  if (binary.includes("\0")) return undefined;
  if (platform !== "win32") return `exec '${binary.replaceAll("'", `'\\''`)}'`;
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      return `& '${binary.replaceAll("'", "''")}'`;
    case "cmd.exe":
      return binary.includes('"') ? undefined : `"${binary}"`;
    default:
      return undefined;
  }
}

function refused(message: string): ProviderTerminalLaunch {
  return { status: "refused", message };
}
