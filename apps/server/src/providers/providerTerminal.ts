import { mkdirSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import type { ProviderExecutionPolicy, ProviderInstance } from "@octant/contracts";
import { acpAgentProfile } from "@octant/contracts/acp-agent-profiles";
import { isAcpAgentInstance, providerTerminalName } from "@octant/domain";
import { sanitizeAcpEnvironment } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderKind, type AcpSessionMode } from "./acpProfiles";
import { DEFAULT_PROVIDER_OWN_CHANNELS } from "./providerOwnChannels";
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
 * account's `CLAUDE_CONFIG_DIR`, the Codex account's `CODEX_HOME`, an ACP
 * agent's managed home and host sign-in folder), and the environment its
 * runtime starts with. A provider with no such program, or one switched off,
 * is refused rather than opened as a plain shell.
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
  /** The thread a turn would launch for; an ACP agent's environment follows them. */
  readonly mode?: AcpSessionMode;
  readonly executionPolicy?: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean | undefined;
  /** Where an ACP agent instance keeps its managed home, as its driver is given. */
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  /**
   * The host credentials the person lets through to each provider, by driver
   * kind, as a turn outside Strict would get them.
   */
  readonly credentialPassThrough?: (
    driverKind: ProviderInstance["driverKind"],
  ) => ReadonlyArray<string>;
}): ProviderTerminalLaunch {
  const instance = input.instance;
  if (instance === undefined || !instance.enabled)
    return refused("This thread's provider is switched off or no longer set up.");
  const name = providerTerminalName(instance.driverKind);
  const program =
    name === undefined
      ? undefined
      : isAcpAgentInstance(instance)
        ? acpProgram(instance, input)
        : toolingProgram(instance, input);
  if (name === undefined || program === undefined)
    return refused("This thread's provider has no command-line program Octant can open.");
  const command = programCommand(program.binary, program.args, input.platform, input.shell);
  if (command === undefined)
    return refused(
      `Octant cannot start ${name} from this terminal shell. Choose Windows PowerShell, PowerShell 7 or Command Prompt in Settings › Code.`,
    );
  const environment: Record<string, string> = {};
  for (const [variable, value] of Object.entries(program.environment)) {
    if (value !== undefined && !value.includes("\0")) environment[variable] = value;
  }
  return { status: "resolved", name, command, environment };
}

interface Program {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

function toolingProgram(
  instance: ProviderInstance,
  input: Parameters<typeof resolveProviderTerminal>[0],
): Program | undefined {
  const account = resolveProviderToolingAccount(
    instance,
    input.hostEnvironment,
    input.homeDirectory,
    input.strict,
    input.credentialPassThrough?.(instance.driverKind) ?? [],
  );
  return account === undefined
    ? undefined
    : { binary: account.binary, args: [], environment: account.environment };
}

/**
 * An ACP agent's own interactive CLI: the profile's executable with the
 * arguments its descriptor names in place of the `acp` ones, and the
 * environment the ACP driver builds for a launch of this thread. That is the
 * same sanitized host environment (Strict's passthrough list and guards, or
 * the person's own outside Strict), the instance's managed home, and the
 * variables that point the CLI at the person's own sign-in folder. Only the
 * guards that keep the piped ACP stream clean (`NO_COLOR`) are left out, since
 * the terminal is a TTY. No API key is passed: an api-key account's CLI asks
 * for its own sign-in.
 */
function acpProgram(
  instance: ProviderInstance,
  input: Parameters<typeof resolveProviderTerminal>[0],
): Program | undefined {
  if (!isAcpAgentInstance(instance) || input.acpHome === undefined) return undefined;
  const args = acpAgentProfile(instance.driverKind).interactiveArgs;
  if (args === undefined) return undefined;
  const profile = acpProviderProfiles[instance.driverKind];
  const managedHome = input.acpHome(instance.driverKind, instance.id);
  try {
    mkdirSync(managedHome, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  const credentialPassThrough = input.credentialPassThrough?.(instance.driverKind) ?? [];
  const environment = sanitizeAcpEnvironment(profile, input.hostEnvironment, {
    managedHome,
    // The provider's channels stay closed here, as before this list existed.
    ...(credentialPassThrough.length === 0
      ? {}
      : { ownChannels: { ...DEFAULT_PROVIDER_OWN_CHANNELS, credentialPassThrough } }),
    executionPolicy: input.executionPolicy ?? "approval-gated",
    mode: input.mode ?? "code",
    // A TTY, not the ACP stream: the CLI keeps its colour.
    interactive: true,
    // As the driver's launch: the open environment only outside Strict for a
    // thread that did not keep its sandbox.
    ...(input.strict === false && input.fullAccessSandbox !== true ? { strict: false } : {}),
  });
  return {
    binary: instance.configuration.binaryPath,
    args,
    environment: { ...environment, ...hostSignInEnvironment(profile) },
  };
}

/**
 * The variables that point the CLI at the person's own sign-in folder, as the
 * ACP launch sets them. A folder that does not exist yet sets none, and the
 * CLI starts with its own default, where the person can sign in.
 */
function hostSignInEnvironment(
  profile: (typeof acpProviderProfiles)[keyof typeof acpProviderProfiles],
): Readonly<Record<string, string>> {
  const authentication = profile.process.hostAuthentication;
  if (authentication?.kind !== "directory" || authentication.environment === undefined) return {};
  try {
    return authentication.environment(realpathSync(authentication.defaultPath));
  } catch {
    return {};
  }
}

/**
 * The program as the terminal's shell runs it. A POSIX shell hands the
 * terminal over with `exec`, so the tab ends when the program does.
 */
function programCommand(
  binary: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  shell: string,
): string | undefined {
  const words = [binary, ...args];
  if (words.some((word) => word.includes("\0"))) return undefined;
  if (platform !== "win32")
    return `exec ${words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ")}`;
  switch (win32.basename(shell).toLowerCase()) {
    case "powershell.exe":
    case "pwsh.exe":
      return `& ${words.map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`;
    case "cmd.exe":
      return words.some((word) => word.includes('"'))
        ? undefined
        : words.map((word) => `"${word}"`).join(" ");
    default:
      return undefined;
  }
}

function refused(message: string): ProviderTerminalLaunch {
  return { status: "refused", message };
}
