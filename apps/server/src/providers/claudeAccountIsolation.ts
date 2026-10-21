import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

/**
 * Static switches every Claude launch sets, each one channel of the runtime's
 * own kept off by its own switch. The `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
 * umbrella is deliberately not among them: blanket-blocking every
 * non-essential channel was stricter than Octant needs, so each channel that
 * matters is named here instead (maintainer decision, 2026-10-20). The
 * channels without a switch of their own are closed by the launch shape, as
 * the architecture's security section records.
 */
export const ISOLATED_CLAUDE_LAUNCH_GUARDS = {
  /** Usage metrics. */
  DISABLE_TELEMETRY: "1",
  /** Error reports. */
  DISABLE_ERROR_REPORTING: "1",
  /** The runtime replacing its own binary. */
  DISABLE_AUTOUPDATER: "1",
  /** `/bug`, which uploads the conversation. */
  DISABLE_BUG_COMMAND: "1",
  /**
   * `/feedback`, which uploads the conversation. Not in the public reference,
   * but both installed binaries carry the name beside `DISABLE_BUG_COMMAND`.
   */
  DISABLE_FEEDBACK_COMMAND: "1",
  /** The session-quality survey the runtime would otherwise raise. */
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
} as const;

const HOST_DISABLE_ONLY_SWITCH = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

/**
 * The umbrella is the person's to set, not Octant's: a host that exports
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps it on every launch. Only
 * that disabling value crosses; any other value is dropped with the rest of
 * the host environment.
 */
export function hostDisableOnlySwitches(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return hostEnvironment[HOST_DISABLE_ONLY_SWITCH] === "1"
    ? { [HOST_DISABLE_ONLY_SWITCH]: "1" }
    : {};
}

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
  return {
    ...environment,
    ...hostDisableOnlySwitches(input.hostEnvironment),
    ...ISOLATED_CLAUDE_LAUNCH_GUARDS,
  };
}

/**
 * Resolve one Claude account directory through existing ancestors.
 *
 * Settings and replay can store `..` or a not-yet-created leaf. Plan
 * isolation and uniqueness have to see the same path `mkdir` will create.
 */
export function canonicalClaudeAccountDirectory(directory: string): {
  readonly path: string;
  readonly existed: boolean;
} {
  let end = directory.length;
  while (end > 0 && directory.charAt(end - 1) === "/") {
    end -= 1;
  }
  const resolved = resolve(directory.slice(0, end) || "/");
  try {
    return { path: realpathSync(resolved), existed: true };
  } catch {
    const parts: string[] = [];
    let current = resolved;
    let canonical = resolved;
    while (current !== dirname(current)) {
      try {
        canonical = parts.reduce((parent, part) => join(parent, part), realpathSync(current));
        break;
      } catch {
        parts.unshift(basename(current));
        current = dirname(current);
      }
    }
    return { path: canonical, existed: false };
  }
}

/** Create the account directory if needed. Never inspects its contents. */
export async function ensureClaudeAccountConfigDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
