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
 * The host's own telemetry opt-outs. Claude Code reads `DO_NOT_TRACK` the same
 * way as `DISABLE_TELEMETRY`, and a launch that offers Claude's Artifact tool
 * goes without Octant's `DISABLE_TELEMETRY`; a person who exported either one
 * must keep telemetry off even in a thread that chose Claude artifacts, so
 * either is carried as `DO_NOT_TRACK=1`, which that launch never removes.
 */
const HOST_TELEMETRY_OPT_OUTS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;
const HOST_TELEMETRY_OPT_OUT = "DO_NOT_TRACK";

function optsOut(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * The person's own switches, never Octant's to remove: a host that exports
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps it on every launch, and
 * one that exports `DISABLE_TELEMETRY` or `DO_NOT_TRACK` keeps telemetry off as
 * `DO_NOT_TRACK=1`. Only those disabling values cross; any other value is
 * dropped with the rest of the host environment.
 */
export function hostDisableOnlySwitches(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(hostEnvironment[HOST_DISABLE_ONLY_SWITCH] === "1"
      ? { [HOST_DISABLE_ONLY_SWITCH]: "1" }
      : {}),
    ...(HOST_TELEMETRY_OPT_OUTS.some((name) => optsOut(hostEnvironment[name]))
      ? { [HOST_TELEMETRY_OPT_OUT]: "1" }
      : {}),
  };
}

/** Whether a launch environment carries one of the host's own switches that keep Claude artifacts off. */
export function disablesNonessentialTraffic(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment[HOST_DISABLE_ONLY_SWITCH] === "1" || environment[HOST_TELEMETRY_OPT_OUT] === "1"
  );
}

/**
 * The one guard a launch offered Claude's Artifact tool goes without.
 *
 * Claude Code 2.1.211 reads claude.ai's switch for the tool
 * (`tengu_cobalt_plinth`) through its feature-flag service, and that service
 * runs only when the runtime's telemetry is on: `kol()` reads
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, and
 * `DO_NOT_TRACK`, and any of them makes `Yee()` false, so the switch reads its
 * default, off, and the tool is never listed. No other guard in
 * {@link ISOLATED_CLAUDE_LAUNCH_GUARDS} is read on that path; error reports
 * keep their own switch (read from the bundled binary, 2026-10-28). Lifting it
 * turns on the runtime's usage telemetry to Anthropic for that launch, which
 * the person accepted when they enabled Claude artifacts (maintainer decision,
 * 2026-10-28).
 */
export const CLAUDE_ARTIFACT_LIFTED_GUARD = "DISABLE_TELEMETRY";

/**
 * The environment of a launch that offers Claude's Artifact tool: the
 * runtime's opt-in for an Agent SDK launch, and every guard but
 * {@link CLAUDE_ARTIFACT_LIFTED_GUARD}. A host that exports the umbrella or its
 * own telemetry opt-out keeps its launch exactly as it was: either would keep
 * the flag service off anyway, and the person's own switch is never weakened.
 */
export function claudeArtifactLaunchEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (disablesNonessentialTraffic(environment)) return environment;
  const { [CLAUDE_ARTIFACT_LIFTED_GUARD]: _lifted, ...kept } = environment;
  return { ...kept, CLAUDE_CODE_ARTIFACT: "1" };
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
