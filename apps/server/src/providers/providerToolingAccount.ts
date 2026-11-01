import { isAbsolute } from "node:path";
import type { ProviderInstance, ProviderToolingProvider } from "@octant/contracts";
import { effectiveClaudeAccountConfigDirectory } from "@octant/domain";
import { isolatedClaudeAccountEnvironment } from "./claudeAccountIsolation";
import { codexAccountProcessEnvironment } from "./codexProcess";
import { effectiveCodexAccountHome } from "./providerDriverFactory";

export interface ProviderToolingAccount {
  readonly provider: ProviderToolingProvider;
  readonly binary: string;
  /** The complete environment a tooling command runs with, before any secret. */
  readonly environment: NodeJS.ProcessEnv;
  /** The variables that name the account's folder, for the command line shown. */
  readonly shownEnvironment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** The account's folder; absent when the account uses its provider's own default. */
  readonly directory: string | undefined;
  /** Whether Octant threads load this account's own tools (the "run as itself" switch). */
  readonly runsAsItself: boolean;
}

/**
 * Resolves the folder and environment a Claude Code or Codex account runs
 * against, by the same rules its launch uses, so a tool added here lands where
 * the account looks. Any other account has no such commands.
 */
export function resolveProviderToolingAccount(
  instance: ProviderInstance,
  hostEnvironment: NodeJS.ProcessEnv,
  homeDirectory: string,
): ProviderToolingAccount | undefined {
  if (instance.driverKind === "claude") {
    const directory =
      effectiveClaudeAccountConfigDirectory(instance, homeDirectory) ??
      absoluteOrUndefined(hostEnvironment.CLAUDE_CONFIG_DIR);
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment,
      configDirectory: directory ?? "/",
      authentication: instance.configuration.authentication,
    });
    if (directory === undefined) {
      // The account uses Claude's own default folder; leave both variables unset
      // so the command finds it exactly as the app does.
      delete environment.CLAUDE_CONFIG_DIR;
      delete environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    }
    return {
      provider: "claude",
      binary: instance.configuration.binaryPath,
      environment,
      shownEnvironment:
        directory === undefined ? [] : [{ name: "CLAUDE_CONFIG_DIR", value: directory }],
      directory,
      runsAsItself: instance.nativeSetup === true,
    };
  }
  if (instance.driverKind === "codex") {
    const directory = effectiveCodexAccountHome(instance, hostEnvironment, homeDirectory);
    return {
      provider: "codex",
      binary: instance.configuration.binaryPath,
      environment: codexAccountProcessEnvironment({
        binaryPath: instance.configuration.binaryPath,
        hostEnvironment,
        codexHome: directory,
      }),
      shownEnvironment: [{ name: "CODEX_HOME", value: directory }],
      directory,
      runsAsItself: instance.nativeSetup === true,
    };
  }
  return undefined;
}

function absoluteOrUndefined(directory: string | undefined): string | undefined {
  const trimmed = directory?.trim();
  return trimmed === undefined || trimmed === "" || !isAbsolute(trimmed) ? undefined : trimmed;
}
