import { mkdir } from "node:fs/promises";

import type { ClaudeAuthentication } from "@octant/contracts";

/**
 * Isolated Claude-account launch environment.
 *
 * This module prepares the directory Claude owns for one account and the
 * environment that launch sees. It never lists, reads, copies, or parses
 * files inside that directory. Sign-in stays on the unmodified
 * `claude auth login` flow; readiness stays on `claude auth status` or the
 * SDK account report.
 */

const PASSTHROUGH_VARIABLES = new Set([
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
]);

/** Static switches every isolated Claude launch sets. */
export const ISOLATED_CLAUDE_LAUNCH_GUARDS = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
} as const;

export interface IsolatedClaudeAccountEnvironmentInput {
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly configDirectory: string;
  readonly authentication: ClaudeAuthentication;
  readonly apiKey?: string;
}

function passthroughHostEnvironment(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(
      ([key, value]) =>
        value !== undefined && (PASSTHROUGH_VARIABLES.has(key) || key.startsWith("LC_")),
    ),
  );
}

/**
 * Build the launch environment for one Claude account.
 *
 * Inherited Anthropic and Claude credential and routing variables are dropped
 * by the passthrough list. The account directory is applied as both
 * `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` so the Claude
 * binary keys macOS Keychain the way it expects. An explicit API-key account
 * still receives only the broker-resolved key.
 */
export function isolatedClaudeAccountEnvironment(
  input: IsolatedClaudeAccountEnvironmentInput,
): NodeJS.ProcessEnv {
  const environment = passthroughHostEnvironment(input.hostEnvironment);
  environment.CLAUDE_CONFIG_DIR = input.configDirectory;
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = input.configDirectory;
  if (input.authentication === "api-key" && input.apiKey !== undefined) {
    environment.ANTHROPIC_API_KEY = input.apiKey;
  }
  return { ...environment, ...ISOLATED_CLAUDE_LAUNCH_GUARDS };
}

/** Create the account directory if needed. Never inspects its contents. */
export async function ensureClaudeAccountConfigDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
